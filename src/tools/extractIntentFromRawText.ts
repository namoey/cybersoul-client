/**
 * Recover a `DispatcherIntent` from raw LLM text content when the model
 * ignored native tool declarations and emitted the schema inline.
 *
 * WHY THIS EXISTS
 * ---------------
 * On the opt-in dispatch paths (tool-calling / streaming), the prompt
 * asks the model to "respond using the available tools" and the model
 * is given native tool declarations. Most turns the model complies and
 * emits proper tool calls. But SOMETIMES a model — especially on edge
 * cases or when the constrained-decoding mask is weak — ignores the
 * declarations and dumps the nested tool-calling schema as plain text:
 *
 *   {"speak":{"text":"怕了吧～...","actionText":"我趴在工位上..."},
 *    "update_state":{"stateUpdate":{...}},
 *    "generate_image":null, ...}
 *
 * Before this helper existed, that raw JSON string leaked straight into
 * `parsedIntent.textResponse` and was shown in the chat bubble + push
 * notification (cybersoul-chat bug report 2026-07-31). This helper
 * detects that shape and folds it into the same `DispatcherIntent` the
 * real tool-call path would have produced, by reusing the single source
 * of truth: `toolCallsToIntent`.
 *
 * HOW IT WORKS
 * ------------
 * 1. Trim + cheap pre-check: only attempt parsing when the text starts
 *    with `{` (the only shape we care about). This keeps the hot path
 *    — ordinary prose reasoning/preamble — free of JSON.parse cost.
 * 2. `robustJsonParse` (tolerates smart quotes, code fences, trailing
 *    garbage — the same parser the classic JSON-dispatcher uses).
 * 3. If the parsed object has a `speak` field (the nested tool-calling
 *    shape), synthesize `LLMToolCall[]` — one per non-null top-level
 *    tool name — and run them through `toolCallsToIntent`. This means
 *    the field mapping (speak.text → textResponse, update_state →
 *    stateUpdate, etc.) has exactly ONE implementation.
 * 4. Otherwise, if the parsed object looks like the FLAT classic
 *    schema (has `textResponse` or `actionText` at top level), return
 *    it as a partial intent directly.
 * 5. Otherwise return `null` — caller decides what to do (typically:
 *    fall back to raw content as textResponse, subject to the
 *    reasoning-guard that lives in the harness).
 *
 * Pure function — no IO, no logging, no side effects.
 */

import type { DispatcherIntent, LLMToolCall } from "../types.js";
import { robustJsonParse } from "../utils/json.utils.js";
import { toolCallsToIntent } from "./toolCallsToIntent.js";

/**
 * The tool names the nested schema uses as top-level keys. Must stay in
 * sync with the tools registered in `toolRegistry.ts` / the mapping in
 * `toolCallsToIntent.ts`. Used to decide which top-level keys to fold
 * into synthesized tool calls.
 */
const NESTED_TOOL_KEYS = [
  "speak",
  "update_state",
  "generate_image",
  "generate_voice",
  "trigger_event",
  "gift_outfit",
  "like_picture",
  "end_turn",
  "skip_turn",
  "skip_proactive",
] as const;

/**
 * Attempt to recover a `DispatcherIntent` from raw LLM text content.
 *
 * @returns A partial `DispatcherIntent` (at minimum `textResponse` /
 *   `actionText` populated when the input was the nested schema), or
 *   `null` when the text is not recognizable as either the nested
 *   tool-calling schema or the flat classic schema.
 *
 *   - Returns `null` for ordinary prose (the common case — reasoning,
 *     preamble, or a model that just talked instead of using tools).
 *   - Returns `null` for malformed JSON (caller falls back to raw text).
 *   - Never throws.
 */
export function extractIntentFromRawText(
  rawText: string | undefined | null,
): DispatcherIntent | null {
  if (typeof rawText !== "string") return null;

  const trimmed = rawText.trim();
  if (trimmed.length === 0) return null;
  // Cheap pre-check: only attempt parsing when a `{` appears somewhere.
  // Ordinary prose (the hot path — reasoning/preamble) almost never
  // contains `{`, so this skips the JSON.parse cost for it. We do NOT
  // require a leading `{` because models frequently wrap JSON in a
  // markdown code fence (```json\n{...}\n```) or prefix it with a word
  // or two — `robustJsonParse` handles the extraction either way.
  if (!trimmed.includes("{")) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = robustJsonParse<Record<string, unknown>>(trimmed, "raw-text intent recovery");
  } catch {
    // Not valid JSON even after robustJsonParse's cleanup. Leave to caller.
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  // Nested tool-calling schema: the model emitted tool calls as a JSON
  // object keyed by tool name, e.g.
  //   {"speak":{"text":...},"update_state":{"stateUpdate":{...}}, ...}
  //   {"skip_turn":{"reason":"..."}}           ← pure-signal, no speak
  // Detect this when ANY known tool key holds a non-null value (not just
  // `speak` — a pure skip_turn/end_turn/like_picture turn has no speak).
  // Synthesize tool calls and reuse the canonical bridge so the field
  // mapping has one implementation.
  const nestedKeys = NESTED_TOOL_KEYS.filter((key) => {
    const value = (parsed as Record<string, unknown>)[key];
    return value != null;
  });
  if (nestedKeys.length > 0) {
    const syntheticCalls: LLMToolCall[] = [];
    for (const key of nestedKeys) {
      const value = (parsed as Record<string, unknown>)[key];
      // Synthesize a tool call with the value as its arguments object.
      // For object-valued tools (speak, update_state, ...) the value IS
      // the args object; bare-value signal tools (end_turn historically {})
      // get wrapped so JSON.stringify produces a valid args object.
      syntheticCalls.push({
        id: `raw-${key}`,
        name: key,
        // toolCallsToIntent expects a JSON string; the value may itself be
        // an object (speak) or a bare value (end_turn historically was {}).
        arguments:
          typeof value === "object" && !Array.isArray(value)
            ? JSON.stringify(value)
            : JSON.stringify({ __value: value }),
      });
    }
    return toolCallsToIntent(syntheticCalls);
  }

  // Flat classic schema: top-level textResponse / actionText / stateUpdate.
  // Return as a partial intent — caller merges with whatever it already has.
  if (
    typeof parsed.textResponse === "string" ||
    typeof parsed.actionText === "string" ||
    typeof parsed.stateUpdate === "object"
  ) {
    const intent: DispatcherIntent = { textResponse: "" };
    if (typeof parsed.textResponse === "string") intent.textResponse = parsed.textResponse;
    if (typeof parsed.actionText === "string") intent.actionText = parsed.actionText;
    if (parsed.stateUpdate && typeof parsed.stateUpdate === "object") {
      intent.stateUpdate = parsed.stateUpdate as DispatcherIntent["stateUpdate"];
    }
    return intent;
  }

  return null;
}
