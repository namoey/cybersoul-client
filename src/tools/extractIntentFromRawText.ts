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
 * 3. If any top-level key RESOLVES to a canonical tool name (via
 *    `resolveToolKey` — exact match after normalization, or a declared
 *    abbreviation alias like "skip" → skip_turn + skip_proactive),
 *    synthesize `LLMToolCall[]` and run them through `toolCallsToIntent`.
 *    This means the field mapping (speak.text → textResponse, update_state
 *    → stateUpdate, etc.) has exactly ONE implementation, and the model's
 *    abbreviated / mistyped tool names don't leak as raw JSON.
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
 * Canonical nested-schema tool names — the keys the model is SUPPOSED to
 * emit at the top level. Must stay in sync with the `switch` in
 * `toolCallsToIntent.ts`. This is the single source of truth for what a
 * "real" tool key looks like; the resolver below maps everything else to
 * one of these.
 */
const CANONICAL_TOOL_NAMES = [
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
 * Normalize a tool key for matching: lowercase + drop non-alphanumerics.
 * Collapses formatting variants so they need no explicit alias entry:
 *   "skip_turn" | "skipTurn" | "SKIP-TURN" | "skip turn" → "skipturn"
 */
function normalizeToolKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Normalized canonical names for exact-match lookup. */
const CANONICAL_NORMALIZED = new Set(CANONICAL_TOOL_NAMES.map(normalizeToolKey));

/**
 * Explicit abbreviations the model emits that do NOT normalize to a
 * canonical name. Maps normalized alias → canonical tool name(s) to fold
 * into. Most map to one target; "skip" expands to BOTH skip intents
 * because the abbreviation is ambiguous between reactive and proactive
 * (each dispatch path consults only its own flag, so both is safe).
 *
 * Why an explicit map (not fuzzy prefix/substring matching): the leak
 * class is "model shortens a tool name" (skip_turn→skip, like_picture→
 * like, generate_image→image…). `normalizeToolKey` already absorbs
 * formatting noise; this map covers the remaining stem abbreviations
 * deterministically, with no false-positive risk on unrelated JSON.
 */
const TOOL_KEY_ALIASES: Record<string, readonly string[]> = {
  skip: ["skip_turn", "skip_proactive"], // ambiguous → both flags
  like: ["like_picture"],
  image: ["generate_image"],
  voice: ["generate_voice"],
  event: ["trigger_event"],
  gift: ["gift_outfit"],
  state: ["update_state"],
  end: ["end_turn"],
};

/**
 * Resolve a top-level key the model emitted to the canonical tool
 * name(s) it should fold into. Returns [] when unrecognized.
 *
 * Order: (1) exact normalized match, (2) explicit alias map.
 */
function resolveToolKey(key: string): string[] {
  const normalized = normalizeToolKey(key);
  if (!normalized) return [];
  if (CANONICAL_NORMALIZED.has(normalized)) {
    // Return the canonical casing, not the model's variant.
    for (const canonical of CANONICAL_TOOL_NAMES) {
      if (normalizeToolKey(canonical) === normalized) return [canonical];
    }
  }
  const alias = TOOL_KEY_ALIASES[normalized];
  return alias ? [...alias] : [];
}

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
  //   {"skip":{"reason":"..."}}                ← abbreviated alias
  // Detect this when ANY top-level key RESOLVES (via resolveToolKey) to a
  // canonical tool name. Keys are resolved, not matched verbatim, so the
  // model's abbreviations / casing variants don't cause a raw-JSON leak.
  // One alias may expand to several canonical names (e.g. "skip" →
  // skip_turn + skip_proactive); each becomes its own synthetic call.
  const resolvedCalls: Array<{ name: string; value: unknown }> = [];
  for (const [rawKey, value] of Object.entries(parsed)) {
    if (value == null) continue;
    for (const name of resolveToolKey(rawKey)) {
      resolvedCalls.push({ name, value });
    }
  }
  if (resolvedCalls.length > 0) {
    const syntheticCalls: LLMToolCall[] = resolvedCalls.map(
      ({ name, value }, i) => ({
        id: `raw-${name}-${i}`,
        name,
        // toolCallsToIntent expects a JSON string; the value may itself be
        // an object (speak) or a bare value (end_turn historically was {}).
        arguments:
          typeof value === "object" && !Array.isArray(value)
            ? JSON.stringify(value)
            : JSON.stringify({ __value: value }),
      }),
    );
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

  // GENERIC no-output signal: a valid JSON object that contains NO
  // dialogue (textResponse/actionText), NO media (imageParams/voiceArgs),
  // NO recognized tool keys, and NO flat schema — i.e. the model emitted
  // structured text that carries no reply. This covers every shape where
  // the model "thought in JSON" instead of replying: bare skip-args
  // ({"reason":"..."}), stray reasoning objects ({"thought":"..."}), or
  // any future unrecognized schema. Interpretation is uniform: NOT a
  // reply → the character goes quiet. Setting BOTH skip flags means
  // whichever dispatch path is active (reactive reads shouldSkipInteract,
  // proactive reads shouldSkipProactive) treats it as a clean no-op
  // instead of throwing non-actionable. The raw JSON is stashed in
  // skipReason for diagnostics — never rendered to the user.
  //
  // This is the systematic replacement for per-field special cases: we
  // don't match field names, we match the ABSENCE of output content.
  return {
    textResponse: "",
    shouldSkipInteract: true,
    shouldSkipProactive: true,
    skipReason: trimmed,
  };
}

/**
 * Classify raw LLM text content into one of three categories. This is
 * the single source of truth used by both `extractIntentFromRawText`
 * and `mergeRawTextIntoIntent` — they share ONE parse pass with ONE
 * parser (`robustJsonParse`), so they never disagree on what counts
 * as JSON (the bug that arose when `mergeRawTextIntoIntent` used a
 * separate strict `JSON.parse` that failed on smart-quoted JSON that
 * `extractIntentFromRawText` considered valid).
 *
 *   - `"intent"`  — parsed as JSON and mapped to a known/named shape
 *                   (nested tool schema, flat classic schema, or the
 *                   generic no-output signal). The intent is returned.
 *   - `"json"`    — parsed as JSON but did not yield an intent object
 *                   (e.g. a JSON array, or a non-object primitive).
 *                   Caller must NOT use it as dialogue — it's raw JSON.
 *                   Suppressed to prevent leaks.
 *   - `"prose"`   — not parseable as JSON (ordinary text). Safe to use
 *                   as dialogue (last-resort fallback).
 */
type RawTextClassification =
  | { kind: "intent"; intent: DispatcherIntent }
  | { kind: "json" }
  | { kind: "prose" };

function classifyRawText(rawText: string): RawTextClassification {
  const intent = extractIntentFromRawText(rawText);
  if (intent) return { kind: "intent", intent };
  // extractIntentFromRawText returns null for two cases: not-JSON
  // (prose) and JSON-that-isn't-an-object (array/primitive). We need
  // to tell them apart so prose can be used as dialogue but raw JSON
  // is suppressed. Use the SAME parser for consistency.
  const trimmed = rawText.trim();
  if (!trimmed.includes("{") && !trimmed.startsWith("[")) {
    return { kind: "prose" };
  }
  try {
    robustJsonParse(trimmed, "raw-text classification");
    return { kind: "json" }; // parsed but yielded no intent
  } catch {
    return { kind: "prose" }; // not parseable → prose
  }
}

/**
 * Safely merge raw text content into a parsed intent. Used by ALL
 * tool-calling / streaming dispatch paths when the model emitted text
 * alongside or instead of tool calls.
 *
 *   - If the text classifies as a known/named intent (nested tool
 *     schema, flat classic schema, or generic no-output signal), merge
 *     it authoritatively. A pure-signal payload ({skip_turn:...},
 *     {end_turn:{}}, {reason:"..."}) legitimately yields empty
 *     textResponse — that IS the intent, not a reason to fall back.
 *   - Else if the text is ordinary PROSE, use it as textResponse (last
 *     resort — the model talked instead of using tools).
 *   - Else (raw JSON that yielded no object — an array/primitive) leave
 *     textResponse untouched. Valid JSON is never dialogue; assigning
 *     it to textResponse would leak raw JSON into the chat bubble /
 *     notification.
 *
 * The classification shares ONE parser with `extractIntentFromRawText`,
 * so the two never disagree on smart-quoted / garbage-wrapped JSON.
 */
export function mergeRawTextIntoIntent(
  intent: DispatcherIntent,
  rawText: string,
): void {
  const c = classifyRawText(rawText);
  if (c.kind === "intent") {
    Object.assign(intent, c.intent);
  } else if (c.kind === "prose") {
    intent.textResponse = rawText;
  }
  // else: raw JSON (array/primitive) → leave textResponse as-is (empty).
}
