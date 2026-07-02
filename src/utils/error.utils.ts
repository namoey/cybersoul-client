import { InteractMediaError } from "../types.js";
import {
  CyberSoulError,
  CyberSoulInsufficientPointsError,
  CyberSoulSensitiveContentError,
  CyberSoulWalletError,
} from "../errors.js";

/**
 * Build the in-band `mediaError` envelope from a typed media failure
 * captured during `interact()` / `proactiveInteract()`.
 *
 * Pure `CyberSoulError → InteractMediaError` mapping. No state, no I/O.
 *
 * Kept in one place so both call sites stay consistent and the SDK
 * never re-throws on a partial media failure once the text reply is
 * already in flight.
 */
export function buildMediaError(
  err: CyberSoulError,
  affected: Array<"image" | "voice">,
): InteractMediaError {
  if (err instanceof CyberSoulInsufficientPointsError) {
    return {
      kind: "insufficient-points",
      code: err.code,
      message: err.message,
      affected,
    };
  }
  if (err instanceof CyberSoulWalletError) {
    return {
      kind: "wallet",
      message: err.message,
      affected,
    };
  }
  if (err instanceof CyberSoulSensitiveContentError) {
    return {
      kind: "sensitive-content",
      code: err.code,
      message: err.message,
      affected,
    };
  }
  return {
    kind: "unknown",
    message: err.message,
    affected,
  };
}
