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
      `Generate an image of the character with full creative detail. ` +
        `CRITICAL PERSPECTIVE RULE: If physically separated from the user, simulate a selfie — but DO NOT use the words 'selfie', 'phone', 'camera', 'lens', or 'holding' in full_prompt (unless a mirror selfie). ` +
        `Achieve the natural selfie look using pure composition (e.g. 'intimate portrait looking directly at the viewer', 'high-angle portrait leaning forward'). ` +
        `If physically together with the user, the image MUST be strict first-person POV from the USER's eyes (start full_prompt with 'POV: '). ` +
        `NEVER mix perspectives. DO NOT describe the user as visible — the view IS the user. ` +
        `full_prompt MUST be in ENGLISH, highly detailed, aligned with the character's appearance/wardrobe/exposure, and must explicitly describe exact clothing (or naked/half-naked if applicable). ` +
        `Always fill the structured fields (expression, pose, scene, view_angle, exposure) for maximum quality — mode 'structured' uses them to build the final prompt.`,
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
          description: "Highly detailed visual description in ENGLISH. Required when mode is 'full-prompt'. For 'structured' mode, still provide a short scene description here.",
        },
        expression: {
          type: "string",
          enum: ["seductive", "cute", "happy", "sleepy", "dazed", "pleased", "default"],
          description: "Choose ONE. Do not invent values outside this list.",
        },
        condition: {
          type: "string",
          enum: ["normal", "sweaty", "wet", "messy", "oily"],
          description: "Choose ONE.",
        },
        view_angle: {
          type: "string",
          enum: ["front", "side", "high_angle", "from_below", "boyfriend_view", "selfie", "mirror"],
          description: "Choose ONE. Use 'selfie' if separated from user, otherwise 'boyfriend_view' or 'front' if together.",
        },
        exposure: {
          type: "string",
          enum: ["normal", "cleavage", "see_through", "half_naked", "naked", "intimate"],
          description: "Choose ONE. Explicitly choose naked/half_naked if the active scene requires it.",
        },
        pose: {
          type: "string",
          description: "e.g. 'sitting on bed, leaning forward' (ENGLISH)",
        },
        scene: {
          type: "string",
          description: "e.g. 'cozy bedroom, morning light' (ENGLISH)",
        },
        outfit: {
          type: "string",
          enum: ["auto", "ondemand"],
          description: "Use 'ondemand' with ondemandOutfit if specifying a custom outfit not in the wardrobe.",
        },
        ondemandOutfit: {
          type: "string",
          description: "Custom outfit description (ENGLISH). Only when outfit is 'ondemand'.",
        },
        style: {
          type: "string",
          description: "e.g. 'photorealistic' (ENGLISH)",
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
