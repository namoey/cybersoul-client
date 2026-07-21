/**
 * Agent-layer core types.
 *
 * These are the harness-grade primitives introduced in Phase 1 of the
 * agent-harness refactor (see
 * `cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md`
 * §3). They are intentionally NOT part of the public SDK contract today
 * — `client.ts` consumes them internally. Phase 3 may promote them to
 * the public `CyberSoulAgent` surface.
 *
 * Design notes:
 *  - A `Tool` is atomic, stateless, and single-step. Multi-step
 *    procedures (skills) are explicitly out of scope for this phase —
 *    see §3.7 of the tech-approach doc.
 *  - The `Tool` shape is forward-compatible with native function-calling
 *    (Phase 2): `name` + `inputSchema` + `description` map 1:1 to the
 *    fields a provider expects in a tool declaration.
 */

import type { DispatcherIntent } from "../types.js";

/* -------------------------------------------------------------------------- */
/* Tool                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * JSON-Schema-ish description of a tool's input. Kept as a permissive
 * `Record<string, unknown>` so the SDK does not depend on a JSON-Schema
 * library at runtime; `buildToolSchemasDoc()` in `tools/schemaDoc.ts`
 * renders the canonical schema strings used by the JSON-dispatcher
 * prompt (Phase 1) and the same data feeds the native function-calling
 * declarations (Phase 2).
 *
 * The schema is the SINGLE SOURCE OF TRUTH for the tool's input shape.
 * Both the prompt-injected schema doc and any future native tool
 * declaration MUST be derived from it — never hand-written a second
 * time. This is what closes the schema-drift gap called out in §6.2 of
 * the tech-approach doc.
 */
export type ToolInputSchema = Record<string, unknown>;

/**
 * A capability the character can invoke during a turn.
 *
 * Each current side-effect in `client.ts`'s `runInteractMediaTasks`
 * (image generation, voice generation, state PATCH, etc.) becomes one
 * `Tool`. So does each currently-embedded field of `DispatcherIntent`
 * (`stateUpdate`, `triggerEvent`, …). The tool's executor wraps the
 * existing `CyberSoulApi.*` call site — no transport logic is moved.
 *
 * Tools are stateless: their executor receives everything it needs via
 * `args` + `ctx`. The harness owns all IO scheduling and the event
 * stream; the tool only does the work for one capability.
 *
 * `TResult` is the shape the executor resolves with. The harness
 * collects these into the turn's `ToolResult[]`. In Phase 1 these
 * results are not fed back to the LLM (single-shot dispatcher), but
 * the type is shaped so Phase 2's run loop can do exactly that.
 */
export interface Tool<
  TArgs = Record<string, unknown>,
  TResult = unknown,
> {
  /** Stable identifier. Matches the JSON-schema key in the dispatcher prompt. */
  readonly name: string;
  /** One-line description. Will become the function-calling description in Phase 2. */
  readonly description: string;
  /** JSON-schema-ish input shape (single source of truth — see ToolInputSchema). */
  readonly inputSchema: ToolInputSchema;
  /** Executor. Calls `api.*` via `ctx`. Must be side-effect-pure apart from that. */
  readonly execute: (args: TArgs, ctx: ToolContext) => Promise<TResult>;
}

/**
 * The runtime context passed to every tool executor. Mirrors the
 * private fields of `CyberSoulClient` that today's inlined side-effect
 * code accesses directly.
 *
 * Tools MUST NOT reach back into the client. Anything they need is
 * passed in here, so tools are independently testable (seed a
 * `ToolContext` with mocks).
 */
export interface ToolContext {
  /** Backend transport — the existing, unchanged `CyberSoulApi` instance. */
  readonly api: import("../api/cyberSoulApi.js").CyberSoulApi;
  /** The character state fetched at turn start (already cached by ContextManager). */
  readonly state: import("../types.js").CharacterState;
  /** The full turn params (for callbacks like onMediaReady / onOutfitGifted). */
  readonly params: TurnParams;
}

/**
 * Minimal union of the turn-param shapes the tools care about. Kept
 * loose on purpose so both `InteractParams` and `ProactiveParams`
 * satisfy it without forcing a shared base class on the public types.
 */
export interface TurnParams {
  onMediaReady?: (payload: import("../types.js").MediaReadyPayload) => void;
  onOutfitGifted?: (
    payload: import("../types.js").OutfitGiftedPayload,
  ) => void;
}

/* -------------------------------------------------------------------------- */
/* Tool result (turn-level aggregation)                                       */
/* -------------------------------------------------------------------------- */

/**
 * One executed tool call in a turn's trajectory. In Phase 1 this is
 * collected purely so `client.ts` can fold the results back into the
 * legacy `InteractResponse` / `ProactiveResponse` shapes — same fields
 * the old inlined code populated.
 *
 * In Phase 2 the harness will also feed `result` back into the LLM
 * message history as a tool-result message.
 */
export interface ToolResult<TResult = unknown> {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly result: TResult;
  /**
   * Wall-clock ordering index, assigned by the harness. Tools execute
   * in parallel today (matching `Promise.all` semantics of
   * `runInteractMediaTasks`); this index preserves the order in which
   * the harness dispatched them, not the order they resolved in.
   */
  readonly order: number;
}

/**
 * A typed media failure captured by the harness, mirroring today's
 * `firstMediaError` + `affected` pair from `runInteractMediaTasks`.
 * One entry per failed tool that raised a typed `CyberSoulError`.
 */
export interface ToolFailure {
  readonly tool: string;
  readonly error: import("../errors.js").CyberSoulError;
}

/* -------------------------------------------------------------------------- */
/* Hook middleware                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Middleware seam introduced for §3.5. Phase 1 wires the hooks but
 * only uses them where existing behavior already emits a signal
 * (e.g. `onTurnComplete` is fired when the response object is built).
 * Hooks for compliance injection, moderation, cost caps, tracing
 * arrive in later phases — the type is here so the harness signature
 * is stable from day one.
 *
 * A hook is just an observer: it cannot mutate the turn. Hooks that
 * need to alter behavior (e.g. block a tool call) will arrive as a
 * separate `beforeTool` filter type when needed.
 */
export type HookName =
  | "onDispatchStart"
  | "onDispatchComplete"
  | "onToolStart"
  | "onToolComplete"
  | "onTurnComplete"
  | "onError";

export type Hook = (name: HookName, payload: HookPayload) => void;

export type HookPayload = {
  onDispatchStart?: { messages: Array<{ role: string; content: string }> };
  onDispatchComplete?: { raw: string; parsed: unknown };
  onToolStart?: { tool: string; args: Record<string, unknown> };
  onToolComplete?: {
    tool: string;
    result?: unknown;
    failure?: ToolFailure;
  };
  onTurnComplete?: { response: unknown };
  onError?: { error: unknown };
};

/* -------------------------------------------------------------------------- */
/* Event stream                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Discriminated union of events the harness emits during a turn. In
 * Phase 1 only the subset that maps 1:1 to existing callbacks is
 * emitted — this guarantees the legacy `onTextReady` / `onMediaReady`
 * / `onStateReady` / `onOutfitGifted` callbacks fire with identical
 * args and identical timing.
 *
 * `text-delta` and `tool-call` events are reserved for Phase 2/3
 * (streaming + native tool-calling). They're in the union now so the
 * public `EventStream` shape is stable.
 */
export type AgentEvent =
  | { type: "text-ready"; text: string; actionText?: string; metadata: import("../types.js").InteractMetadata }
  | { type: "state-ready"; persisted: import("../types.js").PersistedDynamicContext }
  | { type: "media-ready"; payload: import("../types.js").MediaReadyPayload }
  | { type: "outfit-gifted"; payload: import("../types.js").OutfitGiftedPayload }
  // Phase 2+ events — reserved, not emitted in Phase 1:
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; tool: string; args: Record<string, unknown> }
  | { type: "tool-result"; tool: string; result: unknown }
  | { type: "turn-complete"; response: unknown };

/**
 * Sink for `AgentEvent`s. The harness calls `emit()` exactly when the
 * legacy code would have called the matching callback — same args,
 * same ordering, same "fires once" or "fires per modality" semantics.
 *
 * `EventStream` (in `agent/eventStream.ts`) implements this and fans
 * the events back out to the legacy callbacks. The indirection is what
 * lets Phase 3 expose a public `AsyncIterable<AgentEvent>` without
 * touching the harness.
 */
export interface AgentEventSink {
  emit(event: AgentEvent): void;
}

/* -------------------------------------------------------------------------- */
/* Dispatcher-decision result (parsed intent)                                 */
/* -------------------------------------------------------------------------- */

/**
 * The parsed dispatcher decision for a turn. In Phase 1 this is just
 * `DispatcherIntent` itself — the harness runs the existing
 * single-shot JSON-dispatcher path as a degenerate one-iteration loop.
 *
 * Kept as a named type (rather than inlining `DispatcherIntent`) so
 * Phase 2 can swap it for a richer "list of tool calls" shape without
 * touching the harness signature.
 */
export type DispatchDecision = DispatcherIntent;
