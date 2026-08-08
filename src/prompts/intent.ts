/**
 * Single source of truth for the core intent fields (speak + update_state
 * + gift_outfit). Both the tool-calling path and the classic JSON-dispatcher
 * path consume these descriptions — eliminates schema drift.
 *
 * Same pattern as prompts/image.ts and prompts/event.ts.
 */

// ── speak (textResponse / actionText) ─────────────────────────────

export const TEXT_RESPONSE_DESCRIPTION =
  "Spoken dialogue ONLY. Never include actions or parentheses. This is what the character says out loud.";

export const ACTION_TEXT_DESCRIPTION =
  "(Scene descriptions, physical actions, expressions, inner feelings) ONLY. Never include spoken dialogue here.";

/** Legacy JSON hint uses "textResponse" as the key name. */
export const TEXT_RESPONSE_JSON_HINT =
  "Spoken dialogue ONLY. Never include actions or parentheses.";

export const ACTION_TEXT_JSON_HINT =
  "(Scene descriptions, physical actions, expressions, inner feelings) ONLY. Never include spoken dialogue here.";

// ── gift_outfit (descriptionText) ─────────────────────────────────

export const GIFT_OUTFIT_DESCRIPTION_TEXT_DESCRIPTION =
  "Concise description of the newly acquired outfit to add into wardrobe.";

// ── update_state (stateUpdate fields) ─────────────────────────────

export interface StateFieldHint {
  jsonHint: string;
  toolDescription: string;
}

export const STATE_FIELDS: Record<string, StateFieldHint> = {
  temperatureDelta: {
    jsonHint: "1",
    toolDescription:
      "Small integer: positive +1, negative -1, neutral 0. Mood shifts must be slow (max ±5 per turn).",
  },
  userNickname: {
    jsonHint: "How character addresses user",
    toolDescription: "How the character addresses the user (e.g., '老公', '哥哥').",
  },
  agentNickname: {
    jsonHint: "How user addresses character",
    toolDescription: "How the user addresses the character.",
  },
  talkingStyle: {
    jsonHint: "Current speaking style",
    toolDescription: "Current speaking style (e.g., '温柔乖巧', '俏皮撒娇').",
  },
};

export const ONGOING_SCENE_FIELDS: Record<string, string> = {
  scene: "Current physical scene/activity",
  outfit: "Current outfit wording; use 'naked' when applicable",
};

// ── update_state (userAnalysis) ───────────────────────────────────

export const USER_ANALYSIS_CATEGORIES = [
  "realName",
  "occupation",
  "age",
  "gender",
  "hobby",
  "trait",
  "communicationStyle",
  "boundary",
  "preference",
] as const;

// ── JSON schema string builders ───────────────────────────────────

/**
 * Build the legacy JSON schema lines for stateUpdate + userAnalysis.
 * Returns the raw string that gets embedded in the schemaHint block.
 */
export function buildStateUpdateJsonHint(): string {
  const stateLines = Object.entries(STATE_FIELDS)
    .map(([name, hint]) => `"${name}": "${hint.jsonHint}"`)
    .join(", ");

  const sceneLines = Object.entries(ONGOING_SCENE_FIELDS)
    .map(([name, hint]) => `"${name}": "${hint}"`)
    .join(", ");

  return `"stateUpdate": { ${stateLines}, "ongoingScene": { ${sceneLines} } }`;
}

export function buildUserAnalysisJsonHint(): string {
  return `"userAnalysis": { "newFactsLearned": [{ "category": "${USER_ANALYSIS_CATEGORIES.join("|")}", "value": "explicit new user fact about the human from THEIR VERY LAST MESSAGE" }] }`;
}
