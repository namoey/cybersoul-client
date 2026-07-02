import { robustJsonParse } from "./json.utils.js";

/**
 * Image-director LLM-response parsing.
 *
 * Pure LLM-response → typed-shape transform. No prompt content.
 */

/**
 * Parse the image-director LLM response into an `imageParams` payload.
 *
 * Falls back to a full-prompt using the original scene description
 * when the response can't be parsed — the backend can still generate
 * an image from a bare prompt, so a non-fatal fallback is preferred
 * over throwing and losing the whole call.
 */
export function parseImageDirectorArgs(
  llmRes: string,
  sceneDescription: string,
): any {
  try {
    const parsedImageArgs = robustJsonParse<any>(
      llmRes,
      "generateImage args fallback",
    );
    return parsedImageArgs.imageParams || parsedImageArgs;
  } catch (e) {
    return {
      mode: "full-prompt",
      full_prompt: sceneDescription,
    };
  }
}
