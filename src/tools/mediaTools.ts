/**
 * Media tools — image + voice generation.
 *
 * Phase 1 extraction (see
 * `cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md`
 * §3.1 and §6.1). Each tool wraps one branch of the legacy
 * `runInteractMediaTasks` media-task loop. Behavior is preserved
 * byte-for-byte:
 *
 *  - Wallet / insufficient-points / sensitive-content failures are
 *    captured as a typed `ToolFailure` so the harness can surface them
 *    in-band as `mediaError` (§5.4 item 3 — partial failure MUST NOT
 *    abort the turn).
 *  - Other failures are logged (with the legacy prefix) and swallowed.
 *  - On success, `media-ready` is emitted to the EventStream so the
 *    UI can render the bubble per-modality as it resolves.
 *  - The `shouldGenerateImage` / `shouldGenerateVoice` gating logic
 *    lives in the harness (it depends on `requestTypes` + `isAuto`),
 *    NOT in the tool — the harness decides whether to dispatch the
 *    tool; the tool just does the work when called.
 */

import type { Tool, ToolFailure, AgentEventSink } from "../agent/types.js";
import type { MediaReadyPayload } from "../types.js";
import type { EventStream } from "../agent/eventStream.js";
import {
  CyberSoulError,
  CyberSoulInsufficientPointsError,
  CyberSoulSensitiveContentError,
  CyberSoulWalletError,
} from "../errors.js";
import { sanitizeTextForVoice } from "../utils/voice.utils.js";

/** The set of error subclasses that count as "typed media failures" (in-band). */
function isTypedMediaError(e: unknown): boolean {
  return (
    e instanceof CyberSoulInsufficientPointsError ||
    e instanceof CyberSoulWalletError ||
    e instanceof CyberSoulSensitiveContentError
  );
}

/**
 * Image generation result — mirrors what the legacy
 * `runInteractMediaTasks` accumulator stored for the image branch.
 */
export interface GenerateImageResult {
  imageUrl?: string;
  imageMediaId?: string;
  /** Typed failure (if any) — surfaced as `mediaError` in-band. */
  failure?: ToolFailure;
}

/**
 * Voice generation result — mirrors what the legacy
 * `runInteractMediaTasks` accumulator stored for the voice branch.
 */
export interface GenerateVoiceResult {
  audioUrl?: string;
  audioMediaId?: string;
  durationSec?: number;
  failure?: ToolFailure;
}

/**
 * Build the `generate_image` tool. The tool itself is stateless; it
 * closes over the EventSink so it can emit `media-ready` on success.
 *
 * The input shape is intentionally permissive (`any`) because the
 * legacy code accepts whatever the LLM produced (with a full-prompt
 * fallback when the LLM emitted nothing useful). Validating the LLM's
 * payload is the LLM's job (and Phase 2's native tool-calling).
 */
export function buildGenerateImageTool(
  sink: AgentEventSink,
): Tool<Record<string, unknown>, GenerateImageResult> {
  return {
    name: "generate_image",
    description:
      `Generate an image of the character. CRITICAL RULE FOR PERSPECTIVE: ` +
        `If you are physically separated from the user, simulate a selfie. However, absolutely DO NOT use the words 'selfie', 'phone', 'camera', 'lens', or 'holding' in full_prompt (unless taking a mirror selfie). ` +
        `NEVER try to use negative prompting like 'no phone visible', as simply writing the word 'phone' forces image models to mistakenly draw a phone or phone border! ` +
        `Instead, achieve the natural selfie look using pure composition descriptions (e.g., 'intimate portrait looking directly at the viewer', 'high-angle portrait leaning forward', or 'wide portrait with one arm reaching out of the frame'). ` +
        `Vary the framing distance and angle to match the mood. ` +
        `If you are physically together with the user, the image MUST be a strict first-person perspective exclusively from the USER's eyes (start full_prompt with 'POV: '). NEVER mix perspectives together. ` +
        `DO NOT describe the user (e.g., 'a man', 'the driver') as visible in the scene because the view IS the user. Describe ONLY the character looking back and their immediate surroundings. ` +
        `MUST align precisely with the character's current Wardrobe and exposure state. Explicitly describe the character's exact clothing (or specify naked/half-naked if applicable). ` +
        `Ensure basic appearance (makeup, body shape, hair, facial features, etc.) aligns exactly with the character's foundational appearance profile.`,
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["structured", "full-prompt"],
          description: "Use 'structured' for normal photos (the backend assembles the prompt from the fields). Use 'full-prompt' only for highly dynamic actions where structured fields can't capture the scene.",
        },
        full_prompt: {
          type: "string",
          description: "Highly detailed visual description in ENGLISH. Use only if mode is full-prompt. For 'structured' mode, still provide a short scene description here.",
        },
        expression: {
          type: "string",
          enum: ["seductive", "cute", "happy", "sleepy", "dazed", "pleased", "default"],
          description: "Strictly choose ONE from this exact list. DO NOT invent new words like 'shy'.",
        },
        condition: {
          type: "string",
          enum: ["normal", "sweaty", "wet", "messy", "oily"],
          description: "Strictly choose ONE from this exact list.",
        },
        view_angle: {
          type: "string",
          enum: ["front", "side", "high_angle", "from_below", "boyfriend_view", "selfie", "mirror"],
          description: "Strictly choose ONE from this exact list. Use 'selfie' if physically separated from the user, otherwise use POV angles like 'boyfriend_view' or 'front' if together.",
        },
        exposure: {
          type: "string",
          enum: ["normal", "cleavage", "see_through", "half_naked", "naked", "intimate"],
          description: "Strictly choose ONE from this exact list. Explicitly choose naked or half_naked if the active scene takes off outfit.",
        },
        pose: {
          type: "string",
          description: "e.g., sitting on bed, leaning forward (ENGLISH ONLY)",
        },
        scene: {
          type: "string",
          description: "e.g., cozy bedroom, morning light (ENGLISH ONLY)",
        },
        outfit: {
          type: "string",
          enum: ["auto", "ondemand"],
          description: "Use 'ondemand' with ondemandOutfit if specifying a custom outfit.",
        },
        ondemandOutfit: {
          type: "string",
          description: "e.g., silk robe (ENGLISH ONLY)",
        },
        style: {
          type: "string",
          description: "e.g., photorealistic (ENGLISH ONLY)",
        },
      },
      required: ["mode", "full_prompt"],
    },
    async execute(imagePayload, ctx) {
      const result: GenerateImageResult = {};
      try {
        const res: any = await ctx.api.generatePrimitive("image", imagePayload);
        result.imageUrl = res.image_url;
        result.imageMediaId = res.id;
        if (result.imageUrl) {
          const payload: MediaReadyPayload = {
            modality: "image",
            url: result.imageUrl,
            mediaId: result.imageMediaId,
          };
          sink.emit({ type: "media-ready", payload });
        }
      } catch (e: any) {
        if (!isTypedMediaError(e)) {
          console.error("[CyberSoulClient] Image generation failed:", e);
        }
        if (e instanceof CyberSoulError) {
          result.failure = { tool: "generate_image", error: e };
        }
      }
      return result;
    },
  };
}

/**
 * Build the `generate_voice` tool. Mirrors the legacy voice branch:
 * sanitizes the text for TTS, falls back to "..." when fully stripped,
 * then dispatches to the voice primitive.
 *
 * `textForVoice` is passed in via args by the harness (which already
 * has the resolved text response). Keeping the sanitization + fallback
 * here means the tool owns everything voice-specific.
 */
export function buildGenerateVoiceTool(
  sink: AgentEventSink,
): Tool<
  { textForVoice: string; dynamicArgs: Record<string, unknown> },
  GenerateVoiceResult
> {
  return {
    name: "generate_voice",
    description:
      "Synthesize voice audio from the resolved text response. The harness passes the already-resolved text; the tool sanitizes it for TTS and dispatches.",
    inputSchema: {
      type: "object",
      properties: {
        textForVoice: { type: "string" },
        dynamicArgs: { type: "object" },
      },
      required: ["textForVoice"],
    },
    async execute(args, ctx) {
      const result: GenerateVoiceResult = {};
      let text = sanitizeTextForVoice(args.textForVoice);
      if (text.length === 0) {
        text = "...";
      }
      try {
        const res: any = await ctx.api.generatePrimitive("voice", {
          text,
          dynamicArgs: args.dynamicArgs ?? {},
        });
        result.audioUrl = res.audio_url;
        result.audioMediaId = res.id;
        result.durationSec = res.duration_sec;
        if (result.audioUrl) {
          const payload: MediaReadyPayload = {
            modality: "voice",
            url: result.audioUrl,
            mediaId: result.audioMediaId,
            durationSec: result.durationSec,
          };
          sink.emit({ type: "media-ready", payload });
        }
      } catch (e: any) {
        if (!isTypedMediaError(e)) {
          console.error("[CyberSoulClient] Voice generation failed:", e);
        }
        if (e instanceof CyberSoulError) {
          result.failure = { tool: "generate_voice", error: e };
        }
      }
      return result;
    },
  };
}

/**
 * Re-exported for the EventStream adapter — the harness uses this to
 * bridge the legacy callback fanout without circular imports.
 */
export type { EventStream };
