import {
  CyberSoulClientConfig,
  HistoryCompactionConfig,
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
  HistoryEntry,
  LikedPicture,
  PersistedDynamicContext,
  SupportedLLMModel,
} from "./types.js";
import { supportsStreaming, supportsToolCalling } from "./types.js";
import { robustJsonParse } from "./utils/json.utils.js";
import { GenericLLMProvider } from "./llm.provider.js";
import { CyberSoulError } from "./errors.js";
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
} from "./utils/state.utils.js";
import { buildMediaError } from "./utils/error.utils.js";
import { parseImageDirectorArgs } from "./utils/image.utils.js";
import { CyberSoulApi } from "./api/cyberSoulApi.js";

// Phase 1 internals — see
// cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
// These are PRIVATE; not re-exported through src/contract/.
import { ContextManager } from "./agent/contextManager.js";
import { EventStream } from "./agent/eventStream.js";
import { AgentHarness, type DispatchResult } from "./agent/agentHarness.js";
import { HistoryCompactor } from "./agent/historyCompactor.js";
import type { ToolContext, Tool, AgentLoopConfig } from "./agent/types.js";
import { buildStatePatchPayload } from "./tools/stateTools.js";
import { ToolRegistry } from "./tools/toolRegistry.js";
import {
  buildGenerateImageTool,
  buildGenerateVoiceTool,
  buildGiftOutfitTool,
  buildTriggerEventTool,
  buildUpdateStateTool,
  speakTool,
  likePictureTool,
  endTurnTool,
  skipTurnTool,
  skipProactiveTool,
} from "./tools/index.js";

/**
 * CyberSoulClient — the public facade.
 *
 * Phase 1 of the agent-harness refactor (see
 * `cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md`).
 * The class signature and every public method signature are
 * UNCHANGED — existing consumers compile and behave identically.
 * Internally, the orchestration has been decomposed into:
 *
 *   - ContextManager (state + wardrobe cache + prepare())
 *   - EventStream    (unified sink for text/state/media/outfit events)
 *   - AgentHarness   (dispatcher retry loop + parallel side-effects)
 *   - tools/*        (one Tool per capability)
 *
 * Each public method's body now reads as a linear pipeline of
 * "prepare -> prompt -> dispatch -> side-effects -> assemble response",
 * with the loop mechanics delegated to the harness. The per-flow
 * gating that lives here (allowSkip, proactive spam guard,
 * assert-actionable, response shaping) is exactly what differs between
 * flows — and the harness is deliberately agnostic to it.
 *
 * Zero-diff contract (§5.3): the harness reproduces the legacy
 * behavior byte-for-byte. Every callback fires with the same args in
 * the same order; every error path returns the same shape.
 */
export class CyberSoulClient {
  /* ====================== Fields ====================== */

  private config: CyberSoulClientConfig;
  private llm: BaseLLMProvider;
  private api: CyberSoulApi;
  private context: ContextManager;
  /**
   * Phase 3.2 — lazily-created per-client HistoryCompactor. Built
   * once from `config.historyCompaction` (or per-turn override) so
   * the cache survives across turns within a session. `null` when
   * compaction is disabled (the default).
   */
  private historyCompactor: HistoryCompactor | null = null;
  private historyCompactorConfig: HistoryCompactionConfig | null = null;

  /**
   * Phase 5 — resolved LLM dispatch capabilities. Populated on first
   * use by `resolveCapabilities()`, reused thereafter. Merges the
   * caller's explicit `capabilities` flags with auto-detection from
   * the backend LLM template. `null` = not yet resolved.
   */
  private resolvedCapabilities: { toolCalling: boolean; streaming: boolean } | null = null;

  /**
   * Phase 5 — in-flight capability resolution promise. When set,
   * concurrent `resolveCapabilities()` calls return this same promise
   * instead of racing to fetch the template. Prevents a double-fetch
   * on the first concurrent pair of interact() calls.
   */
  private capabilitiesPromise: Promise<{ toolCalling: boolean; streaming: boolean }> | null = null;

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

    this.context = new ContextManager(this.api);

    // Phase 3.2 — eagerly build the compactor when the client-level
    // config is set, so the first turn doesn't pay the construction
    // cost. Per-turn overrides rebuild on demand (rare).
    if (config.historyCompaction) {
      this.applyHistoryCompactionConfig(config.historyCompaction);
    }
  }

  /**
   * Phase 3.2 — (re)build the HistoryCompactor for a given config.
   * Called once from the constructor for the client-level default,
   * and again when a per-turn override differs from the cached one.
   *
   * The compactor is per-client (not per-turn) so the summary cache
   * survives across turns — re-summarizing every turn would be
   * exorbitantly expensive for the llm-summary strategy.
   */
  private applyHistoryCompactionConfig(
    cfg: HistoryCompactionConfig,
  ): void {
    // Skip the rebuild if the effective config is unchanged — per-turn
    // overrides that match the client default shouldn't bust the cache.
    if (
      this.historyCompactorConfig &&
      JSON.stringify(this.historyCompactorConfig) === JSON.stringify(cfg)
    ) {
      return;
    }
    this.historyCompactor = new HistoryCompactor({
      strategy: cfg.strategy,
      maxRawEntries: cfg.maxRawEntries,
      reSummarizeThreshold: cfg.reSummarizeThreshold,
    });
    this.historyCompactorConfig = cfg;
  }

  /**
   * Phase 3.2 — resolve the effective history-compaction config for a
   * turn. Per-turn value wins over client-level. `null` per-turn
   * explicitly disables (useful for A/B). Undefined per-turn falls
   * back to client-level (which defaults to undefined → off).
   *
   * Returns `null` when compaction is OFF (the default) — callers
   * then use today's `buildHistoryTranscript` slice.
   */
  private resolveHistoryCompactionConfig(
    turnLevel: HistoryCompactionConfig | null | undefined,
  ): HistoryCompactionConfig | null {
    if (turnLevel !== undefined) return turnLevel;
    return this.config.historyCompaction ?? null;
  }

  /**
   * Phase 3.3 — resolve the effective agent-loop config for a turn.
   * Per-turn value wins over client-level; null per-turn explicitly
   * disables. Undefined per-turn falls back to client-level (which
   * defaults to undefined → no loop = single-shot dispatch).
   *
   * Returns null when the loop is OFF. The harness then uses the
   * single-shot runInteractDispatchWithTools instead.
   */
  private resolveAgentLoopConfig(
    turnLevel: AgentLoopConfig | null | undefined,
  ): AgentLoopConfig | null {
    if (turnLevel !== undefined) return turnLevel;
    return this.config.agentLoop ?? null;
  }

  /**
   * Phase 3.2 — build the chat-history transcript for a turn, using
   * the configured HistoryCompactor when compaction is enabled, or
   * falling back to today's `buildHistoryTranscript` slice when not.
   *
   * When compaction is on AND the strategy is "llm-summary", the
   * client's own `summarizeHistory` method is auto-wired as the
   * `summarizeFn` — callers never need to wire it themselves. This
   * is the Phase 3.2 deliverable that closes Phase 3.1's deferred
   * "llm-summary wired to client.summarizeHistory automatically".
   *
   * The compactor instance is per-client (cached) so the summary
   * survives across turns. Per-turn override (when different from
   * the cached config) rebuilds the compactor and resets the cache.
   */
  private async buildTranscript(
    history: HistoryEntry[] | undefined,
    state: CharacterState,
    turnLevelCompaction: HistoryCompactionConfig | null | undefined,
  ): Promise<string> {
    // No history or empty → nothing to do. buildHistoryTranscript
    // handles this too, but bail early so compaction logic never
    // sees empty input.
    if (!history || history.length === 0) return "";

    const cfg = this.resolveHistoryCompactionConfig(turnLevelCompaction);
    if (!cfg) {
      // Compaction OFF — today's verbatim slice.
      return buildHistoryTranscript(history, state);
    }

    // Compaction ON — make sure the cached compactor matches the
    // effective config (rebuild on per-turn override change).
    this.applyHistoryCompactionConfig(cfg);
    const compactor = this.historyCompactor!;

    const agentName =
      state.dynamic_context?.agentNickname || state.name || "Agent";
    const userName = state.dynamic_context?.userNickname || "User";

    // Auto-wire summarizeHistory for llm-summary strategy. For bullet
    // strategy summarizeFn is unused (the compactor ignores it).
    const summarizeFn = (entries: HistoryEntry[]) =>
      this.summarizeHistory(entries);

    const result = await compactor.compactAsync(
      history,
      userName,
      agentName,
      summarizeFn,
    );
    return result.transcript;
  }

  /* ============================================================ */
  /* Private — tool-context + event-stream assembly               */
  /* ============================================================ */

  /**
   * Build the per-turn ToolContext. Tools close over this; it carries
   * the API instance, the freshly-fetched state, and the turn params
   * (so tools can re-emit legacy callbacks via the EventStream).
   */
  private buildToolContext(
    state: CharacterState,
    params: {
      onMediaReady?: InteractParams["onMediaReady"];
      onOutfitGifted?: InteractParams["onOutfitGifted"];
    },
  ): ToolContext {
    return {
      api: this.api,
      state,
      params: {
        onMediaReady: params.onMediaReady,
        onOutfitGifted: params.onOutfitGifted,
      },
    };
  }

  /**
   * Build a fresh EventStream for one turn, pre-attached with the
   * caller's legacy callbacks. One stream per turn — never reused —
   * so concurrent interact() calls don't cross the wires.
   */
  private newSink(params: {
    onTextReady?: InteractParams["onTextReady"];
    onTextDelta?: InteractParams["onTextDelta"];
    onStateReady?: InteractParams["onStateReady"];
    onMediaReady?: InteractParams["onMediaReady"];
    onOutfitGifted?: InteractParams["onOutfitGifted"];
  }): EventStream {
    const sink = new EventStream();
    sink.attachLegacy({
      onTextReady: params.onTextReady,
      onTextDelta: params.onTextDelta,
      onStateReady: params.onStateReady,
      onMediaReady: params.onMediaReady,
      onOutfitGifted: params.onOutfitGifted,
    });
    return sink;
  }

  /**
   * Phase 5 — resolve the effective LLM dispatch capabilities by
   * merging the caller's explicit flags with auto-detection from the
   * backend LLM template.
   *
   * Resolution rules per capability (toolCalling / streaming):
   *   - Explicit `true`  → check template; if supported, use it. If
   *     the template doesn't support it, log a warning and fall back
   *     to false (the classic path). The caller asked for it but the
   *     model can't do it.
   *   - Explicit `false` → false. The caller is pinning to the
   *     classic path (A/B testing, known limitations, etc.).
   *   - Undefined       → auto-detect from the backend template.
   *     Modern models (DeepSeek, GPT-4o) with configured templates
   *     get the agent path; traditional models get the classic path.
   *
   * The result is cached on the instance so the template is only
   * fetched once per client. MUST be called (and awaited) before any
   * `shouldUseToolCalling()` / `shouldUseStreaming()` call in the
   * same turn — typically at the top of `interact()` /
   * `proactiveInteract()` / `ondemandEvent()`.
   */
  private async resolveCapabilities(): Promise<{ toolCalling: boolean; streaming: boolean }> {
    // Fast path — already resolved.
    if (this.resolvedCapabilities) return this.resolvedCapabilities;

    // Dedupe — if a resolution is already in flight, return the same
    // promise so concurrent callers don't race to fetch the template.
    if (this.capabilitiesPromise) return this.capabilitiesPromise;

    this.capabilitiesPromise = (async () => {
      // Fetch the template-derived capabilities (cached in the provider).
      // Gracefully degrades to all-false on any fetch error.
      const detected = this.llm instanceof GenericLLMProvider
        ? await this.llm.detectCapabilities()
        : { toolCalling: supportsToolCalling(this.llm), streaming: supportsStreaming(this.llm) };

      const explicitToolCalling = this.config.llmConfig.capabilities?.toolCalling;
      const explicitStreaming = this.config.llmConfig.capabilities?.streaming;

      // Merge: explicit false always wins (pin to classic). Explicit true
      // requires template support (warn + fall back if template says no).
      // Undefined → trust the template detection.
      const toolCalling =
        explicitToolCalling === false
          ? false
          : explicitToolCalling === true
            ? detected.toolCalling ||
              (console.warn(
                "[CyberSoulClient] capabilities.toolCalling=true but the backend LLM template does not support tool-calling. Falling back to the classic JSON-dispatcher path.",
              ), false)
            : detected.toolCalling;

      const streaming =
        explicitStreaming === true
          ? (detected.streaming && supportsStreaming(this.llm)) ||
            (console.warn(
              "[CyberSoulClient] capabilities.streaming=true but the backend LLM template does not support streaming. Falling back to the non-streaming path.",
            ), false)
          : false;

      this.resolvedCapabilities = { toolCalling, streaming };
      return this.resolvedCapabilities;
    })();

    try {
      return await this.capabilitiesPromise;
    } finally {
      // Clear the in-flight marker so future calls (after a potential
      // reset) can re-resolve. The cached result in resolvedCapabilities
      // will short-circuit them anyway.
      this.capabilitiesPromise = null;
    }
  }

  /**
   * Phase 5 — returns the resolved tool-calling capability. MUST be
   * preceded by an `await this.resolveCapabilities()` call in the
   * same turn (the interact/proactive/ondemand entry points do this).
   *
   * Uses the cached resolution from `resolveCapabilities()` — no
   * async work here so it can be called synchronously mid-dispatch.
   */
  private shouldUseToolCalling(): boolean {
    return this.resolvedCapabilities?.toolCalling === true;
  }

  /**
   * Phase 5 — returns the resolved streaming capability. Same
   * contract as `shouldUseToolCalling()`: `resolveCapabilities()`
   * must have been awaited earlier in the turn.
   *
   * IMPORTANT: streaming is gated on tool-calling being active too.
   * The streaming dispatch path (`runInteractDispatchStream`) sends
   * tool declarations to the model. If tool-calling is NOT active
   * (classic JSON-dispatcher path), streaming would silently drop
   * the tools — the model would produce freeform text with no
   * speak/update_state/image/voice dispatch. So streaming is only
   * useful when tool-calling is also on. Streaming-without-tools is
   * a valid config for future text-only streaming UIs, but the agent
   * harness doesn't support it today.
   */
  private shouldUseStreaming(): boolean {
    return (
      this.shouldUseToolCalling() &&
      this.resolvedCapabilities?.streaming === true &&
      supportsStreaming(this.llm)
    );
  }

  /**
   * Phase 2 — build a per-turn ToolRegistry with every capability the
   * character may invoke. Tools that emit events (image/voice/gift)
   * close over the per-turn EventStream; signal tools
   * (speak/like/end_turn/skip_*) are stateless placeholders whose
   * declarations still ship to the LLM so the model can choose them.
   *
   * Built per-turn (not cached on the client) because the sink is
   * per-turn and the tools close over it. This is cheap — tool
   * construction is just object assembly, no IO.
   *
   * The `as Tool[]` erasure is necessary because each concrete tool
   * has a narrower `TArgs` than the registry's default — TypeScript's
   * function-parameter invariance prevents the direct assignment. The
   * registry never invokes the executor with the wrong shape (callers
   * that build the tool also build the args that go with it).
   */
  private buildTurnToolRegistry(
    sink: EventStream,
    extraTools: Tool[] = [],
    state?: CharacterState,
  ): ToolRegistry {
    return new ToolRegistry([
      speakTool,
      buildUpdateStateTool(),
      buildGenerateImageTool(sink),
      buildGenerateVoiceTool(sink, state),
      buildTriggerEventTool(),
      buildGiftOutfitTool(sink),
      likePictureTool,
      endTurnTool,
      skipTurnTool,
      skipProactiveTool,
      ...extraTools,
    ] as unknown as Tool[]);
  }

  /* ============================================================ */
  /* Private — interact helpers (prompt assembly + gating)       */
  /* ============================================================ */

  /**
   * Build the {system, user} prompt pair for an interact turn.
   * Mirrors the legacy `buildInteractPromptMessages` — same prompt
   * builders, same transcript assembly, same `allowSkip` propagation.
   */
  private async buildInteractPromptMessages(
    state: CharacterState,
    availableOutfits: string,
    types: InteractRequestType[],
    isAuto: boolean,
    requestedOthers: InteractRequestType[],
    params: InteractParams,
  ): Promise<Array<{ role: string; content: string }>> {
    const systemPrompt = buildInteractSystemPrompt({
      state,
      availableOutfits,
      types,
      isAuto,
      requestedOthers,
      allowSkip: params.allowSkip === true,
      systemPromptFragment: params.systemPromptFragment,
      // Phase 5 — the JSON schema hint is REQUIRED on the classic
      // JSON-dispatcher path (the LLM has no tool declarations, so it
      // MUST see the schema to produce valid JSON). It's OMITTED on
      // the tool-calling path (native tool declarations replace it).
      // Default: false when tool-calling (omit), true when classic.
      embedJsonSchemaHint:
        this.shouldUseToolCalling() ? (params.embedJsonSchemaHint ?? false) : true,
    });

    // Phase 3.2 — use the configured HistoryCompactor when enabled,
    // else fall back to today's buildHistoryTranscript slice. The
    // await is a no-op for the bullet strategy / disabled path.
    const transcript = await this.buildTranscript(
      params.history,
      state,
      params.historyCompaction,
    );
    const userName = state.dynamic_context?.userNickname || "User";

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
   * Fail fast instead of echoing the user's own message back as the
   * character's reply. The `: params.userMessage` fallback used in
   * `resolveInteractText` is only ever reached for media-only turns now.
   *
   * (§5.4 item 9 — must stay throw-on-non-actionable.)
   */
  private assertInteractIntentActionable(parsedIntent: DispatcherIntent): void {
    const finalHasUsableText =
      typeof parsedIntent.textResponse === "string" &&
      parsedIntent.textResponse.trim().length > 0;
    const finalHasMediaIntent =
      !!parsedIntent.imageParams || !!parsedIntent.voiceArgs;
    if (!finalHasUsableText && !finalHasMediaIntent) {
      throw new Error(
        "LLM returned a non-actionable response (no usable textResponse and no media intent). " +
          "This can happen when: (1) the classic JSON-dispatcher path failed to parse the LLM's JSON after 3 retries, " +
          "(2) the agent loop hit maxIterations without the model ever calling speak/generate_image/generate_voice, or " +
          "(3) the LLM template/provider is misconfigured. Check LLM template/provider alignment.",
      );
    }
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

  /**
   * Emit `text-ready` via the EventStream. Same gating as the legacy
   * `emitInteractTextReady` — only fires when there's text or action
   * to deliver.
   */
  private emitInteractTextReady(
    sink: EventStream,
    parsedIntent: DispatcherIntent,
    resolvedTextResponse: string,
    willGenerateVoice: boolean,
  ): void {
    if (resolvedTextResponse || parsedIntent.actionText) {
      sink.emit({
        type: "text-ready",
        text: resolvedTextResponse,
        actionText: parsedIntent.actionText,
        metadata: {
          stateUpdate: parsedIntent.stateUpdate,
          userAnalysis: parsedIntent.userAnalysis,
          isEndTurn: parsedIntent.isEndTurn,
          triggerEvent: parsedIntent.triggerEvent,
          likePreviousPicture: parsedIntent.likePreviousPicture,
          willGenerateVoice,
        },
      });
    }
  }

  /* ============================================================ */
  /* Private — proactive helpers (prompt assembly)                */
  /* ============================================================ */

  private async buildProactivePromptMessages(
    state: CharacterState,
    availableOutfits: string,
    imageAllowed: boolean,
    params: ProactiveParams,
  ): Promise<Array<{ role: string; content: string }>> {
    const systemPrompt = buildProactiveSystemPrompt({
      state,
      availableOutfits,
      imageAllowed,
      systemPromptFragment: params.systemPromptFragment,
      // Phase 5 — same gate as interact: omit the JSON schema hint
      // when tool-calling is active (native tool declarations replace
      // it); force it on for the classic path.
      embedJsonSchemaHint:
        this.shouldUseToolCalling() ? (params.embedJsonSchemaHint ?? false) : true,
    });

    // Phase 3.2 — same compaction-aware transcript build as interact.
    const transcript = await this.buildTranscript(
      params.history,
      state,
      params.historyCompaction,
    );

    const userContent = buildProactiveUserMessage({
      localContext: params.localContext,
      transcript,
    });

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ];
  }

  /* ============================================================ */
  /* Private — ondemand helpers                                   */
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
  /* Private — memory helpers                                     */
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
      // 0. Phase 5 — resolve LLM dispatch capabilities (auto-detect
      //    from backend template, merged with explicit flags). MUST
      //    happen before buildInteractPromptMessages because the
      //    result drives `embedJsonSchemaHint` (tool-calling path
      //    omits the JSON schema; classic path includes it).
      await this.resolveCapabilities();

      // 1. Prepare context (state + wardrobe + normalized types).
      const ctx = await this.context.prepareInteract(params);

      // 2. Build the {system, user} prompt pair.
      const promptMessages = await this.buildInteractPromptMessages(
        ctx.state,
        ctx.availableOutfits,
        ctx.types,
        ctx.isAuto,
        ctx.requestedOthers,
        params,
      );

      // 3. Fresh per-turn event sink + harness.
      const sink = this.newSink(params);
      const harness = new AgentHarness(this.llm, sink);

      // 4. Dispatcher LLM call. Three dispatch paths, in priority order:
      //    a) Phase 4 streaming — when capabilities.streaming === true
      //       AND provider implements chatStream(). Text arrives as
      //       deltas via text-delta events.
      //    b) Phase 2 tool-calling — when capabilities.toolCalling ===
      //       true. Single-shot OR multi-step loop (Phase 3.3) when
      //       agentLoop is set.
      //    c) Phase 1 JSON-dispatcher — the default, zero-diff for
      //       existing consumers.
      //    See §4 + §5.3 (feature-flagged, default off).
      const useStreaming = this.shouldUseStreaming();
      const useToolCalling = this.shouldUseToolCalling();
      const loopConfig = this.resolveAgentLoopConfig(params.agentLoop);
      let parsedIntent: DispatcherIntent;
      let loopDispatchedTools: Set<string> | undefined;
      let loopMedia: DispatchResult["loopMedia"];
      if (useStreaming) {
        const registry = this.buildTurnToolRegistry(sink, params.extraTools, ctx.state);
        const declarations = registry.buildToolDeclarations();
        ({ parsedIntent } = await harness.runInteractDispatchStream(
          promptMessages,
          declarations,
        ));
      } else if (useToolCalling) {
        const registry = this.buildTurnToolRegistry(sink, params.extraTools, ctx.state);
        const declarations = registry.buildToolDeclarations();
        const toolCtx = this.buildToolContext(ctx.state, params);
        if (loopConfig) {
          // Phase 3.3 — multi-step agent loop. The loop dispatches
          // side-effect tools inline (image, voice, etc.) and tracks
          // which ones ran so the side-effect layer skips them.
          ({ parsedIntent, loopDispatchedTools, loopMedia } =
            await harness.runInteractDispatchLoop(
              promptMessages,
              declarations,
              registry,
              toolCtx,
              loopConfig,
            ));
        } else {
          ({ parsedIntent } = await harness.runInteractDispatchWithTools(
            promptMessages,
            declarations,
          ));
        }
      } else {
        ({ parsedIntent } = await harness.runInteractDispatch(
          promptMessages,
        ));
      }

      // 5. Reactive skip — short-circuit BEFORE any media / state work.
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

      // 6. Tool context — closed over by every tool executor.
      const toolCtx = this.buildToolContext(ctx.state, params);

      // 7. State PATCH in parallel with everything else. `onStateReady`
      //    is wired inside the harness via the EventStream.
      //    When the loop already dispatched update_state inline, skip
      //    the re-PATCH (the tool already did it). But still fire
      //    onStateReady with {} so the UI's generic "LLM phase done"
      //    signal fires.
      let persistedStatePromise: Promise<PersistedDynamicContext | null>;
      if (loopDispatchedTools?.has("update_state")) {
        // State was already PATCHed by the loop's update_state tool.
        // Fire onStateReady with empty so the callback signal works.
        persistedStatePromise = Promise.resolve(null);
        if (params.onStateReady) {
          try {
            params.onStateReady({});
          } catch (cbErr) {
            console.warn("[CyberSoulClient] onStateReady callback threw:", cbErr);
          }
        }
      } else {
        persistedStatePromise = harness.startInteractStateUpdate(
          parsedIntent,
          toolCtx,
        );
      }

      // 8. Resolve text + emit text-ready with the legacy gating.
      //    SKIP if the loop already emitted text-ready when it
      //    dispatched the speak tool inline — otherwise the panel
      //    gets two text-ready events and renders duplicate bubbles.
      const resolvedTextResponse = this.resolveInteractText(
        parsedIntent,
        params.userMessage,
      );
      const willGenerateVoice =
        ctx.types.includes(InteractRequestType.VOICE) &&
        (!ctx.isAuto || !!parsedIntent.voiceArgs);

      if (!loopDispatchedTools?.has("speak")) {
        this.emitInteractTextReady(
          sink,
          parsedIntent,
          resolvedTextResponse,
          willGenerateVoice,
        );
      }

      // 9. Parallel side-effects (image/voice/event/gift). Failures of
      //    typed-media errors are captured in-band; everything else is
      //    swallowed so a partial hiccup never aborts the turn.
      const media = await harness.runInteractSideEffects(
        { types: ctx.types, isAuto: ctx.isAuto },
        parsedIntent,
        params,
        resolvedTextResponse,
        toolCtx,
        loopDispatchedTools,
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
        // When the loop dispatched media inline, the side-effect layer
        // skipped those tools. Use the loop's captured results so the
        // final response carries the correct URLs. Fall back to the
        // side-effect layer's results for the classic/single-shot path.
        imageUrl: loopMedia?.imageUrl ?? media.imageUrl,
        imageMediaId: loopMedia?.imageMediaId ?? media.imageMediaId,
        audioUrl: loopMedia?.audioUrl ?? media.audioUrl,
        audioMediaId: loopMedia?.audioMediaId ?? media.audioMediaId,
        likePreviousPicture: parsedIntent.likePreviousPicture,
        durationSec: loopMedia?.durationSec ?? media.durationSec,
        // triggeredEvent stays sourced from parsedIntent (not the tool result)
        // to match the legacy response shape — the tool's `triggered` return
        // value is for Phase 2 observability only.
        triggeredEvent: parsedIntent.triggerEvent || undefined,
        stateUpdate: parsedIntent.stateUpdate,
        userAnalysis: parsedIntent.userAnalysis,
        isEndTurn: parsedIntent.isEndTurn,
        persistedDynamicContext,
        mediaError,
        giftedOutfit: loopMedia?.giftedOutfit ?? media.giftedOutfit,
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
      // 0. Phase 5 — resolve LLM dispatch capabilities (auto-detect).
      await this.resolveCapabilities();

      // 1. Fetch current state and wardrobe items
      const [state, availableOutfits] = await Promise.all([
        this.context.fetchState(),
        this.context.getWardrobePromptStr(),
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
      // 1. Spam guard — the only hard-coded gate. (§5.4 item 7 — must
      //    short-circuit BEFORE any network call.)
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

      // 1b. Phase 5 — resolve LLM dispatch capabilities (auto-detect).
      //     Must happen before prompt building (embedJsonSchemaHint gate).
      await this.resolveCapabilities();

      // 2. Prepare context (state + wardrobe + modality gates).
      const ctx = await this.context.prepareProactive(params);

      // 3. Build the LLM prompt.
      const promptMessages = await this.buildProactivePromptMessages(
        ctx.state,
        ctx.availableOutfits,
        ctx.imageAllowed,
        params,
      );

      // 4. Fresh per-turn event sink + harness.
      const sink = this.newSink(params);
      const harness = new AgentHarness(this.llm, sink);

      // 5. LLM decides. Lower temperature than `interact` because this
      //    is a judgment call, not creative reply. Phase 2 routes to
      //    the native tool-calling path when opted in (same gate as
      //    interact — see step 4 there).
      //
      //    Phase 3.3 NOTE: the multi-step agent loop is NOT wired into
      //    proactive today. Proactive turns are rare + simple (decide
      //    whether to reach out + what to say); the loop's value is
      //    reactive side-effects, which proactive doesn't have. The
      //    agentLoop config is accepted but ignored on this path.
      const useToolCalling = this.shouldUseToolCalling();
      const decision = useToolCalling
        ? await harness.runProactiveDispatchWithTools(
            promptMessages,
            this.buildTurnToolRegistry(sink, params.extraTools, ctx.state).buildToolDeclarations(),
          )
        : await harness.runProactiveDispatch(promptMessages);
      if (decision.kind === "skip") {
        return { status: "skipped", reason: decision.reason };
      }
      const parsedIntent = decision.intent;

      // 6. Tool context.
      const toolCtx = this.buildToolContext(ctx.state, params);

      // 7. Persist state in parallel with side effects; wire callbacks.
      const persistedStatePromise = harness.startProactiveStateUpdate(
        parsedIntent,
        toolCtx,
      );

      // 8. Emit text-ready.
      if (parsedIntent.textResponse) {
        sink.emit({
          type: "text-ready",
          text: parsedIntent.textResponse,
          actionText: parsedIntent.actionText,
          metadata: { stateUpdate: parsedIntent.stateUpdate },
        });
      }

      // 9. Side effects: outfit acquisition + optional image. Failures
      //    are captured (not thrown) so a partial hiccup never aborts
      //    the proactive turn.
      const giftOutfitPromise = harness.runProactiveGiftOutfit(
        parsedIntent,
        toolCtx,
      );
      const imageResult = await harness.runProactiveImageTask(
        parsedIntent,
        toolCtx,
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
    const state = await this.context.fetchState();
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
    const state = await this.context.fetchState();
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
    return this.context.fetchState();
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
    const payload = buildStatePatchPayload(stateUpdate, userAnalysis);
    if (!payload) return null;
    return this.api.patchDynamicContext(payload);
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
    // Invalidate the moments cache so the next turn sees the newly
    // saved moment instead of the stale 5-min-cached list.
    this.context.invalidateMomentsCache();
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

      // Invalidate the moments cache — core-memory consolidation is
      // triggered by the same end_turn flow that saves a new moment,
      // so the cache is likely stale at this point.
      this.context.invalidateMomentsCache();

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
