/**
 * HistoryCompactor — Phase 3.1 in-turn memory compaction (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * Phase 3.1 Deferred → "In-turn memory compaction").
 *
 * Today `buildHistoryTranscript` slices the last 20 entries and ships
 * them verbatim every turn. When history grows beyond that window,
 * older entries are silently dropped — the companion "forgets" the
 * emotionally-weighty moments that happened earlier in the session.
 *
 * HistoryCompactor addresses this by folding entries BEYOND the
 * recent window into a compact "[BEFORE THAT]" block prepended to the
 * transcript. The recent window stays verbatim (the LLM needs the
 * exact last messages for immediate-reply coherence); the older
 * entries become a condensed reference the LLM can draw on for
 * continuity.
 *
 * Compaction strategy (two tiers, pluggable):
 *
 *   1. **BULLET** (default, no LLM cost) — older entries become a
 *      compact one-line-per-turn bullet list with timestamps. Zero
 *      latency overhead. Good enough for short sessions (< 50 turns).
 *
 *   2. **LLM_SUMMARY** (opt-in, expensive) — older entries are sent
 *      to `client.summarizeHistory` which produces a narrative
 *      paragraph in the character's first-person voice. Cached so
 *      it's not re-computed every turn; only re-summarized when the
 *      older-window grows past a re-summarization threshold.
 *
 * The compactor is per-session stateful: it caches the compacted
 * summary and only re-compacts when new entries roll out of the
 * recent window. Construction is cheap; call `compact()` on every
 * turn and the cache makes it a no-op when nothing changed.
 *
 * DEFAULT BEHAVIOR IS UNCHANGED: `maxRawEntries` defaults to 20
 * (today's slice) and `strategy` defaults to BULLET. The compactor
 * only activates when history.length > maxRawEntries. Existing
 * callers that pass ≤20 entries see byte-identical transcripts.
 */

import type { HistoryEntry } from "../types.js";
import { formatHistoryEntries } from "../utils/history.utils.js";
import { getElapsedTimeInfo } from "../utils/time.utils.js";

export type CompactionStrategy = "bullet" | "llm-summary";

export interface HistoryCompactorOptions {
  /**
   * Max entries to keep verbatim in the recent window. Older entries
   * are compacted. Defaults to 20 (today's behavior).
   */
  maxRawEntries?: number;
  /**
   * Compaction strategy for entries beyond the recent window.
   *   - "bullet" (default): compact one-line-per-turn bullet list.
   *     Zero LLM cost.
   *   - "llm-summary": narrative paragraph via client.summarizeHistory.
   *     Expensive; cached.
   */
  strategy?: CompactionStrategy;
  /**
   * Only relevant for "llm-summary". Re-summarize when the compacted
   * window grows by this many new entries since the last summary.
   * Defaults to 10 — means the summary refreshes every ~10 turns.
   */
  reSummarizeThreshold?: number;
}

export interface CompactedHistory {
  /**
   * The full transcript string ready for prompt injection. When no
   * compaction was needed (history ≤ maxRawEntries), this is just the
   * raw transcript — byte-identical to today's `buildHistoryTranscript`.
   */
  transcript: string;
  /** True when compaction actually happened (entries were folded). */
  wasCompacted: boolean;
  /** Number of entries in the recent verbatim window. */
  recentCount: number;
  /** Number of entries that were folded into the compacted block. */
  compactedCount: number;
}

/**
 * Build a compact bullet-list summary of older history entries.
 *
 * Each entry becomes one line: `[time-gap] speaker: content (truncated)`.
 * This is NOT an LLM summary — it's a deterministic format that gives
 * the LLM enough context to maintain continuity without the token cost
 * of the full transcript.
 *
 * Pure function, no IO. Used by both the "bullet" strategy and as the
 * fallback when "llm-summary" hasn't computed yet.
 */
export function buildBulletSummary(
  entries: HistoryEntry[],
  userName: string,
  agentName: string,
): string {
  if (entries.length === 0) return "";

  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const msg = entries[i];
    const speaker =
      msg.role === "user"
        ? userName
        : msg.role === "assistant" || msg.role === "agent"
          ? agentName
          : msg.role;

    // Time-gap marker (same logic as formatHistoryEntries but simpler)
    let gap = "";
    if (i > 0 && entries[i - 1].timestamp && msg.timestamp) {
      const prev = new Date(entries[i - 1].timestamp!).getTime();
      const curr = new Date(msg.timestamp!).getTime();
      const info = getElapsedTimeInfo(curr, prev);
      if (info.elapsedHours > 1) {
        gap = `[${info.displayStr} later] `;
      }
    }

    // Truncate long content — the bullet summary is a reference, not
    // a verbatim transcript. 80 chars is enough for the LLM to recall
    // the topic without paying for the full message.
    const content =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    const truncated =
      content.length > 80 ? content.slice(0, 77) + "..." : content;

    const action = msg.actionText ? ` (${msg.actionText})` : "";
    const media = msg.mediaHint ? ` [${msg.mediaHint}]` : "";
    lines.push(`- ${gap}${speaker}:${action} ${truncated}${media}`);
  }

  return lines.join("\n");
}

export class HistoryCompactor {
  private readonly maxRawEntries: number;
  private readonly strategy: CompactionStrategy;
  private readonly reSummarizeThreshold: number;

  // Cache state for llm-summary strategy. Tracks which entries have
  // been summarized so we only re-summarize when new ones roll out.
  private lastSummarizedIndex = -1;
  private cachedSummary: string | null = null;
  private cachedEntryCount = 0;

  constructor(opts: HistoryCompactorOptions = {}) {
    this.maxRawEntries = opts.maxRawEntries ?? 20;
    this.strategy = opts.strategy ?? "bullet";
    this.reSummarizeThreshold = opts.reSummarizeThreshold ?? 10;
  }

  /**
   * Compact a history array into a transcript-ready string.
   *
   * When `history.length ≤ maxRawEntries`, returns the verbatim
   * transcript via `formatHistoryEntries` — byte-identical to today's
   * `buildHistoryTranscript` for the same input.
   *
   * When `history.length > maxRawEntries`, splits into:
   *   - recent window: last `maxRawEntries` entries → verbatim
   *   - older entries: everything before → compacted block
   *
   * The compacted block is prepended as:
   *   `[BEFORE THAT — condensed reference]\n<summary>\n\n`
   *
   * For "bullet" strategy the summary is computed inline (no IO). For
   * "llm-summary" strategy, the caller MUST provide `summarizeFn` —
   * otherwise falls back to bullet. The summary is cached.
   */
  compact(
    history: HistoryEntry[],
    userName: string,
    agentName: string,
    summarizeFn?: (entries: HistoryEntry[]) => Promise<string>,
  ): CompactedHistory {
    if (history.length === 0) {
      return {
        transcript: "",
        wasCompacted: false,
        recentCount: 0,
        compactedCount: 0,
      };
    }

    // No compaction needed — verbatim, same as today.
    if (history.length <= this.maxRawEntries) {
      const directive =
        "The previous chat history is completely outdated by the time passage. Do not continue its immediate action flow.";
      return {
        transcript: `[CHAT HISTORY]\n${formatHistoryEntries(
          history,
          userName,
          agentName,
          directive,
        )}\n`,
        wasCompacted: false,
        recentCount: history.length,
        compactedCount: 0,
      };
    }

    // Split: older entries + recent window.
    const splitIdx = history.length - this.maxRawEntries;
    const olderEntries = history.slice(0, splitIdx);
    const recentEntries = history.slice(splitIdx);

    // Build the compacted summary for the older entries.
    let summary: string;
    if (this.strategy === "llm-summary" && summarizeFn) {
      // Re-summarize only when enough new entries have rolled out of
      // the recent window. The cache makes per-turn calls cheap.
      const newEntriesSinceLastSummary =
        splitIdx - 1 - this.lastSummarizedIndex;
      if (
        this.cachedSummary === null ||
        newEntriesSinceLastSummary >= this.reSummarizeThreshold
      ) {
        // NOTE: this is async but we're in a sync method. The caller
        // MUST use compactAsync() for llm-summary. If they land here
        // via compact(), fall back to bullet to avoid a deadlock.
        summary = buildBulletSummary(olderEntries, userName, agentName);
      } else {
        summary = this.cachedSummary!;
      }
    } else {
      // Bullet strategy — always inline, no cache needed.
      summary = buildBulletSummary(olderEntries, userName, agentName);
    }

    const directive =
      "The previous chat history is completely outdated by the time passage. Do not continue its immediate action flow.";
    const recentTranscript = formatHistoryEntries(
      recentEntries,
      userName,
      agentName,
      directive,
    );

    const transcript =
      `[CHAT HISTORY]\n` +
      `[BEFORE THAT — condensed reference for continuity]\n${summary}\n\n` +
      `${recentTranscript}\n`;

    return {
      transcript,
      wasCompacted: true,
      recentCount: recentEntries.length,
      compactedCount: olderEntries.length,
    };
  }

  /**
   * Async variant for the "llm-summary" strategy. Re-summarizes the
   * older window via the provided `summarizeFn` when the cache is
   * stale, then returns the compacted transcript.
   *
   * For "bullet" strategy this is identical to `compact()` (no await
   * needed) but still async for API uniformity.
   */
  async compactAsync(
    history: HistoryEntry[],
    userName: string,
    agentName: string,
    summarizeFn?: (entries: HistoryEntry[]) => Promise<string>,
  ): Promise<CompactedHistory> {
    if (
      this.strategy !== "llm-summary" ||
      !summarizeFn ||
      history.length <= this.maxRawEntries
    ) {
      return this.compact(history, userName, agentName, summarizeFn);
    }

    const splitIdx = history.length - this.maxRawEntries;
    const olderEntries = history.slice(0, splitIdx);
    const newEntriesSinceLastSummary = splitIdx - 1 - this.lastSummarizedIndex;

    if (
      this.cachedSummary === null ||
      newEntriesSinceLastSummary >= this.reSummarizeThreshold
    ) {
      try {
        this.cachedSummary = await summarizeFn(olderEntries);
        this.lastSummarizedIndex = splitIdx - 1;
        this.cachedEntryCount = olderEntries.length;
      } catch {
        // Fall back to bullet on summarization failure — never block
        // the turn on a summary hiccup.
        this.cachedSummary = buildBulletSummary(
          olderEntries,
          userName,
          agentName,
        );
      }
    }

    // Delegate to compact() with the now-fresh cache.
    return this.compact(history, userName, agentName, summarizeFn);
  }

  /** Invalidate the cached summary. Call when history is reset. */
  reset(): void {
    this.lastSummarizedIndex = -1;
    this.cachedSummary = null;
    this.cachedEntryCount = 0;
  }
}
