/**
 * ContextManager — owns the read-side context every turn needs.
 *
 * Phase 1 extraction target (see
 * `cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md`
 * §3.4 and §6.3). Replaces:
 *   - `CyberSoulClient.fetchRemoteState()`   (one-liner, kept as a delegation)
 *   - `CyberSoulClient.getWardrobePromptStr()` (5-min cache, prompt-side formatting)
 *   - `CyberSoulClient.prepareInteractContext()`   (interact-mode preamble)
 *   - `CyberSoulClient.prepareProactiveContext()`  (proactive-mode preamble)
 *
 * The two `prepare*` paths were ~90% duplicated. Folding them into one
 * `prepare(mode)` is the §6.3 low-risk win that proves out the
 * abstraction. CRITICAL: behavior is preserved byte-for-byte — same
 * Promise.all over state + wardrobe, same `normalizeRequestTypes`
 * call, same modality-gate derivation. See §5.4 items 6, 7.
 */

import {
  CharacterState,
  InteractRequestType,
  ProactiveParams,
  InteractParams,
  WardrobeItem,
  MomentSummary,
} from "../types.js";
import { normalizeRequestTypes } from "../utils/requestTypes.utils.js";
import { CyberSoulApi } from "../api/cyberSoulApi.js";

/** Wardrobe prompt-string cache TTL — MUST stay at 5 minutes (§5.4 item 6). */
const WARDROBE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Recent-moments cache TTL. Moments only change when an `end_turn`
 * consolidation runs (at most a few times per session), so a 5-minute
 * cache is safe and avoids an extra HTTP round-trip every chat turn.
 */
const MOMENTS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Cap on how many moments to inject into the prompt. */
const MAX_MOMENTS_IN_PROMPT = 10;

/**
 * The mode-specific subset returned by `prepare()`. The
 * `InteractContext` and `ProactiveContext` variants match the shapes
 * the legacy private helpers returned, so `client.ts` can consume them
 * without change.
 */
export interface BaseTurnContext {
  state: CharacterState;
  availableOutfits: string;
  types: InteractRequestType[];
  requestedOthers: InteractRequestType[];
}

export interface InteractContext extends BaseTurnContext {
  mode: "interact";
  isAuto: boolean;
}

export interface ProactiveContext extends BaseTurnContext {
  mode: "proactive";
  imageAllowed: boolean;
}

export type TurnContext = InteractContext | ProactiveContext;

export class ContextManager {
  private cachedWardrobeStr: string | null = null;
  private cachedWardrobeTime: number = 0;
  private cachedMoments: MomentSummary[] | null = null;
  private cachedMomentsTime: number = 0;

  constructor(private readonly api: CyberSoulApi) {}

  /**
   * Fetch the authoritative character state. Identical to the legacy
   * `fetchRemoteState` one-liner — kept as a named method so callers
   * don't reach into `api.getState()` directly.
   */
  async fetchState(): Promise<CharacterState> {
    return this.api.getState();
  }

  /**
   * Cached wardrobe prompt string (5 minute TTL). The raw items come
   * from `api.getWardrobe()`; this method owns the prompt-side
   * formatting + the cache so we don't ship a huge list on every chat
   * turn.
   *
   * Behavior preserved verbatim from
   * `CyberSoulClient.getWardrobePromptStr`:
   *   - 5-min TTL on a successful fetch.
   *   - Onward errors swallowed (logged in transport layer); cache
   *     falls back to "None available" and IS stored so the next turn
   *     within the TTL also gets "None available" without retrying.
   *     (Mirrors legacy behavior — the empty `catch (e) {}` block.)
   *   - Empty wardrobe → "None available".
   */
  async getWardrobePromptStr(): Promise<string> {
    const now = Date.now();
    if (
      this.cachedWardrobeStr &&
      now - this.cachedWardrobeTime <= WARDROBE_CACHE_TTL_MS
    ) {
      return this.cachedWardrobeStr;
    }

    let availableOutfits = "None available";
    try {
      const wardrobes = await this.api.getWardrobe();
      if (wardrobes.length > 0) {
        availableOutfits = wardrobes
          .map(
            (w: WardrobeItem) =>
              `- ID: ${w.id} | Name: ${w.itemName} | Category: ${w.category}`,
          )
          .join("\n");
      }
    } catch (e) {
      // Legacy behavior: swallow. The transport layer has already
      // logged via CyberSoulApi's typed-error path. Cache the fallback
      // so we don't retry every turn.
    }

    this.cachedWardrobeStr = availableOutfits;
    this.cachedWardrobeTime = now;
    return availableOutfits;
  }

  /**
   * Cached recent story moments (5 minute TTL). The raw moments come
   * from `api.getMoments()`; this method owns the cache so we don't
   * add an extra HTTP round-trip on every chat turn.
   *
   * IMPORTANT: moments change when an `end_turn` consolidation runs
   * (saveMoment + core-memory PATCH). The TTL alone is NOT enough to
   * keep the cache fresh — `invalidateMomentsCache()` must be called
   * after any moment write so the next turn sees the updated list.
   *
   * Failures are swallowed (mirrors the wardrobe fallback pattern) —
   * the prompt builder simply omits `[RECENT MOMENTS]` when the list
   * is empty, so a transient backend hiccup degrades gracefully
   * instead of blocking the conversation.
   */
  async getRecentMoments(): Promise<MomentSummary[]> {
    const now = Date.now();
    if (
      this.cachedMoments &&
      now - this.cachedMomentsTime <= MOMENTS_CACHE_TTL_MS
    ) {
      return this.cachedMoments;
    }

    let moments: MomentSummary[] = [];
    try {
      moments = await this.api.getMoments(MAX_MOMENTS_IN_PROMPT);
    } catch (e) {
      // Swallow — the prompt builder handles an empty moments list
      // by omitting the [RECENT MOMENTS] block entirely.
    }

    this.cachedMoments = moments;
    this.cachedMomentsTime = now;
    return moments;
  }

  /**
   * Invalidate the moments cache so the next `getRecentMoments()`
   * re-fetches from the backend. MUST be called after any moment
   * write (`saveMoment`, core-memory consolidation) — otherwise
   * turns within the 5-min TTL window will read stale moments that
   * miss the just-saved entry.
   */
  invalidateMomentsCache(): void {
    this.cachedMoments = null;
    this.cachedMomentsTime = 0;
  }

  /**
   * Shared read-path: fetch state + wardrobe + recent moments in
   * parallel, normalize the request types, derive the modality gates.
   *
   * Mirrors legacy `prepareInteractContext` and `prepareProactiveContext`
   * — `Promise.all` over the reads, `normalizeRequestTypes` applied to
   * the caller's `requestTypes`, `requestedOthers` filtered to drop
   * AUTO + TEXT. Recent moments are merged onto `state.recent_moments`
   * so the prompt builder can inject them as `[RECENT MOMENTS]`.
   */
  private async prepareBase(
    requestTypes: InteractRequestType[] | undefined,
  ): Promise<BaseTurnContext> {
    const [state, availableOutfits, recentMoments] = await Promise.all([
      this.fetchState(),
      this.getWardrobePromptStr(),
      this.getRecentMoments(),
    ]);

    // Inject the moments onto the state so the prompt builder sees them.
    // The backend's GET /state does NOT return moments; they come from a
    // separate endpoint and are merged here.
    if (recentMoments.length > 0) {
      state.recent_moments = recentMoments;
    }

    const types = normalizeRequestTypes(requestTypes);
    const requestedOthers = types.filter(
      (t) => t !== InteractRequestType.AUTO && t !== InteractRequestType.TEXT,
    );

    return { state, availableOutfits, types, requestedOthers };
  }

  /**
   * Interact-mode preamble. Identical to legacy
   * `CyberSoulClient.prepareInteractContext` — same `isAuto` derivation.
   */
  async prepareInteract(
    params: InteractParams,
  ): Promise<InteractContext> {
    const base = await this.prepareBase(params.requestTypes);
    const isAuto = base.types.includes(InteractRequestType.AUTO);
    return { ...base, mode: "interact", isAuto };
  }

  /**
   * Proactive-mode preamble. Identical to legacy
   * `CyberSoulClient.prepareProactiveContext` — same `imageAllowed`
   * derivation (no AUTO gate, mirrors legacy).
   */
  async prepareProactive(
    params: ProactiveParams,
  ): Promise<ProactiveContext> {
    const base = await this.prepareBase(params.requestTypes);
    const imageAllowed = base.requestedOthers.includes(
      InteractRequestType.IMAGE,
    );
    return { ...base, mode: "proactive", imageAllowed };
  }
}
