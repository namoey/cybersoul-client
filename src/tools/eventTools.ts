/**
 * Event tools — auto-triggered ondemand events.
 *
 * Phase 1 extraction. Lifts the legacy auto-trigger branch from
 * `runInteractMediaTasks` verbatim: same field-coalescing
 * (`durationMins ?? 60`, `outfitId || undefined`, etc.) and the same
 * swallow-on-failure semantics. The auto-triggered event is a
 * side-effect; its failure is logged but does NOT abort the turn
 * (mirrors `runInteractMediaTasks`'s `.catch` on this specific task).
 */

import type { Tool } from "../agent/types.js";
import type { DispatcherIntent } from "../types.js";
import {
  EVENT_TOOL_DESCRIPTION,
  buildEventToolInputSchema,
} from "../prompts/event.js";

export interface TriggerEventResult {
  /** Always `undefined` today — the legacy path doesn't surface the created event back. Here for Phase 2 observability. */
  triggered?: {
    eventTitle?: string;
    eventDescription: string;
    durationMins?: number;
    outfitId?: string | null;
    scheduledStartTimeStr?: string | null;
    scheduledDateStr?: string | null;
  };
}

export function buildTriggerEventTool(): Tool<
  NonNullable<DispatcherIntent["triggerEvent"]>,
  TriggerEventResult
> {
  return {
    name: "trigger_event",
    description: EVENT_TOOL_DESCRIPTION,
    inputSchema: buildEventToolInputSchema(),
    async execute(args, ctx) {
      try {
        await ctx.api.triggerOndemandEvent({
          eventTitle: args.eventTitle,
          eventDescription: args.eventDescription,
          durationMins: args.durationMins || 60,
          outfitId: args.outfitId || undefined,
          scheduledStartTimeStr: args.scheduledStartTimeStr || undefined,
          scheduledDateStr: args.scheduledDateStr || undefined,
        });
        return { triggered: { ...args } };
      } catch (e) {
        console.error(
          "[CyberSoulClient] Auto-triggered ondemandEvent failed:",
          e,
        );
        return {};
      }
    },
  };
}
