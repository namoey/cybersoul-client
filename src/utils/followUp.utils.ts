/**
 * Normalization for the dispatcher LLM's `followUpInMins` signal —
 * see [DispatcherIntent.followUpInMins] in types.ts.
 *
 * The LLM owns the judgment (is the character mid-activity with a
 * promised comeback? how long?); this helper only coerces whatever the
 * model actually emitted (number, numeric string, null) into a sane
 * number-or-null so schedulers downstream never see garbage.
 */

/** Defensive ceiling (minutes): a hallucinated multi-day "be right back" is not a live-conversation beat. */
const MAX_FOLLOW_UP_MINS = 24 * 60;

export function normalizeFollowUpInMins(value: unknown): number | null {
  const parsed = typeof value === "string" ? parseFloat(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(parsed, MAX_FOLLOW_UP_MINS);
}
