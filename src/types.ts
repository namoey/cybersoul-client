export interface GenericLLMConfig {
  provider: string;
  apiKey: string;
  model: string;
  customSettings?: Record<string, any>;
  /**
   * Phase 2 — explicit capability hints. When omitted, the SDK
   * auto-detects tool-calling support from the backend template
   * (presence of `toolsPayloadTemplate` + `toolCallsResponsePath` +
   * `toolCallArgsResponsePath`). When provided, the explicit hint
   * wins — useful for forcing the JSON-dispatcher path (`toolCalling:
   * false`) even when the template supports tools, e.g. for A/B
   * comparison during shadow mode (§5.2 Layer C).
   */
  capabilities?: {
    /** Opt into native tool-calling. Default: auto-detect from template. */
    toolCalling?: boolean;
    /** Reserved for Phase 4 — streaming text deltas. */
    streaming?: boolean;
  };
}

export interface CyberSoulClientConfig {
  characterKey: string;
  backendUrl: string;
  llmConfig: GenericLLMConfig;
  requestTimeoutMs?: number;
  maxRetries?: number;
  /**
   * Optional fetch override. When provided, the client uses this in
   * place of the global `fetch` for every HTTP call (backend + LLM
   * provider). Intended for environments where the global fetch is
   * suspended by the host platform — e.g. React Native on Samsung
   * BBA / Doze — and a native HTTP path must be used instead. Must
   * conform to the standard `fetch` signature.
   */
  fetchImpl?: typeof fetch;
  /**
   * Phase 3.2 — optional in-turn history compaction. When set, the
   * client owns a `HistoryCompactor` instance and uses it instead of
   * the legacy `buildHistoryTranscript` slice. Lets long conversations
   * maintain continuity past the 20-entry window without the LLM
   * "forgetting" earlier emotionally-weighty moments.
   *
   * DEFAULT UNSET → today's behavior (slice last 20, drop older).
   * Callers opt in by providing a config; per-turn override via
   * `InteractParams.historyCompaction` (set `null` to disable for
   * one turn).
   *
   * See HistoryCompactionConfig + agent/historyCompactor.ts.
   */
  historyCompaction?: HistoryCompactionConfig;
  /**
   * Phase 3.3 — optional multi-step agent loop. When set AND
   * `llmConfig.capabilities.toolCalling === true`, the harness
   * iterates: call provider.chat() → dispatch tool calls → feed
   * results back → repeat. Lets the model observe tool results
   * (e.g. image generation failed) and react mid-turn instead of
   * committing blind.
   *
   * DEFAULT UNSET → single-shot dispatch (Phase 2 behavior) even
   * when tool-calling is on. Per-turn override via
   * `InteractParams.agentLoop` (set `null` to disable for one turn).
   *
   * REQUIRES `capabilities.toolCalling === true`. If tool-calling is
   * off, agentLoop is silently ignored (the JSON-dispatcher path
   * doesn't loop).
   *
   * See AgentLoopConfig + agent/agentHarness.ts runInteractDispatchLoop.
   */
  agentLoop?: import("./agent/types.js").AgentLoopConfig | null;
}

/**
 * Phase 3.2 — config for in-turn history compaction.
 *
 * `strategy`:
 *   - "bullet" (default, zero LLM cost): one-line-per-turn summary.
 *   - "llm-summary" (expensive, cached): narrative paragraph via the
 *     client's `summarizeHistory` method. The harness auto-wires the
 *     summarizeFn — callers don't pass it.
 *
 * `maxRawEntries`: verbatim recent-window size. Default 20 (= today's
 * slice). Older entries are folded per `strategy`.
 *
 * `reSummarizeThreshold`: only for "llm-summary". Re-summarize when
 * the compacted window grows by this many new entries since the last
 * summary. Default 10.
 *
 * Exported through the contract barrel so callers can construct it
 * without reaching into agent/ internals.
 */
export interface HistoryCompactionConfig {
  strategy?: "bullet" | "llm-summary";
  maxRawEntries?: number;
  reSummarizeThreshold?: number;
}

export enum InteractRequestType {
  AUTO = "auto",
  TEXT = "text",
  IMAGE = "image",
  VOICE = "voice",
}

export interface HistoryEntry {
  role: string;
  content: string;
  actionText?: string;
  mediaHint?: string;
  /**
   * Marker for assistant turns that already auto-triggered an event
   * (e.g. an outing/hangout the character accepted). Surfaced in the
   * transcript as a `[Triggered Event: ...]` tag so the dispatcher's
   * trigger-event repetition gate can avoid re-triggering the same
   * activity on later turns. Mirrors how `mediaHint` tags past media.
   */
  eventHint?: string;
  isProactive?: boolean;
  timestamp?: string | number | Date;
}

export interface InteractMetadata {
  stateUpdate?: DispatcherIntent["stateUpdate"];
  userAnalysis?: DispatcherIntent["userAnalysis"];
  isEndTurn?: boolean;
  triggerEvent?: DispatcherIntent["triggerEvent"];
  likePreviousPicture?: boolean;
  /**
   * True when the client has already decided to dispatch a voice
   * generation task for this turn (i.e. `onMediaReady({modality:"voice"})`
   * will fire later, barring TTS failure). UIs that render an early
   * text bubble from `onTextReady` should suppress it when this is set —
   * the text content is going to be replaced by the voice bubble anyway,
   * so showing both (with a brief text-then-voice flicker, and a text
   * push notification that gets superseded by a voice bubble) is
   * confusing to the end user.
   */
  willGenerateVoice?: boolean;
}

/**
 * Server-authoritative snapshot returned by PATCH /characters/dynamic-context
 * after the backend applies stage dampening, familiarity soft caps, hard
 * floors, rounding, and stage re-evaluation. Use this instead of recomputing
 * the delta on the client.
 */
export interface PersistedDynamicContext {
  /** Persisted absolute temperature (0-100), post all server-side adjustments. */
  temperature?: number;
  /** Persisted relationship stage label after re-evaluation. */
  relationshipStage?: string;
}

/**
 * Payload delivered by [InteractParams.onMediaReady] when an individual
 * media task (image/voice) finishes. Fires from inside the SDK's
 * per-modality `.then()` so callers can render the bubble the moment
 * that modality is ready, instead of waiting for the slowest one to
 * finish. The aggregated `InteractResponse` is still returned at the
 * end and carries the same URLs (no double-render needed if the caller
 * tracks per-modality state).
 */
export interface MediaReadyPayload {
  modality: "image" | "voice";
  url: string;
  mediaId?: string;
  /** Voice only — TTS duration in seconds when known. */
  durationSec?: number;
}

/**
 * Payload delivered by [InteractParams.onOutfitGifted] /
 * [ProactiveParams.onOutfitGifted] when a new outfit is successfully
 * added to the character's wardrobe during a turn. Fires for BOTH
 * trigger paths: (a) the user explicitly gifts/buys an outfit, and
 * (b) the conversation or an active event leads the character to
 * acquire a brand-new outfit. Lets upstream consumers (e.g.
 * cybersoul-chat) render a system message like
 * "New outfit added to wardrobe".
 */
export interface OutfitGiftedPayload {
  /** Human-readable description of the newly acquired outfit. */
  descriptionText: string;
  /**
   * Number of wardrobe items the backend created for this gift, when
   * the server reported it. Omitted when the count is unknown — never
   * fabricated.
   */
  count?: number;
}

export interface ProactiveParams {
  /**
   * Optional host-application prompt fragment. Same contract as
   * InteractParams.systemPromptFragment — see there for placement and
   * Phase 3.1 rationale.
   */
  systemPromptFragment?: string;
  /**
   * Phase 3.1b — optional extra tools. Same contract as
   * InteractParams.extraTools — see there for execution semantics.
   */
  extraTools?: import("./agent/types.js").Tool[];
  /**
   * Phase 3.2 — per-turn override for history compaction. Same
   * contract as InteractParams.historyCompaction — see there.
   */
  historyCompaction?: HistoryCompactionConfig | null;
  /**
   * Phase 3.3 — per-turn override for the multi-step agent loop.
   * Same contract as InteractParams.agentLoop — see there.
   */
  agentLoop?: import("./agent/types.js").AgentLoopConfig | null;
  history?: HistoryEntry[];
  maxUnreplied?: number;
  requestTypes?: InteractRequestType[];
  localContext?: string;
  onTextReady?: (textResponse: string, actionText?: string, metadata?: InteractMetadata) => void;
  /**
   * Fires when the server-authoritative PATCH /dynamic-context resolves,
   * before media generation completes. Lets the UI update the live
   * temperature / relationship stage immediately instead of waiting for
   * the (potentially slow) image task.
   */
  onStateReady?: (persisted: PersistedDynamicContext) => void;
  /** Fires per modality as each media task settles successfully. */
  onMediaReady?: (payload: MediaReadyPayload) => void;
  /**
   * Fires when an outfit has been successfully added to the wardrobe
   * during this turn (user-initiated gift OR character-initiated
   * acquisition). Lets the UI render a system message like
   * "New outfit added to wardrobe" in real time.
   */
  onOutfitGifted?: (payload: OutfitGiftedPayload) => void;
}

export interface ProactiveResponse {
  status: "success" | "skipped" | "error";
  reason?: string;
  textResponse?: string;
  actionText?: string;
  imageUrl?: string;
  imageMediaId?: string;
  audioUrl?: string;
  audioMediaId?: string;
  stateUpdate?: DispatcherIntent["stateUpdate"];
  /** Server-authoritative post-write snapshot (see PersistedDynamicContext). */
  persistedDynamicContext?: PersistedDynamicContext;
  /** Partial-failure descriptor: text was generated successfully but one or
   * more media calls (image/voice) failed. Surfaced in-band so the caller
   * can still render the text reply and explain the missing media
   * without losing the conversation. See [InteractMediaError]. */
  mediaError?: InteractMediaError;
  /** Set when an outfit was successfully added to the wardrobe this turn.
   * Mirrors the [ProactiveParams.onOutfitGifted] callback for consumers
   * that only read the final response. See [OutfitGiftedPayload]. */
  giftedOutfit?: OutfitGiftedPayload;
  error?: string;
}

export interface InteractParams {
  userMessage: string;
  localContext?: string;
  requestTypes?: InteractRequestType[];
  history?: HistoryEntry[];
  /**   * Optional host-application prompt fragment prepended to the system
   * prompt, between the compliance directive (highest priority) and
   * the character's identity block. Lets host apps layer their own
   * instructions on top of the character baseline (e.g. "Always reply
   * in French", "This user is a premium subscriber").
   *
   * Phase 3.1 — this is the seam `CyberSoulAgent` uses to inject
   * `PersonaConfig.systemPromptFragment`. Callers that use
   * `CyberSoulClient` directly can also pass it explicitly.
   *
   * Empty / undefined → no behavior change (no token cost, no
   * prompt mutation). When present, the builder wraps it as:
   *
   *   `[HOST APPLICATION INSTRUCTIONS]\n<fragment>\n\n`
   *
   * and places it AFTER `[COMPLIANCE BOUNDARY]` (which remains highest
   * priority) but BEFORE the character identity block.
   */
  systemPromptFragment?: string;  /**
   * Phase 3.1b — optional extra tools to register alongside the built-in
   * toolset. Lets host apps register character-specific capabilities
   * (e.g. "remember my birthday", "check my calendar") that the LLM
   * can call during a tool-calling turn.
   *
   * When `capabilities.toolCalling` is OFF (the default), this field is
   * stored but NOT executed — the JSON-dispatcher path doesn't dispatch
   * tools from the registry, only the built-in side-effect tools via
   * `runInteractSideEffects`. Custom tools only fire when tool-calling
   * is enabled AND the LLM emits a matching tool call.
   *
   * Name collisions with built-in tools (speak, generate_image, etc.)
   * throw at registry-build time — choose distinct names.
   */
  extraTools?: import("./agent/types.js").Tool[];
  /**
   * Phase 3.2 — per-turn override for history compaction. When
   * provided, takes precedence over the client-level
   * `CyberSoulClientConfig.historyCompaction`. Pass `null` to
   * explicitly disable compaction for this turn even when the
   * client default is on (useful for A/B testing).
   *
   * Default undefined → use the client-level setting (which itself
   * defaults to off → today's slice-20 behavior).
   */
  historyCompaction?: HistoryCompactionConfig | null;
  /**
   * Phase 3.3 — per-turn override for the multi-step agent loop.
   * Same contract as `CyberSoulClientConfig.agentLoop` — see there.
   * Pass `null` to explicitly disable the loop for this turn even
   * when the client default is on.
   */
  agentLoop?: import("./agent/types.js").AgentLoopConfig | null;
  /**
   * When true, the character is permitted to SKIP replying to the user's
   * message — simulating a real human who sometimes goes quiet based on
   * context, personality, and relationship state. Defaults to false so
   * existing callers always get a reply (backward compatible).
   *
   * When the character decides to skip, the SDK returns
   * `{ status: "skipped", reason }` without generating media or persisting
   * state, and `onTextReady` is NOT fired. Frontends should treat a
   * skipped turn as a no-op (keep the user's message, render no assistant
   * bubble).
   */
  allowSkip?: boolean;
  onTextReady?: (textResponse: string, actionText?: string, metadata?: InteractMetadata) => void;
  /**
   * Fires when the server-authoritative PATCH /dynamic-context resolves,
   * before media generation completes. Lets the UI update the live
   * temperature / relationship stage immediately instead of waiting for
   * the (potentially slow) image task. When the turn has no
   * `stateUpdate`, this still fires with an empty object so callers can
   * use it as a generic "LLM phase done" signal.
   */
  onStateReady?: (persisted: PersistedDynamicContext) => void;
  /** Fires per modality as each media task settles successfully. */
  onMediaReady?: (payload: MediaReadyPayload) => void;
  /**
   * Fires when an outfit has been successfully added to the wardrobe
   * during this turn (user-initiated gift OR character-initiated
   * acquisition). Lets the UI render a system message like
   * "New outfit added to wardrobe" in real time.
   */
  onOutfitGifted?: (payload: OutfitGiftedPayload) => void;
}

export interface OndemandEventParams {
  eventDescription: string;
  durationMins?: number;
  interactParams?: InteractParams;
}

export interface OndemandEventResponse {
  status: "success" | "error";
  acceptEvent?: boolean;
  reason?: string;
  requiresOutfitChange?: boolean;
  selectedOutfitId?: string;
  scheduledStartTimeStr?: string;
  scheduledDateStr?: string;
  error?: string;
}

export enum WardrobeCategory {
  CASUAL = 'CASUAL',
  FORMAL = 'FORMAL',
  WORKWEAR = 'WORKWEAR',
  SPORTSWEAR = 'SPORTSWEAR',
  SWIMWEAR = 'SWIMWEAR',
  COSTUME = 'COSTUME',
  SLEEPWEAR = 'SLEEPWEAR',
  INTIMATE = 'INTIMATE',
  DAILY = 'DAILY',
}

export interface WardrobeItem {
  id: string;
  itemName: string;
  category: WardrobeCategory;
  promptModifier: string;
}

export interface InteractResponse {
  status: "success" | "skipped" | "error";
  /**
   * Short explanation when `status === "skipped"` (the character chose not
   * to reply) or `status === "error"`. Absent on success. Frontends use
   * this only for diagnostics/logging — a skipped turn renders nothing.
   */
  reason?: string;
  textResponse: string;
  actionText?: string;
  imageUrl?: string;
  imageMediaId?: string;
  audioUrl?: string;
  audioMediaId?: string;
  /** Set when an outfit was successfully added to the wardrobe this turn.
   * Mirrors the [InteractParams.onOutfitGifted] callback for consumers
   * that only read the final response. See [OutfitGiftedPayload]. */
  giftedOutfit?: OutfitGiftedPayload;
  likePreviousPicture?: boolean;
  durationSec?: number;
  triggeredEvent?: {
    eventTitle?: string;
    eventDescription: string;
    durationMins?: number;
    outfitId?: string | null;
  };
  stateUpdate?: DispatcherIntent["stateUpdate"];
  userAnalysis?: DispatcherIntent["userAnalysis"];
  isEndTurn?: boolean;
  /** Server-authoritative post-write snapshot (see PersistedDynamicContext). */
  persistedDynamicContext?: PersistedDynamicContext;
  /** Partial-failure descriptor: text was generated successfully but one or
   * more media calls (image/voice) failed. Surfaced in-band so the caller
   * can still render the text reply and explain the missing media
   * without losing the conversation. See [InteractMediaError]. */
  mediaError?: InteractMediaError;
  error?: string;
}

/**
 * Describes a partial-failure during an [interact] / [proactiveInteract]
 * call: the text reply was generated and returned, but image and/or
 * voice generation failed (usually because the user ran out of points
 * mid-turn). Surfaced in-band on the success envelope so callers can
 * render the text response without losing it to an exception.
 */
export interface InteractMediaError {
  /** Coarse kind so UIs can map to a single user-facing message. */
  kind: "insufficient-points" | "wallet" | "sensitive-content" | "unknown";
  /** Backend machine code when available (e.g. "INSUFFICIENT_POINTS"). */
  code?: string;
  /** Raw error message, for logs / diagnostics. */
  message?: string;
  /** Which media generation calls were affected. */
  affected: Array<"image" | "voice">;
}

export interface OngoingSceneState {
  scene: string;
  outfit: string;
}

export interface DispatcherIntent {
  shouldSkipProactive?: boolean;
  skipReason?: string;
  /**
   * Reactive-skip signal for `interact()`. Only produced when the caller
   * opts in via [InteractParams.allowSkip]. When true, the character
   * chose NOT to reply to the user's message (simulating a real human
   * who sometimes goes quiet). The SDK short-circuits before any media /
   * state work and returns `{ status: "skipped" }`.
   */
  shouldSkipInteract?: boolean;
  textResponse?: string;
  actionText?: string;
  imageParams?: any;
  likePreviousPicture?: boolean;
  voiceArgs?: VoiceArgs | null;
  giftOutfit?: {
    descriptionText: string;
  } | null;
  userAnalysis?: {
    newFactsLearned: {
      category:
        | "realName"
        | "occupation"
        | "age"
        | "gender"
        | "hobby"
        | "trait"
        | "communicationStyle"
        | "boundary"
        | "preference";
      value: string;
    }[];
  };
  stateUpdate?: {
    temperatureDelta?: string | number;
    userNickname?: string;
    agentNickname?: string;
    talkingStyle?: string;
    ongoingScene?: OngoingSceneState | string | null;
  };
  triggerEvent?: {
    eventTitle?: string;
    eventDescription: string;
    durationMins?: number;
    outfitId?: string | null;
    scheduledStartTimeStr?: string | null;
    scheduledDateStr?: string | null;
  } | null;
  isEndTurn?: boolean;
}

export interface Appointment {
  date: string;
  time: string;
  title: string;
  context: string;
  withWhom: string;
}

export interface CoreMemory {
  relationshipStatus: string;
  identityAnchors: string[];
  activeArcs: string[];
  keyEvents: string[];
  appointments: Appointment[];
}

export interface UserCodex {
  basicInfo: {
    realName?: string;
    occupation?: string;
    age?: number | string;
    gender?: string;
  };
  psychological: {
    hobbies: string[];
    traits: string[];
    communicationStyle: string;
    boundaries: string[];
    preferences?: string[];
  };
  familiarityScore?: number;
}

/**
 * Generic dynamic voice args returned by the LLM and forwarded to backend TTS.
 *
 * - T lets callers/project code narrow this to model-specific fields when needed.
 * - Defaults to fully dynamic key/value pairs for provider-agnostic SDK behavior.
 */
export type VoiceArgs<
  T extends Record<string, unknown> = Record<string, unknown>,
> = T;

/**
 * Optional compatibility shape for currently common fields.
 * Not used as the SDK contract to avoid coupling to specific providers.
 */
export interface CommonVoiceArgs {
  style_instruction?: string;
  emotion?: string;
}

export interface VoiceModelState {
  tts_provider?: string;
  dynamic_param_prompt_template?: string;
  dynamic_params?: Array<{
    name: string;
    description: string;
    type: string;
    required: boolean;
    default?: unknown;
  }>;
}

export interface CharacterState {
  current_time: string;
  active_event?: any;
  next_event?: any;
  active_wardrobe?: any;
  core_memory?: CoreMemory;
  dynamic_context?: {
    temperature?: number;
    userNickname?: string;
    agentNickname?: string;
    talkingStyle?: string;
    lastInteractionAt?: string;
    ongoingScene?: OngoingSceneState | string | null;
    [key: string]: unknown;
  };
  voice_model?: VoiceModelState | null;
  /**
   * Platform-wide compliance boundary rule (backend PromptSegment,
   * key="COMPLIANCE_RULE"). When present, the client prepends it to the
   * system prompt as the highest-priority instruction. Projected by the
   * backend only when the per-character toggle is on AND the segment is
   * enabled with a non-empty template; otherwise `null` (no-op). Mirrors
   * how `voice_model` is delivered and consumed.
   */
  compliance_boundary?: {
    key: string;
    promptTemplate: string;
  } | null;
  relationship_stage?: string;
  name?: string;
  age?: number;
  gender?: string;
  occupation?: string;
  hobby?: string;
  personality_traits?: string;
  appearance?: string;
  interaction_boundaries?: string;
  communication_style?: string;
  backstory?: string;
  user_codex?: UserCodex;
}

/* -------------------------------------------------------------------------- */
/* Phase 2 — native tool-calling types                                         */
/* -------------------------------------------------------------------------- */
//
// See cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
// §3.3 + §3.3.1 + §4 Phase 2. These types let the SDK pass tool
// declarations to an LLM and receive parsed tool_calls back, WITHOUT
// embedding a JSON schema in the prompt or relying on robustJsonParse.
//
// They are additive to the public contract — existing callers that
// only use `generate()` are unaffected. A provider signals tool-calling
// support by implementing the optional `chat()` method on
// BaseLLMProvider; the harness checks for its presence before routing
// to the tool-calling dispatch path.

/**
 * One tool declaration sent to the LLM. Provider-agnostic canonical
 * shape — `GenericLLMProvider` translates this into the template's
 * `toolsPayloadTemplate` format at call time.
 *
 * Derived 1:1 from the SDK's internal `Tool` type (name + description +
 * inputSchema). The registry produces these from its registered tools.
 */
export interface LLMToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * One tool call parsed from the LLM's response. Mirrors the
 * OpenAI/MiniMax shape (which most providers follow); the provider
 * adapter translates from the raw response format into this shape.
 *
 * `arguments` is a raw JSON string (matching provider conventions) —
 * callers `JSON.parse()` it. With native tool-calling this parse
 * CANNOT fail because the provider enforced the schema at decode time
 * (see §3.3.1).
 *
 * Phase 3.3 — `id` is optional but REQUIRED for the multi-step loop:
 * when the harness feeds tool results back to the LLM, the provider
 * needs to correlate each result with the original tool call. OpenAI/
 * MiniMax require `tool_call_id` on the result message; Anthropic
 * uses `tool_use_id`. The provider adapter maps from this canonical
 * `id` to whatever the provider expects.
 */
export interface LLMToolCall {
  /**
   * Optional provider-assigned ID for this tool call. Present in the
   * OpenAI/MiniMax response shape; absent in Anthropic's native shape
   * (which uses content-block indices). When present, the multi-step
   * loop includes it on the corresponding tool-result message.
   */
  id?: string;
  /** Tool name. Matches `LLMToolDeclaration.name` the provider received. */
  name: string;
  /** Raw JSON-string arguments. Schema-conformant by construction. */
  arguments: string;
}

/**
 * Conversation message shape accepted by `provider.chat()`. Phase 3.3
 * extends the original `{ role, content }` shape with a tool-result
 * variant so the multi-step agent loop can feed tool results back to
 * the LLM.
 *
 * Discriminated on `role`:
 *   - "system" | "user" | "assistant" — plain content message.
 *   - "tool" — a tool-result message. The provider adapter translates
 *     this into the provider's tool-result format (OpenAI's
 *     `{role:"tool", tool_call_id, content}`, Anthropic's
 *     `{role:"user", content: [{type:"tool_result", tool_use_id,
 *     content}]}).
 */
export type LLMConversationMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "tool";
      /**
       * ID of the tool call this result answers. Matches
       * `LLMToolCall.id`. When the original call had no id (Anthropic
       * native), the provider adapter correlates by index.
       */
      toolCallId: string;
      /** Tool-result payload as a JSON string. */
      content: string;
    };

/**
 * Loose message shape accepted at API boundaries where the caller has
 * plain `{role, content}` messages (the original Phase 2 shape). This
 * is assignable to `LLMConversationMessage` without manual narrowing.
 * Used by harness call sites that build messages from prompt strings.
 */
export type LLMPlainMessage = { role: string; content: string };

/**
 * Result of a tool-calling LLM turn. The harness uses `toolCalls` to
 * dispatch side-effects and `textResponse` to emit `text-ready`.
 *
 * A turn may have:
 *  - tool calls only (no text) — the model is mid-trajectory
 *  - text only (no tool calls) — the model produced a final reply
 *  - both — the model emitted text alongside tool calls
 *  - neither — the model declined to act (treated as skip / non-actionable)
 */
export interface LLMChatResult {
  /** Spoken/assistant text, if any. Empty string when absent. */
  textResponse: string;
  /** Tool calls parsed from the response, if any. Empty array when absent. */
  toolCalls: LLMToolCall[];
}

export interface BaseLLMProvider {
  generate(
    messages: { role: string; content: string }[],
    maxTokens?: number,
    temperature?: number,
  ): Promise<string>;

  /**
   * OPTIONAL Phase 2 native tool-calling method. A provider that
   * supports tool-calling implements this; the harness checks for its
   * presence via `'chat' in provider` before routing to the tool-
   * calling dispatch path.
   *
   * When called, the provider must:
   *   1. Translate `tools` into the provider's tool-declaration format
   *      (using the backend template's `toolsPayloadTemplate`).
   *   2. Inject them into the request payload alongside `messages`.
   *   3. Run inference with constrained decoding active (provider-side).
   *   4. Parse `tool_calls` from the response using the template's
   *      `toolCallsResponsePath` + `toolCallArgsResponsePath`.
   *   5. Return the normalized `LLMChatResult`.
   *
   * Providers that don't support tool-calling simply omit this method —
   * callers MUST NOT assume it exists. Use `supportsToolCalling(provider)`
   * to check.
   *
   * NOTE: streaming is out of scope for Phase 2 (that's Phase 4). This
   * method returns the complete result; `textResponse` arrives whole,
   * not as deltas.
   */
  chat?(params: {
    /**
     * Phase 3.3 — widened to accept tool-result messages so the
     * multi-step agent loop can feed tool results back to the LLM.
     * Plain `{role, content}` messages remain valid (the original
     * Phase 2 shape). The provider's `chat()` implementation
     * normalizes via `normalizeMessagesForProvider`.
     */
    messages: Array<LLMConversationMessage | LLMPlainMessage>;
    tools: LLMToolDeclaration[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<LLMChatResult>;
}

/**
 * Runtime capability check. Returns true iff the provider implements
 * the optional `chat()` method. The harness uses this to decide which
 * dispatch path to take.
 *
 * Exported as part of the public contract so callers building custom
 * providers can also gate on it.
 */
export function supportsToolCalling(
  provider: BaseLLMProvider,
): provider is BaseLLMProvider & { chat: NonNullable<BaseLLMProvider['chat']> } {
  return typeof (provider as BaseLLMProvider).chat === 'function';
}

export type ModelCustomConfigValueType =
  | "string"
  | "stringArray"
  | "number"
  | "integer"
  | "boolean"
  | "enum";

export interface IModelCustomConfigField {
  key: string;
  label: string;
  valueType: ModelCustomConfigValueType;
  customerFacing?: boolean;
  isFile?: boolean;
  description?: string;
  required?: boolean;
  defaultValue?: string | number | boolean | string[];
  minItems?: number;
  maxItems?: number;
  min?: number;
  max?: number;
  step?: number;
  enumOptions?: string[];
  options?: string[];
}

export interface IVoiceModel {
  id: string;
  name: string;
  ttsProvider: string;
  voiceConfigPayload: Record<string, unknown>;
  dynamicParamPromptTemplate: string;
  dynamicParams: Array<{
    name: string;
    description: string;
    type: string;
    required: boolean;
    default?: unknown;
  }>;
  voiceOptions: Array<{
    id: string;
    name: string;
    description?: string;
    configPatch: Record<string, unknown>;
    dynamicParamPromptTemplate?: string;
    sampleUrl?: string;
  }>;
  voiceCustomConfigDefinition?: IModelCustomConfigField[];
  isPublic: boolean;
  pointsPerGeneration: number;
}

/**
 * Public LLM model entry returned by `GET /api/v1/cyber-soul/llm-models`.
 *
 * - `provider` is the value to pass as `llmConfig.provider`.
 * - `name` is the value to pass as `llmConfig.model`.
 * - `customConfigDefinition` describes the keys (and their constraints) that
 *   the model accepts via `llmConfig.customSettings`.
 */
export interface SupportedLLMModel {
  id: string;
  name: string;
  provider: string;
  customConfigDefinition: IModelCustomConfigField[];
}

export interface ICharacterProfile {
  id: string;
  name: string;
  voiceModelId?: string;
  voiceModelOptionId?: string;
  voiceCustomConfig?: Record<string, Record<string, unknown>>;
  visualModelId?: string;
  visualCustomConfig?: Record<string, Record<string, unknown>>;
  [key: string]: unknown; // Allow other properties to exist without breaking SDK clients that don't need them fully defined
}

export interface LikedPicture {
  url: string;
  date: string;
  mediaId?: string;
}
