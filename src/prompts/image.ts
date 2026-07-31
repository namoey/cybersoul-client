/**
 * Single source of truth for the image generation schema.
 *
 * Both paths consume this:
 *   - Tool-calling path: `buildImageToolInputSchema()` → tool inputSchema
 *   - Classic JSON-dispatcher: `buildImageJsonSchemaString()` → embedded in prompt
 *
 * This eliminates schema drift between the two paths — any field/enum/
 * description change here propagates to both automatically.
 */

// ── Perspective guidance ──────────────────────────────────────────
// Used in the tool description AND embedded in full_prompt's JSON hint.
const IMAGE_PERSPECTIVE_GUIDANCE = `CRITICAL RULE FOR PERSPECTIVE: If you are physically separated from the user, simulate a selfie. However, absolutely DO NOT use the words 'selfie', 'phone', 'camera', 'lens', or 'holding' in full_prompt (unless taking a mirror selfie). NEVER try to use negative prompting like 'no phone visible', as simply writing the word 'phone' forces image models to mistakenly draw a phone or phone border! Instead, achieve the natural selfie look using pure composition descriptions (e.g., 'intimate portrait looking directly at the viewer', 'high-angle portrait leaning forward', or 'wide portrait with one arm reaching out of the frame'). Vary the framing distance and angle to match the mood. If you are physically together with the user, the image MUST be a strict first-person perspective exclusively from the USER's eyes (start full_prompt with 'POV: '). NEVER mix perspectives together. DO NOT describe the user (e.g., 'a man', 'the driver') as visible in the scene because the view IS the user. Describe ONLY the character looking back and their immediate surroundings. MUST align precisely with the character's current Wardrobe and exposure state. Explicitly describe the character's exact clothing (or specify naked/half-naked if applicable). Ensure basic appearance (makeup, body shape, hair, facial features, etc.) aligns exactly with the character's foundational appearance profile.`;

// ── Field definitions ─────────────────────────────────────────────

export interface ImageFieldDef {
  type: string;
  enum?: string[];
  description: string;
  /** Override for the legacy JSON schema string format. */
  jsonHintOverride?: string;
}

export const IMAGE_FIELDS: Record<string, ImageFieldDef> = {
  mode: {
    type: "string",
    enum: ["structured", "full-prompt"],
    description:
      "Use 'structured' for normal photos (the backend assembles the prompt from the fields). Use 'full-prompt' only for highly dynamic actions where structured fields can't capture the scene.",
    jsonHintOverride:
      "structured | full-prompt (use 'full-prompt' for highly dynamic actions)",
  },
  full_prompt: {
    type: "string",
    description:
      "Highly detailed visual description in ENGLISH. Use only if mode is full-prompt. For 'structured' mode, still provide a short scene description here.",
    jsonHintOverride: `Use only if mode is full-prompt. Highly detailed visual description in ENGLISH. ${IMAGE_PERSPECTIVE_GUIDANCE}`,
  },
  expression: {
    type: "string",
    enum: ["seductive", "cute", "happy", "sleepy", "dazed", "pleased", "default"],
    description:
      "Strictly choose ONE from this exact list. DO NOT invent new words like 'shy'.",
  },
  condition: {
    type: "string",
    enum: ["normal", "sweaty", "wet", "messy", "oily"],
    description: "Strictly choose ONE from this exact list.",
  },
  view_angle: {
    type: "string",
    enum: ["front", "side", "high_angle", "from_below", "boyfriend_view", "selfie", "mirror"],
    description:
      "Strictly choose ONE from this exact list. Use 'selfie' if physically separated from the user, otherwise use POV angles like 'boyfriend_view' or 'front' if together.",
  },
  exposure: {
    type: "string",
    enum: ["normal", "cleavage", "see_through", "half_naked", "naked", "intimate"],
    description:
      "Strictly choose ONE from this exact list. Explicitly choose naked or half_naked if the active scene takes off outfit.",
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
    jsonHintOverride: "auto | ondemand",
  },
  ondemandOutfit: {
    type: "string",
    description: "e.g., silk robe (ENGLISH ONLY)",
  },
  style: {
    type: "string",
    description: "e.g., photorealistic (ENGLISH ONLY)",
  },
};

export const IMAGE_REQUIRED_FIELDS = ["mode", "full_prompt"];

export const IMAGE_TOOL_DESCRIPTION = `Generate an image of the character. ${IMAGE_PERSPECTIVE_GUIDANCE}`;

// ── Schema builders ───────────────────────────────────────────────

/**
 * Build the tool inputSchema (for the tool-calling path).
 * Converts IMAGE_FIELDS to JSON Schema `properties` format.
 */
export function buildImageToolInputSchema() {
  const properties: Record<string, any> = {};
  for (const [name, field] of Object.entries(IMAGE_FIELDS)) {
    const prop: any = { type: field.type };
    if (field.enum) prop.enum = field.enum;
    prop.description = field.description;
    properties[name] = prop;
  }
  return {
    type: "object",
    properties,
    required: IMAGE_REQUIRED_FIELDS,
  };
}

/**
 * Build the legacy JSON schema string (for the classic JSON-dispatcher
 * prompt). Each field becomes `"fieldName": "hint"` where hint is:
 *   - enum fields: `"val1 | val2 | ... (description)"`
 *   - non-enum: just `"description"`
 *   - override: `field.jsonHintOverride` when present
 */
export function buildImageJsonSchemaString(allowed: boolean): string {
  if (!allowed) return `"imageParams": null`;

  const lines: string[] = [];
  for (const [name, field] of Object.entries(IMAGE_FIELDS)) {
    let hint: string;
    if (field.jsonHintOverride) {
      hint = field.jsonHintOverride;
    } else if (field.enum) {
      hint = `${field.enum.join(" | ")} (${field.description})`;
    } else {
      hint = field.description;
    }
    lines.push(`    "${name}": "${hint}"`);
  }

  return `"imageParams": {\n${lines.join(",\n")}\n  }`;
}
