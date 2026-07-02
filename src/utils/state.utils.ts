import {
  CharacterState,
  CoreMemory,
  OngoingSceneState,
  UserCodex,
} from "../types.js";

/**
 * Character-state shape normalization helpers.
 *
 * These are pure input transforms — they coerce loosely-typed backend
 * payloads into the SDK's `OngoingSceneState` shape. Used by both the
 * transport layer (client.ts → backend PATCH payload) and the prompt
 * layer. They contain no prompt content.
 */

/**
 * Normalize an `ongoingScene` value (which may arrive as a string, a
 * partial object, or `null`) into a well-formed
 * `{ scene, outfit }` object.
 *
 * - `null` / `undefined` / empty → `undefined` (caller should treat as
 *   "no ongoing scene").
 * - Bare string → `{ scene: <string>, outfit: <fallback> }`.
 * - Object with a non-empty `scene` → fills a missing `outfit` with
 *   the provided fallback (or "same as current wardrobe" when no
 *   fallback is supplied).
 *
 * The fallback mirrors how `buildStateContextPrompt` refers to the
 * active wardrobe: when the scene doesn't imply a clothing change, we
 * don't force the LLM to invent an outfit description.
 */
export function normalizeOngoingSceneState(
  raw: unknown,
  fallbackOutfit?: string,
): OngoingSceneState | undefined {
  if (raw === null || raw === undefined) return undefined;

  const normalizedFallbackOutfit =
    typeof fallbackOutfit === "string" && fallbackOutfit.trim().length > 0
      ? fallbackOutfit.trim()
      : "same as current wardrobe";

  if (typeof raw === "string") {
    const scene = raw.trim();
    if (!scene) return undefined;
    return {
      scene,
      outfit: normalizedFallbackOutfit,
    };
  }

  if (typeof raw === "object") {
    const parsed = raw as { scene?: unknown; outfit?: unknown };
    const scene =
      typeof parsed.scene === "string" ? parsed.scene.trim() : "";
    const outfit =
      typeof parsed.outfit === "string" ? parsed.outfit.trim() : "";

    if (!scene) return undefined;
    return {
      scene,
      outfit: outfit || normalizedFallbackOutfit,
    };
  }

  return undefined;
}

/**
 * Resolve the identity anchors the summarizer prompt needs from the
 * character state.
 *
 * - `charName` is the character's REAL name (authoritative identity
 *   anchor); we fall back to the agent nickname only when the profile
 *   has no name set.
 * - `userName` is what the character calls the human (falls back to
 *   "User").
 * - The `transcript*Label` pair are the nicknames actually used as
 *   line prefixes in chat, so the LLM can match spoken lines back to
 *   the right party. They may differ from the canonical names.
 */
export function deriveSummarizerIdentity(state: CharacterState): {
  charName: string;
  userName: string;
  transcriptAgentLabel: string;
  transcriptUserLabel: string;
} {
  const charName =
    state.name || state.dynamic_context?.agentNickname || "Character";
  const userName = state.dynamic_context?.userNickname || "User";
  const transcriptAgentLabel =
    state.dynamic_context?.agentNickname || charName;
  const transcriptUserLabel = userName;
  return { charName, userName, transcriptAgentLabel, transcriptUserLabel };
}

/**
 * Default core-memory shape used when the character has no stored
 * memory yet. Mirrors the schema's required fields so the
 * consolidation prompt always receives well-formed input.
 */
export function getDefaultCoreMemory(
  memory: CoreMemory | undefined,
): CoreMemory {
  return (
    memory || {
      relationshipStatus: "Starting out",
      identityAnchors: [],
      activeArcs: [],
      keyEvents: [],
      appointments: [],
    }
  );
}

/**
 * Default user-codex shape used when the character has no stored
 * codex yet. Mirrors the schema's required fields so the
 * consolidation prompt always receives well-formed input.
 */
export function getDefaultUserCodex(
  codex: UserCodex | undefined,
): UserCodex {
  return (
    codex || {
      basicInfo: {},
      psychological: {
        hobbies: [],
        traits: [],
        communicationStyle: "",
        boundaries: [],
        preferences: [],
      },
    }
  );
}
