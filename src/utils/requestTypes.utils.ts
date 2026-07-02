import { InteractRequestType } from "../types.js";

/**
 * `InteractRequestType[]` validation + defaulting.
 *
 * Pure enum-array transform. No state, no I/O.
 */

/**
 * Normalize a caller-supplied `requestTypes` array into a well-formed
 * shape for the dispatcher:
 *   - Empty / absent → `[AUTO, TEXT]` (the default chat turn).
 *   - Always ensures `TEXT` is present (text is mandatory on every
 *     turn).
 *   - Rejects unknown values with a thrown error so misconfigured
 *     callers fail fast instead of silently degrading.
 */
export function normalizeRequestTypes(
  requestTypes?: InteractRequestType[],
): InteractRequestType[] {
  let normalized = requestTypes;
  if (!normalized || normalized.length === 0) {
    normalized = [InteractRequestType.AUTO, InteractRequestType.TEXT];
  } else {
    normalized = [...normalized];
  }

  if (!normalized.includes(InteractRequestType.TEXT)) {
    normalized.push(InteractRequestType.TEXT);
  }

  const validRequestTypes = new Set<string>(
    Object.values(InteractRequestType),
  );
  const invalidRequestTypes = normalized.filter(
    (type) => !validRequestTypes.has(type),
  );

  if (invalidRequestTypes.length > 0) {
    throw new Error(
      `Invalid requestTypes: ${invalidRequestTypes.join(", ")}. Allowed values: ${Object.values(InteractRequestType).join(", ")}`,
    );
  }

  return normalized;
}
