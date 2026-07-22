/**
 * CyberSoulAgent — public Phase 3 surface (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * §4 Phase 3).
 *
 * Wraps a `CyberSoulClient` and exposes an `AsyncIterable<AgentEvent>`
 * instead of the legacy callback params. Existing consumers that use
 * `client.interact()` directly are UNCHANGED — `CyberSoulAgent` is the
 * "graduate to" surface for callers that want streaming-shaped event
 * consumption.
 *
 * What it does:
 *   - Translates the legacy `onTextReady` / `onMediaReady` /
 *     `onStateReady` / `onOutfitGifted` callbacks into an
 *     `AsyncIterable<AgentEvent>` the caller can `for await` over.
 *   - Emits a final `{ type: "turn-complete", response }` event
 *     carrying the full `InteractResponse` / `ProactiveResponse`.
 *   - Propagates typed `CyberSoulError` throws via iterator rejection
 *     (the `for await` loop throws — callers use `try/catch`).
 *
 * What it deliberately does NOT do:
 *   - It does NOT re-implement the harness, tool dispatch, context
 *     management, or prompt assembly. All of that is delegated to the
 *     wrapped `CyberSoulClient`. The agent is purely an event-delivery
 *     adapter.
 *   - It does NOT emit `text-delta` (arrives in Phase 4 with streaming)
 *     or `tool-call` / `tool-result` (arrives when the harness gains
 *     per-tool event emission — Phase 3.1 follow-up).
 *   - It does NOT mutate the client's behavior. The persona +
 *     custom tools + hooks passed to the constructor are stored for
 *     Phase 3.1; Phase 3 itself doesn't inject them.
 *
 * Error contract (mirrors `client.interact()`'s contract):
 *   - `CyberSoulError` subclasses (insufficient points, wallet, auth,
 *     capability mismatch, etc.) → iterator REJECTS → `for await`
 *     throws. Callers `instanceof`-branch in the catch.
 *   - Legacy `{ status: "error" }` envelope (for non-typed failures)
 *     → `turn-complete` fires with `response.status === "error"`. The
 *     iterator does NOT reject; the caller reads the response.
 *   - `{ status: "skipped" }` → `turn-complete` fires with
 *     `response.status === "skipped"`. Same: no rejection.
 *
 * Single-consumer contract: each `run()` call yields a FRESH async
 * iterator. Multiple concurrent `run()` calls produce independent
 * streams that don't interfere.
 */

import type { CyberSoulClient } from "../client.js";
import type {
  InteractResponse,
  ProactiveResponse,
} from "../types.js";
import type {
  AgentEvent,
  AgentProactiveParams,
  AgentRunParams,
  CyberSoulAgentOptions,
  Hook,
  Tool,
} from "./types.js";
import { AsyncEventQueue } from "./asyncEventQueue.js";

export class CyberSoulAgent {
  private readonly client: CyberSoulClient;
  private readonly hooks: Hook[];
  private readonly customTools: Tool[];
  private readonly systemPromptFragment: string | undefined;

  constructor(options: CyberSoulAgentOptions) {
    this.client = options.client;
    this.hooks = options.hooks ? [...options.hooks] : [];
    this.customTools = options.tools ? [...options.tools] : [];
    // Phase 3.1 — store the persona's systemPromptFragment so run() /
    // runProactive() can inject it into every turn. Other persona
    // fields (e.g. displayName) are still reserved for future
    // Phase 3.x wiring; only systemPromptFragment is consumed today.
    this.systemPromptFragment = options.persona?.systemPromptFragment;
  }

  /**
   * Resolve the effective systemPromptFragment for a turn: caller's
   * per-turn value wins over the agent's persona-level value (so a
   * caller can override or unset it ad-hoc). `undefined` when neither
   * is set → no injection, byte-identical to the legacy prompt.
   */
  private resolveSystemPromptFragment(
    turnLevel: string | undefined,
  ): string | undefined {
    if (turnLevel !== undefined) return turnLevel;
    return this.systemPromptFragment;
  }

  /**
   * Phase 3.1b — resolve the effective extraTools for a turn. Caller's
   * per-turn value wins over the agent's persona-level value (so a
   * caller can override or unset ad-hoc by passing `[]`). Empty when
   * neither is set → no extra tools registered.
   */
  private resolveExtraTools(
    turnLevel: Tool[] | undefined,
  ): Tool[] {
    if (turnLevel !== undefined) return turnLevel;
    return this.customTools;
  }

  /**
   * Run one interact turn, returning an async iterable of events.
   *
   * Events fire in the same order the legacy callbacks fire:
   *
   *   1. `text-ready`     — exactly once, after the dispatcher resolves
   *   2. `state-ready`    — once when the PATCH resolves (may fire
   *                         before or after media-ready depending on
   *                         which settles first — both run in parallel)
   *   3. `media-ready`    — zero or more times (once per modality that
   *                         actually generated)
   *   4. `outfit-gifted`  — zero or one time
   *   5. `turn-complete`  — exactly once, last, carrying the full
   *                         `InteractResponse`
   *
   * On a thrown `CyberSoulError`, the iterator rejects — no
   * `turn-complete` is emitted. Callers use `try/catch` around the
   * `for await` loop.
   */
  async *run(params: AgentRunParams): AsyncGenerator<AgentEvent> {
    const queue = new AsyncEventQueue<AgentEvent>();

    // Kick off the turn WITHOUT awaiting — we need to iterate the
    // queue concurrently so events can stream as they fire. The
    // turnPromise settles after every callback has fired; we close
    // the queue when it does.
    const turnPromise = this.client.interact({
      ...params,
      // Phase 3.1 — inject the persona's fragment unless the caller
      // explicitly overrode it at the turn level.
      systemPromptFragment: this.resolveSystemPromptFragment(
        params.systemPromptFragment,
      ),
      // Phase 3.1b — register the agent's custom tools alongside the
      // built-in toolset. Caller's per-turn extraTools (if any) wins
      // over the constructor-level persona tools.
      extraTools: this.resolveExtraTools(params.extraTools),
      // Phase 4 — forward streaming text deltas as text-delta events.
      onTextDelta: (delta) => {
        queue.push({ type: "text-delta", delta });
      },
      onTextReady: (text, actionText, metadata) => {
        queue.push({
          type: "text-ready",
          text,
          actionText,
          // The legacy callback allows `metadata === undefined`; the
          // event contract requires the field. Default to `{}` so the
          // shape is stable for consumers reading `ev.metadata.*`.
          metadata: metadata ?? {},
        });
      },
      onStateReady: (persisted) => {
        queue.push({ type: "state-ready", persisted });
      },
      onMediaReady: (payload) => {
        queue.push({ type: "media-ready", payload });
      },
      onOutfitGifted: (payload) => {
        queue.push({ type: "outfit-gifted", payload });
      },
    });

    // Wire the turn's completion to the queue's close. Two paths:
    //   - Success: emit turn-complete, then close normally.
    //   - Throw: close with error → iterator rejects.
    turnPromise
      .then((response: InteractResponse) => {
        for (const hook of this.hooks) {
          try {
            hook("onTurnComplete", { onTurnComplete: { response } });
          } catch {
            // Hooks are observers; their failures must never abort
            // the turn's event delivery.
          }
        }
        queue.push({ type: "turn-complete", response });
        queue.close();
      })
      .catch((error: unknown) => {
        for (const hook of this.hooks) {
          try {
            hook("onError", { onError: { error } });
          } catch {
            // same — observer failures are swallowed
          }
        }
        queue.closeWithError(error);
      });

    yield* queue;
  }

  /**
   * Run one proactive turn. Same event-delivery contract as `run()`
   * but delegates to `client.proactiveInteract()`. The
   * `turn-complete` event carries a `ProactiveResponse`.
   *
   * Skipped proactive turns (spam guard, LLM chose not to reach out)
   * arrive as `turn-complete` with `response.status === "skipped"`.
   */
  async *runProactive(
    params: AgentProactiveParams,
  ): AsyncGenerator<AgentEvent> {
    const queue = new AsyncEventQueue<AgentEvent>();

    const turnPromise = this.client.proactiveInteract({
      ...params,
      systemPromptFragment: this.resolveSystemPromptFragment(
        params.systemPromptFragment,
      ),
      extraTools: this.resolveExtraTools(params.extraTools),
      onTextDelta: (delta) => {
        queue.push({ type: "text-delta", delta });
      },
      onTextReady: (text, actionText, metadata) => {
        queue.push({
          type: "text-ready",
          text,
          actionText,
          metadata: metadata ?? {},
        });
      },
      onStateReady: (persisted) => {
        queue.push({ type: "state-ready", persisted });
      },
      onMediaReady: (payload) => {
        queue.push({ type: "media-ready", payload });
      },
      onOutfitGifted: (payload) => {
        queue.push({ type: "outfit-gifted", payload });
      },
    });

    turnPromise
      .then((response: ProactiveResponse) => {
        for (const hook of this.hooks) {
          try {
            hook("onTurnComplete", { onTurnComplete: { response } });
          } catch {
            // observer failures swallowed
          }
        }
        queue.push({ type: "turn-complete", response });
        queue.close();
      })
      .catch((error: unknown) => {
        for (const hook of this.hooks) {
          try {
            hook("onError", { onError: { error } });
          } catch {
            // same
          }
        }
        queue.closeWithError(error);
      });

    yield* queue;
  }
}
