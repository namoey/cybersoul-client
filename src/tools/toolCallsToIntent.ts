/**
 * Tool-call → DispatcherIntent adapter.
 *
 * The crucial bridge that lets Phase 2's native tool-calling path
 * reuse ALL of the harness's existing side-effect machinery (§3.2,
 * §3.3, §4 Phase 2 of the tech-approach doc). The harness's
 * `runInteractSideEffects`, `startInteractStateUpdate`, etc. all read
 * fields off `DispatcherIntent`. This adapter takes the structured
 * `LLMToolCall[]` returned by `provider.chat()` and folds them into
 * the same `DispatcherIntent` shape — so neither the side-effect layer
 * nor `client.ts`'s response assembly need to know which dispatch
 * path produced the intent.
 *
 * Mapping rules (mirror the schema in §3.1 / tools/*):
 *
 *   speak({ text, actionText })
 *     → textResponse, actionText
 *
 *   generate_image({ ...imageParams })
 *     → imageParams
 *
 *   generate_voice({ textForVoice, dynamicArgs })
 *     → voiceArgs = dynamicArgs   (textForVoice is derived from
 *                                  textResponse by the harness today;
 *                                  the legacy dispatcher didn't carry
 *                                  it either)
 *
 *   update_state({ stateUpdate, userAnalysis })
 *     → stateUpdate, userAnalysis
 *
 *   trigger_event({ ... })
 *     → triggerEvent
 *
 *   gift_outfit({ descriptionText })
 *     → giftOutfit = { descriptionText }
 *
 *   like_picture({})
 *     → likePreviousPicture = true   (presence == true)
 *
 *   end_turn({})
 *     → isEndTurn = true             (presence == true)
 *
 *   skip_turn({ reason })
 *     → shouldSkipInteract = true, skipReason = reason
 *
 *   skip_proactive({ reason })
 *     → shouldSkipProactive = true, skipReason = reason
 *
 * Unknown tool calls are logged and skipped (forward-compat: a future
 * tool added to the registry that this adapter doesn't know about
 * degrades gracefully rather than crashing).
 *
 * JSON.parse() failures on a tool call's arguments are logged but NOT
 * rethrown — constrained decoding (§3.3.1) makes them structurally
 * impossible in practice, but defending against provider bugs keeps
 * Phase 2 fail-safe relative to the JSON-dispatcher path.
 */

import type { DispatcherIntent } from "../types.js";
import type { LLMToolCall } from "../types.js";

/**
 * Fold a list of tool calls into a `DispatcherIntent`. Pure function —
 * no IO, no state. Used by the harness after `provider.chat()` returns.
 *
 * Multiple calls of the same tool (rare, but possible if the model
 * splits its intent across calls) merge by last-wins for scalar fields
 * and by concat for array-shaped fields. Today the intent shape has no
 * arrays, so last-wins is the rule.
 */
export function toolCallsToIntent(toolCalls: LLMToolCall[]): DispatcherIntent {
  const intent: DispatcherIntent = { textResponse: "" };

  for (const call of toolCalls) {
    let args: Record<string, unknown> = {};
    if (call.arguments && call.arguments.length > 0) {
      try {
        const parsed = JSON.parse(call.arguments);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch (e) {
        // Constrained decoding makes this impossible in practice, but
        // fail-safe rather than fail-loud — the JSON-dispatcher path
        // also tolerates partial intent.
        console.warn(
          `[CyberSoulClient] Failed to parse arguments for tool call '${call.name}' (expected impossible with constrained decoding):`,
          e,
        );
        continue;
      }
    }

    switch (call.name) {
      case "speak": {
        if (typeof args.text === "string") intent.textResponse = args.text;
        if (typeof args.actionText === "string") intent.actionText = args.actionText;
        break;
      }
      case "generate_image": {
        // imageParams is opaque to the SDK — pass whatever the model
        // emitted straight through (mirrors the legacy dispatcher).
        intent.imageParams = args;
        break;
      }
      case "generate_voice": {
        // The tool input carries `dynamicArgs`; the harness derives
        // `textForVoice` from the resolved textResponse downstream.
        if (args.dynamicArgs && typeof args.dynamicArgs === "object") {
          intent.voiceArgs = args.dynamicArgs as Record<string, unknown>;
        } else {
          intent.voiceArgs = {};
        }
        break;
      }
      case "update_state": {
        if (args.stateUpdate && typeof args.stateUpdate === "object") {
          intent.stateUpdate = args.stateUpdate as DispatcherIntent["stateUpdate"];
        }
        if (args.userAnalysis && typeof args.userAnalysis === "object") {
          intent.userAnalysis = args.userAnalysis as DispatcherIntent["userAnalysis"];
        }
        break;
      }
      case "trigger_event": {
        intent.triggerEvent = {
          eventDescription:
            typeof args.eventDescription === "string"
              ? args.eventDescription
              : "",
          eventTitle: typeof args.eventTitle === "string" ? args.eventTitle : undefined,
          durationMins:
            typeof args.durationMins === "number" ? args.durationMins : undefined,
          outfitId:
            typeof args.outfitId === "string"
              ? args.outfitId
              : null,
          scheduledStartTimeStr:
            typeof args.scheduledStartTimeStr === "string"
              ? args.scheduledStartTimeStr
              : null,
          scheduledDateStr:
            typeof args.scheduledDateStr === "string" ? args.scheduledDateStr : null,
        };
        break;
      }
      case "gift_outfit": {
        if (typeof args.descriptionText === "string") {
          intent.giftOutfit = { descriptionText: args.descriptionText };
        }
        break;
      }
      case "like_picture": {
        intent.likePreviousPicture = true;
        break;
      }
      case "end_turn": {
        intent.isEndTurn = true;
        break;
      }
      case "skip_turn": {
        intent.shouldSkipInteract = true;
        if (typeof args.reason === "string") intent.skipReason = args.reason;
        break;
      }
      case "skip_proactive": {
        intent.shouldSkipProactive = true;
        if (typeof args.reason === "string") intent.skipReason = args.reason;
        break;
      }
      default:
        // Forward-compat: unknown tools degrade gracefully. No crash,
        // no intent field populated. A future SDK version may promote
        // the unknown tool to a first-class intent field.
        console.warn(
          `[CyberSoulClient] Unrecognized tool call '${call.name}' — skipped.`,
        );
        break;
    }
  }

  return intent;
}
