/**
 * EventStream — unified internal sink for `AgentEvent`s.
 *
 * Phase 1 extraction target (see
 * `cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md`
 * §3.6 and §6.4). Replaces the four ad-hoc callback params
 * (`onTextReady` / `onMediaReady` / `onStateReady` / `onOutfitGifted`)
 * with a single `AgentEventSink` that the harness emits into.
 *
 * The legacy callbacks come back via `EventStream.attachLegacy()`,
 * which is the backward-compat shim. Phase 3 will add `asIterable()`
 * so a public `AsyncIterable<AgentEvent>` surface can be exposed
 * without touching the harness.
 *
 * BEHAVIOR CONTRACT (§5.4 items 1, 2, 3):
 *  - Each legacy callback fires with EXACTLY the same args and timing
 *    it had before. The harness emits one `AgentEvent` per logical
 *    signal; this class translates 1:1.
 *  - Callback exceptions are caught and logged, NEVER rethrown — same
 *    as today's inlined try/catch blocks around every callback site.
 */

import type {
  AgentEvent,
  AgentEventSink,
  Hook,
} from "./types.js";
import type {
  InteractMetadata,
  MediaReadyPayload,
  OutfitGiftedPayload,
  PersistedDynamicContext,
} from "../types.js";

/**
 * The legacy callback set. Each is optional, mirroring `InteractParams`
 * / `ProactiveParams`. A handler that throws is logged and swallowed.
 */
export interface LegacyCallbacks {
  onTextReady?: (
    textResponse: string,
    actionText?: string,
    metadata?: InteractMetadata,
  ) => void;
  /** Phase 4 — streaming text-delta callback. */
  onTextDelta?: (delta: string) => void;
  onStateReady?: (persisted: PersistedDynamicContext) => void;
  onMediaReady?: (payload: MediaReadyPayload) => void;
  onOutfitGifted?: (payload: OutfitGiftedPayload) => void;
}

export class EventStream implements AgentEventSink {
  private legacy: LegacyCallbacks = {};
  private hooks: Hook[] = [];

  /**
   * Attach the legacy callback set. All subsequent `emit()` calls fan
   * out to whichever legacy callbacks are present.
   */
  attachLegacy(callbacks: LegacyCallbacks): this {
    this.legacy = { ...callbacks };
    return this;
  }

  /** Attach a hook observer (Phase 1 wires hooks; only onTurnComplete fires yet). */
  attachHook(hook: Hook): this {
    this.hooks.push(hook);
    return this;
  }

  /**
   * Emit one event. Translates to the matching legacy callback(s).
   * Any throw inside a callback is logged and swallowed — identical
   * to today's inlined try/catch around every callback invocation.
   */
  emit(event: AgentEvent): void {
    switch (event.type) {
      case "text-ready": {
        if (this.legacy.onTextReady) {
          try {
            this.legacy.onTextReady(
              event.text,
              event.actionText,
              event.metadata,
            );
          } catch (cbErr) {
            console.warn(
              "[CyberSoulClient] onTextReady callback threw:",
              cbErr,
            );
          }
        }
        break;
      }
      case "state-ready": {
        if (this.legacy.onStateReady) {
          try {
            this.legacy.onStateReady(event.persisted);
          } catch (cbErr) {
            console.warn(
              "[CyberSoulClient] onStateReady callback threw:",
              cbErr,
            );
          }
        }
        break;
      }
      case "media-ready": {
        if (this.legacy.onMediaReady) {
          try {
            this.legacy.onMediaReady(event.payload);
          } catch (cbErr) {
            console.warn(
              `[CyberSoulClient] onMediaReady(${event.payload.modality}) threw:`,
              cbErr,
            );
          }
        }
        break;
      }
      case "outfit-gifted": {
        if (this.legacy.onOutfitGifted) {
          try {
            this.legacy.onOutfitGifted(event.payload);
          } catch (cbErr) {
            console.warn(
              "[CyberSoulClient] onOutfitGifted callback threw:",
              cbErr,
            );
          }
        }
        break;
      }
      // Phase 2+ events — not yet emitted by the harness in Phase 1.
      // They exist in the union so the public EventStream shape is stable.
      case "text-delta": {
        // Phase 4 — forward to the onTextDelta callback when present.
        if (this.legacy.onTextDelta) {
          try {
            this.legacy.onTextDelta(event.delta);
          } catch (cbErr) {
            console.warn(
              "[CyberSoulClient] onTextDelta callback threw:",
              cbErr,
            );
          }
        }
        break;
      }
      case "tool-call":
      case "tool-result":
      case "turn-complete":
        // No legacy equivalent — intentionally no-op for these.
        break;
    }
  }
}
