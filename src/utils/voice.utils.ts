import { VoiceArgs } from "../types.js";
import { robustJsonParse } from "./json.utils.js";

/**
 * Voice-specific helpers.
 *
 * Pure text/LLM-response → typed-shape transforms. No prompt content.
 */

/**
 * Extract and type `voiceArgs` from a raw standalone voice-director LLM
 * response.
 *
 * The voice-only prompt wraps its result as `{ voiceArgs: { ... } }`, so
 * this unwraps the inner object. If the payload is already the inner
 * args object (no `voiceArgs` wrapper — some providers return the args
 * directly), it is used as-is.
 *
 * No validation of the inner keys is performed here; the TTS backend is
 * the authority on which dynamic params are valid for the configured
 * voice model.
 */
export function extractVoiceArgsFromLlmResponse(
  payload: Record<string, unknown>,
): VoiceArgs {
  const inner = payload.voiceArgs;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as VoiceArgs;
  }
  return payload as VoiceArgs;
}

/**
 * Strip content the TTS engine can't speak naturally:
 *   - Stage-direction wrappers like (smiles), （挑眉）, [pauses], 【动作】, *grins*
 *   - Emoji and emoji-component codepoints (Extended_Pictographic plus the
 *     ZWJ / variation-selector / skin-tone / regional-indicator scaffolding
 *     that builds composite emoji).
 *
 * Collapses runs of whitespace introduced by removals and trims the result.
 * Returns "" if everything gets stripped — callers should fall back to a
 * neutral placeholder (e.g. "...") so the TTS call still has valid input.
 */
export function sanitizeTextForVoice(text: unknown): string {
  if (typeof text !== "string") return "";
  return (
    text
      // (parens), （全角）, [brackets], 【全角】, *asterisks*
      .replace(/[\(（\[【\*].*?[\)）\]】\*]/g, "")
      // emoji + ZWJ + variation selectors + skin-tone modifiers + regional indicators
      .replace(
        /[\p{Extended_Pictographic}\u200D\uFE0F\uFE0E\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu,
        "",
      )
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Parse the voice-director LLM response into a `VoiceArgs` payload.
 * Falls back to empty args on parse failure — the TTS backend applies
 * its own provider defaults when dynamic args are absent.
 */
export function parseVoiceDirectorArgs(llmRes: string): VoiceArgs {
  try {
    const parsedVoicePayload = robustJsonParse<Record<string, unknown>>(
      llmRes,
      "generateVoice args fallback",
    );
    return extractVoiceArgsFromLlmResponse(parsedVoicePayload);
  } catch (e) {
    return {};
  }
}
