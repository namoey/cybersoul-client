/**
 * Time arithmetic + classification helpers.
 *
 * These are pure datetime utilities with no prompt content. They are
 * consumed by the prompt layer (to pre-compute "how long ago" strings
 * the LLM would otherwise have to derive) and by history formatting.
 */

export interface ElapsedTimeInfo {
  elapsedMs: number;
  elapsedMins: number;
  elapsedHours: number;
  elapsedDays: number;
  elapsedYears: number;
  /** Human-readable coarse duration, e.g. "1.5 hours", "30 mins". */
  displayStr: string;
}

/**
 * Compute the elapsed time between a reference point and a past
 * timestamp, returning the delta broken out by unit plus a
 * human-readable coarse display string.
 *
 * Clamped at 0 — a future `lastInteractionAt` (clock skew) yields 0
 * rather than a negative duration.
 */
export function getElapsedTimeInfo(
  currentTimeMs: number,
  lastInteractionAt: string | number | Date,
): ElapsedTimeInfo {
  const elapsedMs = Math.max(
    0,
    currentTimeMs - new Date(lastInteractionAt).getTime(),
  );
  const elapsedMins = elapsedMs / (1000 * 60);
  const elapsedHours = elapsedMins / 60;
  const elapsedDays = elapsedHours / 24;
  const elapsedYears = elapsedDays / 365;

  let displayStr = "";
  if (elapsedYears >= 1) displayStr = `${elapsedYears.toFixed(1)} years`;
  else if (elapsedDays >= 1) displayStr = `${elapsedDays.toFixed(1)} days`;
  else if (elapsedHours >= 1) displayStr = `${elapsedHours.toFixed(1)} hours`;
  else displayStr = `${Math.floor(elapsedMins)} mins`;

  return {
    elapsedMs,
    elapsedMins,
    elapsedHours,
    elapsedDays,
    elapsedYears,
    displayStr,
  };
}

/**
 * Map a timestamp to a coarse day-part label ("Early Morning",
 * "Afternoon", "Late Night", ...).
 *
 * Pre-computed for the prompt layer so the LLM doesn't have to derive
 * it from a wall-clock string — reduces cognitive load and avoids
 * inconsistent bucketing across turns. Uses the Asia/Shanghai timezone
 * to match the rest of the prompt context.
 */
export function getTimePeriodInfo(timeMs: number): {
  hour: number;
  period: string;
} {
  const date = new Date(timeMs);
  const hour = parseInt(
    date
      .toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        hour12: false,
      })
      .split(":")[0],
  );

  let period: string;

  if (hour >= 6 && hour < 9) {
    period = "Early Morning";
  } else if (hour >= 9 && hour < 12) {
    period = "Late Morning";
  } else if (hour >= 12 && hour < 13) {
    period = "Noon";
  } else if (hour >= 13 && hour < 18) {
    period = "Afternoon";
  } else if (hour >= 18 && hour < 19) {
    period = "Evening";
  } else if (hour >= 19 && hour < 23) {
    period = "Night";
  } else {
    period = "Late Night";
  }

  return { hour, period };
}

/**
 * Resolve all time-derived values the prompt layer needs from the
 * character's current time + last interaction time.
 *
 * Returns the wall-clock string (Asia/Shanghai, en-US long form with
 * weekday), the coarse day-part label, and (when `lastInteractionAt`
 * is provided) the elapsed hours + display string so the caller can do
 * the ongoing-scene freshness check without a separate
 * `getElapsedTimeInfo` call. Falls back to "now" when `currentTime`
 * is absent.
 */
export function resolveTimeContext(
  currentTime?: string | number | Date,
  lastInteractionAt?: string | number | Date,
): {
  /** Full localized wall-clock string, e.g. "Tuesday, July 1, 2026 at 14:30:00". */
  timeStr: string;
  /** Coarse day-part label, e.g. "Afternoon". */
  period: string;
  /**
   * Elapsed hours since `lastInteractionAt`, or `null` when
   * `lastInteractionAt` is absent. Clamped at 0 (clock skew safe).
   */
  elapsedHours: number | null;
  /**
   * Human-readable coarse duration since `lastInteractionAt`
   * (e.g. "1.5 hours"), or `null` when `lastInteractionAt` is absent.
   */
  elapsedDisplayStr: string | null;
} {
  const currentTimeMs = currentTime
    ? new Date(currentTime).getTime()
    : Date.now();
  const { period } = getTimePeriodInfo(currentTimeMs);
  const timeStr = new Date(currentTimeMs).toLocaleString("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  if (lastInteractionAt === undefined || lastInteractionAt === null) {
    return { timeStr, period, elapsedHours: null, elapsedDisplayStr: null };
  }

  const timeInfo = getElapsedTimeInfo(currentTimeMs, lastInteractionAt);
  return {
    timeStr,
    period,
    elapsedHours: timeInfo.elapsedHours,
    elapsedDisplayStr: timeInfo.displayStr,
  };
}
