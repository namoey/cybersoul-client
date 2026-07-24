/**
 * CyberSoulCore — the shared kernel used by BOTH `CyberSoulClient`
 * (classic JSON-dispatcher path) and `CyberSoulAgent` (modern tool-
 * calling path). See
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * "Two-path separation" for the design rationale.
 *
 * The Core owns:
 *   - CyberSoulApi (transport)
 *   - ContextManager (state + wardrobe cache + HistoryCompactor)
 *   - BaseLLMProvider (the LLM)
 *   - AgentHarness factory (all dispatch methods)
 *
 * The Core does NOT own:
 *   - EventStream (per-turn, owned by whichever path is running)
 *   - ToolRegistry (per-turn, built fresh because tools close over the
 *     per-turn EventStream)
 *   - Public response shaping (that's path-specific)
 *
 * By holding the shared dependencies, the Core ensures both paths
 * use the SAME ContextManager instance (so state + wardrobe + history
 * caches don't diverge between paths) and the SAME transport layer.
 *
 * Construction: typically built implicitly by `CyberSoulClient` or
 * `CyberSoulAgent` from their respective configs. Can also be
 * constructed explicitly and shared between a client + agent pair
 * (rare — usually you pick one path).
 */

import { CyberSoulApi } from "../api/cyberSoulApi.js";
import { ContextManager } from "../agent/contextManager.js";
import { HistoryCompactor } from "../agent/historyCompactor.js";
import { AgentHarness } from "../agent/agentHarness.js";
import { EventStream } from "../agent/eventStream.js";
import { GenericLLMProvider } from "../llm.provider.js";
import type {
  BaseLLMProvider,
  CharacterState,
  HistoryCompactionConfig,
  HistoryEntry,
  InteractRequestType,
  PersistedDynamicContext,
} from "../types.js";
import type { TurnContext } from "../agent/contextManager.js";
import type { Hook, Tool } from "../agent/types.js";

export interface CyberSoulCoreConfig {
  backendUrl: string;
  characterKey: string;
  llmConfig: import("../types.js").GenericLLMConfig;
  requestTimeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  historyCompaction?: HistoryCompactionConfig;
}

export class CyberSoulCore {
  readonly api: CyberSoulApi;
  readonly llm: BaseLLMProvider;
  readonly context: ContextManager;
  private historyCompactor: HistoryCompactor | null = null;
  private historyCompactorConfig: HistoryCompactionConfig | null = null;

  constructor(config: CyberSoulCoreConfig) {
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

    if (config.historyCompaction) {
      this.applyHistoryCompactionConfig(config.historyCompaction);
    }
  }

  /**
   * Build the chat-history transcript for a turn, using the configured
   * HistoryCompactor when compaction is enabled, or falling back to
   * today's buildHistoryTranscript slice when not. Same logic the
   * legacy CyberSoulClient used — moved here so both paths share it.
   *
   * When compaction is on AND the strategy is "llm-summary", the
   * core's summarizeHistory is auto-wired as the summarizeFn.
   */
  async buildTranscript(
    history: HistoryEntry[] | undefined,
    state: CharacterState,
    turnLevelCompaction: HistoryCompactionConfig | null | undefined,
  ): Promise<string> {
    if (!history || history.length === 0) return "";

    const cfg = this.resolveHistoryCompactionConfig(turnLevelCompaction);
    if (!cfg) {
      // Fall back to today's verbatim slice. Import lazily to avoid
      // pulling the prompt layer into the Core's module graph when
      // compaction isn't used.
      const { buildHistoryTranscript } = await import(
        "../prompts/promptBuilders.js"
      );
      return buildHistoryTranscript(history, state);
    }

    this.applyHistoryCompactionConfig(cfg);
    const compactor = this.historyCompactor!;

    const agentName =
      state.dynamic_context?.agentNickname || state.name || "Agent";
    const userName = state.dynamic_context?.userNickname || "User";

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

  /**
   * Summarize a slice of history via the LLM. Used by the llm-summary
   * compaction strategy. Same implementation as CyberSoulClient's
   * public summarizeHistory — lifted into the Core so both paths
   * share it.
   *
   * TODO: this duplicates the body of CyberSoulClient.summarizeHistory
   * — the client should delegate to core.summarizeHistory in step 4.
   */
  async summarizeHistory(history: HistoryEntry[]): Promise<string> {
    if (!history || history.length === 0) return "";
    try {
      const state = await this.context.fetchState();
      const { deriveSummarizerIdentity, getDefaultCoreMemory, getDefaultUserCodex } =
        await import("../utils/state.utils.js");
      const identity = deriveSummarizerIdentity(state);
      const {
        buildSummarizerContextBlock,
        buildSummarizerPromptMessages,
      } = await import("../prompts/promptBuilders.js");
      const { formatHistoryEntries } = await import(
        "../utils/history.utils.js"
      );
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
      console.error("[CyberSoulCore] Summarize History Error:", e);
      return "The two spent some time talking with each other.";
    }
  }

  /**
   * Build a fresh per-turn EventStream attached with the caller's
   * legacy callbacks. One stream per turn — never reused — so
   * concurrent turns don't cross the wires.
   */
  newSink(callbacks: {
    onTextReady?: import("../types.js").InteractParams["onTextReady"];
    onTextDelta?: import("../types.js").InteractParams["onTextDelta"];
    onStateReady?: import("../types.js").InteractParams["onStateReady"];
    onMediaReady?: import("../types.js").InteractParams["onMediaReady"];
    onOutfitGifted?: import("../types.js").InteractParams["onOutfitGifted"];
  }): EventStream {
    const sink = new EventStream();
    sink.attachLegacy(callbacks);
    return sink;
  }

  /**
   * Build a fresh per-turn AgentHarness bound to the given sink. The
   * harness is cheap to construct (just holds references); one per
   * turn so the sink matches.
   */
  newHarness(sink: EventStream): AgentHarness {
    return new AgentHarness(this.llm, sink);
  }

  /**
   * Fetch the authoritative character state. Thin delegation to
   * ContextManager — both paths use this.
   */
  async fetchState(): Promise<CharacterState> {
    return this.context.fetchState();
  }

  /**
   * Cached wardrobe prompt string (5-min TTL). Both paths share the
   * cache via the ContextManager.
   */
  async getWardrobePromptStr(): Promise<string> {
    return this.context.getWardrobePromptStr();
  }

  /* ----- HistoryCompactor management (moved from client) ----- */

  private applyHistoryCompactionConfig(cfg: HistoryCompactionConfig): void {
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

  private resolveHistoryCompactionConfig(
    turnLevel: HistoryCompactionConfig | null | undefined,
    clientDefault?: HistoryCompactionConfig,
  ): HistoryCompactionConfig | null {
    if (turnLevel !== undefined) return turnLevel;
    return clientDefault ?? this.historyCompactorConfig ?? null;
  }
}
