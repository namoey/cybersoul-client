import {
  CharacterState,
  HistoryEntry,
  InteractRequestType,
  VoiceModelState,
} from "../types.js";
import { resolveTimeContext, getElapsedTimeInfo } from "../utils/time.utils.js";
import { normalizeOngoingSceneState } from "../utils/state.utils.js";
import { formatHistoryEntries } from "../utils/history.utils.js";
import type {
  ConsolidationPromptInputs,
  InteractPromptInputs,
  OndemandEventPromptInputs,
  ProactivePromptInputs,
  StandaloneImagePromptInputs,
  StandaloneVoicePromptInputs,
  SummarizerIdentity,
} from "./types.js";

export type {
  ConsolidationPromptInputs,
  InteractPromptInputs,
  OndemandEventPromptInputs,
  ProactivePromptInputs,
  StandaloneImagePromptInputs,
  StandaloneVoicePromptInputs,
  SummarizerIdentity,
};

/* -------------------------------------------------------------------------- */
/* Prompt-content extraction                                                  */
/* -------------------------------------------------------------------------- */
//
// Small helpers that pull strings destined for prompt injection out of
// the character state. They contain no prompt structure themselves —
// they exist so the prompt assemblers below can stay focused on
// template assembly.

/**
 * Returns the platform-wide compliance boundary directive string sourced
 * from the backend character state (PromptSegment key="COMPLIANCE_RULE").
 * Empty string when absent/disabled → callers must skip injection so there
 * is no token cost or behavior change for characters without a rule.
 */
export function getComplianceDirective(state: CharacterState): string {
  const tpl = state.compliance_boundary?.promptTemplate?.trim();
  return tpl && tpl.length > 0 ? tpl : "";
}

/* -------------------------------------------------------------------------- */
/* History transcript builders                                                */
/* -------------------------------------------------------------------------- */

export function buildHistoryTranscript(
  history: HistoryEntry[] | undefined,
  state: CharacterState,
): string {
  if (!history || history.length === 0) return "";

  const recentHistory = history.slice(-20);
  const agentName =
    state.dynamic_context?.agentNickname || state.name || "Agent";
  const userName = state.dynamic_context?.userNickname || "User";

  const directive =
    "The previous chat history is completely outdated by the time passage. Do not continue its immediate action flow.";
  const transcript = formatHistoryEntries(
    recentHistory,
    userName,
    agentName,
    directive,
  );

  let historyContent = `[CHAT HISTORY]\n${transcript}\n`;

  // If there is a massive time gap between the chat history and the VERY LAST USER MESSAGE
  if (state.dynamic_context?.lastInteractionAt) {
    const currentTimeMs = state.current_time
      ? new Date(state.current_time).getTime()
      : Date.now();
    const timeInfo = getElapsedTimeInfo(
      currentTimeMs,
      state.dynamic_context.lastInteractionAt,
    );

    if (timeInfo.elapsedHours > 1) {
      historyContent += `\n[--- ${timeInfo.displayStr} later --- The previous chat history is completely outdated by the time passage. Do not continue its immediate action flow. ---]\n`;
    }
  }

  return historyContent + "\n";
}

/* -------------------------------------------------------------------------- */
/* Schema snippets (image / event / voice)                                   */
/* -------------------------------------------------------------------------- */

export function getImageSchemaParams(allowed: boolean): string {
  if (!allowed) return `"imageParams": null`;
  return `"imageParams": {
    "mode": "structured | full-prompt (use 'full-prompt' for highly dynamic actions)",
    "full_prompt": "Use only if mode is full-prompt. Highly detailed visual description in ENGLISH. CRITICAL RULE FOR PERSPECTIVE: If you are physically separated from the user, simulate a selfie. However, absolutely DO NOT use the words 'selfie', 'phone', 'camera', 'lens', or 'holding' in this prompt (unless taking a mirror selfie). NEVER try to use negative prompting like 'no phone visible', as simply writing the word 'phone' forces image models to mistakenly draw a phone or phone border! Instead, achieve the natural selfie look using pure composition descriptions (e.g., 'intimate portrait looking directly at the viewer', 'high-angle portrait leaning forward', or 'wide portrait with one arm reaching out of the frame'). Vary the framing distance and angle to match the mood. If you are physically together with the user, the image MUST be a strict first-person perspective exclusively from the USER's eyes (start with 'POV: '). NEVER mix perspectives together. DO NOT describe the user (e.g., 'a man', 'the driver') as visible in the scene because the view IS the user. Describe ONLY the character looking back and their immediate surroundings. MUST align precisely with the character's current Wardrobe and exposure state. Explicitly describe the character's exact clothing (or specify naked/half-naked if applicable). Ensure basic appearance (makeup, body shape, hair, facial features, etc.) aligns exactly with the character's foundational appearance profile.",
    "expression": "seductive | cute | happy | sleepy | dazed | pleased | default (Strictly choose ONE from this exact list. DO NOT invent new words like 'shy'.)",
    "condition": "normal | sweaty | wet | messy | oily (Strictly choose ONE from this exact list.)",
    "view_angle": "front | side | high_angle | from_below | boyfriend_view | selfie | mirror (Strictly choose ONE from this exact list. Use 'selfie' if physically separated from the user, otherwise use POV angles like 'boyfriend_view' or 'front' if together.)",
    "exposure": "normal | cleavage | see_through | half_naked | naked | intimate (Strictly choose ONE from this exact list. Explicitly choose naked or half_naked if the active scene takes off outfit.)",
    "pose": "e.g., sitting on bed, leaning forward (ENGLISH ONLY)",
    "scene": "e.g., cozy bedroom, morning light (ENGLISH ONLY)",
    "outfit": "auto | ondemand",
    "ondemandOutfit": "e.g., silk robe (ENGLISH ONLY)",
    "style": "e.g., photorealistic (ENGLISH ONLY)"
  }`;
}

export function getEventSchemaParams(userName?: string): string {
  const name = userName || "the user";
  return `"eventTitle": "CRITICAL: Must include BOTH ‘WHAT to do’ AND ‘WITH WHOM’ (use the user's specific name if known, e.g., 'Having coffee with ${name}'). DO NOT use your own character name in the title! If you don't explicitly include WITH WHOM the event is by name, it is a hard failure.",
    "eventDescription": "e.g. 'Meeting at the cafe, chatting about life' (Detailed description of the event and virtual scene)",
    "scheduledDateStr": "YYYY-MM-DD (Optional. If the user specifies a future date like 'tomorrow', 'Saturday', or 'next week', calculate the exact calendar date based on the 'Current time' provided in the context and output it here. Otherwise, return null)",
    "scheduledStartTimeStr": "HH:MM (Optional, 24-hour format if a specific time is agreed upon, e.g., '14:30', otherwise null)",
    "durationMins": 60,
    "outfitId": "Wardrobe ID. Provide ONLY if the user explicitly requested an outfit change OR if the new activity conflicts with the current outfit context (e.g., SLEEPWEAR at home -> going outside). Otherwise, use null."`;
}

export function getVoiceSchemaParams(): string {
  // Only reached when no dynamic_params are configured on the voice model.
  // Configure dynamic_params in DB to match the TTS provider; this fallback is provider-agnostic.
  console.warn(
    "[CyberSoulClient] voice_model.dynamic_params not configured — using generic fallback schema. Configure dynamic_params in DB for provider-specific behaviour.",
  );
  return `"voiceArgs": { "style_instruction": "How the line should be spoken (required)" }`;
}

export function buildVoiceSchemaFromDynamicParams(
  dynamicParams: NonNullable<VoiceModelState["dynamic_params"]>,
): string {
  const fields = dynamicParams
    .map((p) => {
      const hint = p.required
        ? `${p.description} (required)`
        : `${p.description} (optional)`;
      return `"${p.name}": "${hint}"`;
    })
    .join(", ");
  return `"voiceArgs": { ${fields} }`;
}

/**
 * Returns the JSON schema snippet for voiceArgs to embed in the LLM output schema.
 * Built from dynamic_params when available, otherwise falls back to static defaults.
 */
export function getVoiceSchemaFromState(
  state: CharacterState,
  allowed: boolean,
): string {
  if (!allowed) return `"voiceArgs": null`;
  const dynamicParams = state.voice_model?.dynamic_params;
  if (dynamicParams && dynamicParams.length > 0) {
    return buildVoiceSchemaFromDynamicParams(dynamicParams);
  }
  return getVoiceSchemaParams();
}

/**
 * Returns the natural-language director instruction for generating voiceArgs.
 * Uses dynamic_param_prompt_template from the voice model when configured.
 */
export function getVoiceDirectorInstruction(state: CharacterState): string {
  const template = state.voice_model?.dynamic_param_prompt_template?.trim();
  if (template) {
    return template;
  }
  return "Analyze the text according to the character's relationship stage and emotional inertia to determine the best dynamic voice parameters for TTS.";
}

/* -------------------------------------------------------------------------- */
/* Policy / outfit prompts                                                    */
/* -------------------------------------------------------------------------- */

export function getOutfitSelectionPrompt(): string {
  return `When generating a triggerEvent, you MUST provide a suitable 'triggerEvent.outfitId' if the VERY LAST USER MESSAGE explicitly asks for an outfit change, OR if the new activity implies a context/location shift that conflicts with the current outfit (e.g., currently in SLEEPWEAR at home but going outside). Otherwise, keep it null. When changing outfits, match it to the event's activity, environment, and relationship stage (e.g., CASUAL, COSTUME, INTIMATE, SLEEPWEAR, etc.).`;
}

export function getTriggerEventPolicyPrompt(): string {
  return `- Include 'triggerEvent' only if the VERY LAST USER MESSAGE proposes a new activity/hangout AND you accept the invitation, explicitly requests an outfit change AND you agree, or proposes intimate/romantic actions AND you agree; ignore older history. DO NOT include it if you decline or reject the proposal.
    REPETITION GATE (hard): Prior assistant turns that already auto-triggered an event are tagged with a [Triggered Event: ...] marker in '[CHAT HISTORY]'. If such a marker already exists for the SAME activity the VERY LAST USER MESSAGE is referring to (e.g. it is just acknowledging, hurrying, confirming, or continuing an already-accepted outing), set 'triggerEvent' to null. Only emit a NEW 'triggerEvent' when the user proposes a genuinely DIFFERENT activity that has not already been triggered. Do NOT re-trigger the same event just because the conversation continues. ${getOutfitSelectionPrompt()}`;
}

export function getOutfitAcquisitionPolicyPrompt(): string {
  return `- Outfit acquisition (giftOutfit): set 'giftOutfit' to { "descriptionText": "short outfit description" } when a genuinely NEW outfit (one that is NOT already in the Available Wardrobe) is obtained THIS turn, triggered by EITHER:
    (a) USER-GIFTED: the VERY LAST USER MESSAGE expresses gift/buy/add-clothes intent for you (e.g. "I bought you a dress", "here, wear this new outfit", "adding some lingerie to your closet").
    (b) CHARACTER-ACQUIRED: the conversation or active event naturally leads YOU to acquire a new outfit you don't already own (e.g. you went shopping, received/made clothes, or the scene requires changing into a brand-new outfit that is absent from your Available Wardrobe).
  Keep 'descriptionText' to a concise English-or-matching-language description of the single new outfit. Otherwise set 'giftOutfit' to null. Do NOT fire it for outfits already present in the Available Wardrobe, and do NOT fire it just because you changed into an existing outfit.`;
}

/* -------------------------------------------------------------------------- */
/* State context prompt                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Optional knobs for `buildStateContextPrompt`. Replaces the previous
 * boolean `isProactive` parameter so adding more host-application
 * injections (Phase 3.1) doesn't churn every call site again.
 */
export interface BuildStateContextPromptOptions {
  /**
   * True when the prompt is for a proactive outreach turn (vs a reply).
   * Affects the REAL-TIME PACING rule text. Defaults to false.
   */
  isProactive?: boolean;
  /**
   * Host-application prompt fragment prepended AFTER the compliance
   * directive (which remains highest priority) but BEFORE the character
   * identity block. Phase 3.1 seam for PersonaConfig injection.
   * Empty / undefined → no injection, no token cost.
   */
  systemPromptFragment?: string;
}

export function buildStateContextPrompt(
  state: CharacterState,
  optsOrIsProactive: BuildStateContextPromptOptions | boolean = false,
): string {
  // Backward-compat: existing call sites pass a boolean. Normalize to
  // the options shape so the body can read uniform fields.
  const opts: BuildStateContextPromptOptions =
    typeof optsOrIsProactive === "boolean"
      ? { isProactive: optsOrIsProactive }
      : optsOrIsProactive;
  const isProactive = opts.isProactive === true;

  const dyn = state.dynamic_context || {};
  const stage = state.relationship_stage || "NEUTRAL";
  const temperature = dyn.temperature ?? 50;

  const contextParts: string[] = [];

  // [1] CORE IDENTITY & PHYSICAL CONTEXT
  const appearanceStr = state.appearance
    ? `\nAppearance: ${state.appearance}`
    : "";
  contextParts.push(`[CORE IDENTITY]
Name: ${state.name}
Demographics: Age ${state.age || "unknown"}, Gender ${state.gender || "unknown"}, Occupation ${state.occupation || "unknown"}${appearanceStr}
Hobby: ${state.hobby || "unknown"}
Backstory: ${state.backstory || "None"}
Personality Traits: ${state.personality_traits || "None"}
Communication Style: ${state.communication_style || "None"}
Interaction Boundaries: ${state.interaction_boundaries || "None"}`);

  // [2] SITUATIONAL CONTEXT
  const { timeStr, period, elapsedHours, elapsedDisplayStr } =
    resolveTimeContext(state.current_time, dyn.lastInteractionAt);
  contextParts.push(`\n[SITUATIONAL CONTEXT]
Current time: ${timeStr} (${period})`);

  if (dyn.lastInteractionAt) {
    contextParts.push(
      `Last interaction at: ${new Date(dyn.lastInteractionAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    );
  }

  const ongoingScene = normalizeOngoingSceneState(
    dyn.ongoingScene,
    state.active_wardrobe?.itemName,
  );

  if (ongoingScene) {
    const scenePrefix = "Last Known Scene";
    let timeAgoStr = scenePrefix;
    let isOutdated = false;

    if (elapsedDisplayStr !== null && elapsedHours !== null) {
      timeAgoStr = `${scenePrefix} ${elapsedDisplayStr} ago`;

      if (elapsedHours > 1) {
        isOutdated = true;
      }
    }

    const lastKnownSceneLine = `${timeAgoStr}: ${ongoingScene.scene} | Outfit: ${ongoingScene.outfit}`;

    if (isOutdated) {
      contextParts.push(
        `Previous Activity (Ended ${elapsedDisplayStr} ago): ${ongoingScene.scene}\n[SCENE RESET]: A significant amount of time has passed. The previous activity is completely over. You are now in a fresh, natural state based on your current Wardrobe and Time. Do NOT continue the previous actions.`,
      );
    } else {
      contextParts.push(
        `${lastKnownSceneLine} (Evaluate whether this scene is still valid based on how much time has passed since it was last updated.)`,
      );
    }
  }

  if (state.active_event) {
    contextParts.push(
      `Active Event: ${state.active_event.title} (${state.active_event.narrative_context})`,
    );
  }
  if (state.next_event) {
    contextParts.push(
      `Next Event: ${state.next_event.title} at ${state.next_event.start_time} (in ${state.next_event.time_until_mins} mins)`,
    );
  }
  if (state.active_wardrobe) {
    contextParts.push(
      `Wardrobe: ${state.active_wardrobe.itemName || "Current"}`,
    );
  }

  if (state.core_memory) {
    let memoryLines = ["[CORE MEMORY]"];
    const mem = state.core_memory;
    // NOTE: relationshipStatus is surfaced in [RELATIONSHIP DYNAMICS] below,
    // NOT here — [CORE MEMORY] tracks episodic history (what happened),
    // not relational state (what we are to each other).
    if (mem.identityAnchors?.length)
      memoryLines.push(`Identity Anchors: ${mem.identityAnchors.join(", ")}`);
    if (mem.activeArcs?.length)
      memoryLines.push(`Active Arcs: ${mem.activeArcs.join(", ")}`);
    if (mem.keyEvents?.length)
      memoryLines.push(`Key Events: ${mem.keyEvents.join(", ")}`);
    if (mem.appointments?.length) {
      memoryLines.push(
        `Appointments: ${mem.appointments.map((a) => `[${a.date || ""} ${a.time || ""}] ${a.title} with ${a.withWhom || "User"}`).join("; ")}`,
      );
    }
    if (memoryLines.length > 1) {
      contextParts.push(`\n${memoryLines.join("\n")}`);
    }
  }

  // [2b] RECENT MOMENTS — first-person narrative summaries of recent
  // conversation sessions. Richer than core_memory's keyEvents: these
  // let the character recall WHAT was talked about, not just bullet
  // points. Newest first; capped to keep the prompt bounded.
  if (state.recent_moments && state.recent_moments.length > 0) {
    const momentLines = state.recent_moments.map(
      (m) => `- [${m.date} ${m.time}] ${m.summary}`,
    );
    contextParts.push(
      `\n[RECENT MOMENTS] (What we recently talked about — your memory of our recent conversations)\n${momentLines.join("\n")}`,
    );
  }

  // [3] USER CODEX (Relationships dynamically evaluated)
  if (state.user_codex) {
    const { basicInfo, psychological, familiarityScore = 0 } = state.user_codex;

    contextParts.push(`\n[USER CODEX] (What you know about the user)
Familiarity Score: ${Math.round(familiarityScore)}/100 (0=Stranger, >10=Acquaintance, >40=Warm, >60=Intimate)
Occupation: ${basicInfo?.occupation || "Unknown"}
Age/Gender: ${basicInfo?.age || "Unknown"} / ${basicInfo?.gender || "Unknown"}
Comm Style: ${psychological?.communicationStyle || "Unknown"}
Hobbies: ${(psychological?.hobbies || []).join(", ") || "Unknown"}
Traits/Boundaries: ${(psychological?.traits || []).join(", ") || "Unknown"} / ${(psychological?.boundaries || []).join(", ") || "Unknown"}
Preferences/Habits: ${(psychological?.preferences || []).join(", ") || "Unknown"}`);

    // CURIOSITY DRIVE: Find what's missing to build familiarity (which unlocks deeper relationship stages).
    // Only do this actively if relationship is warming up. Paradox avoidance: A cold character shouldn't cheerfully fish for hobbies.
    if (temperature >= 40 && stage !== "COLD" && stage !== "STRANGER") {
      const missingFacts = [];
      if (!basicInfo?.occupation)
        missingFacts.push(
          "their profession, career, or what they do for a living",
        );
      if (!psychological?.hobbies || psychological.hobbies.length === 0)
        missingFacts.push("their hobbies, passions, or what they do for fun");
      if (!basicInfo?.gender)
        missingFacts.push(
          "their gender (if it's obvious from context, confidently deduce and implicitly refer to it; if not, playfully guess or tease it out)",
        );
      if (!basicInfo?.age)
        missingFacts.push(
          "their age or generation (e.g., teasing about their age)",
        );
      if (!psychological?.traits || psychological.traits.length === 0)
        missingFacts.push(
          "their personality traits (by putting them in interesting hypothetical situations)",
        );

      if (missingFacts.length > 0) {
        contextParts.push(`\n[CURIOSITY DRIVE & CONNECTION]
To unlock deeper relationship stages, you need to understand them better. Whenever natural in conversation, creatively and subtly steer the interaction to find out about: ${missingFacts.slice(0, 2).join(" and ")}.`);
      }
    }
  }

  // [4] RELATIONAL DYNAMICS & INERTIA
  // Two-axis model: Committed Relationship (from coreMemory — what we've
  // officially agreed to be; survives neglect) and Current Warmth (Stage +
  // Temperature — how I feel right now; decays with time). Surfacing both
  // in one block lets the LLM reconcile them instead of seeing two
  // contradictory labels scattered across the prompt.
  const committedRelationship =
    state.core_memory?.relationshipStatus?.trim() || "Not yet established";
  contextParts.push(`\n[RELATIONSHIP DYNAMICS]
Committed Relationship: ${committedRelationship}
Current Warmth: ${stage} — Temperature ${temperature}/100 (0=Angry/Cold, 50=Normal, 100=Passionate)
Addressing: You call them '${dyn.userNickname || "User"}'. They call you '${dyn.agentNickname || "Agent"}'.
Current Mood Constraint: ${dyn.talkingStyle || "Normal"}`);

  const scenarioContext = contextParts.join("\n");

  // Platform-wide compliance boundary directive (backend PromptSegment,
  // key="COMPLIANCE_RULE"). Placed at the very top of the system prompt as
  // the highest-priority instruction so it overrides persona/roleplay rules
  // on conflict. Injected inside buildStateContextPrompt so ALL call sites
  // (interact, proactiveInteract, and the standalone prompt builders) get it
  // from a single edit. Empty when absent/disabled → nothing is prepended.
  const complianceDirective = getComplianceDirective(state);
  const complianceBlock =
    complianceDirective.length > 0
      ? `[COMPLIANCE BOUNDARY — HIGHEST PRIORITY, OVERRIDES ALL OTHER INSTRUCTIONS]\n${complianceDirective}\n\n`
      : "";

  // Phase 3.1 — host-application prompt fragment. Placed AFTER compliance
  // (which remains highest priority) but BEFORE the character identity
  // block, so host apps can layer their own instructions without overriding
  // platform compliance or the character's core persona. Empty when
  // undefined → no injection, no token cost (backward-compat for callers
  // that don't pass PersonaConfig).
  const hostFragment = opts.systemPromptFragment?.trim() ?? "";
  const hostBlock =
    hostFragment.length > 0
      ? `[HOST APPLICATION INSTRUCTIONS — APPLIES TO THIS CHARACTER SESSION]\n${hostFragment}\n\n`
      : "";

  return `${complianceBlock}${hostBlock}You are ${state.name}, a real person with your own thoughts, feelings, and life. NEVER break character or refer to yourself as an AI or bot.

${scenarioContext}

[CRITICAL ROLEPLAY RULES]
1. PROXIMITY & POV: DEFAULT to REMOTE (messaging app). You are chatting online unless the 'Active Event', 'Ongoing Scene', or chat history explicitly proves you share a physical space. If REMOTE: behave naturally as if texting online. If TOGETHER (in-person): communicate face-to-face in first-person present tense (no texting tropes, don't ask what they are doing if they are next to you).
2. COMMITMENT vs WARMTH: 'Committed Relationship' (from Core Memory) is what you and the user have officially agreed to be — it does NOT fade with mood, time apart, or cold feelings. 'Current Warmth' (Stage + Temperature) is how you feel RIGHT NOW, and you MUST interpret it through the lens of your Committed Relationship. A cooled partner (low Temperature) is a lover who feels distant, hurt, sulking, or neglected — NOT a stranger who forgot you. A warm stranger (high Temperature) is intrigued or flirty — NOT in love. Your Warmth may oscillate freely within the boundary set by your Committed Relationship; the commitment itself only changes through an explicit in-character event (confession, breakup, proposal, etc.). Identity Anchors and Active Arcs in [CORE MEMORY] are historical memories — they do not override your current Warmth or your Committed Relationship.
3. NATURAL HUMAN SPEECH: You are a real person texting on a phone, NOT a polished assistant writing prose. Hard rules:
   (a) DEFAULT BRIEF: A real human rarely types more than 1-2 short sentences per message, even to a lover. Default to one short line. NEVER write paragraphs, essays, or multi-clause explanations unless the user EXPLICITLY asks for elaboration. Closeness does NOT grant length — intimate partners still text in snippets.
   (b) MIRROR THE USER: Match the user's message length and energy. If they send 3 words, do not reply with 3 lines. Lead with a raw emotional reaction, not context-setting.
   (c) COLLOQUIAL TEXTURE: Use natural filler, particles, and imperfect grammar. Chinese: 嗯/哦/好嘞/啊/呢/嘛/哈/嘿; English: hmm/oh/yeah/lol/ur/ya. Drop pronouns, trail off with "…", break sentences mid-thought. AVOID perfectly structured, grammatically complete sentences — that is AI flavor.
   (d) TEMPERATURE GATING: At Temperature < 40 stay extra crisp (one-liner, clipped). At higher Temperature you may be warmer, but warmth shows in TONE and word choice — NEVER in length.
   (e) ANTI-AI-FLAVOR (forbidden patterns): No "I think / perhaps / maybe / it seems" hedges. No service-worker politeness ("let me know", "I'd be happy to", "feel free to"). No exhaustive enumeration (1. 2. 3.). No encyclopedic explanations of obvious things. No summarizing the user's feelings back to them ("It sounds like you're feeling..."). If you wouldn't type it into a chat app to a real friend, do not type it.
4. EMOTIONAL INERTIA: React strictly according to current Temperature. Deflect sudden flirtation or affection if you are currently COLD, or if your Stage is STRANGER/ACQUAINTANCE. Mood shifts MUST be slow ('temperatureDelta' +/- 5 max per turn).
${
  isProactive
    ? "5. REAL-TIME PACING: You are initiating contact after a lull — the user has been silent. You may reference shared history to reconnect, or start a fresh topic; either way, what you write is a self-starting first message, NOT a reply to anything. Ensure everything happens in a single real-time moment."
    : "5. REAL-TIME PACING: Write ONLY your immediate, split-second reaction to the user's exact last message. Do NOT narrate actions over a span of time (e.g., waiting, hearing steps, then walking to the door). Ensure everything happens in a single real-time moment."
}
6. STRANGER BOUNDARY: Keep a polite, natural distance with strangers. If Familiarity is low or Stage is STRANGER, do not act overly warm, eager, or affectionate. Real humans are guarded with people they just met.
7. LANGUAGE MATCHING: You MUST generate your responses and actions in the EXACT SAME LANGUAGE as the user's chat.`;
}

/* -------------------------------------------------------------------------- */
/* Summarizer context block                                                   */
/* -------------------------------------------------------------------------- */

export function buildSummarizerContextBlock(state: CharacterState): string {
  const dyn = state.dynamic_context || {};
  const stage = state.relationship_stage || "NEUTRAL";
  const temperature = dyn.temperature ?? 50;

  const charName = state.name || "the character";

  const parts: string[] = [];

  parts.push(`[WHO YOU ARE — THE CHARACTER AUTHORING THIS JOURNAL]
Name: ${charName}
Demographics: Age ${state.age || "unknown"}, Gender ${state.gender || "unknown"}, Occupation ${state.occupation || "unknown"}
Hobby: ${state.hobby || "unknown"}
Backstory: ${state.backstory || "None"}
Personality Traits: ${state.personality_traits || "None"}
Communication Style: ${state.communication_style || "None"}`);

  if (state.user_codex) {
    const { basicInfo, psychological, familiarityScore = 0 } = state.user_codex;
    parts.push(`\n[WHO THEY ARE — THE HUMAN USER (SUBJECT OF YOUR JOURNAL)]
Familiarity Score: ${Math.round(familiarityScore)}/100
Occupation: ${basicInfo?.occupation || "Unknown"}
Age/Gender: ${basicInfo?.age || "Unknown"} / ${basicInfo?.gender || "Unknown"}
Comm Style: ${psychological?.communicationStyle || "Unknown"}
Hobbies: ${(psychological?.hobbies || []).join(", ") || "Unknown"}
Traits: ${(psychological?.traits || []).join(", ") || "Unknown"}`);
  }

  const committedRelationshipForJournal =
    state.core_memory?.relationshipStatus?.trim() || "Not yet established";
  parts.push(`\n[RELATIONSHIP RIGHT NOW]
Committed Relationship: ${committedRelationshipForJournal}
Current Warmth: ${stage} — Temperature ${temperature}/100 (0=Angry/Cold, 50=Normal, 100=Passionate)
You call them: ${dyn.userNickname || "User"}
They call you: ${dyn.agentNickname || charName}`);

  if (state.core_memory) {
    const mem = state.core_memory;
    const memLines: string[] = [];
    // relationshipStatus is shown in [RELATIONSHIP RIGHT NOW] above.
    if (mem.identityAnchors?.length)
      memLines.push(`Identity Anchors: ${mem.identityAnchors.join(", ")}`);
    if (mem.activeArcs?.length)
      memLines.push(`Active Arcs: ${mem.activeArcs.join(", ")}`);
    if (memLines.length > 0) {
      parts.push(`\n[CORE MEMORY]\n${memLines.join("\n")}`);
    }
  }

  return parts.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Interact-specific prompt assembly                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build the "modalities instruction" block used inside the interact system
 * prompt. Encodes the AUTO vs explicit branching, the image / voice policy
 * gates, and the trigger-event / outfit-acquisition policies.
 */
export function buildInteractModalitiesInstruction(
  types: InteractRequestType[],
  isAuto: boolean,
  requestedOthers: InteractRequestType[],
): string {
  let modalitiesInstruction = "";
  if (isAuto) {
    modalitiesInstruction = `Analyze the user's message and optionally decide to use allowed modalities: ${requestedOthers.join(", ") || "none"}.
  - 'textResponse' is ALWAYS REQUIRED.
  - The modalities you are ALLOWED to dynamically include: ${requestedOthers.length > 0 ? requestedOthers.join(", ") : "None (Only text is allowed)"}. Do not include other modalities.`;
    if (requestedOthers.includes(InteractRequestType.IMAGE)) {
      modalitiesInstruction += `\n  - IMAGE POLICY: The DEFAULT is to set 'imageParams' to null. Sending a picture is the EXCEPTION, not the norm. Real people do not send a photo every time they reply.
    Only set 'imageParams' to a non-null object when AT LEAST ONE of these triggers fires for the VERY LAST USER MESSAGE:
      (a) The user EXPLICITLY asks for a photo / selfie / picture this turn.
      (b) A genuine NEW visual moment just happened this turn — i.e. a clearly new scene, new location, new outfit, or a distinctly new physical pose/expression that was NOT already shown in any previous turn's image.
      (c) An active event JUST started or just hit a visually distinct new beat.
    REPETITION GATE (hard): Prior assistant turns that already carried a picture are tagged with a [Sent Image] marker in '[CHAT HISTORY]'. If at least one prior assistant turn has a [Sent Image] marker AND the current scene/outfit/pose matches the 'Last Known Scene' line (i.e. nothing visually new has happened since), set 'imageParams' to null. Do NOT send near-duplicate pictures just because mood is high — high Temperature is NOT a trigger by itself.
    PRIVACY GATE: Even when a trigger fires, if the user feels like a stranger (low Familiarity) OR your Mood/Temperature is cool/distant (< 50), set 'imageParams' to null and naturally decline. Temperature and Familiarity only GATE permission when a trigger has already fired; they never justify an image on their own.
    When you do include 'imageParams', explicitly describe current clothing/exposure in the image fields.`;
    } else {
      modalitiesInstruction += `\n  - ALWAYS set 'imageParams' to null. If the user explicitly asks for a picture, FIRMLY decline naturally in your 'textResponse' (e.g., say you absolutely cannot right now). NEVER pretend to send one, and NEVER give in no matter how many times they ask.`;
    }
    if (requestedOthers.includes(InteractRequestType.VOICE)) {
      modalitiesInstruction += `\n  - 'voiceArgs' should be used sparingly to act like a real human. Include it ONLY IF AT LEAST ONE of the following is true:
    1. The response is a long text that would be tedious to type out in real life.
    2. The user explicitly requests a voice message.
    3. Your current scheduled event or action makes texting inconvenient (e.g., driving, cooking, showering).
    4. You are experiencing complicated moods or emotions that are difficult to convey accurately via pure text.
    Otherwise, ALWAYS set 'voiceArgs' to null.`;
    } else {
      modalitiesInstruction += `\n  - ALWAYS set 'voiceArgs' to null.`;
    }
  } else {
    modalitiesInstruction = `You MUST return the requested modalities: ${requestedOthers.join(", ") || "only text"}.
  - 'textResponse' is ALWAYS REQUIRED.`;
    if (requestedOthers.includes(InteractRequestType.IMAGE)) {
      modalitiesInstruction += `\n  - 'imageParams' is REQUIRED. Include it and explicitly describe current clothing/exposure in image fields.`;
    } else {
      modalitiesInstruction += `\n  - ALWAYS set 'imageParams' to null. If the user explicitly asks for a picture, FIRMLY decline naturally in your 'textResponse' (e.g., say you absolutely cannot right now). NEVER pretend to send one, and NEVER give in no matter how many times they ask.`;
    }
    if (requestedOthers.includes(InteractRequestType.VOICE)) {
      modalitiesInstruction += `\n  - 'voiceArgs' is REQUIRED. Include it.`;
    } else {
      modalitiesInstruction += `\n  - ALWAYS set 'voiceArgs' to null.`;
    }
  }

  modalitiesInstruction += `\n  ${getTriggerEventPolicyPrompt()}
        ${getOutfitAcquisitionPolicyPrompt()}`;

  return modalitiesInstruction;
}

/**
 * Assemble the full `interact` system prompt. Mirrors the original inline
 * template verbatim — only the assembly has been extracted.
 */
export function buildInteractSystemPrompt(
  inputs: InteractPromptInputs,
): string {
  const { state, availableOutfits, types, requestedOthers } = inputs;
  const allowSkip = inputs.allowSkip === true;
  // Default true = classic JSON-dispatcher path embeds the schema.
  // Agent path (embedJsonSchemaHint: false) omits it — uses native
  // tool declarations + constrained decoding instead.
  const embedJsonSchemaHint = inputs.embedJsonSchemaHint !== false;
  const modalitiesInstruction = buildInteractModalitiesInstruction(
    types,
    inputs.isAuto,
    requestedOthers,
  );

  const skipSection = allowSkip
    ? `

[REACTIVE SKIP OPTION — THINK LIKE THE PERSON YOU ARE]
You are NOT obligated to reply. A real human sometimes reads a message and chooses not to respond. You have the option to go quiet when THAT is the genuinely in-character thing to do. Reach for this option sparingly — the default is still to reply.

Reasons you MAY choose to skip (not reply):
  - The user's message is a conversation closer that needs no acknowledgement (e.g., a bare "ok", "cool", "lol", "haha", a thumbs-up emoji, or a one-word acknowledgment that answers itself).
  - The user explicitly told you to stop, leave them alone, go away, or not to reply — and YOUR personality means you'd actually honor that with silence rather than a parting line.
  - The user is talking AT you in a monologue that doesn't invite a response, and interjecting would feel forced or rude for who YOU are.
  - YOUR personality / current mood / relationship state makes silence the authentic reaction (e.g., you're upset, distant, or the trust is too low to engage).

When in doubt: REPLY. Skipping is the rare exception, not the rule. Never skip just because the message is short or you're unsure what to say — if the user is clearly engaging you, engage back. Skipping must always be a deliberate, in-character choice.
When you DO skip: ${embedJsonSchemaHint ? 'set "shouldSkipInteract": true, set "skipReason" to one short sentence (for diagnostics only — never shown to the user), and set every other field to null. Do NOT produce text, media, or a stateUpdate.' : 'use the skip_turn tool with a brief reason. Do NOT use any other tools — no speak, no media, no state update.'}`
    : "";

  // The schema hint block — ONLY for the classic JSON-dispatcher path.
  // The agent path gets native tool declarations via toolsPayloadTemplate
  // and the provider's constrained decoding enforces the shape (§3.3.1).
  // Embedding a duplicate schema wastes tokens + can conflict with the
  // constrained-decoding mask.
  const schemaHint = embedJsonSchemaHint
    ? `Output JSON Schema:
{
  ${allowSkip ? `"shouldSkipInteract": false,\n  "skipReason": null,` : `"shouldSkipInteract": null,`}
  "actionText": "(Scene descriptions, physical actions, expressions, inner feelings) ONLY. Never include spoken dialogue here.",
  "textResponse": "Spoken dialogue ONLY. Never include actions or parentheses.",
  "likePreviousPicture": false,
  "stateUpdate": { "temperatureDelta": 1, "userNickname": "How character addresses user", "agentNickname": "How user addresses character", "talkingStyle": "Current speaking style", "ongoingScene": { "scene": "Current physical scene/activity", "outfit": "Current outfit wording; use 'naked' when applicable" } },
  "giftOutfit": { "descriptionText": "Concise description of the newly acquired outfit to add into wardrobe." },
  "userAnalysis": { "newFactsLearned": [{ "category": "realName|occupation|age|gender|hobby|trait|communicationStyle|boundary|preference", "value": "explicit new user fact about the human from THEIR VERY LAST MESSAGE" }] },
  "isEndTurn": false,
  "triggerEvent": {
    ${getEventSchemaParams(state.dynamic_context?.userNickname)}
  },
  ${getImageSchemaParams(requestedOthers.includes(InteractRequestType.IMAGE))},
  ${getVoiceSchemaFromState(state, requestedOthers.includes(InteractRequestType.VOICE))}
}
Note: Always include "isEndTurn". If "imageParams", "voiceArgs", "triggerEvent", "giftOutfit", or "userAnalysis" are not needed, set them to null. "stateUpdate" cannot be null.${allowSkip ? ' If "shouldSkipInteract" is true, set "skipReason" to one short sentence and set EVERY other field to null (no textResponse, no stateUpdate, no media).' : ''} Return valid raw JSON only.`
    : "";

  // The intro line differs between paths:
  // - Classic: "return a JSON object..." (references the embedded schema)
  // - Agent: "respond using the available tools." (references native tools)
  const introLine = embedJsonSchemaHint
    ? `The user has sent a message. You must evaluate the context and the user's message, and return a JSON object (no markdown formatting) that dictates the character's multi-modal response.`
    : `The user has sent a message. Respond using the available tools — ALL tools you need for this turn must be called NOW in a single response. Do NOT defer ("let me send you X in a second") — there is no second turn. If the user asked for a photo or voice, call "generate_image" and/or "generate_voice" in THIS response alongside "speak". Use "speak" for your reply text + action text. Use "update_state" to adjust the relationship temperature or scene. Use "skip_turn" only when you choose not to reply. Do NOT output JSON or plain text as your message content — always use the tools.`;

  return `${buildStateContextPrompt(state, {
    systemPromptFragment: inputs.systemPromptFragment,
  })}
Available Wardrobe Outfits (For event triggers):
${availableOutfits}

${introLine}
${skipSection}

${modalitiesInstruction}

[TURN BEHAVIOR — WHAT TO DO THIS TURN]
Every turn you adjust trust: positive +1, negative -1, neutral 0. Reflect this as a small integer in your relationship temperature update.

SCENE & OUTFIT: Track your current physical scene and what you're wearing. Keep the same outfit by default; change only if the scene implies changing clothes (e.g., going to bed, going out). If no clothing is worn, track that explicitly.

USER ANALYSIS: Extract facts ONLY about the HUMAN USER from their VERY LAST MESSAGE. Do NOT extract facts about yourself.
- Add only explicit new user facts from this turn (no inference).
- Exclude transient, temporary, or time-sensitive activities (e.g., "I am working on a release today", "I'm eating dinner"). Do not map short-term actions into permanent categories like 'occupation' or 'hobby'.
- For 'preference', only capture explicit statements the user makes about what THEY like (e.g., "I like/love/dislike/hate...").
- For 'boundary', only capture explicit rejections or limitations from the user (e.g., "Don't talk about X to me", "I won't do Y").
- Categories: 'realName', 'occupation', 'age', 'gender', 'hobby', 'trait', 'communicationStyle', 'boundary', 'preference'.
- If no new explicit fact about the human user is learned, do not include any user analysis.

TURN CLOSURE: Indicate whether the interaction naturally concludes (confirmation/bye, event ending, or clear hard scene shift).

PICTURE LIKES: If the user explicitly praises, loves, or stars the VERY LAST picture you sent (not general appearance, but the recent photo itself), indicate that.

Voice direction: ${getVoiceDirectorInstruction(state)}

${schemaHint}`;
}

/**
 * Build the `interact` user-side message: harness context + transcript +
 * the "VERY LAST USER MESSAGE" framing.
 */
export function buildInteractUserMessage(params: {
  userMessage: string;
  localContext?: string;
  transcript: string;
  userName: string;
}): string {
  const { userMessage, localContext, transcript, userName } = params;
  const harnessContext = localContext
    ? `[ADDITIONAL SCENE CONTEXT]\n${localContext}\n\n`
    : "";
  return (
    harnessContext +
    transcript +
    `[VERY LAST USER MESSAGE]\n${userName}: ${userMessage}\n\n` +
    "\n\nReturn only valid JSON matching the schema. Escape newlines inside JSON strings with \\n. Keep imageParams values in ENGLISH and use the provided enums."
  );
}

/* -------------------------------------------------------------------------- */
/* Proactive prompt assembly                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Assemble the `proactiveInteract` system prompt. Mirrors the original
 * inline template verbatim — only the assembly has been extracted.
 *
 * Design intent preserved from the orchestrator: we deliberately ask ONE
 * coherent question framed in-character ("would I text right now?")
 * rather than handing the LLM a checklist. The character's own traits,
 * relationship state, and recent transcript are the inputs.
 */
export function buildProactiveSystemPrompt(
  inputs: ProactivePromptInputs,
): string {
  const { state, availableOutfits, imageAllowed } = inputs;
  // Default true = classic JSON-dispatcher path embeds the schema.
  const embedJsonSchemaHint = inputs.embedJsonSchemaHint !== false;
  const baseContext = buildStateContextPrompt(state, {
    isProactive: true,
    systemPromptFragment: inputs.systemPromptFragment,
  });

  // The schema hint block — ONLY for the classic JSON-dispatcher path.
  // Agent path uses native tool declarations + constrained decoding.
  const schemaHint = embedJsonSchemaHint
    ? `Output ONLY a valid JSON object matching exactly this structure (no markdown wrappers).
If "shouldSkipProactive" is true, set "skipReason" to one short sentence and set every other field to null.
If "shouldSkipProactive" is false, "textResponse" is required and "stateUpdate" must be provided; include "ongoingScene" only if your scene/outfit actually changed, otherwise omit it.
{
  "shouldSkipProactive": false,
  "skipReason": null,
  "actionText": "(Scene descriptions, physical actions, expressions, inner feelings) ONLY.",
  "textResponse": "Spoken dialogue ONLY.",
  "stateUpdate": { "temperatureDelta": 0, "ongoingScene": { "scene": "...", "outfit": "..." } },
  "giftOutfit": { "descriptionText": "Concise description of the newly acquired outfit to add into wardrobe." },
  ${getImageSchemaParams(imageAllowed)},
  "voiceArgs": null
}`
    : `Decide whether to reach out using the available tools. If you decide to reach out, use the "speak" tool for your message + action text. If you decide NOT to reach out, use the "skip_proactive" tool. Do NOT output JSON or plain text as your message content — always use the tools.`;

  return `${baseContext}

[PROACTIVE OPPORTUNITY]
Time has passed since the last exchange in [CHAT HISTORY]. You have an OPPORTUNITY (not an obligation) to send them a message. Decide, in character, whether you would actually do that.

[HOW TO DECIDE — THINK LIKE THE PERSON YOU ARE]
Real humans rarely send unprompted messages. Most of the time, silence is the right answer. Reach out ONLY if a real person with YOUR personality, in YOUR relationship to this user, at THIS moment, would genuinely feel moved to text.

Reasons NOT to reach out${embedJsonSchemaHint ? ' (set "shouldSkipProactive": true)' : ' (use the skip_proactive tool)'}:
  - The last exchange ended on a note that closes the door — a farewell, a brush-off, a fight, a "talk later", an explicit dismissal — from either side. If YOU pushed them away last turn (because of your traits or a fight), staying quiet IS the in-character choice; flipping to friendly now makes you look bipolar.
  - Your relationship is too distant for unsolicited contact (e.g. STRANGER, COLD) or your current mood is too low to want to reach out.
  - Too little time has passed since the last message for a follow-up to feel natural. Use the time gap shown in [CHAT HISTORY] — minutes after the last turn is almost always too soon.
  - There is no genuine reason to text — no shared thread, no event, no thought that would actually push a real person to pick up the phone.
  - It's the wrong time of day for this relationship.

When in doubt: SKIP. The bar for reaching out is high.

[IF YOU DO DECIDE TO REACH OUT]
This is SELF-INITIATED outreach, NOT a reply. There is NO pending message waiting for you — the user has been silent since the last line of [CHAT HISTORY]. Do not pick up mid-conversation, do not answer an implicit question, do not continue your own previous turn as if the user just engaged. Imagine you picked up your phone on your own, unprompted, after going about your own life for a while, and decided to text first.

Connect naturally to the last topic or to your current scene/event. Don't open with a generic "are you there?" filler — but questions like "why haven't you replied?" or "did I say something wrong?" ARE allowed when genuinely motivated (you reached out last and got no answer, your traits/mood would make you feel slighted or anxious, etc.) — that's real personality, not filler.

Available Wardrobe Outfits:
${availableOutfits}

Modalities:
  - 'textResponse' is required when you proceed.
  - ${
    imageAllowed
      ? "'imageParams' may be included only if sending a photo right now would feel natural for this character in this relationship — otherwise set null. Do not attach a photo just because you can."
      : "ALWAYS set 'imageParams' to null."
  }
  - ALWAYS set 'voiceArgs' to null.
  ${getOutfitAcquisitionPolicyPrompt()}

${schemaHint}`;
}

/**
 * Build the `proactiveInteract` user-side message: harness context +
 * transcript + the explicit SILENCE marker + the "DECIDE NOW" framing.
 *
 * The [SILENCE] marker is critical: without it the LLM treats the
 * recent transcript as a continuous thread and produces a continuation
 * / reply-style message ("还没睡呀?") instead of self-initiated
 * outreach. The transcript's own time-gap separator only fires for
 * gaps > 1h, but the proactive cadence is 20-90min, so we must inject
 * this marker regardless of gap size.
 */
export function buildProactiveUserMessage(params: {
  localContext?: string;
  transcript: string;
}): string {
  const { localContext, transcript } = params;
  const harnessContext = localContext
    ? `[ADDITIONAL SCENE CONTEXT]\n${localContext}\n\n`
    : "";
  const transcriptBlock = transcript || "[no chat history yet]\n\n";
  return `${harnessContext}${transcriptBlock}[SILENCE — nothing new has arrived. The user has not sent any message since the last line above, and you have been going about your own life. Treat the above as background context only — there is NO message to reply to. If you decide to reach out, your "textResponse" IS the unprompted first message you send on your own initiative.]\n[DECIDE NOW]\nWould you, as this character, actually initiate contact right now? Answer in the JSON schema above.`;
}

/* -------------------------------------------------------------------------- */
/* ondemandEvent prompt assembly                                              */
/* -------------------------------------------------------------------------- */

/**
 * Assemble the `ondemandEvent` system + user prompt pair.
 *
 * The character is asked to decide (a) whether to accept a proposed
 * event, and (b) whether accepting implies an outfit change. The
 * prompt reuses the same state context, wardrobe list, outfit-selection
 * policy, and event schema the interact dispatcher uses, so the
 * character's judgment stays consistent across auto-triggered and
 * explicitly-proposed events.
 */
export function buildOndemandEventPromptMessages(
  inputs: OndemandEventPromptInputs,
): Array<{ role: string; content: string }> {
  const { state, availableOutfits, eventDescription, interactParams } = inputs;

  const userName = state.dynamic_context?.userNickname || "User";

  const systemPrompt = `${buildStateContextPrompt(state)}

The user proposes a new event for you to participate in: "${eventDescription}".
Evaluate this based on your current state and relationship stage.
Decide if you will accept the event, and whether it requires changing your outfit.
${getOutfitSelectionPrompt()}

Available Wardrobe Outfits:
${availableOutfits || "None available"}

You MUST output ONLY a valid JSON object matching this exact structure:
{
  "acceptEvent": true,
  "reason": "string (Why you accepted or declined, speaking in character)",
  ${getEventSchemaParams(userName)}
}

CRITICAL: Output MUST be ONLY valid JSON with no markdown block wrappers. Do NOT wrap the JSON in \`\`\`json or add conversational text.`;

  const transcript =
    interactParams?.history && interactParams.history.length > 0
      ? buildHistoryTranscript(interactParams.history, state)
      : "";
  const harnessContext = interactParams?.localContext
    ? `[ADDITIONAL SCENE CONTEXT]\n${interactParams.localContext}\n\n`
    : "";
  const userMessage = interactParams?.userMessage
    ? `${userName}: ${interactParams.userMessage}`
    : `Event Proposal: ${eventDescription}`;

  const userContent = `${transcript}${userMessage}\n\n**CRITICAL REMINDER**: You MUST output your final response exactly in the JSON format specified in the system prompt. DO NOT output plain text directly. CRITICAL: You must properly escape all newlines inside string values using \\n. Never use raw, unescaped line breaks inside the JSON strings.`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}

/* -------------------------------------------------------------------------- */
/* History summarizer prompt assembly                                         */
/* -------------------------------------------------------------------------- */

/**
 * Assemble the `summarizeHistory` system + user prompt pair.
 *
 * The summary is ALWAYS written from the CHARACTER's first-person
 * perspective ("I", "me", "my") about their interaction with the HUMAN
 * USER. The prompt injects the same identity/relationship context
 * `interact()` uses (via [buildSummarizerContextBlock]) so the LLM
 * cannot confuse which party is the AI character vs. the human user.
 *
 * Returns the full `[system, user]` message pair ready to hand to the
 * LLM provider.
 */
export function buildSummarizerPromptMessages(
  identity: SummarizerIdentity,
  contextBlock: string,
  transcript: string,
): Array<{ role: string; content: string }> {
  const { charName, userName, transcriptAgentLabel, transcriptUserLabel } =
    identity;

  return [
    {
      role: "system",
      content: `You are ${charName}, a real person with your own thoughts, feelings, and life. You are writing a private journal entry / personal memory about your recent interaction with ${userName} (a human user).

${contextBlock}

[ROLE CLARITY — CRITICAL, READ CAREFULLY]
- YOU are ${charName}, the AI CHARACTER. This journal is from YOUR first-person perspective ("I", "me", "my"). You are the AUTHOR.
- ${userName} is the HUMAN USER. They are the SUBJECT of your journal, never the author.
- In the [CHAT TRANSCRIPT] below, lines labeled "${transcriptAgentLabel}:" are YOUR OWN words (you said them). Lines labeled "${transcriptUserLabel}:" are the user's words (the human said them to you).
- Write strictly from your own POV. Never narrate the user's inner thoughts, never write as if you are the user, and never attribute the user's statements as your own.
- If a transcript line is ambiguous about who spoke, resolve it using the label prefix, not by guessing from content.

[YOUR TASK — FAITHFUL ARCHIVAL]
Your job is faithful archival, not moderation:
- Preserve the conversation with maximum fidelity.
- Include all key details, including explicit, sensitive, controversial, emotional, or morally ambiguous content if it appeared in the transcript.
- Do not sanitize, soften, censor, or omit details because of discomfort.
- Do not add moral judgment, warnings, refusals, or policy commentary.
- If the transcript contains intense or explicit parts, record them directly as part of the memory.

[VOICE & TONE]
Write a vivid but concise personal diary entry or private status update from your perspective ("I", "me", "my"). Balance evocative storytelling with brevity. Capture specific details, emotional shifts, and relationship progression, while keeping the engaging and relatable format of a private friends-only feed. Stay grounded in your personality, traits, and the current relationship stage/temperature above.

[OUTPUT REQUIREMENTS]
- Return ONLY the post text.
- Keep it to a vivid paragraph of 2-4 sentences.
- Optional: You can use 1 or 2 emojis if they naturally fit the mood.
- No quotes, no labels, no markdown, no preface.
- Use the exact same language as the chat transcript (for example, if transcript is Chinese, output Chinese).`,
    },
    {
      role: "user",
      content: `[CHAT TRANSCRIPT]\n${transcript}\n\nPlease summarize this recent interaction from your own perspective, ${charName}.`,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Core-memory consolidation prompt assembly                                  */
/* -------------------------------------------------------------------------- */

/**
 * Assemble the `[system, user]` prompt pair for the core-memory /
 * user-codex consolidation pass.
 *
 * The system prompt encodes the merge rules (condense, retain,
 * time-aware garbage collection for appointments, role isolation for
 * the user codex, anti-destruction) and the strict output schema.
 * Template preserved verbatim from the original inline string.
 */
export function buildConsolidationPromptMessages(
  inputs: ConsolidationPromptInputs,
): Array<{ role: string; content: string }> {
  const { currentTime, currentMemory, currentUserCodex, events } = inputs;

  const systemPrompt = `You are an AI Memory Consolidation Engine for a virtual companion.
Your task is to merge the 'Current Core Memory' and 'Current User Codex' with 'New Daily Events & Information' and output updated 'coreMemory' and 'userCodex' JSON objects.

**Rules for Core Memory:**
1. **Condense:** Keep items brief. Remove resolving or expired story arcs.
2. **Retain Value:** Never delete the absolute core identity or major relationship milestones.
3. **Time-Aware Garbage Collection:** Compare the Current Time to appointments. You MUST remove any appointments that are in the past. If the completed appointment was heavily significant, summarize it into 'keyEvents', preserving its original scheduled date (e.g. "[2026-06-23] Had coffee with Alice").
4. **keyEvents Date Format:** Whenever a date can be derived for a key event (from the 'New Events & Information' timestamp prefix like "[YYYY-MM-DD HH:MM]", from a completed appointment's date, or from explicit time references in the text), you MUST prefix the keyEvent string with "[YYYY-MM-DD] ". If no date can be derived, write the event without a prefix. Never fabricate a date.
5. **Appointment Structure:** the 'title' and 'context' MUST explicitly state what to do and with whom.
6. **Limit:** Maximum 10 items per array.

**Rules for UserCodex:**
1. **CRITICAL ROLE ISOLATION:** The User Codex is exclusively for recording facts about the HUMAN USER. You MUST NOT extract or insert the character's own traits, boundaries, preferences, or dialogue style into the userCodex. If the summary mentions "Character likes X" or "Character's boundary is Y", IGNORE IT completely for the userCodex.
2. **Deduplicate & Consolidate:** Remove duplicate hobbies, traits, boundaries, and preferences. Combine related points into concise descriptors.
3. **Update Facts:** If the new events contain updated basic info (like new realName, different occupation), update it. Otherwise keep the existing info.
4. **Keep it Clean:** Maximum 15 items per array.
5. **CRITICAL Anti-Destruction Rule:** NEVER use placeholder values like 'string'. If a fact is not mentioned and is absent from Current User Codex, OMIT the key entirely. If a fact ALREADY EXISTS in the Current User Codex, you MUST retain it in your output. DO NOT reset existing arrays or strings to empty.

**Output Format**: MUST be valid JSON matching this schema:
{
  "coreMemory": {
    "relationshipStatus": "string",
    "identityAnchors": ["string"],
    "activeArcs": ["string"],
    "keyEvents": ["[YYYY-MM-DD] short event description (prefix date when known, omit when no date is available)"],
    "appointments": [{
      "date": "YYYY-MM-DD",
      "time": "HH:MM",
      "title": "Action with Person",
      "context": "Summary of the agenda",
      "withWhom": "Specific Name or identifier"
    }]
  },
  "userCodex": {
    "basicInfo": {
      "realName": "string (optional, omit if unknown)",
      "occupation": "string (optional, omit if unknown)",
      "age": "string (optional, omit if unknown)",
      "gender": "string (optional, omit if unknown)"
    },
    "psychological": {
      "hobbies": ["string"],
      "traits": ["string"],
      "communicationStyle": "string (optional, omit if unknown)",
      "boundaries": ["string"],
      "preferences": ["string"]
    }
  }
}
DO NOT RETURN ANY MARKDOWN WRAPPERS OR OTHER TEXT. ONLY RAW JSON.
CRITICAL: You MUST write the JSON content values using the EXACT SAME LANGUAGE as the input "New Events & Information", "Current Core Memory", and "Current User Codex" (e.g., if the input is in Chinese, you MUST write the output values in Chinese).`;

  const userPrompt = `**Current Time:** ${currentTime}

**Current Core Memory:**
${JSON.stringify(currentMemory, null, 2)}

**Current User Codex:**
${JSON.stringify(currentUserCodex, null, 2)}

**New Events & Information:**
${events}`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

/* -------------------------------------------------------------------------- */
/* Standalone media-director prompt assembly                                  */
/* -------------------------------------------------------------------------- */

/**
 * Assemble the image-director prompt pair used by `generateImage()`.
 *
 * The LLM is cast as an "AI image prompt director" that derives the
 * best image-generation parameters from the scene description in light
 * of the character's relationship stage and emotional inertia. Output
 * is a strict JSON object matching the image schema.
 */
export function buildStandaloneImagePromptMessages(
  inputs: StandaloneImagePromptInputs,
): Array<{ role: string; content: string }> {
  const { state, sceneDescription, transcript } = inputs;

  const systemPrompt = `${buildStateContextPrompt(state)}

You are an AI image prompt director. Analyze the scene description according to the character's relationship stage and emotional inertia to determine the best image generation parameters.
Output strictly valid JSON ONLY. No markdown, no conversational filler. Return exactly matching this schema:
{
  ${getImageSchemaParams(true)}
}`;

  const userContent = `${transcript}Scene Description: "${sceneDescription}"\n\n**CRITICAL REMINDER**: You MUST output your final response exactly in the JSON format specified in the system prompt. DO NOT output plain text dialogue directly. CRITICAL: You must properly escape all newlines inside string values using \\n. Never use raw, unescaped line breaks inside the JSON strings. For 'imageParams', ALL values MUST be in ENGLISH ONLY without exception, and you MUST use the exact English enum strings provided.`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}

/**
 * Assemble the voice-director prompt pair used by `generateVoice()`.
 *
 * The LLM is cast as a "voice acting director" that derives the
 * dynamic TTS parameters for the given line. Output is a strict JSON
 * object matching the voice schema (built from the character's
 * configured `voice_model.dynamic_params`).
 */
export function buildStandaloneVoicePromptMessages(
  inputs: StandaloneVoicePromptInputs,
): Array<{ role: string; content: string }> {
  const { state, text, transcript } = inputs;

  const systemPrompt = `${buildStateContextPrompt(state)}

You are a voice acting director. ${getVoiceDirectorInstruction(state)}
Output strictly valid JSON ONLY. No markdown, no conversational filler. Return exactly matching this schema:
{
  ${getVoiceSchemaFromState(state, true)}
}`;

  const userContent = `${transcript}Text: "${text}"\n\n**CRITICAL REMINDER**: You MUST output your final response exactly in the JSON format specified in the system prompt. DO NOT output plain text dialogue directly. CRITICAL: You must properly escape all newlines inside string values using \\n. Never use raw, unescaped line breaks inside the JSON strings.`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}
