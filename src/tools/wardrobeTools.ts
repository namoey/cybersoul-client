/**
 * Wardrobe tools — outfit gifting / acquisition.
 *
 * Phase 1 extraction. Lifts the legacy `CyberSoulClient.processGiftOutfit`
 * body verbatim: same validation, same `giftOutfit` -> `api.giftOutfit`
 * call, same `outfit-gifted` event emission, same non-fatal failure
 * handling. See §5.4 item 3 (partial failure MUST NOT abort the turn).
 */

import type { Tool, AgentEventSink } from "../agent/types.js";
import type { OutfitGiftedPayload } from "../types.js";
import { GIFT_OUTFIT_DESCRIPTION_TEXT_DESCRIPTION } from "../prompts/intent.js";

export interface GiftOutfitResult {
  /** Populated when an outfit was actually gifted; `undefined` when there was nothing to gift or the write failed. */
  giftedOutfit?: OutfitGiftedPayload;
}

/**
 * Build the `gift_outfit` tool. The executor validates the LLM's
 * `descriptionText`, performs the wardrobe write via `api.giftOutfit`,
 * and emits `outfit-gifted` on success.
 *
 * Failure is swallowed — the harness collects `giftedOutfit` and folds
 * it into the response shape. A wardrobe hiccup never aborts the turn.
 */
export function buildGiftOutfitTool(
  sink: AgentEventSink,
): Tool<{ descriptionText: string }, GiftOutfitResult> {
  return {
    name: "gift_outfit",
    description:
      "Add a newly-acquired outfit to the character's wardrobe. Used for both user-initiated gifts and character-initiated acquisitions.",
    inputSchema: {
      type: "object",
      properties: {
        descriptionText: {
          type: "string",
          description: GIFT_OUTFIT_DESCRIPTION_TEXT_DESCRIPTION,
        },
      },
      required: ["descriptionText"],
    },
    async execute(args, ctx) {
      const result: GiftOutfitResult = {};

      const descriptionText =
        typeof args?.descriptionText === "string"
          ? args.descriptionText.trim()
          : "";
      if (descriptionText.length === 0) {
        return result;
      }

      try {
        const count = await ctx.api.giftOutfit(descriptionText);
        const giftedOutfit: OutfitGiftedPayload = { descriptionText };
        if (typeof count === "number") {
          giftedOutfit.count = count;
        }
        result.giftedOutfit = giftedOutfit;
        sink.emit({ type: "outfit-gifted", payload: giftedOutfit });
      } catch (e) {
        // Legacy behavior: log + swallow. The turn is not aborted.
        console.error("[CyberSoulClient] giftOutfit failed:", e);
      }
      return result;
    },
  };
}
