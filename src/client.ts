import {
  CyberSoulClientConfig,
  InteractParams,
  ProactiveParams,
  ProactiveResponse,
  OndemandEventParams,
  OndemandEventResponse,
  InteractRequestType,
  DispatcherIntent,
  InteractResponse,
  BaseLLMProvider,
  CharacterState,
  CoreMemory,
  UserCodex,
  VoiceArgs,
  WardrobeItem,
  HistoryEntry,
  LikedPicture,
  OutfitGiftedPayload,
  PersistedDynamicContext,
  SupportedLLMModel,
} from "./types.js";
import { robustJsonParse } from "./utils/json.utils.js";
import { GenericLLMProvider } from "./llm.provider.js";
import {
  CyberSoulError,
  CyberSoulInsufficientPointsError,
  CyberSoulSensitiveContentError,
  CyberSoulWalletError,
} from "./errors.js";
import {
  buildConsolidationPromptMessages,
  buildHistoryTranscript,
  buildInteractSystemPrompt,
  buildInteractUserMessage,
  buildOndemandEventPromptMessages,
  buildProactiveSystemPrompt,
  buildProactiveUserMessage,
  buildStandaloneImagePromptMessages,
  buildStandaloneVoicePromptMessages,
  buildSummarizerContextBlock,
  buildSummarizerPromptMessages,
} from "./prompts/promptBuilders.js";
import {
  parseVoiceDirectorArgs,
  sanitizeTextForVoice,
} from "./utils/voice.utils.js";
import {
  countConsecutiveProactiveTurns,
  formatHistoryEntries,
} from "./utils/history.utils.js";
import {
  deriveSummarizerIdentity,
  getDefaultCoreMemory,
  getDefaultUserCodex,
  normalizeOngoingSceneState,
} from "./utils/state.utils.js";
import { normalizeRequestTypes } from "./utils/requestTypes.utils.js";
import { buildMediaError } from "./utils/error.utils.js";
import { parseImageDirectorArgs } from "./utils/image.utils.js";
import { CyberSoulApi } from "./api/cyberSoulApi.js";

export class CyberSoulClient {
  /* ====================== Fields ====================== */

  private config: CyberSoulClientConfig;
  private llm: BaseLLMProvider;
  private api: CyberSoulApi;
  private cachedWardrobeStr: string | null = null;
  private cachedWardrobeTime: number = 0;

  /* ==================== Constructor ==================== */

  constructor(config: CyberSoulClientConfig) {
    this.config = config;

    this.api = new CyberSoulApi({
      backendUrl: config.backendUrl,
      characterKey: config.characterKey,
      requestTimeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      fetchImpl: config.fetchImpl,
    });

    this.llm = new GenericLLMProvider(
      config.llmConfig,
      config.backendUrl,
      config.characterKey,
      config.fetchImpl,
    );
  }

  /* ============================================================ */
  /* Private — backend transport delegation                      */
  /* ============================================================ */
  //
  // Every backend HTTP call goes through `this.api` (see
  // [CyberSoulApi]). These wrappers exist only to (a) cache the
  // wardrobe string used for prompt assembly, (b) translate the
  // dispatcher-intent shape into the PATCH payload shape the backend
  // expects, and (c) give every call site inside `interact()` /
  // `proactiveInteract()` a stable, named target. There is no fetch /
  // status-code / error-class logic here — that lives in the API layer.

  private async fetchRemoteState(): Promise<CharacterState> {
    return this.api.getState();
  }

  /**
   * Cached wardrobe prompt string (5 minute TTL). The raw items come
   * from `this.api.getWardrobe()`; this method owns the prompt-side
   * formatting + the cache so we don't ship a huge list on every chat
   * turn.
   */
  private async getWardrobePromptStr(): Promise<string> {
    const now = Date.now();
    if (
      this.cachedWardrobeStr &&
      now - this.cachedWardrobeTime <= 5 * 60 * 1000
    ) {
      return this.cachedWardrobeStr;
    }

    let availableOutfits = "None available";
    try {
      const wardrobes = await this.api.getWardrobe();
      if (wardrobes.length > 0) {
        availableOutfits = wardrobes
          .map(
            (w: WardrobeItem) =>
              `- ID: ${w.id} | Name: ${w.itemName} | Category: ${w.category}`,
          )
          .join("\n");
      }
    } catch (e) {}

    this.cachedWardrobeStr = availableOutfits;
    this.cachedWardrobeTime = now;
    return availableOutfits;
  }

  /**
   * PATCH the backend dynamic context. The server applies stage-based
   * dampening, familiarity soft-caps, hard floor, and stage re-evaluation,
   * then returns the *authoritative* persisted `temperature` and
   * `relationshipStage`. We surface those so callers (and ultimately the UI)
   * can avoid recomputing the delta locally — local math would diverge from
   * the server because the LLM-supplied `temperatureDelta` is just raw intent.
   *
   * Returns `null` when there's nothing to send, or when the request fails
   * (failure is non-fatal for the chat turn; callers must treat `null` as
   * "no fresh server snapshot available").
   *
   * Owns the dispatcher-intent → backend-payload translation
   * (`temperatureDelta` → `temperature`, ongoing-scene normalization).
   */
  private async _updateDynamicContextInternal(
    stateUpdate: DispatcherIntent["stateUpdate"],
    userAnalysis?: DispatcherIntent["userAnalysis"],
  ): Promise<PersistedDynamicContext | null> {
    if (!stateUpdate && !userAnalysis) return null;

    const payload: any = { ...stateUpdate };
    if (userAnalysis) {
      payload.userAnalysis = userAnalysis;
    }
    if (payload.temperatureDelta !== undefined) {
      payload.temperature = payload.temperatureDelta;
      delete payload.temperatureDelta;
    }

    if (payload.ongoingScene !== undefined) {
      const normalizedOngoingScene = normalizeOngoingSceneState(
        payload.ongoingScene,
      );
      payload.ongoingScene = normalizedOngoingScene || null;
    }

    return this.api.patchDynamicContext(payload);
  }

  /**
   * Shared giftOutfit handler for `interact()` / `proactiveInteract()`.
   * Validates the LLM's `giftOutfit` intent, performs the wardrobe write,
   * fires the `onOutfitGifted` callback, and resolves to the
   * [OutfitGiftedPayload] (or `undefined` when there was nothing to gift
   * or the write failed). Failures are swallowed (logged) so a wardrobe
   * hiccup never aborts the chat turn.
   */
  private async processGiftOutfit(
    giftOutfitIntent: DispatcherIntent["giftOutfit"],
    onOutfitGifted?: (payload: OutfitGiftedPayload) => void,
  ): Promise<OutfitGiftedPayload | undefined> {
    if (
      !giftOutfitIntent ||
      typeof giftOutfitIntent !== "object" ||
      typeof giftOutfitIntent.descriptionText !== "string" ||
      giftOutfitIntent.descriptionText.trim().length === 0
    ) {
      return undefined;
    }

    const outfitDescription = giftOutfitIntent.descriptionText.trim();
    try {
      const count = await this.giftOutfit(outfitDescription);
      const giftedOutfit: OutfitGiftedPayload = {
        descriptionText: outfitDescription,
      };
      if (typeof count === "number") {
        giftedOutfit.count = count;
      }
      if (onOutfitGifted) {
        try {
          onOutfitGifted(giftedOutfit);
        } catch (cbErr) {
          console.warn(
            "[CyberSoulClient] onOutfitGifted callback threw:",
            cbErr,
          );
        }
      }
      return giftedOutfit;
    } catch (e) {
      console.error("[CyberSoulClient] giftOutfit failed:", e);
      return undefined;
    }
  }

  /* ============================================================ */
  /* Private — interact helpers                                  */
  /* ============================================================ */

  /**
   * Fetch state + wardrobe and normalize the request types. Everything
   * downstream of this point can run synchronously off these inputs.
   */
  private async prepareInteractContext(params: InteractParams): Promise<{
    state: CharacterState;
    availableOutfits: string;
    types: InteractRequestType[];
    isAuto: boolean;
    requestedOthers: InteractRequestType[];
  }> {
    const [state, availableOutfits] = await Promise.all([
      this.fetchRemoteState(),
      this.getWardrobePromptStr(),
    ]);

    const types = normalizeRequestTypes(params.requestTypes);
    const isAuto = types.includes(InteractRequestType.AUTO);
    const requestedOthers = types.filter(
      (t) => t !== InteractRequestType.AUTO && t !== InteractRequestType.TEXT,
    );

    return { state, availableOutfits, types, isAuto, requestedOthers };
  }

  private buildInteractPromptMessages(
    ctx: {
      state: CharacterState;
      availableOutfits: string;
      types: InteractRequestType[];
      isAuto: boolean;
      requestedOthers: InteractRequestType[];
    },
    params: InteractParams,
  ): Array<{ role: string; content: string }> {
    const systemPrompt = buildInteractSystemPrompt({
      state: ctx.state,
      availableOutfits: ctx.availableOutfits,
      types: ctx.types,
      isAuto: ctx.isAuto,
      requestedOthers: ctx.requestedOthers,
      allowSkip: params.allowSkip === true,
    });

    const transcript =
      params.history && params.history.length > 0
        ? buildHistoryTranscript(params.history, ctx.state)
        : "";
    const userName = ctx.state.dynamic_context?.userNickname || "User";

    const userContent = buildInteractUserMessage({
      userMessage: params.userMessage,
      localContext: params.localContext,
      transcript,
      userName,
    });

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ];
  }

  /**
   * Run the dispatcher LLM with a bounded retry loop. A "non-actionable"
   * parse yields no usable `textResponse` AND no media intent — i.e. the
   * LLM hiccuped (empty body, truncated or garbled JSON, or an empty
   * textResponse field). Retrying the generation is far better than
   * silently echoing the user's own message back as the character's
   * reply, which downstream consumers correctly reject as a
   * non-actionable response.
   */
  private async dispatchInteractWithRetry(
    promptMessages: Array<{ role: string; content: string }>,
  ): Promise<DispatcherIntent> {
    const MAX_DISPATCH_ATTEMPTS = 3;
    let parsedIntent: DispatcherIntent = { textResponse: "" };
    for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) {
      const rawLlmResponse = await this.llm.generate(
        promptMessages,
        15000,
        0.7,
      );

      try {
        parsedIntent = robustJsonParse<DispatcherIntent>(
          rawLlmResponse,
          "Dispatcher fallback",
          { textResponse: "", actionText: "", isEndTurn: false },
        );
      } catch (e) {
        console.warn(
          "[CyberSoulClient] JSON parse failed, falling back to raw text:",
          e,
        );
        parsedIntent = {
          textResponse: rawLlmResponse.replace(/^[\`\s]+|[\`\s]+$/g, "").trim(),
        };
      }

      const hasUsableText =
        typeof parsedIntent.textResponse === "string" &&
        parsedIntent.textResponse.trim().length > 0;
      const hasMediaIntent =
        !!parsedIntent.imageParams || !!parsedIntent.voiceArgs;
      // A deliberate reactive-skip decision is itself an actionable
      // outcome — don't burn retry attempts trying to "fix" it into a
      // text reply. Whether the caller actually honors the skip is
      // decided later in `interact()` (gated on `allowSkip`).
      const hasSkipIntent = parsedIntent.shouldSkipInteract === true;
      if (hasUsableText || hasMediaIntent || hasSkipIntent) {
        break;
      }
      console.warn(
        `[CyberSoulClient] interact produced a non-actionable intent (attempt ${attempt}/${MAX_DISPATCH_ATTEMPTS}); ${
          attempt < MAX_DISPATCH_ATTEMPTS ? "retrying" : "giving up"
        }.`,
      );
    }
    return parsedIntent;
  }

  /**
   * Fail fast instead of echoing the user's own message back as the
   * character's reply. The `: params.userMessage` fallback used in
   * `resolveInteractText` is only ever reached for media-only turns now.
   */
  private assertInteractIntentActionable(parsedIntent: DispatcherIntent): void {
    const finalHasUsableText =
      typeof parsedIntent.textResponse === "string" &&
      parsedIntent.textResponse.trim().length > 0;
    const finalHasMediaIntent =
      !!parsedIntent.imageParams || !!parsedIntent.voiceArgs;
    if (!finalHasUsableText && !finalHasMediaIntent) {
      throw new Error(
        "LLM returned a non-actionable response after retries (no usable textResponse and no media intent). Check LLM template/provider alignment.",
      );
    }
  }

  /**
   * Kick off the server-side dynamic-context PATCH in parallel with media
   * generation. Returns the in-flight promise (awaited at the end of
   * `interact()` to surface the server-authoritative snapshot). Also wires
   * `onStateReady` so the UI can update temperature/stage as soon as the
   * PATCH resolves — independent of (potentially slow) image generation.
   */
  private startInteractStateUpdate(
    parsedIntent: DispatcherIntent,
    onStateReady?: InteractParams["onStateReady"],
  ): Promise<PersistedDynamicContext | null> {
    let persistedStatePromise: Promise<PersistedDynamicContext | null> =
      Promise.resolve(null);
    if (parsedIntent.stateUpdate || parsedIntent.userAnalysis) {
      persistedStatePromise = this._updateDynamicContextInternal(
        parsedIntent.stateUpdate,
        parsedIntent.userAnalysis,
      );
    }

    if (onStateReady) {
      persistedStatePromise
        .then((persisted) => {
          try {
            onStateReady(persisted ?? {});
          } catch (cbErr) {
            console.warn(
              "[CyberSoulClient] onStateReady callback threw:",
              cbErr,
            );
          }
        })
        .catch(() => {
          try {
            onStateReady({});
          } catch (cbErr) {
            console.warn(
              "[CyberSoulClient] onStateReady callback threw:",
              cbErr,
            );
          }
        });
    }

    return persistedStatePromise;
  }

  private resolveInteractText(
    parsedIntent: DispatcherIntent,
    userMessage: string,
  ): string {
    return typeof parsedIntent.textResponse === "string" &&
      parsedIntent.textResponse.trim().length > 0
      ? parsedIntent.textResponse
      : userMessage;
  }

  private emitInteractTextReady(
    params: InteractParams,
    parsedIntent: DispatcherIntent,
    resolvedTextResponse: string,
    willGenerateVoice: boolean,
  ): void {
    if (
      params.onTextReady &&
      (resolvedTextResponse || parsedIntent.actionText)
    ) {
      params.onTextReady(resolvedTextResponse, parsedIntent.actionText, {
        stateUpdate: parsedIntent.stateUpdate,
        userAnalysis: parsedIntent.userAnalysis,
        isEndTurn: parsedIntent.isEndTurn,
        triggerEvent: parsedIntent.triggerEvent,
        likePreviousPicture: parsedIntent.likePreviousPicture,
        willGenerateVoice,
      });
    }
  }

  /**
   * Schedule all side-effect tasks attached to a turn: trigger-event
   * POST, giftOutfit, image generation, voice generation. Text was
   * already emitted via `onTextReady`, so a wallet / insufficient-points
   * failure on image or voice MUST NOT abort the whole turn — partial
   * failures are captured and surfaced in-band via `firstMediaError` /
   * `affected`. Resolves once every task has settled.
   */
  private async runInteractMediaTasks(
    ctx: {
      types: InteractRequestType[];
      isAuto: boolean;
    },
    parsedIntent: DispatcherIntent,
    params: InteractParams,
    resolvedTextResponse: string,
  ): Promise<{
    imageUrl?: string;
    imageMediaId?: string;
    audioUrl?: string;
    audioMediaId?: string;
    durationSec?: number;
    giftedOutfit?: OutfitGiftedPayload;
    firstMediaError: CyberSoulError | null;
    affected: Array<"image" | "voice">;
  }> {
    let imageUrl: string | undefined = undefined;
    let imageMediaId: string | undefined = undefined;
    let audioUrl: string | undefined = undefined;
    let audioMediaId: string | undefined = undefined;
    let durationSec: number | undefined = undefined;
    let giftedOutfit: OutfitGiftedPayload | undefined = undefined;

    const affected: Array<"image" | "voice"> = [];
    let firstMediaError: CyberSoulError | null = null;
    const captureMediaError = (
      modality: "image" | "voice",
      e: unknown,
    ): void => {
      if (!(e instanceof CyberSoulError)) return;
      if (
        !(e instanceof CyberSoulInsufficientPointsError) &&
        !(e instanceof CyberSoulWalletError) &&
        !(e instanceof CyberSoulSensitiveContentError)
      ) {
        return;
      }
      if (!affected.includes(modality)) {
        affected.push(modality);
      }
      if (!firstMediaError) firstMediaError = e;
    };

    const mediaTasks: Promise<unknown>[] = [];

    if (parsedIntent.triggerEvent) {
      mediaTasks.push(
        this.api
          .triggerOndemandEvent({
            eventTitle: parsedIntent.triggerEvent.eventTitle,
            eventDescription: parsedIntent.triggerEvent.eventDescription,
            durationMins: parsedIntent.triggerEvent.durationMins || 60,
            outfitId: parsedIntent.triggerEvent.outfitId || undefined,
            scheduledStartTimeStr:
              parsedIntent.triggerEvent.scheduledStartTimeStr || undefined,
            scheduledDateStr:
              parsedIntent.triggerEvent.scheduledDateStr || undefined,
          })
          .catch((e) =>
            console.error(
              "[CyberSoulClient] Auto-triggered ondemandEvent failed:",
              e,
            ),
          ),
      );
    }

    if (
      parsedIntent.giftOutfit &&
      typeof parsedIntent.giftOutfit === "object" &&
      typeof parsedIntent.giftOutfit.descriptionText === "string" &&
      parsedIntent.giftOutfit.descriptionText.trim().length > 0
    ) {
      mediaTasks.push(
        this.processGiftOutfit(
          parsedIntent.giftOutfit,
          params.onOutfitGifted,
        ).then((result) => {
          if (result) giftedOutfit = result;
        }),
      );
    }

    const shouldGenerateImage =
      ctx.types.includes(InteractRequestType.IMAGE) &&
      (!ctx.isAuto || !!parsedIntent.imageParams);
    if (shouldGenerateImage) {
      const imagePayload =
        parsedIntent.imageParams && typeof parsedIntent.imageParams === "object"
          ? parsedIntent.imageParams
          : {
              mode: "full-prompt",
              full_prompt: resolvedTextResponse,
            };

      mediaTasks.push(
        this.api
          .generatePrimitive("image", imagePayload)
          .then((res: any) => {
            imageUrl = res.image_url;
            imageMediaId = res.id;
            if (params.onMediaReady && imageUrl) {
              try {
                params.onMediaReady({
                  modality: "image",
                  url: imageUrl,
                  mediaId: imageMediaId,
                });
              } catch (cbErr) {
                console.warn(
                  "[CyberSoulClient] onMediaReady(image) threw:",
                  cbErr,
                );
              }
            }
          })
          .catch((e: any) => {
            if (
              !(e instanceof CyberSoulInsufficientPointsError) &&
              !(e instanceof CyberSoulWalletError) &&
              !(e instanceof CyberSoulSensitiveContentError)
            ) {
              console.error("[CyberSoulClient] Image generation failed:", e);
            }
            captureMediaError("image", e);
          }),
      );
    }

    const shouldGenerateVoice =
      ctx.types.includes(InteractRequestType.VOICE) &&
      (!ctx.isAuto || !!parsedIntent.voiceArgs);
    if (shouldGenerateVoice) {
      const normalizedVoiceArgs: VoiceArgs =
        parsedIntent.voiceArgs && typeof parsedIntent.voiceArgs === "object"
          ? (parsedIntent.voiceArgs as VoiceArgs)
          : {};

      let textForVoice = sanitizeTextForVoice(resolvedTextResponse);
      if (textForVoice.length === 0) {
        textForVoice = "...";
      }

      mediaTasks.push(
        this.api
          .generatePrimitive("voice", {
            text: textForVoice,
            dynamicArgs: normalizedVoiceArgs,
          })
          .then((res: any) => {
            audioUrl = res.audio_url;
            audioMediaId = res.id;
            durationSec = res.duration_sec;
            if (params.onMediaReady && audioUrl) {
              try {
                params.onMediaReady({
                  modality: "voice",
                  url: audioUrl,
                  mediaId: audioMediaId,
                  durationSec,
                });
              } catch (cbErr) {
                console.warn(
                  "[CyberSoulClient] onMediaReady(voice) threw:",
                  cbErr,
                );
              }
            }
          })
          .catch((e: any) => {
            if (
              !(e instanceof CyberSoulInsufficientPointsError) &&
              !(e instanceof CyberSoulWalletError) &&
              !(e instanceof CyberSoulSensitiveContentError)
            ) {
              console.error("[CyberSoulClient] Voice generation failed:", e);
            }
            captureMediaError("voice", e);
          }),
      );
    }

    await Promise.all(mediaTasks);

    return {
      imageUrl,
      imageMediaId,
      audioUrl,
      audioMediaId,
      durationSec,
      giftedOutfit,
      firstMediaError,
      affected,
    };
  }

  /* ============================================================ */
  /* Private — ondemand helpers                                  */
  /* ============================================================ */

  /**
   * Run the ondemand-event decision LLM call and parse the structured
   * accept/decline payload. Throws on parse failure so the outer
   * handler surfaces it as `{ status: "error" }` rather than silently
   * treating an unparseable response as a decline.
   */
  private async dispatchOndemandDecision(
    promptMessages: Array<{ role: string; content: string }>,
  ): Promise<any> {
    const rawLlmResponse = await this.llm.generate(promptMessages, 800, 0.5);

    try {
      return robustJsonParse<any>(rawLlmResponse, "OndemandEvent fallback");
    } catch (e) {
      throw new Error(
        `Failed to parse LLM decision for ondemandEvent. Raw response: ${rawLlmResponse}`,
      );
    }
  }

  /* ============================================================ */
  /* Private — proactive helpers                                 */
  /* ============================================================ */

  /**
   * Fetch state + wardrobe and derive the modality gates. The base
   * context built by [buildProactiveSystemPrompt] already includes
   * stage, temperature, traits, ongoing scene, active/next event,
   * current time, and lastInteractionAt — the LLM has everything it
   * needs to make the social call without us restating it.
   */
  private async prepareProactiveContext(params: ProactiveParams): Promise<{
    state: CharacterState;
    availableOutfits: string;
    types: InteractRequestType[];
    requestedOthers: InteractRequestType[];
    imageAllowed: boolean;
  }> {
    const [state, availableOutfits] = await Promise.all([
      this.fetchRemoteState(),
      this.getWardrobePromptStr(),
    ]);

    const types = normalizeRequestTypes(params.requestTypes);
    const requestedOthers = types.filter(
      (t) => t !== InteractRequestType.AUTO && t !== InteractRequestType.TEXT,
    );
    const imageAllowed = requestedOthers.includes(InteractRequestType.IMAGE);

    return { state, availableOutfits, types, requestedOthers, imageAllowed };
  }

  private buildProactivePromptMessages(
    ctx: {
      state: CharacterState;
      availableOutfits: string;
      imageAllowed: boolean;
    },
    params: ProactiveParams,
  ): Array<{ role: string; content: string }> {
    const systemPrompt = buildProactiveSystemPrompt({
      state: ctx.state,
      availableOutfits: ctx.availableOutfits,
      imageAllowed: ctx.imageAllowed,
    });

    const transcript =
      params.history && params.history.length > 0
        ? buildHistoryTranscript(params.history, ctx.state)
        : "";

    const userContent = buildProactiveUserMessage({
      localContext: params.localContext,
      transcript,
    });

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ];
  }

  /**
   * Run the proactive-decision LLM call and parse the response.
   *
   * Fail fast on parse error: a proactive message is opt-in by design,
   * so if the LLM produced unparseable output we'd rather let the outer
   * handler convert that to `{ status: "error" }` than ship raw
   * scaffolding to the user.
   *
   * Returns a discriminated union:
   *   - `{ kind: "skip", reason }` when the character chose not to
   *     reach out, or produced no usable `textResponse` (implicit skip).
   *   - `{ kind: "proceed", intent }` when the character decided to
   *     send a message.
   */
  private async dispatchProactiveDecision(
    promptMessages: Array<{ role: string; content: string }>,
  ): Promise<
    | { kind: "skip"; reason: string }
    | { kind: "proceed"; intent: DispatcherIntent }
  > {
    const rawLlmResponse = await this.llm.generate(promptMessages, 800, 0.5);
    const parsedIntent = robustJsonParse<DispatcherIntent>(
      rawLlmResponse,
      "Proactive fallback",
    );

    if (parsedIntent.shouldSkipProactive) {
      return {
        kind: "skip",
        reason: parsedIntent.skipReason || "Character chose not to reach out.",
      };
    }

    if (
      typeof parsedIntent.textResponse !== "string" ||
      parsedIntent.textResponse.trim().length === 0
    ) {
      return {
        kind: "skip",
        reason: "LLM produced no textResponse (treated as implicit skip).",
      };
    }

    return { kind: "proceed", intent: parsedIntent };
  }

  /**
   * Kick off the server-side dynamic-context PATCH in parallel with
   * image generation. Returns the in-flight promise (awaited at the end
   * of `proactiveInteract()` to surface the server-authoritative
   * snapshot). Also wires `onStateReady` so the UI can update
   * temperature/stage the moment the PATCH resolves — independent of
   * (potentially slow) image generation.
   *
   * Mirrors [startInteractStateUpdate] but only fires on `stateUpdate`
   * (proactive turns never emit `userAnalysis`).
   */
  private startProactiveStateUpdate(
    parsedIntent: DispatcherIntent,
    onStateReady?: ProactiveParams["onStateReady"],
  ): Promise<PersistedDynamicContext | null> {
    let persistedStatePromise: Promise<PersistedDynamicContext | null> =
      Promise.resolve(null);
    if (parsedIntent.stateUpdate) {
      persistedStatePromise = this._updateDynamicContextInternal(
        parsedIntent.stateUpdate,
      );
    }

    if (onStateReady) {
      persistedStatePromise
        .then((persisted) => {
          try {
            onStateReady(persisted ?? {});
          } catch (cbErr) {
            console.warn(
              "[CyberSoulClient] onStateReady callback threw:",
              cbErr,
            );
          }
        })
        .catch(() => {
          try {
            onStateReady({});
          } catch (cbErr) {
            console.warn(
              "[CyberSoulClient] onStateReady callback threw:",
              cbErr,
            );
          }
        });
    }

    return persistedStatePromise;
  }

  /**
   * Generate the optional proactive image and capture any typed media
   * failure. Text was already emitted via `onTextReady`, so a wallet /
   * insufficient-points / sensitive-content failure MUST NOT abort the
   * whole turn — it is surfaced in-band via `mediaError`. Non-typed
   * failures are logged and swallowed (no image, no in-band error).
   *
   * Voice is forced off for proactive turns (the prompt sets
   * `voiceArgs: null`), so this only ever handles the image path.
   */
  private async runProactiveImageTask(
    parsedIntent: DispatcherIntent,
    params: ProactiveParams,
  ): Promise<{
    imageUrl?: string;
    imageMediaId?: string;
    mediaError: CyberSoulError | null;
    affected: Array<"image" | "voice">;
  }> {
    let imageUrl: string | undefined;
    let imageMediaId: string | undefined;
    let mediaError: CyberSoulError | null = null;
    const affected: Array<"image" | "voice"> = [];

    if (!parsedIntent.imageParams) {
      return { imageUrl, imageMediaId, mediaError, affected };
    }

    try {
      const res = await this.api.generatePrimitive(
        "image",
        parsedIntent.imageParams,
      );
      imageUrl = res.image_url;
      imageMediaId = res.id;
      if (params.onMediaReady && imageUrl) {
        try {
          params.onMediaReady({
            modality: "image",
            url: imageUrl,
            mediaId: imageMediaId,
          });
        } catch (cbErr) {
          console.warn("[CyberSoulClient] onMediaReady(image) threw:", cbErr);
        }
      }
    } catch (e) {
      if (
        e instanceof CyberSoulInsufficientPointsError ||
        e instanceof CyberSoulWalletError ||
        e instanceof CyberSoulSensitiveContentError
      ) {
        mediaError = e;
        affected.push("image");
      } else {
        console.error(
          "[CyberSoulClient] Proactive Image generation failed:",
          e,
        );
      }
    }

    return { imageUrl, imageMediaId, mediaError, affected };
  }

  /* ============================================================ */
  /* Private — memory helpers                                    */
  /* ============================================================ */

  /**
   * Run the consolidation LLM call and parse + validate the structured
   * memory payload. Throws on parse failure or on an incomplete payload
   * (missing `coreMemory`, `coreMemory.relationshipStatus`, or
   * `userCodex`) so the outer handler surfaces the error instead of
   * silently writing a corrupt memory snapshot.
   */
  private async dispatchConsolidationLLM(
    promptMessages: Array<{ role: string; content: string }>,
  ): Promise<{ coreMemory: CoreMemory; userCodex: UserCodex }> {
    const responseText = await this.llm.generate(promptMessages, 1500, 0.4);

    let parsedPayload: { coreMemory: CoreMemory; userCodex: UserCodex };
    try {
      parsedPayload = robustJsonParse<{
        coreMemory: CoreMemory;
        userCodex: UserCodex;
      }>(responseText, "parsing memory and codex consolidation");
    } catch (e) {
      throw new Error("LLM failed to return valid JSON payload");
    }

    if (
      !parsedPayload ||
      !parsedPayload.coreMemory ||
      !parsedPayload.coreMemory.relationshipStatus ||
      !parsedPayload.userCodex
    ) {
      throw new Error("LLM returned incomplete structured memory payload");
    }

    return parsedPayload;
  }

  /* ============================================================ */
  /* Public — chat orchestration                                  */
  /* ============================================================ */

  public async interact(params: InteractParams): Promise<InteractResponse> {
    try {
      const ctx = await this.prepareInteractContext(params);
      const promptMessages = this.buildInteractPromptMessages(ctx, params);
      const parsedIntent = await this.dispatchInteractWithRetry(promptMessages);

      // Reactive skip: when the caller opted in (allowSkip) and the
      // character chose not to reply, short-circuit BEFORE any media /
      // state work. Mirrors proactive's skip path. Frontends treat this
      // as a no-op — the user's message stays, no assistant bubble is
      // rendered, no temperature / scene mutation is persisted.
      if (params.allowSkip && parsedIntent.shouldSkipInteract) {
        return {
          status: "skipped",
          reason:
            parsedIntent.skipReason ||
            "Character chose not to reply to this message.",
          textResponse: "",
        };
      }

      this.assertInteractIntentActionable(parsedIntent);

      const persistedStatePromise = this.startInteractStateUpdate(
        parsedIntent,
        params.onStateReady,
      );

      const resolvedTextResponse = this.resolveInteractText(
        parsedIntent,
        params.userMessage,
      );
      const willGenerateVoice =
        ctx.types.includes(InteractRequestType.VOICE) &&
        (!ctx.isAuto || !!parsedIntent.voiceArgs);

      this.emitInteractTextReady(
        params,
        parsedIntent,
        resolvedTextResponse,
        willGenerateVoice,
      );

      const media = await this.runInteractMediaTasks(
        ctx,
        parsedIntent,
        params,
        resolvedTextResponse,
      );

      const persistedDynamicContext =
        (await persistedStatePromise) ?? undefined;

      const mediaError = media.firstMediaError
        ? buildMediaError(media.firstMediaError, media.affected)
        : undefined;

      return {
        status: "success",
        textResponse: resolvedTextResponse || "...",
        actionText: parsedIntent.actionText || "",
        imageUrl: media.imageUrl,
        imageMediaId: media.imageMediaId,
        audioUrl: media.audioUrl,
        audioMediaId: media.audioMediaId,
        likePreviousPicture: parsedIntent.likePreviousPicture,
        durationSec: media.durationSec,
        triggeredEvent: parsedIntent.triggerEvent || undefined,
        stateUpdate: parsedIntent.stateUpdate,
        userAnalysis: parsedIntent.userAnalysis,
        isEndTurn: parsedIntent.isEndTurn,
        persistedDynamicContext,
        mediaError,
        giftedOutfit: media.giftedOutfit,
      };
    } catch (error: any) {
      // Typed SDK errors (insufficient points, wallet failure, auth, etc.)
      // are part of the public contract — let callers branch on
      // `instanceof` instead of string-sniffing a generic status:"error"
      // envelope. Only truly-unexpected throws fall back to the legacy
      // envelope so we don't break callers that don't yet handle throws.
      if (error instanceof CyberSoulError) {
        throw error;
      }
      console.error("[CyberSoulClient] Interface Error: ", error);
      return {
        status: "error",
        textResponse: "System Error...",
        error: error.message,
      };
    }
  }

  /**
   * Evaluates and triggers an on-demand event, intelligently deciding if
   * an outfit change is needed. Asks the character (via LLM) whether to
   * accept the proposal; if accepted, schedules it on the backend.
   */
  public async ondemandEvent(
    params: OndemandEventParams,
  ): Promise<OndemandEventResponse> {
    try {
      // 1. Fetch current state and wardrobe items
      const [state, availableOutfits] = await Promise.all([
        this.fetchRemoteState(),
        this.getWardrobePromptStr(),
      ]);

      const promptMessages = buildOndemandEventPromptMessages({
        state,
        availableOutfits,
        eventDescription: params.eventDescription,
        interactParams: params.interactParams,
      });

      const decisionData = await this.dispatchOndemandDecision(
        promptMessages,
      );

      if (decisionData.acceptEvent === true) {
        await this.api.triggerOndemandEvent({
          eventTitle: decisionData.eventTitle,
          eventDescription: decisionData.eventDescription,
          durationMins:
            decisionData.durationMins || params.durationMins || 60,
          outfitId: decisionData.outfitId || undefined,
          scheduledStartTimeStr:
            decisionData.scheduledStartTimeStr || undefined,
          scheduledDateStr: decisionData.scheduledDateStr || undefined,
        });
      }

      return {
        status: "success",
        acceptEvent: decisionData.acceptEvent,
        reason: decisionData.reason,
        requiresOutfitChange: !!decisionData.outfitId,
        selectedOutfitId: decisionData.outfitId || null,
        scheduledStartTimeStr:
          decisionData.scheduledStartTimeStr ||
          decisionData.startTime ||
          undefined,
        scheduledDateStr: decisionData.scheduledDateStr || undefined,
      };
    } catch (error: any) {
      console.error("[CyberSoulClient] ondemandEvent Error: ", error);
      return {
        status: "error",
        error: error.message,
      };
    }
  }

  /**
   * Generates a proactive message when the user hasn't responded.
   *
   * Design:
   *  - Code owns ONE objective rule: don't spam (cap consecutive un-replied
   *    messages). Everything else is a social judgment.
   *  - The LLM owns the social judgment — given full character context
   *    (stage, temperature, traits, ongoing scene, time since last
   *    interaction, recent history), it answers a single question:
   *    "Would I, as this person right now, actually reach out?"
   *    Skip is the default; speaking is the exception.
   */
  public async proactiveInteract(
    params: ProactiveParams,
  ): Promise<ProactiveResponse> {
    try {
      // 1. Spam guard — the only hard-coded gate.
      const consecutiveProactive = countConsecutiveProactiveTurns(
        params.history || [],
      );
      const maxUnreplied = params.maxUnreplied ?? 2;
      if (consecutiveProactive >= maxUnreplied) {
        return {
          status: "skipped",
          reason: `Spam guard: ${consecutiveProactive} consecutive un-replied turns already sent.`,
        };
      }

      // 2. Fetch state + wardrobe; compute modality gates.
      const ctx = await this.prepareProactiveContext(params);

      // 3. Build the LLM prompt.
      const promptMessages = this.buildProactivePromptMessages(ctx, params);

      // 4. LLM decides. Lower temperature than `interact` because this
      //    is a judgment call, not creative reply.
      const decision = await this.dispatchProactiveDecision(promptMessages);
      if (decision.kind === "skip") {
        return { status: "skipped", reason: decision.reason };
      }
      const parsedIntent = decision.intent;

      // 5. Persist state in parallel with side effects; wire callbacks.
      const persistedStatePromise = this.startProactiveStateUpdate(
        parsedIntent,
        params.onStateReady,
      );

      if (params.onTextReady) {
        params.onTextReady(
          parsedIntent.textResponse!,
          parsedIntent.actionText,
          { stateUpdate: parsedIntent.stateUpdate },
        );
      }

      // 6. Side effects: outfit acquisition + optional image. Failures
      //    are captured (not thrown) so a partial hiccup never aborts
      //    the proactive turn.
      const giftOutfitPromise = this.processGiftOutfit(
        parsedIntent.giftOutfit,
        params.onOutfitGifted,
      );
      const imageResult = await this.runProactiveImageTask(
        parsedIntent,
        params,
      );

      const persistedDynamicContext =
        (await persistedStatePromise) ?? undefined;
      const giftedOutfit = (await giftOutfitPromise) ?? undefined;
      const mediaError = imageResult.mediaError
        ? buildMediaError(imageResult.mediaError, imageResult.affected)
        : undefined;

      return {
        status: "success",
        textResponse: parsedIntent.textResponse!,
        actionText: parsedIntent.actionText,
        imageUrl: imageResult.imageUrl,
        imageMediaId: imageResult.imageMediaId,
        stateUpdate: parsedIntent.stateUpdate,
        persistedDynamicContext,
        mediaError,
        giftedOutfit,
      };
    } catch (error: any) {
      // Mirror `interact()`: preserve typed SDK errors for the caller.
      if (error instanceof CyberSoulError) {
        throw error;
      }
      console.error("[CyberSoulClient] Proactive Interact Error: ", error);
      return { status: "error", error: error.message };
    }
  }

  /* ============================================================ */
  /* Public — standalone media generation                         */
  /* ============================================================ */

  /**
   * Manually generate an image of the character outside of chat flow.
   *
   * Casts the LLM as an image-director that derives the generation
   * parameters from the scene description + character state, then
   * dispatches the actual generation through the backend primitive.
   * On parse failure the raw scene description is used as a
   * full-prompt fallback so the call still produces an image.
   */
  public async generateImage(params: {
    sceneDescription: string;
    interactParams?: InteractParams;
  }): Promise<{ imageUrl: string; imageMediaId?: string }> {
    const state = await this.fetchRemoteState();
    const transcript = buildHistoryTranscript(
      params.interactParams?.history,
      state,
    );
    const promptMessages = buildStandaloneImagePromptMessages({
      state,
      sceneDescription: params.sceneDescription,
      transcript,
    });

    const llmRes = await this.llm.generate(promptMessages, 800, 0.4);
    const imageParams = parseImageDirectorArgs(llmRes, params.sceneDescription);
    const res = await this.api.generatePrimitive("image", imageParams);

    return {
      imageUrl: res.image_url,
      imageMediaId: res.id,
    };
  }

  /**
   * Manually synthesize voice audio outside of chat flow.
   *
   * Casts the LLM as a voice-director that derives the dynamic TTS
   * parameters from the line text + character state, then dispatches
   * the actual synthesis through the backend primitive. On parse
   * failure the dynamic args default to empty — the backend applies
   * its own provider defaults in that case.
   */
  public async generateVoice(params: {
    text: string;
    interactParams?: InteractParams;
  }): Promise<{
    audioUrl: string;
    audioMediaId?: string;
    durationSec?: number;
  }> {
    const state = await this.fetchRemoteState();
    const transcript = buildHistoryTranscript(
      params.interactParams?.history,
      state,
    );
    const promptMessages = buildStandaloneVoicePromptMessages({
      state,
      text: params.text,
      transcript,
    });

    const llmRes = await this.llm.generate(promptMessages, 800, 0.3);
    const dynamicArgs = parseVoiceDirectorArgs(llmRes);
    const res = await this.api.generatePrimitive("voice", {
      text: sanitizeTextForVoice(params.text) || "...",
      dynamicArgs,
    });

    return {
      audioUrl: res.audio_url,
      audioMediaId: res.id,
      durationSec: res.duration_sec,
    };
  }

  /* ============================================================ */
  /* Public — state & config                                      */
  /* ============================================================ */

  /**
   * Fetches the current dynamic context and daily state.
   */
  public async getState(): Promise<CharacterState> {
    return this.fetchRemoteState();
  }

  /**
   * List the public LLM models the backend currently supports, including the
   * `customConfigDefinition` schema for each model's `customSettings`.
   *
   * Use this to discover valid `provider` / `model` strings and the keys
   * each model accepts via `llmConfig.customSettings`.
   */
  public async listSupportedLLMs(): Promise<SupportedLLMModel[]> {
    return this.api.listLLMModels();
  }

  /**
   * Updates the character's relationship temperature or mood.
   * Returns the server-authoritative post-write `{ temperature, relationshipStage }`
   * snapshot (or `null` if there was nothing to send / the request failed).
   */
  public async updateDynamicContext(
    stateUpdate: DispatcherIntent["stateUpdate"],
    userAnalysis?: DispatcherIntent["userAnalysis"],
  ): Promise<PersistedDynamicContext | null> {
    return this._updateDynamicContextInternal(stateUpdate, userAnalysis);
  }

  /**
   * Restores the server-side relationship temperature to an exact absolute
   * value. Used by chat recall, where inverse deltas are not accurate once the
   * backend has applied dampening, caps, and stage re-evaluation.
   */
  public async restoreDynamicContextTemperature(
    temperatureAbsolute: number,
  ): Promise<PersistedDynamicContext | null> {
    return this.api.restoreDynamicContextTemperature(temperatureAbsolute);
  }

  /**
   * Gift a new outfit to the character's wardrobe inventory.
   * Returns the number of wardrobe items the backend created (the
   * backend may expand a single description into multiple items), or
   * `undefined` when the server did not report a count.
   */
  public async giftOutfit(
    descriptionText: string,
  ): Promise<number | undefined> {
    return this.api.giftOutfit(descriptionText);
  }

  /**
   * Bootstrap character profile from OpenClaw workspace files.
   */
  public async bootstrapCharacter(
    workspaceFiles: Record<string, string>,
  ): Promise<void> {
    await this.api.bootstrapCharacter(workspaceFiles);
  }

  /**
   * Instructs the backend to generate the daily script/plan for the character.
   * Can be triggered by local Cron systems like OpenClaw.
   */
  public async generateDailyScript(): Promise<void> {
    await this.api.generateDailyScript();
  }

  /* ============================================================ */
  /* Public — memory pipeline                                     */
  /* ============================================================ */

  /**
   * Automatically detect and summarize the story from the current chat history.
   * It takes raw message history and returns a narrative paragraph representing the current story segment.
   *
   * The summary is ALWAYS written from the CHARACTER's first-person perspective
   * ("I", "me", "my") about their interaction with the HUMAN USER. The prompt
   * injects the same identity/relationship context `interact()` uses so the
   * LLM cannot confuse which party is the AI character vs. the human user.
   */
  public async summarizeHistory(history: HistoryEntry[]): Promise<string> {
    if (!history || history.length === 0) return "";

    try {
      const state = await this.getState();
      const identity = deriveSummarizerIdentity(state);
      const contextBlock = buildSummarizerContextBlock(state);
      const transcript = formatHistoryEntries(
        history,
        identity.transcriptUserLabel,
        identity.transcriptAgentLabel,
      );
      const promptMessages = buildSummarizerPromptMessages(
        identity,
        contextBlock,
        transcript,
      );

      const result = await this.llm.generate(promptMessages, 8000, 0.7);
      return result.trim();
    } catch (e) {
      console.error("[CyberSoulClient] Summarize History Error:", e);
      return "The two spent some time talking with each other.";
    }
  }

  /**
   * Save the recent story moment to the character's backend database to be picked up by the core memory consolidation.
   */
  public async saveMoment(
    summary: string,
    date: string,
    time: string,
    likedPictures?: LikedPicture[],
  ): Promise<void> {
    await this.api.saveMoment({ summary, date, time, likedPictures });
  }

  /**
   * Consolidate Core Memory and User Codex using edge LLM logic and sync to remote DB
   */
  public async consolidateCoreMemory(input: { events: string }): Promise<{
    status: string;
    coreMemory?: CoreMemory;
    userCodex?: UserCodex;
    error?: string;
  }> {
    try {
      const state = await this.getState();
      const currentMemory = getDefaultCoreMemory(state.core_memory);
      const currentUserCodex = getDefaultUserCodex(state.user_codex);

      const currentTime = state.current_time
        ? new Date(state.current_time).toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
          })
        : new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

      const promptMessages = buildConsolidationPromptMessages({
        currentTime,
        currentMemory,
        currentUserCodex,
        events: input.events,
      });

      const parsedPayload = await this.dispatchConsolidationLLM(promptMessages);
      await this.api.updateCoreMemory(parsedPayload);

      return {
        status: "success",
        coreMemory: parsedPayload.coreMemory,
        userCodex: parsedPayload.userCodex,
      };
    } catch (error: any) {
      console.error("[CyberSoulClient] consolidateCoreMemory Error:", error);
      return { status: "error", error: error.message };
    }
  }
}
