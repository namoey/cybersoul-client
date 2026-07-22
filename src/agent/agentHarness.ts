/**
 * AgentHarness — the degenerate single-shot loop body for Phase 1.
 *
 * Phase 1 target (see
 * `cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md`
 * §3.2). Encapsulates the generic mechanics that today are inlined in
 * `client.ts`'s `interact()` / `proactiveInteract()`:
 *
 *   1. dispatcher LLM call with bounded retry on non-actionable output
 *   2. parallel side-effect dispatch (state PATCH + media + event + gift)
 *   3. event emission via EventStream (text-ready / state-ready /
 *      media-ready / outfit-gifted) with EXACTLY the same timing and
 *      args the legacy code used
 *
 * What stays in `client.ts`:
 *   - prompt assembly (builds the {system,user} message pair per flow)
 *   - per-flow gating (skip checks, allowSkip, assert-actionable,
 *     proactive spam guard)
 *   - response-shape assembly (InteractResponse / ProactiveResponse)
 *
 * This split keeps the public response types in `client.ts` (where
 * callers expect them) while pulling the loop mechanics out into a
 * unit-testable seam. Phase 2 swaps the dispatcher for native tool-
 * calling without touching client.ts's response shaping.
 *
 * CRITICAL — Phase 1 zero-diff guarantee (§5.3):
 *   - The harness's `runInteractDispatch` reproduces
 *     `dispatchInteractWithRetry` byte-for-byte: same 3-attempt cap,
 *     same "hasUsableText || hasMediaIntent || hasSkipIntent" break
 *     condition, same fallback to raw text on parse error, same warn
 *     log format.
 *   - `runInteractSideEffects` reproduces `runInteractMediaTasks` byte-
 *     for-byte: same task list ordering (triggerEvent, giftOutfit,
 *     image, voice), same per-task `.catch` semantics, same
 *     `firstMediaError` / `affected` capture, same Promise.all.
 *   - The `state-ready` event fires via the legacy
 *     `startInteractStateUpdate` pattern: `onStateReady` is wired to
 *     the in-flight PATCH promise with the "fire `{}` even on failure"
 *     behavior from §5.4 item 2.
 */

import type {
  BaseLLMProvider,
  DispatcherIntent,
  InteractParams,
  OutfitGiftedPayload,
  PersistedDynamicContext,
  ProactiveParams,
} from "../types.js";
import { InteractRequestType, supportsToolCalling } from "../types.js";
import type { ToolContext, ToolFailure } from "./types.js";
import type { EventStream } from "./eventStream.js";
import {
  buildGenerateImageTool,
  buildGenerateVoiceTool,
  buildGiftOutfitTool,
  buildTriggerEventTool,
  buildUpdateStateTool,
  toolCallsToIntent,
} from "../tools/index.js";
import type {
  GenerateImageResult,
  GenerateVoiceResult,
  GiftOutfitResult,
  TriggerEventResult,
  UpdateStateResult,
} from "../tools/index.js";
import { robustJsonParse } from "../utils/json.utils.js";
import { sanitizeTextForVoice } from "../utils/voice.utils.js";
import {
  CyberSoulError,
  CyberSoulInsufficientPointsError,
  CyberSoulSensitiveContentError,
  CyberSoulWalletError,
} from "../errors.js";

/** Bounded retry cap for the dispatcher (§5.4 item 9 — must stay 3). */
const MAX_DISPATCH_ATTEMPTS = 3;

/**
 * Result of the dispatcher phase. Mirrors what
 * `dispatchInteractWithRetry` returned.
 */
export interface DispatchResult {
  parsedIntent: DispatcherIntent;
}

/**
 * Result of the side-effect phase. Mirrors what
 * `runInteractMediaTasks` returned (with the `triggered` field added
 * — the legacy code dropped the trigger-event success on the floor;
 * we preserve that by leaving it unused in client.ts, but tracking it
 * here makes Phase 2 observability trivial).
 */
export interface InteractSideEffectResult {
  imageUrl?: string;
  imageMediaId?: string;
  audioUrl?: string;
  audioMediaId?: string;
  durationSec?: number;
  giftedOutfit?: OutfitGiftedPayload;
  triggeredEvent?: NonNullable<DispatcherIntent["triggerEvent"]>;
  firstMediaError: CyberSoulError | null;
  affected: Array<"image" | "voice">;
}

export class AgentHarness {
  constructor(
    private readonly llm: BaseLLMProvider,
    private readonly sink: EventStream,
  ) {}

  /* ============================================================ */
  /* Phase 1 — dispatcher (single-shot JSON, with retry)          */
  /* ============================================================ */

  /**
   * Reproduce `dispatchInteractWithRetry` byte-for-byte.
   *
   * A "non-actionable" parse yields no usable `textResponse` AND no
   * media intent AND no skip intent — i.e. the LLM hiccuped. Retrying
   * the generation is far better than silently echoing the user's
   * own message back as the character's reply.
   */
  async runInteractDispatch(
    promptMessages: Array<{ role: string; content: string }>,
  ): Promise<DispatchResult> {
    let parsedIntent: DispatcherIntent = { textResponse: "" };
    for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) {
      const rawLlmResponse = await this.llm.generate(promptMessages, 15000, 0.7);

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
    return { parsedIntent };
  }

  /* ============================================================ */
  /* Phase 2 — native tool-calling dispatch path                  */
  /* ============================================================ */

  /**
   * Throw a typed `CyberSoulError` (kind `"llm-capability-mismatch"`)
   * if the configured LLM provider doesn't implement `chat()`.
   *
   * Called at the top of both tool-calling dispatch methods so a
   * capability mismatch surfaces as an actionable, typed error
   * instead of a confusing `TypeError: this.llm.chat is not a
   * function` from the non-null assertion at the call site. The
   * error is a `CyberSoulError` (not a plain `Error`) so `client.ts`'s
   * outer catch re-throws it instead of wrapping it in the legacy
   * `{ status: "error" }` envelope — callers can branch on
   * `instanceof CyberSoulError` + `err.kind`.
   *
   * The error message is intentionally prescriptive — it tells the
   * operator exactly which knob to turn (unset
   * `capabilities.toolCalling` to fall back to the JSON-dispatcher).
   * This is the Scenario-D fix from the Phase 2.1 design review.
   */
  private assertToolCallingSupported(): void {
    if (!supportsToolCalling(this.llm)) {
      throw new CyberSoulError(
        "llm-capability-mismatch",
        "Tool-calling dispatch path selected (llmConfig.capabilities.toolCalling === true) but the LLM provider does not implement chat(). Either implement chat() on the provider, or unset capabilities.toolCalling to fall back to the JSON-dispatcher path.",
      );
    }
  }

  /**
   * Phase 3.1c — wrap a tool execution with `tool-call` + `tool-result`
   * events so `CyberSoulAgent` consumers see each side-effect fire on
   * the AsyncIterable surface. The events are emitted BEFORE the
   * executor starts and AFTER it settles, regardless of success or
   * failure — consumers always see the closing `tool-result`.
   *
   * Result shape:
   *   - Success → `{ type: "tool-result", tool, result: <TResult> }`
   *   - Failure → `{ type: "tool-result", tool, result: { __error: ... } }`
   *
   * The error is re-thrown after emission so the harness's existing
   * typed-error-capture logic (`captureMediaError` etc.) still runs.
   * Events are an OBSERVATION channel — they do not change the
   * control flow of the side-effect layer.
   *
   * For backward compatibility with `client.ts` callers using the
   * legacy EventStream, the EventStream treats `tool-call` /
   * `tool-result` as no-op (no legacy callback to fan out to) — only
   * `CyberSoulAgent` consumers actually see them via the
   * AsyncEventQueue.
   */
  private async withToolEvents<T>(
    toolName: string,
    args: Record<string, unknown>,
    exec: () => Promise<T>,
  ): Promise<T> {
    this.sink.emit({ type: "tool-call", tool: toolName, args });
    try {
      const result = await exec();
      this.sink.emit({ type: "tool-result", tool: toolName, result });
      return result;
    } catch (e) {
      this.sink.emit({
        type: "tool-result",
        tool: toolName,
        result: {
          __error: e instanceof Error ? e.message : String(e),
          __kind: e instanceof CyberSoulError ? e.kind : undefined,
        },
      });
      throw e;
    }
  }

  /**
   * Phase 2 native tool-calling dispatcher (see
   * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
   * §3.3.1 + §4 Phase 2). Replaces the JSON-schema-in-prompt +
   * robustJsonParse + retry loop with a single `provider.chat()` call
   * that passes the tool declarations natively.
   *
   * Why no retry loop? With constrained decoding (§3.3.1), the
   * provider guarantees the returned `tool_calls[i].arguments` is
   * valid JSON conforming to the declared schema. The malformed-JSON
   * failure class that `dispatchInteractWithRetry` exists to handle
   * is structurally impossible here.
   *
   * Returns the SAME `DispatchResult` shape as `runInteractDispatch`
   * — `toolCallsToIntent` folds the structured tool calls into a
   * `DispatcherIntent`, so every downstream consumer
   * (`runInteractSideEffects`, `startInteractStateUpdate`,
   * `client.ts` response assembly) is byte-for-byte identical between
   * the two paths. This is what makes the Phase 2 swap a single
   * routing decision in client.ts.
   *
   * Capability contract: this method checks `supportsToolCalling(
   * this.llm)` at the top and throws a typed `CyberSoulError` (kind
   * `"llm-capability-mismatch"`) with actionable guidance if the
   * provider doesn't implement `chat()`. The harness deliberately
   * does NOT silently degrade to the JSON-dispatcher here — that
   * would hide a misconfiguration where the caller opted into
   * tool-calling (`capabilities.toolCalling === true`) but is using
   * a provider that doesn't support it.
   *
   * @param promptMessages Same {system, user} pair as
   *   `runInteractDispatch`. NOTE: the system prompt passed here
   *   SHOULD NOT embed the JSON schema — the prompt-builder variant
   *   for the tool-calling path is a separate concern (Phase 1.5 /
   *   Phase 2 follow-up). For Phase 2 as shipped, the same prompt is
   *   used and the model receives both the embedded schema AND the
   *   native tool declarations; the native declarations win because
   *   the provider's constrained-decoding mask takes priority over
   *   prose instructions. This is acceptable for the shadow-mode
   *   rollout (§5.5) and a follow-up cleans up the prompt.
   * @param toolDeclarations The `LLMToolDeclaration[]` built from the
   *   ToolRegistry.
   */
  async runInteractDispatchWithTools(
    promptMessages: Array<{ role: string; content: string }>,
    toolDeclarations: import("../types.js").LLMToolDeclaration[],
  ): Promise<DispatchResult> {
    this.assertToolCallingSupported();
    const result = await this.llm.chat!({
      messages: promptMessages,
      tools: toolDeclarations,
      maxTokens: 15000,
      temperature: 0.7,
    });

    // Fold the structured tool calls into the same DispatcherIntent
    // shape the JSON-dispatcher path produces. Downstream is identical.
    const parsedIntent = toolCallsToIntent(result.toolCalls);

    // The model may emit text alongside tool calls (or as a pure-text
    // reply with no tool calls). Preserve either.
    if (
      typeof result.textResponse === "string" &&
      result.textResponse.trim().length > 0
    ) {
      parsedIntent.textResponse = result.textResponse;
    }

    return { parsedIntent };
  }

  /**
   * Phase 2 native tool-calling proactive dispatcher. Mirrors
   * `runProactiveDispatch`'s return shape so the proactive gating in
   * client.ts stays untouched.
   *
   * Same capability contract as `runInteractDispatchWithTools`:
   * throws `CyberSoulError` (kind `"llm-capability-mismatch"`) if the
   * provider doesn't implement `chat()`.
   */
  async runProactiveDispatchWithTools(
    promptMessages: Array<{ role: string; content: string }>,
    toolDeclarations: import("../types.js").LLMToolDeclaration[],
  ): Promise<
    | { kind: "skip"; reason: string }
    | { kind: "proceed"; intent: DispatcherIntent }
  > {
    this.assertToolCallingSupported();
    const result = await this.llm.chat!({
      messages: promptMessages,
      tools: toolDeclarations,
      maxTokens: 800,
      temperature: 0.5,
    });

    const parsedIntent = toolCallsToIntent(result.toolCalls);
    if (
      typeof result.textResponse === "string" &&
      result.textResponse.trim().length > 0
    ) {
      parsedIntent.textResponse = result.textResponse;
    }

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
   * Reproduce the proactive dispatcher (`dispatchProactiveDecision`)
   * byte-for-byte. Lower maxTokens (800) + temperature (0.5) than
   * interact — this is a judgment call, not creative reply.
   *
   * Returns the same discriminated union the legacy code returned so
   * the proactive gating in client.ts stays untouched.
   */
  async runProactiveDispatch(
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

  /* ============================================================ */
  /* Phase 1 — side-effect orchestration                          */
  /* ============================================================ */

  /**
   * Reproduce `startInteractStateUpdate` byte-for-byte.
   *
   * Kicks off the dynamic-context PATCH in parallel with everything
   * else. Returns the in-flight promise (awaited at the end of the
   * turn to surface the server-authoritative snapshot). Also wires
   * `state-ready` via EventStream so the UI updates temperature/stage
   * the moment the PATCH resolves — independent of (potentially slow)
   * image generation. The "fire `{}` even when the PATCH fails or
   * there's nothing to send" behavior from §5.4 item 2 is preserved.
   */
  startInteractStateUpdate(
    parsedIntent: DispatcherIntent,
    toolCtx: ToolContext,
  ): Promise<PersistedDynamicContext | null> {
    let persistedStatePromise: Promise<PersistedDynamicContext | null> =
      Promise.resolve(null);

    if (parsedIntent.stateUpdate || parsedIntent.userAnalysis) {
      const updateState = buildUpdateStateTool().execute(
        {
          stateUpdate: parsedIntent.stateUpdate,
          userAnalysis: parsedIntent.userAnalysis,
        },
        toolCtx,
      );
      // unwrap the tool's { persisted } envelope so the returned promise
      // has the same type as the legacy startInteractStateUpdate.
      persistedStatePromise = updateState.then((r: UpdateStateResult) => r.persisted);
    }

    // Wire onStateReady with the legacy "fire {} on failure / no-op" pattern.
    persistedStatePromise
      .then((persisted) => {
        this.sink.emit({
          type: "state-ready",
          persisted: persisted ?? {},
        });
      })
      .catch(() => {
        this.sink.emit({ type: "state-ready", persisted: {} });
      });

    return persistedStatePromise;
  }

  /**
   * Reproduce `startProactiveStateUpdate` byte-for-byte. Mirrors the
   * interact path but only fires on `stateUpdate` (proactive turns
   * never emit `userAnalysis`).
   */
  startProactiveStateUpdate(
    parsedIntent: DispatcherIntent,
    toolCtx: ToolContext,
  ): Promise<PersistedDynamicContext | null> {
    let persistedStatePromise: Promise<PersistedDynamicContext | null> =
      Promise.resolve(null);

    if (parsedIntent.stateUpdate) {
      const updateState = buildUpdateStateTool().execute(
        { stateUpdate: parsedIntent.stateUpdate },
        toolCtx,
      );
      persistedStatePromise = updateState.then((r: UpdateStateResult) => r.persisted);
    }

    persistedStatePromise
      .then((persisted) => {
        this.sink.emit({
          type: "state-ready",
          persisted: persisted ?? {},
        });
      })
      .catch(() => {
        this.sink.emit({ type: "state-ready", persisted: {} });
      });

    return persistedStatePromise;
  }

  /**
   * Reproduce `runInteractMediaTasks` byte-for-byte.
   *
   * Dispatches the four side-effect branches (triggerEvent, giftOutfit,
   * image, voice) in parallel via Promise.all, capturing typed media
   * failures into `firstMediaError` / `affected` and swallowing
   * everything else. Each successful branch emits its
   * media-ready / outfit-gifted event via the EventStream with the
   * same args the legacy code passed to the callbacks.
   *
   * The harness decides which branches to dispatch by mirroring the
   * legacy gating:
   *   - triggerEvent: dispatched iff parsedIntent.triggerEvent is set.
   *   - giftOutfit:   dispatched iff the LLM emitted a valid
   *                    giftOutfit.descriptionText.
   *   - image:        dispatched iff `types.includes(IMAGE)` AND
   *                    (`!isAuto` OR parsedIntent.imageParams is set).
   *   - voice:        dispatched iff `types.includes(VOICE)` AND
   *                    (`!isAuto` OR parsedIntent.voiceArgs is set),
   *                    using the resolved text response (sanitized +
   *                    "..." fallback inside the tool).
   */
  async runInteractSideEffects(
    ctx: { types: InteractRequestType[]; isAuto: boolean },
    parsedIntent: DispatcherIntent,
    params: InteractParams,
    resolvedTextResponse: string,
    toolCtx: ToolContext,
  ): Promise<InteractSideEffectResult> {
    let imageUrl: string | undefined = undefined;
    let imageMediaId: string | undefined = undefined;
    let audioUrl: string | undefined = undefined;
    let audioMediaId: string | undefined = undefined;
    let durationSec: number | undefined = undefined;
    let giftedOutfit: OutfitGiftedPayload | undefined = undefined;
    let triggeredEvent: NonNullable<DispatcherIntent["triggerEvent"]> | undefined;

    const affected: Array<"image" | "voice"> = [];
    let firstMediaError: CyberSoulError | null = null;
    const captureMediaError = (
      modality: "image" | "voice",
      failure: ToolFailure | undefined,
    ): void => {
      if (!failure) return;
      const e = failure.error;
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

    const tasks: Promise<unknown>[] = [];

    // [1] triggerEvent — same catch-and-swallow as the legacy code.
    if (parsedIntent.triggerEvent) {
      const triggerEvent = buildTriggerEventTool();
      tasks.push(
        this.withToolEvents("trigger_event", parsedIntent.triggerEvent as Record<string, unknown>, () =>
          triggerEvent.execute(parsedIntent.triggerEvent!, toolCtx),
        )
          .then((r: TriggerEventResult) => {
            if (r.triggered) triggeredEvent = r.triggered;
          }),
      );
    }

    // [2] giftOutfit — same validation + capture as the legacy code.
    if (
      parsedIntent.giftOutfit &&
      typeof parsedIntent.giftOutfit === "object" &&
      typeof parsedIntent.giftOutfit.descriptionText === "string" &&
      parsedIntent.giftOutfit.descriptionText.trim().length > 0
    ) {
      const giftOutfit = buildGiftOutfitTool(this.sink);
      const giftArgs = { descriptionText: parsedIntent.giftOutfit.descriptionText };
      tasks.push(
        this.withToolEvents("gift_outfit", giftArgs, () =>
          giftOutfit.execute(giftArgs, toolCtx),
        )
          .then((r: GiftOutfitResult) => {
            if (r.giftedOutfit) giftedOutfit = r.giftedOutfit;
          }),
      );
    }

    // [3] image — mirrors the legacy shouldGenerateImage gate.
    const shouldGenerateImage =
      ctx.types.includes(InteractRequestType.IMAGE) &&
      (!ctx.isAuto || !!parsedIntent.imageParams);
    if (shouldGenerateImage) {
      const imagePayload =
        parsedIntent.imageParams && typeof parsedIntent.imageParams === "object"
          ? parsedIntent.imageParams
          : { mode: "full-prompt", full_prompt: resolvedTextResponse };
      const imageArgs = imagePayload as Record<string, unknown>;

      const generateImage = buildGenerateImageTool(this.sink);
      tasks.push(
        this.withToolEvents("generate_image", imageArgs, () =>
          generateImage.execute(imageArgs, toolCtx),
        )
          .then((r: GenerateImageResult) => {
            imageUrl = r.imageUrl;
            imageMediaId = r.imageMediaId;
            captureMediaError("image", r.failure);
          }),
      );
    }

    // [4] voice — mirrors the legacy shouldGenerateVoice gate. The tool
    //     does its own sanitization + "..." fallback; we pass the
    //     resolved text and the LLM-supplied dynamic args.
    const shouldGenerateVoice =
      ctx.types.includes(InteractRequestType.VOICE) &&
      (!ctx.isAuto || !!parsedIntent.voiceArgs);
    if (shouldGenerateVoice) {
      const normalizedVoiceArgs =
        parsedIntent.voiceArgs && typeof parsedIntent.voiceArgs === "object"
          ? (parsedIntent.voiceArgs as Record<string, unknown>)
          : {};
      const voiceArgs = {
        textForVoice: resolvedTextResponse,
        dynamicArgs: normalizedVoiceArgs,
      };

      const generateVoice = buildGenerateVoiceTool(this.sink);
      tasks.push(
        this.withToolEvents("generate_voice", voiceArgs as unknown as Record<string, unknown>, () =>
          generateVoice.execute(voiceArgs, toolCtx),
        )
          .then((r: GenerateVoiceResult) => {
            audioUrl = r.audioUrl;
            audioMediaId = r.audioMediaId;
            durationSec = r.durationSec;
            captureMediaError("voice", r.failure);
          }),
      );
    }

    await Promise.all(tasks);

    return {
      imageUrl,
      imageMediaId,
      audioUrl,
      audioMediaId,
      durationSec,
      giftedOutfit,
      triggeredEvent,
      firstMediaError,
      affected,
    };
  }

  /**
   * Reproduce the proactive image task (`runProactiveImageTask`)
   * byte-for-byte. Single image branch only (voice is forced off for
   * proactive turns). Returns the typed media failure for in-band
   * surfacing.
   */
  async runProactiveImageTask(
    parsedIntent: DispatcherIntent,
    toolCtx: ToolContext,
  ): Promise<{
    imageUrl?: string;
    imageMediaId?: string;
    mediaError: CyberSoulError | null;
    affected: Array<"image" | "voice">;
  }> {
    const affected: Array<"image" | "voice"> = [];
    if (!parsedIntent.imageParams) {
      return {
        imageUrl: undefined,
        imageMediaId: undefined,
        mediaError: null,
        affected,
      };
    }

    const generateImage = buildGenerateImageTool(this.sink);
    const r = await generateImage.execute(
      parsedIntent.imageParams as Record<string, unknown>,
      toolCtx,
    );

    let mediaError: CyberSoulError | null = null;
    if (r.failure) {
      const e = r.failure.error;
      if (
        e instanceof CyberSoulInsufficientPointsError ||
        e instanceof CyberSoulWalletError ||
        e instanceof CyberSoulSensitiveContentError
      ) {
        mediaError = e;
        affected.push("image");
      } else {
        // Legacy: non-typed errors are already logged inside the tool.
      }
    }

    return {
      imageUrl: r.imageUrl,
      imageMediaId: r.imageMediaId,
      mediaError,
      affected,
    };
  }

  /**
   * Reproduce the proactive gift-outfit path. Mirrors the legacy
   * `processGiftOutfit` invocation (returns the payload or undefined
   * on failure / nothing-to-gift; outfit-gifted event fires from
   * inside the tool).
   */
  async runProactiveGiftOutfit(
    parsedIntent: DispatcherIntent,
    toolCtx: ToolContext,
  ): Promise<OutfitGiftedPayload | undefined> {
    const giftOutfit = buildGiftOutfitTool(this.sink);
    const r = await giftOutfit.execute(
      { descriptionText: parsedIntent.giftOutfit?.descriptionText ?? "" },
      toolCtx,
    );
    return r.giftedOutfit;
  }
}

/**
 * Convenience: legacy `sanitizeTextForVoice` is re-exported so client.ts
 * can drop the voice.utils import (it was only used in two places,
 * both now inside the harness/tools layer).
 */
export { sanitizeTextForVoice };
