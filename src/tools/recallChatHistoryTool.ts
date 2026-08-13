/**
 * Recall chat-history tool.
 *
 * Lets the character, mid-turn, retrieve past conversation turns that
 * are NOT in its recent context window. Use case: the user asks
 * recall-style questions ("do you remember what I said about…",
 * "what happened at work last week?") and the detail lives in older
 * history the SDK's recent-transcript slice doesn't include.
 *
 * Architecture (see `cybersoul-chat/docs/recall-chat-history-tool.md`):
 *
 *   - The SDK owns the tool's CONTRACT: name, description, input
 *     schema, and the LLM-friendly result formatting. This is shared
 *     and drift-free across hosts (`cybersoul-chat`, `cybersoul-web`).
 *   - The HOST owns EXECUTION: where history lives (MMKV blob, SQLite
 *     table, remote index, …) is host-specific, so the host supplies a
 *     `ChatHistorySearcher` closure that the tool calls. This mirrors
 *     the existing `buildGenerateImageTool` / `buildUpdateStateTool`
 *     convention: SDK owns the tool, host supplies the transport.
 *
 * The searcher contract is intentionally vector-ready: Phase A ships a
 * keyword scan (case-insensitive OR-match over the in-memory history)
 * and Phase B may swap in sqlite-vec cosine search — both implement
 * the same `ChatHistorySearcher` signature, so the swap requires zero
 * SDK change (only the closure the host passes in changes).
 *
 * This tool is an INTERMEDIATE step: its result is consumed by the LLM
 * via the existing Phase 3.3 multi-step agent loop (when
 * `capabilities.toolCalling` is active and `agentLoop` is enabled) and
 * folded into the model's final reply. The tool does NOT emit any
 * `AgentEvent` and does NOT touch `ToolContext` — it operates purely
 * through the injected searcher, so it needs nothing from
 * `{ api, state, params }`.
 *
 * Capability gating: custom tools only fire when
 * `capabilities.toolCalling` is active. On the classic JSON-dispatcher
 * path the tool is registered but never invoked (no behavior change).
 */

import type { Tool } from "../agent/types.js";

/* -------------------------------------------------------------------------- */
/* Types — the host/SDK contract                                              */
/* -------------------------------------------------------------------------- */

/**
 * Arguments the LLM emits when calling `recall_chat_history`. The SDK
 * forwards them verbatim to the host-supplied searcher.
 *
 *  - `query`: an array of salient terms the LLM extracted from the
 *    user's question. OR-matching (a message matches if it contains
 *    ANY term, case-insensitive) — recall is the priority; the LLM
 *    filters downstream. Omit to return all messages in the date range.
 *  - `dateFrom` / `dateTo`: ISO 8601 bounds (inclusive). The tool
 *    description injects today's date so the LLM can resolve relative
 *    words ("yesterday", "last week") to concrete ISO values.
 *  - `role`: restrict to one side of the conversation. Omit for both.
 *  - `limit`: max messages to return. The SDK caps this at the tool's
 *    configured `maxHits` even if the LLM asks for more.
 */
export interface RecallChatHistoryArgs {
  query?: string[];
  dateFrom?: string;
  dateTo?: string;
  role?: "user" | "assistant";
  limit?: number;
}

/**
 * One recalled message. The host maps its persisted message shape
 * (GiftedChat `IMessage`, a SQLite row, …) into this neutral form.
 */
export interface RecallChatHistoryHit {
  role: "user" | "assistant";
  content: string;
  /** Epoch milliseconds. */
  timestamp: number;
}

/**
 * Tool result. The `transcript` is a compact, chronological,
 * token-bounded string the LLM reads and weaves into its reply.
 */
export interface RecallChatHistoryResult {
  /**
   * Chronological, compact transcript. One line per hit:
   *
   *   [YYYY-MM-DD HH:MM] role: content
   *
   * The SDK owns this formatting so every host produces identical
   * output. Once `maxTranscriptChars` is reached, formatting stops and
   * `truncated` is set.
   */
  transcript: string;
  /** Number of messages returned. */
  hitCount: number;
  /** True if the limit or character budget was hit (more matches exist). */
  truncated: boolean;
}

/**
 * Supplied by the host. Reads local history, filters, returns matches
 * in chronological order (oldest first). The SDK tool handles capping
 * + formatting.
 *
 * Phase A: keyword scan over the host's in-memory history.
 * Phase B: sqlite-vec cosine search (same signature).
 *
 * May be sync or async; the tool awaits either.
 */
export type ChatHistorySearcher = (
  args: RecallChatHistoryArgs,
) => Promise<RecallChatHistoryHit[]> | RecallChatHistoryHit[];

/* -------------------------------------------------------------------------- */
/* Formatter — owned by the SDK so output is drift-free across hosts          */
/* -------------------------------------------------------------------------- */

/**
 * Format a list of hits into a compact, chronological transcript,
 * stopping at the message-count or character-budget cap. Pure / no IO
 * — unit-tested directly.
 *
 * @param hits    Chronological (oldest-first) hits from the searcher.
 * @param maxHits Hard cap on number of lines. Defaults to 10.
 * @param maxChars Soft cap on total transcript length. Once exceeded,
 *                 formatting stops and `truncated` is set. Defaults to 2000.
 */
export function formatRecallTranscript(
  hits: RecallChatHistoryHit[],
  maxHits = 10,
  maxChars = 2000,
): { transcript: string; hitCount: number; truncated: boolean } {
  if (hits.length === 0) {
    return { transcript: "", hitCount: 0, truncated: false };
  }

  const lines: string[] = [];
  let totalLen = 0;
  let truncated = false;
  let used = 0;

  for (let i = 0; i < hits.length; i++) {
    if (used >= maxHits) {
      truncated = true;
      break;
    }
    const line = formatRecallLine(hits[i]);
    // Reserve room for a trailing truncation marker so we never silently
    // cut mid-line past the cap.
    const prospective = totalLen + line.length + (i > 0 ? 1 : 0);
    if (prospective > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    totalLen = prospective;
    used++;
  }

  let transcript = lines.join("\n");
  if (truncated) {
    const marker = "\n[…more matches omitted]";
    // Only append the marker if it fits; otherwise the cap already
    // communicates truncation via `truncated: true`.
    if (transcript.length + marker.length <= maxChars) {
      transcript += marker;
    }
  }
  return { transcript, hitCount: used, truncated };
}

/** Format a single hit as `[YYYY-MM-DD HH:MM] role: content`. */
function formatRecallLine(hit: RecallChatHistoryHit): string {
  const ts =
    typeof hit.timestamp === "number" && Number.isFinite(hit.timestamp)
      ? new Date(hit.timestamp)
      : null;
  const stamp = ts ? formatStamp(ts) : "????-??-?? ??:??";
  const content = (hit.content ?? "").replace(/\s+/g, " ").trim();
  return `[${stamp}] ${hit.role}: ${content}`;
}

function formatStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/* -------------------------------------------------------------------------- */
/* Tool description — coaches triggering + injects today's date               */
/* -------------------------------------------------------------------------- */

/**
 * The fixed preamble of the tool description. The date is appended at
 * build time from `now()` (overridable for tests). Kept as a constant
 * so tests can assert the triggering guidance verbatim.
 */
export const RECALL_CHAT_HISTORY_DESCRIPTION_PREAMBLE =
  "Recall past conversation turns with the user that are NOT already in your recent context. " +
  "Call this when the user references past events, shared memories, or specifics " +
  '(e.g. "do you remember…", "what did I say about…", "yesterday / last week / that time…") ' +
  "and the detail is not present in the recent transcript. " +
  "Extract the most distinctive terms from the user's question as `query` " +
  "(people, places, objects, topics); provide a date range when the user names a time. " +
  "The result is a compact transcript — read it and weave the relevant facts into your reply; " +
  "do NOT echo it verbatim or mention that you searched.";

/**
 * Build the full description, appending today's date so the LLM can
 * resolve relative time words ("yesterday", "last Tuesday") to concrete
 * ISO values — LLMs don't otherwise know today's date.
 */
export function buildRecallChatHistoryDescription(now: () => Date): string {
  const iso = now().toISOString();
  return `${RECALL_CHAT_HISTORY_DESCRIPTION_PREAMBLE} Today is ${iso}.`;
}

/* -------------------------------------------------------------------------- */
/* Builder                                                                    */
/* -------------------------------------------------------------------------- */

/** Default caps — see `RecallChatHistoryResult.truncated`. */
export const DEFAULT_MAX_HITS = 10;
export const DEFAULT_MAX_TRANSCRIPT_CHARS = 2000;

/**
 * Build the `recall_chat_history` tool.
 *
 * @param searcher Host-supplied closure that reads local history and
 *   returns matching hits in chronological order. The host typically
 *   closes over `characterId` + its history store when constructing
 *   this, so the tool needs nothing from `ToolContext`.
 * @param opts
 *   - `now`: clock used for the description's "Today is …" injection.
 *     Defaults to `() => new Date()`. Override in tests.
 *   - `maxHits`, `maxTranscriptChars`: override the formatting caps.
 */
export function buildRecallChatHistoryTool(
  searcher: ChatHistorySearcher,
  opts: { now?: () => Date; maxHits?: number; maxTranscriptChars?: number } = {},
): Tool<RecallChatHistoryArgs, RecallChatHistoryResult> {
  const now = opts.now ?? (() => new Date());
  const maxHits = opts.maxHits ?? DEFAULT_MAX_HITS;
  const maxTranscriptChars =
    opts.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;

  return {
    name: "recall_chat_history",
    description: buildRecallChatHistoryDescription(now),
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "array",
          items: { type: "string" },
          description:
            "Salient terms or phrases to recall, extracted from the user's message. " +
            "Broad recall: a message matches if it contains ANY of these (case-insensitive). " +
            "Omit to return all messages in the date range.",
        },
        dateFrom: {
          type: "string",
          format: "date-time",
          description:
            "ISO 8601 lower bound (inclusive). Resolve relative words like 'yesterday' / 'last week' against today's date.",
        },
        dateTo: {
          type: "string",
          format: "date-time",
          description: "ISO 8601 upper bound (inclusive).",
        },
        role: {
          type: "string",
          enum: ["user", "assistant"],
          description:
            "Restrict to one side of the conversation. Omit for both.",
        },
        limit: {
          type: "number",
          description: `Max messages to return. Default ${DEFAULT_MAX_HITS}.`,
        },
      },
    },
    async execute(args) {
      // Clamp `limit` to the configured cap so an over-large LLM
      // request can't blow the transcript budget. The searcher is free
      // to also cap on its side; this is the SDK backstop.
      const effArgs: RecallChatHistoryArgs = {
        ...args,
        limit:
          typeof args.limit === "number"
            ? Math.min(args.limit, maxHits)
            : maxHits,
      };
      const hits = await searcher(effArgs);
      const { transcript, hitCount, truncated } = formatRecallTranscript(
        hits,
        maxHits,
        maxTranscriptChars,
      );
      return { transcript, hitCount, truncated };
    },
  };
}
