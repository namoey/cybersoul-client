import { HistoryEntry } from "../types.js";
import { getElapsedTimeInfo } from "./time.utils.js";

/**
 * History transcript formatting.
 *
 * Pure data → string transformation. The prompt layer consumes the
 * output to build `[CHAT HISTORY]` blocks, but this function itself
 * contains no prompt directives — it only decides how to lay out
 * history entries as labeled chat lines and where to splice in
 * elapsed-time separators.
 */

/**
 * Render a list of chat history entries as a flat transcript string.
 *
 * Each entry becomes a `speaker: (action) content [media] [event]` line.
 * When two consecutive entries are more than an hour apart, a
 * `[--- {time} later{ ?directive} ---]` separator is inserted between
 * them so downstream consumers (the prompt layer, the summarizer) can
 * surface the time gap.
 *
 * @param history     The entries to render (caller is responsible for
 *                    any slicing/windowing).
 * @param userName    Label to use for `role === "user"` lines.
 * @param agentName   Label to use for `role === "assistant"|"agent"` lines.
 * @param promptDirective Optional suffix appended to the time-gap
 *                    separator (e.g. an "outdated history" warning).
 *                    Empty by default — keep this function directive-free.
 */
export function formatHistoryEntries(
  history: HistoryEntry[],
  userName: string,
  agentName: string,
  promptDirective: string = "",
): string {
  const contextLines: string[] = [];

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];

    if (i > 0 && history[i - 1].timestamp && msg.timestamp) {
      const prevTime = new Date(history[i - 1].timestamp!).getTime();
      const currTime = new Date(msg.timestamp!).getTime();
      const timeInfo = getElapsedTimeInfo(currTime, prevTime);

      if (timeInfo.elapsedHours > 1) {
        contextLines.push(
          `\n[--- ${timeInfo.displayStr} later ---${promptDirective ? " " + promptDirective : ""} ---]\n`,
        );
      }
    }

    const speaker =
      msg.role === "user"
        ? userName
        : msg.role === "assistant" || msg.role === "agent"
          ? agentName
          : msg.role;
    const content =
      typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    const action = msg.actionText ? ` (${msg.actionText})` : "";
    const media = msg.mediaHint ? ` [${msg.mediaHint}]` : "";
    const event = msg.eventHint ? ` [Triggered Event: ${msg.eventHint}]` : "";
    contextLines.push(`${speaker}:${action} ${content}${media}${event}`);
  }

  return contextLines.join("\n");
}

/**
 * Spam guard. Counts assistant *turns* since the last user reply.
 *
 * A single character response can be emitted as multiple HistoryEntry
 * rows (one per modality: text + image + voice). The host typically
 * writes them within seconds of each other. Counting entries directly
 * would treat one multimodal reply as 2-3 "unreplied messages" and
 * trip `maxUnreplied = 2` on the very first proactive attempt.
 * Collapse consecutive assistant entries whose timestamps are within
 * SAME_TURN_WINDOW_MS into a single turn before counting.
 */
export function countConsecutiveProactiveTurns(history: HistoryEntry[]): number {
  const SAME_TURN_WINDOW_MS = 60_000;
  let consecutiveProactive = 0;
  let lastAssistantTs: number | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === "user") break;
    if (msg.role !== "assistant") continue;
    const ts = typeof msg.timestamp === "number" ? msg.timestamp : 0;
    if (
      lastAssistantTs === null ||
      Math.abs(lastAssistantTs - ts) > SAME_TURN_WINDOW_MS
    ) {
      consecutiveProactive++;
    }
    lastAssistantTs = ts;
  }
  return consecutiveProactive;
}
