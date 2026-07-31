/**
 * Single source of truth for the trigger_event schema.
 *
 * Both paths consume this:
 *   - Tool-calling path: `buildEventToolInputSchema()` → tool inputSchema
 *   - Classic JSON-dispatcher: `buildEventJsonSchemaString()` → embedded in prompt
 *
 * Same pattern as prompts/image.ts — eliminates schema drift.
 */

// ── Event policy guidance ─────────────────────────────────────────
// Used in the tool description AND the classic prompt's trigger policy.

export function getOutfitSelectionPrompt(): string {
  return `When generating a triggerEvent, you MUST provide a suitable 'triggerEvent.outfitId' if the VERY LAST USER MESSAGE explicitly asks for an outfit change, OR if the new activity implies a context/location shift that conflicts with the current outfit (e.g., currently in SLEEPWEAR at home but going outside). Otherwise, keep it null. When changing outfits, match it to the event's activity, environment, and relationship stage (e.g., CASUAL, COSTUME, INTIMATE, SLEEPWEAR, etc.).`;
}

export const EVENT_POLICY_PROMPT = `- Include 'triggerEvent' only if the VERY LAST USER MESSAGE proposes a new activity/hangout AND you accept the invitation, explicitly requests an outfit change AND you agree, or proposes intimate/romantic actions AND you agree; ignore older history. DO NOT include it if you decline or reject the proposal.
    REPETITION GATE (hard): Prior assistant turns that already auto-triggered an event are tagged with a [Triggered Event: ...] marker in '[CHAT HISTORY]'. If such a marker already exists for the SAME activity the VERY LAST USER MESSAGE is referring to (e.g. it is just acknowledging, hurrying, confirming, or continuing an already-accepted outing), set 'triggerEvent' to null. Only emit a NEW 'triggerEvent' when the user proposes a genuinely DIFFERENT activity that has not already been triggered. Do NOT re-trigger the same event just because the conversation continues. ${getOutfitSelectionPrompt()}`;

// ── Field definitions ─────────────────────────────────────────────

export interface EventFieldDef {
  type: string;
  description: string;
  /** Override for the legacy JSON schema string format. */
  jsonHintOverride?: string;
}

export const EVENT_FIELDS: Record<string, EventFieldDef> = {
  eventTitle: {
    type: "string",
    description:
      "CRITICAL: Must include BOTH 'WHAT to do' AND 'WITH WHOM'. Use the user's specific name if known (e.g., 'Having coffee with the user'). DO NOT use your own character name in the title! If you don't explicitly include WITH WHOM the event is by name, it is a hard failure.",
  },
  eventDescription: {
    type: "string",
    description:
      "Detailed description of the event and virtual scene (e.g., 'Meeting at the cafe, chatting about life').",
  },
  scheduledDateStr: {
    type: "string",
    description:
      "YYYY-MM-DD format. Optional. If the user specifies a future date like 'tomorrow', 'Saturday', or 'next week', calculate the exact calendar date based on the 'Current time' provided in the context. Otherwise, return null.",
  },
  scheduledStartTimeStr: {
    type: "string",
    description:
      "HH:MM 24-hour format. Optional. Only if a specific time is agreed upon (e.g., '14:30'). Otherwise, return null.",
  },
  durationMins: {
    type: "number",
    description: "Duration of the event in minutes (e.g., 60).",
  },
  outfitId: {
    type: "string",
    description:
      "Wardrobe ID. Provide ONLY if the user explicitly requested an outfit change OR if the new activity conflicts with the current outfit context (e.g., SLEEPWEAR at home -> going outside). Otherwise, use null.",
  },
};

export const EVENT_REQUIRED_FIELDS = ["eventDescription"];

export const EVENT_TOOL_DESCRIPTION = `Auto-trigger an on-demand event the character accepted during this turn. ${EVENT_POLICY_PROMPT}`;

// ── Schema builders ───────────────────────────────────────────────

/**
 * Build the tool inputSchema (for the tool-calling path).
 */
export function buildEventToolInputSchema() {
  const properties: Record<string, any> = {};
  for (const [name, field] of Object.entries(EVENT_FIELDS)) {
    properties[name] = {
      type: field.type,
      description: field.description,
    };
  }
  return {
    type: "object",
    properties,
    required: EVENT_REQUIRED_FIELDS,
  };
}

/**
 * Build the legacy JSON schema string (for the classic JSON-dispatcher
 * prompt). The eventTitle field is special — it interpolates the
 * user's name dynamically.
 */
export function buildEventJsonSchemaString(userName?: string): string {
  const name = userName || "the user";

  const lines: string[] = [];
  for (const [fieldName, field] of Object.entries(EVENT_FIELDS)) {
    let hint: string;
    if (fieldName === "eventTitle") {
      // Special: interpolate userName into the title hint
      hint = `CRITICAL: Must include BOTH 'WHAT to do' AND 'WITH WHOM' (use the user's specific name if known, e.g., 'Having coffee with ${name}'). DO NOT use your own character name in the title! If you don't explicitly include WITH WHOM the event is by name, it is a hard failure.`;
    } else if (field.jsonHintOverride) {
      hint = field.jsonHintOverride;
    } else {
      hint = field.description;
    }
    lines.push(`    "${fieldName}": "${hint}"`);
  }

  return lines.join(",\n");
}
