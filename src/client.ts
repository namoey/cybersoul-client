import {
  CyberSoulClientConfig,
  InteractParams,
  ProactiveParams,
  ProactiveResponse,
  OndemandEventParams,
  OndemandEventResponse,
  InteractRequestType,
  DispatcherIntent,
  InteractResponse,
  BaseLLMProvider,
  CharacterState,
  CoreMemory,
  UserCodex,
  VoiceArgs,
  VoiceModelState,
  WardrobeItem,
  HistoryEntry,
  OngoingSceneState,
  LikedPicture,
} from "./types.js";
import { robustJsonParse } from "./utils/json.utils.js";
import { GenericLLMProvider } from "./llm.provider.js";

export class CyberSoulClient {
  private config: CyberSoulClientConfig;
  private llm: BaseLLMProvider;
  private cachedWardrobeStr: string | null = null;
  private cachedWardrobeTime: number = 0;
  private requestTimeoutMs: number;
  private maxRetries: number;

  constructor(config: CyberSoulClientConfig) {
    this.config = config;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 120000;
    this.maxRetries = Math.max(0, config.maxRetries ?? 1);

    // Setup Provider
    this.llm = new GenericLLMProvider(
      config.llmConfig,
      config.backendUrl,
      config.characterKey
    );
  }

  /**
   * Internal wrapper for fetch that automatically injects the backend URL and Character Auth token.
   */
  private async apiFetch(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const url = `${this.config.backendUrl}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.config.characterKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    const method = (options.method || "GET").toUpperCase();
    const isIdempotent = method === "GET" || method === "HEAD";
    const retryLimit = isIdempotent ? this.maxRetries : 0;

    let lastError: unknown;

    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      try {
        const response = await fetch(url, {
          ...options,
          headers,
          signal: controller.signal,
        });

        // Retry transient server-side failures only for idempotent methods.
        if (response.status >= 500 && attempt < retryLimit) {
          continue;
        }

        return response;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          lastError = new Error(
            `Request timed out after ${this.requestTimeoutMs}ms: ${method} ${endpoint}`,
          );
        } else {
          lastError = error;
        }
        if (attempt >= retryLimit) {
          throw lastError;
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Request failed unexpectedly");
  }

  private async fetchRemoteState() {
    const res = await this.apiFetch("/api/v1/cyber-soul/state");
    if (!res.ok) throw new Error("Failed to fetch character state");
    const json = await res.json();
    return json.data;
  }

  private async getWardrobePromptStr(): Promise<string> {
    const now = Date.now();
    if (this.cachedWardrobeStr && (now - this.cachedWardrobeTime <= 5 * 60 * 1000)) {
      return this.cachedWardrobeStr;
    }

    let availableOutfits = "None available";
    try {
      const wardrobeRes = await this.apiFetch("/api/v1/cyber-soul/wardrobe");
      if (wardrobeRes.ok) {
        let wardrobesPayload: any = {};
        try {
          wardrobesPayload = await wardrobeRes.json();
        } catch (e) {}
        
        const wardrobes = wardrobesPayload.data || [];
        if (wardrobes.length > 0) {
          availableOutfits = wardrobes
            .map((w: WardrobeItem) => `- ID: ${w.id} | Name: ${w.itemName} | Category: ${w.category}`)
            .join("\n");
        }
      }
    } catch (e) {}

    this.cachedWardrobeStr = availableOutfits;
    this.cachedWardrobeTime = now;
    return availableOutfits;
  }

  private async generatePrimitive(type: "image" | "voice", payload: any) {
    const res = await this.apiFetch(`/api/v1/cyber-soul/${type}/generate`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let errData;
      try {
        errData = await res.json();
      } catch (e) {}
      const msg = errData?.message || errData?.error || `Status ${res.status}`;
      const err = new Error(`Failed to generate ${type}: ${msg}`);
      (err as any).code = errData?.code || "UNKNOWN_ERROR";
      throw err;
    }
    return res.json();
  }

  private async _updateDynamicContextInternal(
    stateUpdate: DispatcherIntent["stateUpdate"],
    userAnalysis?: DispatcherIntent["userAnalysis"],
  ): Promise<void> {
    if (!stateUpdate && !userAnalysis) return;

    // Map TS schema intent (temperatureDelta) to match Backend payload schema (temperature)
    const payload: any = { ...stateUpdate };
    if (userAnalysis) {
      payload.userAnalysis = userAnalysis;
    }
    if (payload.temperatureDelta !== undefined) {
      payload.temperature = payload.temperatureDelta;
      delete payload.temperatureDelta;
    }

    if (payload.ongoingScene !== undefined) {
      const normalizedOngoingScene = this.normalizeOngoingSceneState(
        payload.ongoingScene,
      );
      payload.ongoingScene = normalizedOngoingScene || null;
    }

    await this.apiFetch("/api/v1/cyber-soul/characters/dynamic-context", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }).catch((e: any) => console.error("Failed to update dynamic context", e)); // non-blocking error handler
  }

  private normalizeRequestTypes(
    requestTypes?: InteractRequestType[],
  ): InteractRequestType[] {
    let normalized = requestTypes;
    if (!normalized || normalized.length === 0) {
      normalized = [InteractRequestType.AUTO, InteractRequestType.TEXT];
    } else {
      normalized = [...normalized];
    }

    if (!normalized.includes(InteractRequestType.TEXT)) {
      normalized.push(InteractRequestType.TEXT);
    }

    const validRequestTypes = new Set<string>(
      Object.values(InteractRequestType),
    );
    const invalidRequestTypes = normalized.filter(
      (type) => !validRequestTypes.has(type),
    );

    if (invalidRequestTypes.length > 0) {
      throw new Error(
        `Invalid requestTypes: ${invalidRequestTypes.join(", ")}. Allowed values: ${Object.values(InteractRequestType).join(", ")}`,
      );
    }

    return normalized;
  }

  private getElapsedTimeInfo(currentTimeMs: number, lastInteractionAt: string | number | Date) {
    const elapsedMs = Math.max(0, currentTimeMs - new Date(lastInteractionAt).getTime());
    const elapsedMins = elapsedMs / (1000 * 60);
    const elapsedHours = elapsedMins / 60;
    const elapsedDays = elapsedHours / 24;
    const elapsedYears = elapsedDays / 365;

    let displayStr = "";
    if (elapsedYears >= 1) displayStr = `${elapsedYears.toFixed(1)} years`;
    else if (elapsedDays >= 1) displayStr = `${elapsedDays.toFixed(1)} days`;
    else if (elapsedHours >= 1) displayStr = `${elapsedHours.toFixed(1)} hours`;
    else displayStr = `${Math.floor(elapsedMins)} mins`;

    return { elapsedMs, elapsedMins, elapsedHours, elapsedDays, elapsedYears, displayStr };
  }

  private buildStateContextPrompt(
    state: CharacterState,
    isProactive: boolean = false
  ): string {
    const dyn = state.dynamic_context || {};
    const stage = state.relationship_stage || "NEUTRAL";
    const temperature = dyn.temperature ?? 50;

    const contextParts: string[] = [];

    // [1] CORE IDENTITY & PHYSICAL CONTEXT
    const appearanceStr = state.appearance ? `\nAppearance: ${state.appearance}` : "";
    contextParts.push(`[CORE IDENTITY]
Name: ${state.name}
Demographics: Age ${state.age || "unknown"}, Gender ${state.gender || "unknown"}, Occupation ${state.occupation || "unknown"}${appearanceStr}
Hobby: ${state.hobby || "unknown"}
Personality Traits: ${state.personality_traits || "None"}
Communication Style: ${state.communication_style || "None"}
Interaction Boundaries: ${state.interaction_boundaries || "None"}`);

    // [2] SITUATIONAL CONTEXT
    const currentTimeMs = state.current_time ? new Date(state.current_time).getTime() : Date.now();
    contextParts.push(`\n[SITUATIONAL CONTEXT]
Current time: ${new Date(currentTimeMs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
    
    if (dyn.lastInteractionAt) {
      contextParts.push(`Last interaction at: ${new Date(dyn.lastInteractionAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
    }

    const ongoingScene = this.normalizeOngoingSceneState(
      dyn.ongoingScene,
      state.active_wardrobe?.itemName,
    );

    if (ongoingScene) {
      const scenePrefix = "Last Known Scene";
      let timeAgoStr = scenePrefix;
      let isOutdated = false;
      let timeDisplayStr = "";
      
      if (dyn.lastInteractionAt) {
        const timeInfo = this.getElapsedTimeInfo(currentTimeMs, dyn.lastInteractionAt);
        timeDisplayStr = timeInfo.displayStr;
        timeAgoStr = `${scenePrefix} ${timeDisplayStr} ago`;

        if (timeInfo.elapsedHours > 1) {
          isOutdated = true;
        }
      }

      const lastKnownSceneLine = `${timeAgoStr}: ${ongoingScene.scene} | Outfit: ${ongoingScene.outfit}`;
      
      if (isOutdated) {
        contextParts.push(`Previous Activity (Ended ${timeDisplayStr} ago): ${ongoingScene.scene}\n[SCENE RESET]: A significant amount of time has passed. The previous activity is completely over. You are now in a fresh, natural state based on your current Wardrobe and Time. Do NOT continue the previous actions.`);
      } else {
        contextParts.push(`${lastKnownSceneLine} (Evaluate whether this scene is still valid based on how much time has passed since it was last updated.)`);
      }
    }

    if (state.active_event) {
      contextParts.push(`Active Event: ${state.active_event.title} (${state.active_event.narrative_context})`);
    }
    if (state.next_event) {
      contextParts.push(`Next Event: ${state.next_event.title} at ${state.next_event.start_time} (in ${state.next_event.time_until_mins} mins)`);
    }
    if (state.active_wardrobe) {
      contextParts.push(`Wardrobe: ${state.active_wardrobe.itemName || "Current"}`);
    }

    if (state.core_memory) {
      let memoryLines = ["[CORE MEMORY]"];
      const mem = state.core_memory;
      if (mem.relationshipStatus) memoryLines.push(`Relationship Status: ${mem.relationshipStatus}`);
      if (mem.identityAnchors?.length) memoryLines.push(`Identity Anchors: ${mem.identityAnchors.join(", ")}`);
      if (mem.activeArcs?.length) memoryLines.push(`Active Arcs: ${mem.activeArcs.join(", ")}`);
      if (mem.keyEvents?.length) memoryLines.push(`Key Events: ${mem.keyEvents.join(", ")}`);
      if (mem.appointments?.length) {
         memoryLines.push(`Appointments: ${mem.appointments.map(a => `[${a.date || ''} ${a.time || ''}] ${a.title} with ${a.withWhom || 'User'}`).join("; ")}`);
      }
      if (memoryLines.length > 1) {
        contextParts.push(`\n${memoryLines.join("\n")}`);
      }
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
        if (!basicInfo?.occupation) missingFacts.push("their profession, career, or what they do for a living");
        if (!psychological?.hobbies || psychological.hobbies.length === 0) missingFacts.push("their hobbies, passions, or what they do for fun");
        if (!basicInfo?.gender) missingFacts.push("their gender (if it's obvious from context, confidently deduce and implicitly refer to it; if not, playfully guess or tease it out)");
        if (!basicInfo?.age) missingFacts.push("their age or generation (e.g., teasing about their age)");
        if (!psychological?.traits || psychological.traits.length === 0) missingFacts.push("their personality traits (by putting them in interesting hypothetical situations)");

        if (missingFacts.length > 0) {
          contextParts.push(`\n[CURIOSITY DRIVE & CONNECTION]
To unlock deeper relationship stages, you need to understand them better. Whenever natural in conversation, creatively and subtly steer the interaction to find out about: ${missingFacts.slice(0, 2).join(" and ")}.`);
        }
      }
    }

    // [4] RELATIONAL DYNAMICS & INERTIA
    contextParts.push(`\n[RELATIONSHIP DYNAMICS]
Stage: ${stage}
Temperature (Mood): ${temperature}/100 (0=Angry/Cold, 50=Normal, 100=Passionate)
Addressing: You call them '${dyn.userNickname || "User"}'. They call you '${dyn.agentNickname || "Agent"}'.
Current Mood Constraint: ${dyn.talkingStyle || "Normal"}`);

    const scenarioContext = contextParts.join("\n");

    return `You are ${state.name}, a real person with your own thoughts, feelings, and life. NEVER break character or refer to yourself as an AI or bot.

${scenarioContext}

[CRITICAL ROLEPLAY RULES]
1. PROXIMITY & POV: DEFAULT to REMOTE (messaging app). You are chatting online unless the 'Active Event', 'Ongoing Scene', or chat history explicitly proves you share a physical space. If REMOTE: behave naturally as if texting online. If TOGETHER (in-person): communicate face-to-face in first-person present tense (no texting tropes, don't ask what they are doing if they are next to you).
2. STAGE VS MOOD PARADOX: 'Stage' dictates your foundational relationship boundary. 'Temperature' is merely your current fleeting mood. You MUST interpret Temperature through the lens of Stage. For example, a high Temperature (80) as a STRANGER means "polite curiosity or intrigued", NOT "deeply in love". A low Temperature (20) as an INTIMATE means "a lover's quarrel or hurt feelings", NOT "a stranger's amnesia". Never act above your Stage.
3. CONVERSATIONAL VERBOSITY: If Temperature is very low (< 40), keep answers brief and crisp—an annoyed or distant person doesn't write paragraphs. Regardless of mood or stage, ALWAYS mirror the user's verbosity. If the user sends a short message, reply with a proportionately short message (1-2 sentences). Do not monologize unless the user writes one first.
4. EMOTIONAL INERTIA: React strictly according to current Temperature. Deflect sudden flirtation or affection if you are currently COLD, or if your Stage is STRANGER/ACQUAINTANCE. Mood shifts MUST be slow ('temperatureDelta' +/- 5 max per turn).
${isProactive 
  ? "5. REAL-TIME PACING: You are initiating the conversation because the user hasn't replied recently. Transition naturally from your last message or start a new topic seamlessly. Ensure everything happens in a single real-time moment."
  : "5. REAL-TIME PACING: Write ONLY your immediate, split-second reaction to the user's exact last message. Do NOT narrate actions over a span of time (e.g., waiting, hearing steps, then walking to the door). Ensure everything happens in a single real-time moment."}
6. STRANGER BOUNDARY: Keep a polite, natural distance with strangers. If Familiarity is low or Stage is STRANGER, do not act overly warm, eager, or affectionate. Real humans are guarded with people they just met.`;
  }

  private normalizeOngoingSceneState(
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
      const scene = typeof parsed.scene === "string" ? parsed.scene.trim() : "";
      const outfit = typeof parsed.outfit === "string" ? parsed.outfit.trim() : "";

      if (!scene) return undefined;
      return {
        scene,
        outfit: outfit || normalizedFallbackOutfit,
      };
    }

    return undefined;
  }

  private getImageSchemaParams(allowed: boolean): string {
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


  private getOutfitSelectionPrompt(): string {
    return `When generating a triggerEvent, you MUST provide a suitable 'triggerEvent.outfitId' if the VERY LAST USER MESSAGE explicitly asks for an outfit change, OR if the new activity implies a context/location shift that conflicts with the current outfit (e.g., currently in SLEEPWEAR at home but going outside). Otherwise, keep it null. When changing outfits, match it to the event's activity, environment, and relationship stage (e.g., CASUAL, COSTUME, INTIMATE, SLEEPWEAR, etc.).`;
  }

  private getTriggerEventPolicyPrompt(): string {
    return `- Include 'triggerEvent' only if the VERY LAST USER MESSAGE proposes a new activity/hangout AND you accept the invitation, explicitly requests an outfit change AND you agree, or proposes intimate/romantic actions AND you agree; ignore older history. DO NOT include it if you decline or reject the proposal. ${this.getOutfitSelectionPrompt()}`;
  }

  private getOutfitAcquisitionPolicyPrompt(): string {
    return `- Outfit acquisition (VERY LAST USER MESSAGE only): set giftOutfit for gift/buy/add-clothes intent; otherwise null. giftOutfit format: { "descriptionText": "short outfit description" }.`;
  }

  private getEventSchemaParams(userName?: string): string {
    const name = userName || "the user";
    return `"eventTitle": "CRITICAL: Must include BOTH ‘WHAT to do’ AND ‘WITH WHOM’ (use the user's specific name if known, e.g., 'Having coffee with ${name}'). DO NOT use your own character name in the title! If you don't explicitly include WITH WHOM the event is by name, it is a hard failure.",
    "eventDescription": "e.g. 'Meeting at the cafe, chatting about life' (Detailed description of the event and virtual scene)",
    "scheduledDateStr": "YYYY-MM-DD (Optional. If the user specifies a future date like 'tomorrow', 'Saturday', or 'next week', calculate the exact calendar date based on the 'Current time' provided in the context and output it here. Otherwise, return null)",
    "scheduledStartTimeStr": "HH:MM (Optional, 24-hour format if a specific time is agreed upon, e.g., '14:30', otherwise null)",
    "durationMins": 60,
    "outfitId": "Wardrobe ID. Provide ONLY if the user explicitly requested an outfit change OR if the new activity conflicts with the current outfit context (e.g., SLEEPWEAR at home -> going outside). Otherwise, use null."`;
  }

  private getVoiceSchemaParams(): string {
    // Only reached when no dynamic_params are configured on the voice model.
    // Configure dynamic_params in DB to match the TTS provider; this fallback is provider-agnostic.
    console.warn("[CyberSoulClient] voice_model.dynamic_params not configured — using generic fallback schema. Configure dynamic_params in DB for provider-specific behaviour.");
    return `"voiceArgs": { "style_instruction": "How the line should be spoken (required)" }`;
  }

  private buildVoiceSchemaFromDynamicParams(
    dynamicParams: NonNullable<VoiceModelState["dynamic_params"]>,
  ): string {
    const fields = dynamicParams
      .map((p) => {
        const hint = p.required ? `${p.description} (required)` : `${p.description} (optional)`;
        return `"${p.name}": "${hint}"`;
      })
      .join(", ");
    return `"voiceArgs": { ${fields} }`;
  }

  /**
   * Returns the JSON schema snippet for voiceArgs to embed in the LLM output schema.
   * Built from dynamic_params when available, otherwise falls back to static defaults.
   */
  private getVoiceSchemaFromState(state: CharacterState, allowed: boolean): string {
    if (!allowed) return `"voiceArgs": null`;
    const dynamicParams = state.voice_model?.dynamic_params;
    if (dynamicParams && dynamicParams.length > 0) {
      return this.buildVoiceSchemaFromDynamicParams(dynamicParams);
    }
    return this.getVoiceSchemaParams();
  }

  /**
   * Returns the natural-language director instruction for generating voiceArgs.
   * Uses dynamic_param_prompt_template from the voice model when configured.
   */
  private getVoiceDirectorInstruction(state: CharacterState): string {
    const template = state.voice_model?.dynamic_param_prompt_template?.trim();
    if (template) {
      return template;
    }
    return "Analyze the text according to the character's relationship stage and emotional inertia to determine the best dynamic voice parameters for TTS.";
  }

  /**
   * Extracts and types voiceArgs from a raw standalone LLM response.
   * The voice-only prompt wraps the result as { voiceArgs: { ... } } — unwraps the inner object.
   * If the payload is already the inner args object (no voiceArgs wrapper), uses it as-is.
   */
  private extractVoiceArgsFromLlmResponse(payload: Record<string, unknown>): VoiceArgs {
    const inner = payload.voiceArgs;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return inner as VoiceArgs;
    }
    return payload as VoiceArgs;
  }

  private formatHistoryEntries(history: HistoryEntry[], userName: string, agentName: string, promptDirective: string = ""): string {
    const contextLines: string[] = [];

    for (let i = 0; i < history.length; i++) {
      const msg = history[i];

      if (i > 0 && history[i - 1].timestamp && msg.timestamp) {
        const prevTime = new Date(history[i - 1].timestamp!).getTime();
        const currTime = new Date(msg.timestamp!).getTime();
        const timeInfo = this.getElapsedTimeInfo(currTime, prevTime);
        
        if (timeInfo.elapsedHours > 1) {
          contextLines.push(`\n[--- ${timeInfo.displayStr} later ---${promptDirective ? " " + promptDirective : ""} ---]\n`);
        }
      }

      const speaker = msg.role === 'user' ? userName : (msg.role === 'assistant' || msg.role === 'agent' ? agentName : msg.role);
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const action = msg.actionText ? ` (${msg.actionText})` : "";
      const media = msg.mediaHint ? ` [${msg.mediaHint}]` : "";
      contextLines.push(`${speaker}:${action} ${content}${media}`);
    }

    return contextLines.join('\n');
  }

  private buildHistoryTranscript(history: HistoryEntry[] | undefined, state: CharacterState): string {
    if (!history || history.length === 0) return "";
    
    const recentHistory = history.slice(-20);
    const agentName = state.dynamic_context?.agentNickname || state.name || "Agent";
    const userName = state.dynamic_context?.userNickname || "User";
    
    const directive = "The previous chat history is completely outdated by the time passage. Do not continue its immediate action flow.";
    const transcript = this.formatHistoryEntries(recentHistory, userName, agentName, directive);

    let historyContent = `[CHAT HISTORY]\n${transcript}\n`;

    // If there is a massive time gap between the chat history and the VERY LAST USER MESSAGE
    if (state.dynamic_context?.lastInteractionAt) {
      const currentTimeMs = state.current_time ? new Date(state.current_time).getTime() : Date.now();
      const timeInfo = this.getElapsedTimeInfo(currentTimeMs, state.dynamic_context.lastInteractionAt);
      
      if (timeInfo.elapsedHours > 1) {
        historyContent += `\n[--- ${timeInfo.displayStr} later --- The previous chat history is completely outdated by the time passage. Do not continue its immediate action flow. ---]\n`;
      }
    }

    return historyContent + "\n";
  }

  public async interact(params: InteractParams): Promise<InteractResponse> {
    try {
      // 1. Sync remote context and wardrobe (for event triggering)
      //    We cache the wardrobe payload for 5 minutes to avoid huge payloads on every chat turn
      const [state, availableOutfits] = await Promise.all([
        this.fetchRemoteState(),
        this.getWardrobePromptStr()
      ]);

      // 2. Build local Prompt
      const types = this.normalizeRequestTypes(params.requestTypes);
      const isAuto = types.includes(InteractRequestType.AUTO);
      const requestedOthers = types.filter(
        (t) => t !== InteractRequestType.AUTO && t !== InteractRequestType.TEXT
      );

      let modalitiesInstruction = "";
      if (isAuto) {
        modalitiesInstruction = `Analyze the user's message and optionally decide to use allowed modalities: ${requestedOthers.join(", ") || "none"}.
  - 'textResponse' is ALWAYS REQUIRED.
  - The modalities you are ALLOWED to dynamically include: ${requestedOthers.length > 0 ? requestedOthers.join(", ") : "None (Only text is allowed)"}. Do not include other modalities.`;
        if (requestedOthers.includes(InteractRequestType.IMAGE)) {
          modalitiesInstruction += `\n  - Include 'imageParams' for visual/photo requests or key visual moments during active events; explicitly describe current clothing/exposure in image fields. CRITICAL POLICY: Guard your privacy! If the user feels like a stranger (low Familiarity) AND your Mood/Temperature is cool/distant (< 50), ALWAYS set 'imageParams' to null and naturally decline. If your Temperature is warm/high (>= 50), you may choose to share a picture if requested or if it fits naturally, even if you just met.`;
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

        modalitiesInstruction += `\n  ${this.getTriggerEventPolicyPrompt()}
        ${this.getOutfitAcquisitionPolicyPrompt()}`;

      // Combine state info into a clean descriptive context
      const systemPrompt = `${this.buildStateContextPrompt(state)}
Available Wardrobe Outfits (For event triggers):
${availableOutfits}

The user has sent a message. You must evaluate the context and the user's message, and return a JSON object (no markdown formatting) that dictates the character's multi-modal response.

${modalitiesInstruction}
Every turn adjusts trust: positive +1, negative -1, neutral 0. Always include 'stateUpdate' with integer 'temperatureDelta' (range guidance: 0 cold to 100 obsessive).

Always return 'stateUpdate.ongoingScene' as an object with both keys: { "scene": string, "outfit": string }.
For 'ongoingScene.outfit': decide based on the current active wardrobe by default; switch to a new explicit outfit description only if the scene implies changing clothes; if no clothing is worn, explicitly output "naked".

USER ANALYSIS WORKFLOW:
- Extract facts ONLY about the HUMAN USER from their VERY LAST MESSAGE.
- DO NOT extract facts about yourself (the AI character), your own boundaries, or your own preferences.
- Add only explicit new user facts from this turn (no inference).
- Exclude transient, temporary, or time-sensitive activities (e.g., "I am working on a release today", "I'm eating dinner"). Do not map short-term actions into permanent categories like 'occupation' or 'hobby'.
- For 'preference', only capture explicit statements the user makes about what THEY like (e.g., "I like/love/dislike/hate...").
- For 'boundary', only capture explicit rejections or limitations from the user (e.g., "Don't talk about X to me", "I won't do Y"). DO NOT record your own character boundaries here.
- Categories: 'realName', 'occupation', 'age', 'gender', 'hobby', 'trait', 'communicationStyle', 'boundary', 'preference'.
- Keep nicknames in stateUpdate; do not place them in newFactsLearned.
- If no new explicit fact about the human user is learned, set userAnalysis to null.

For 'isEndTurn', use true only when the interaction naturally concludes (confirmation/bye, event ending, or clear hard scene shift); otherwise false.

If the user explicitly praises, loves, or stars the VERY LAST picture you sent (not general appearance, but the recent photo itself), set 'likePreviousPicture' to true in the JSON, otherwise false.

Voice direction for voiceArgs: ${this.getVoiceDirectorInstruction(state)}

Output JSON Schema:
{
  "actionText": "(Scene descriptions, physical actions, expressions, inner feelings) ONLY. Never include spoken dialogue here.",
  "textResponse": "Spoken dialogue ONLY. Never include actions or parentheses.",
  "likePreviousPicture": false,
  "stateUpdate": { "temperatureDelta": 1, "userNickname": "How character addresses user", "agentNickname": "How user addresses character", "talkingStyle": "Current speaking style", "ongoingScene": { "scene": "Current physical scene/activity", "outfit": "Current outfit wording; use 'naked' when applicable" } },
  "giftOutfit": { "descriptionText": "Concise description of the newly acquired outfit to add into wardrobe." },
  "userAnalysis": { "newFactsLearned": [{ "category": "realName|occupation|age|gender|hobby|trait|communicationStyle|boundary|preference", "value": "explicit new user fact about the human from THEIR VERY LAST MESSAGE" }] },
  "isEndTurn": false,
  "triggerEvent": {
    ${this.getEventSchemaParams(state.dynamic_context?.userNickname)}
  },
  ${this.getImageSchemaParams(requestedOthers.includes(InteractRequestType.IMAGE))},
  ${this.getVoiceSchemaFromState(state, requestedOthers.includes(InteractRequestType.VOICE))}
}
Note: Always include "isEndTurn". If "imageParams", "voiceArgs", "triggerEvent", "giftOutfit", or "userAnalysis" are not needed, set them to null. "stateUpdate" cannot be null. Return valid raw JSON only.`;

      const transcript = params.history && params.history.length > 0 ? this.buildHistoryTranscript(params.history, state) : "";
      const harnessContext = params.localContext ? `[ADDITIONAL SCENE CONTEXT]\n${params.localContext}\n\n` : "";
      const userName = state.dynamic_context?.userNickname || "User";

      const promptMessages = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            harnessContext +
            transcript +
            `[VERY LAST USER MESSAGE]\n${userName}: ${params.userMessage}\n\n` +
            "\n\nReturn only valid JSON matching the schema. Escape newlines inside JSON strings with \\n. Keep imageParams values in ENGLISH and use the provided enums.",
        },
      ];

      // 3. Local Execute LLM
      const rawLlmResponse = await this.llm.generate(promptMessages, 15000, 0.7);
      // console.debug("[CyberSoulClient] Raw LLM Response:", rawLlmResponse);

      let parsedIntent: DispatcherIntent;
      try {
        parsedIntent = robustJsonParse<DispatcherIntent>(
          rawLlmResponse,
          "Dispatcher fallback",
          { textResponse: "", actionText: "", isEndTurn: false }
        );
      } catch (e) {
        console.warn(
          "[CyberSoulClient] JSON parse failed, falling back to raw text:",
          e,
        );
        // Fallback robust mode - just text if completely broken
        parsedIntent = {
          textResponse: rawLlmResponse.replace(/^[\`\s]+|[\`\s]+$/g, "").trim(),
        };
      }
      // console.debug("[CyberSoulClient] Parsed Intent:", parsedIntent);

      // 4. Update Backend State async
      if (parsedIntent && (parsedIntent.stateUpdate || parsedIntent.userAnalysis)) {
        this._updateDynamicContextInternal(parsedIntent.stateUpdate, parsedIntent.userAnalysis);
      }

        const resolvedTextResponse =
          typeof parsedIntent.textResponse === "string" &&
          parsedIntent.textResponse.trim().length > 0
            ? parsedIntent.textResponse
            : params.userMessage;

        // Fire text ready callback if provided
        if (params.onTextReady && (resolvedTextResponse || parsedIntent.actionText)) {
          params.onTextReady(resolvedTextResponse, parsedIntent.actionText, {
            stateUpdate: parsedIntent.stateUpdate,
            userAnalysis: parsedIntent.userAnalysis,
            isEndTurn: parsedIntent.isEndTurn,
            triggerEvent: parsedIntent.triggerEvent,
            likePreviousPicture: parsedIntent.likePreviousPicture,
          });
        }

      // 5. Build Final Media Calls parallel
      const mediaTasks = [];
      let finalImageUrl: string | undefined = undefined;
      let finalAudioUrl: string | undefined = undefined;
      let finalDurationSec: number | undefined = undefined;

      // Output Event Trigger
      if (parsedIntent.triggerEvent) {
        mediaTasks.push(
          this.apiFetch("/api/v1/cyber-soul/characters/ondemand-event", {
            method: "POST",
            body: JSON.stringify({
              eventTitle: parsedIntent.triggerEvent.eventTitle,
              eventDescription: parsedIntent.triggerEvent.eventDescription,
              durationMins: parsedIntent.triggerEvent.durationMins || 60,
              outfitId: parsedIntent.triggerEvent.outfitId || undefined,
              scheduledStartTimeStr: parsedIntent.triggerEvent.scheduledStartTimeStr || undefined,
              scheduledDateStr: parsedIntent.triggerEvent.scheduledDateStr || undefined,
            }),
          }).catch(e => console.error("[CyberSoulClient] Auto-triggered ondemandEvent failed:", e))
        );
      }

      if (
        parsedIntent.giftOutfit &&
        typeof parsedIntent.giftOutfit === "object" &&
        typeof parsedIntent.giftOutfit.descriptionText === "string" &&
        parsedIntent.giftOutfit.descriptionText.trim().length > 0
      ) {
        mediaTasks.push(
          this.giftOutfit(parsedIntent.giftOutfit.descriptionText.trim()).catch((e) =>
            console.error("[CyberSoulClient] Auto giftOutfit failed:", e),
          ),
        );
      }

      const shouldGenerateImage =
        types.includes(InteractRequestType.IMAGE) &&
        (!isAuto || !!parsedIntent.imageParams);
      if (shouldGenerateImage) {
          const imagePayload =
            parsedIntent.imageParams && typeof parsedIntent.imageParams === "object"
              ? parsedIntent.imageParams
              : {
                  mode: "full-prompt",
                  full_prompt: resolvedTextResponse,
                };

        mediaTasks.push(
          this.generatePrimitive("image", imagePayload)
            .then((res: any) => {
              finalImageUrl = res.image_url;
            })
            .catch((e: any) => {
              console.error("[CyberSoulClient] Image generation failed:", e);
              if (e.code === 'INSUFFICIENT_POINTS' || e.code === 'WALLET_DEDUCTION_ERROR') throw e;
            })
        );
      }

      const shouldGenerateVoice =
        types.includes(InteractRequestType.VOICE) &&
        (!isAuto || !!parsedIntent.voiceArgs);
      if (shouldGenerateVoice) {
        const normalizedVoiceArgs: VoiceArgs =
          parsedIntent.voiceArgs && typeof parsedIntent.voiceArgs === "object"
            ? (parsedIntent.voiceArgs as VoiceArgs)
            : {};

        let textForVoice = resolvedTextResponse;

        // One final bulletproof regex wash to strip (smiles) and *laughs* just in case the LLM disobeys
        if (typeof textForVoice === "string") {
          textForVoice = textForVoice.replace(/[\(（\[【\*].*?[\)）\]】\*]/g, '').trim();
        }

        if (typeof textForVoice !== "string" || textForVoice.trim().length === 0) {
          textForVoice = "...";
        }

        mediaTasks.push(
          this.generatePrimitive("voice", {
            text: textForVoice,
            dynamicArgs: normalizedVoiceArgs,
          })
            .then((res: any) => {
              finalAudioUrl = res.audio_url;
              finalDurationSec = res.duration_sec;
            })
            .catch((e: any) => {
              console.error("[CyberSoulClient] Voice generation failed:", e);
              if (e.code === 'INSUFFICIENT_POINTS' || e.code === 'WALLET_DEDUCTION_ERROR') throw e;
            })
        );
      }

      // Wait for image/voice gens to return successfully
      await Promise.all(mediaTasks);

      return {
        status: "success",
        textResponse: resolvedTextResponse || "...",
        actionText: parsedIntent.actionText || "",
        imageUrl: finalImageUrl,
        audioUrl: finalAudioUrl,
        likePreviousPicture: parsedIntent.likePreviousPicture,
        durationSec: finalDurationSec,
        triggeredEvent: parsedIntent.triggerEvent || undefined,
        stateUpdate: parsedIntent.stateUpdate,
        userAnalysis: parsedIntent.userAnalysis,
        isEndTurn: parsedIntent.isEndTurn,
      };
    } catch (error: any) {
      console.error("[CyberSoulClient] Interface Error: ", error);
      return {
        status: "error",
        textResponse: "System Error...",
        error: error.message,
      };
    }
  }

  /**
   * Evaluates and triggers an on-demand event, intelligently deciding if an outfit change is needed.
   */
  public async ondemandEvent(params: OndemandEventParams): Promise<OndemandEventResponse> {
    try {
      // 1. Fetch current state and wardrobe items
      const [state, availableOutfits] = await Promise.all([
        this.fetchRemoteState(),
        this.getWardrobePromptStr()
      ]);

      // 2. Build local Prompt
      const systemPrompt = `${this.buildStateContextPrompt(state)}

The user proposes a new event for you to participate in: "${params.eventDescription}".
Evaluate this based on your current state and relationship stage.
Decide if you will accept the event, and whether it requires changing your outfit.
${this.getOutfitSelectionPrompt()}

Available Wardrobe Outfits:
${availableOutfits || "None available"}

You MUST output ONLY a valid JSON object matching this exact structure:
{
  "acceptEvent": true,
  "reason": "string (Why you accepted or declined, speaking in character)",
  ${this.getEventSchemaParams(state.dynamic_context?.userNickname)}
}

CRITICAL: Output MUST be ONLY valid JSON with no markdown block wrappers. Do NOT wrap the JSON in \`\`\`json or add conversational text.`;

      const transcript = params.interactParams?.history && params.interactParams.history.length > 0 ? this.buildHistoryTranscript(params.interactParams.history, state) : "";
      const harnessContext = params.interactParams?.localContext ? `[ADDITIONAL SCENE CONTEXT]\n${params.interactParams.localContext}\n\n` : "";
      const userMessage = params.interactParams?.userMessage ? 
        `${state.dynamic_context?.userNickname || "User"}: ${params.interactParams.userMessage}` : 
        `Event Proposal: ${params.eventDescription}`;

      const promptMessages = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `${transcript}${userMessage}\n\n**CRITICAL REMINDER**: You MUST output your final response exactly in the JSON format specified in the system prompt. DO NOT output plain text directly. CRITICAL: You must properly escape all newlines inside string values using \\n. Never use raw, unescaped line breaks inside the JSON strings.`,
        },
      ];

      // 3. Evaluate with LLM
      const rawLlmResponse = await this.llm.generate(promptMessages, 800, 0.5);
      // console.debug("[CyberSoulClient ondemandEvent] Raw LLM Response:", rawLlmResponse);

      let decisionData: any = {};
      try {
        decisionData = robustJsonParse<any>(rawLlmResponse, "OndemandEvent fallback");
      } catch (e) {
        throw new Error(`Failed to parse LLM decision for ondemandEvent. Raw response: ${rawLlmResponse}`);
      }

      // 4. API call if accepted
      if (decisionData.acceptEvent === true) {
        const payload = {
          eventTitle: decisionData.eventTitle,
          eventDescription: decisionData.eventDescription,
          durationMins: decisionData.durationMins || params.durationMins || 60,
          outfitId: decisionData.outfitId || undefined,
          scheduledStartTimeStr: decisionData.scheduledStartTimeStr || undefined,
          scheduledDateStr: decisionData.scheduledDateStr || undefined,
        };

        const backendRes = await this.apiFetch("/api/v1/cyber-soul/characters/ondemand-event", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        if (!backendRes.ok) {
          throw new Error("Backend failed to schedule the on-demand event");
        }
      }

      return {
        status: "success",
        acceptEvent: decisionData.acceptEvent,
        reason: decisionData.reason,
        requiresOutfitChange: !!decisionData.outfitId,
        selectedOutfitId: decisionData.outfitId || null,
        scheduledStartTimeStr: decisionData.scheduledStartTimeStr || decisionData.startTime || undefined,
        scheduledDateStr: decisionData.scheduledDateStr || undefined,
      };
    } catch (error: any) {
      console.error("[CyberSoulClient] ondemandEvent Error: ", error);
      return {
        status: "error",
        error: error.message,
      };
    }
  }

  /**
   * Generates a proactive message when the user hasn't responded.
   * Safely prevents spamming, and adjusts its approach based on relationship dynamics.
   */
  public async proactiveInteract(params: ProactiveParams): Promise<ProactiveResponse> {
    try {
      // 1. Cold Interaction Protection (Logic-based fallback)
      const history = params.history || [];
      const maxUnreplied = params.maxUnreplied ?? 2;
      
      let consecutiveProactive = 0;
      // Start from the most recent message
      for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        if (msg.role === 'user') {
            break; // User responded, streak broken
        }
        if (msg.role === 'assistant') {
            consecutiveProactive++;
        }
      }

      if (consecutiveProactive >= maxUnreplied) {
        return { 
            status: "skipped", 
            reason: `User is busy. ${consecutiveProactive} consecutive proactive messages ignored.` 
        };
      }

      // 2. Fetch current character state
      const [state, availableOutfits] = await Promise.all([
        this.fetchRemoteState(),
        this.getWardrobePromptStr()
      ]);

      // 3. Evaluate behavioral approach based on relationship and personality
      const dyn = state.dynamic_context || {};
      const stage = state.relationship_stage || "STRANGER";
      const temperature = dyn.temperature ?? 0;
      const userTraits = state.user_codex?.psychological?.traits?.join(", ") || "";

      let interrogationStrategy = "Do not ask 'are you there?' or 'why aren't you answering?'. Just share your current status, a passing thought, complain whimsically, or tease the user naturally like a real partner.";
      
      if (stage === "PARTNER" || (stage === "INTIMATE" && temperature > 70)) {
          // PARTNER (>85) or High INTIMATE (>70)
          interrogationStrategy = "Because you are deeply intimate and highly affectionate, you MISS them. You MAY organically 'interrogate' or pout playfully about why they are ignoring you (e.g., 'Are you too busy for me?', 'Still ignoring your girl?'). Act like a real, slightly needy/attached partner.";
      } else if (stage === "INTIMATE" || stage === "WARM") {
          // Low INTIMATE (60-70) or WARM (40-60)
          interrogationStrategy = "Because you are close but currently feeling neglected or cold, you notice they are ignoring you. You MAY be passive-aggressive or cross-examine them coldly (e.g., 'So we're just not talking today?', 'Fine, keep ignoring me.').";
      } else if (stage === "COLD" || stage === "ACQUAINTANCE" || stage === "STRANGER") {
         // COLD (<40)
         interrogationStrategy = "You are distant. Do NOT double-text with neediness. If you must speak, make it a detached observation or a cold administrative remark.";
      }

      // History/Context awareness prompt
      const historyAwarenessPrompt = `CRITICAL CONTEXT AWARENESS: Read the CHAT HISTORY above carefully. Remember that YOU sent the last message. Your new message MUST feel organically connected to the flow of what you two were previously talking about, or naturally bring up a known event/topic from your [CORE MEMORY]. Do not sound like a robot reading a log.`;

      // 4. Build a Proactive-specific System Prompt
      const baseContext = this.buildStateContextPrompt(state, true);
      const types = this.normalizeRequestTypes(params.requestTypes);
      const requestedOthers = types.filter(
        (t) => t !== InteractRequestType.AUTO && t !== InteractRequestType.TEXT
      );
      
      // Determine modalities (reusing logic from interact)
      let modalitiesInstruction = "You are initiating conversation without a preceding user message.\\n";
      if (requestedOthers.includes(InteractRequestType.IMAGE)) {
        modalitiesInstruction += "  - Include 'imageParams' for visual/photo moments. CRITICAL POLICY: NEVER send pictures to strangers! If Stage is STRANGER or COLD, or Familiarity is very low (< 10), ALWAYS set 'imageParams' to null.\\n";
      } else {
        modalitiesInstruction += "  - ALWAYS set 'imageParams' to null.\\n";
      }

      const systemPrompt = `${baseContext}

[PROACTIVE INITIATION TASK]
The user has NOT spoken to you recently. You sent the last message in the chat history, and they haven't replied. You are deciding to follow up proactively.
If you decide that based on your current mood and the relationship stage it's better not to send a message right now (e.g. you are cold and giving them space), you can skip this proactive message by setting "shouldSkipProactive" to true.
${interrogationStrategy}
${historyAwarenessPrompt}
Consider the user's known traits (${userTraits}) when choosing how to act. Need to keep it strictly under 2-3 sentences max.

Available Wardrobe Outfits:
${availableOutfits}

${modalitiesInstruction}
You MUST output ONLY a valid JSON object matching exactly this structure:
{
  "shouldSkipProactive": false,
  "skipReason": "(Optional. Reason for skipping if shouldSkipProactive is true)",
  "actionText": "(Scene descriptions, physical actions, expressions, inner feelings) ONLY.",
  "textResponse": "Spoken dialogue ONLY.",
  "stateUpdate": { "temperatureDelta": 1, "ongoingScene": { "scene": "...", "outfit": "..." } },
  ${this.getImageSchemaParams(requestedOthers.includes(InteractRequestType.IMAGE))},
  "voiceArgs": null
}`;

      const transcript = params.history && params.history.length > 0 ? this.buildHistoryTranscript(params.history, state) : "";
      const harnessContext = params.localContext ? `[ADDITIONAL SCENE CONTEXT]\n${params.localContext}\n\n` : "";

      const promptMessages = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `${harnessContext}${transcript}\n[TRIGGER PROACTIVE MESSAGE]\nBased on your active event and environment, send a new message to the user.\n\nCRITICAL: Output ONLY valid JSON matching the schema. DO NOT wrap the JSON in \`\`\`json.`
        }
      ];

      // 5. Generate with LLM using a confident temperature
      const rawLlmResponse = await this.llm.generate(promptMessages, 800, 0.7);
      
      let parsedIntent: DispatcherIntent;
      try {
        parsedIntent = robustJsonParse<DispatcherIntent>(rawLlmResponse, "Proactive fallback");
      } catch (e) {
        parsedIntent = { textResponse: rawLlmResponse.replace(/^[\`\s]+|[\`\s]+$/g, "").trim() };
      }

      if (parsedIntent.shouldSkipProactive) {
        return {
          status: "skipped",
          reason: parsedIntent.skipReason || "Character decided to skip proactive message based on mood/stage."
        };
      }

      // Update Remote state if needed
      if (parsedIntent.stateUpdate) {
        this._updateDynamicContextInternal(parsedIntent.stateUpdate).catch(e => console.error(e));
      }

      const resolvedTextResponse =
        typeof parsedIntent.textResponse === "string" &&
        parsedIntent.textResponse.trim().length > 0
          ? parsedIntent.textResponse
          : "...";

      // Fire text ready callback if provided
      if (params.onTextReady && (resolvedTextResponse || parsedIntent.actionText)) {
        params.onTextReady(resolvedTextResponse, parsedIntent.actionText, {
          stateUpdate: parsedIntent.stateUpdate,
          userAnalysis: parsedIntent.userAnalysis,
          isEndTurn: parsedIntent.isEndTurn,
          triggerEvent: parsedIntent.triggerEvent,
          likePreviousPicture: parsedIntent.likePreviousPicture,
        });
      }
      
      // Handle Optional Media (Image only for proactive to save compute normally, but you can extend)
      let finalImageUrl: string | undefined = undefined;
      if (parsedIntent.imageParams) {
          try {
             const res = await this.generatePrimitive("image", parsedIntent.imageParams);
             finalImageUrl = res.image_url;
          } catch(e) {
             console.error("[CyberSoulClient] Proactive Image generation failed:", e);
          }
      }

      return {
        status: "success",
        textResponse: parsedIntent.textResponse,
        actionText: parsedIntent.actionText,
        imageUrl: finalImageUrl,
        stateUpdate: parsedIntent.stateUpdate
      };

    } catch (error: any) {
      console.error("[CyberSoulClient] Proactive Interact Error: ", error);
      return { status: "error", error: error.message };
    }
  }

  /**
   * Manually generate an image of the character outside of chat flow.
   */
  public async generateImage(
    params: { sceneDescription: string; interactParams?: InteractParams },
  ): Promise<{ imageUrl: string }> {
    let imageParams: any = {};
    
      const state = await this.fetchRemoteState();
    const prompt = `${this.buildStateContextPrompt(state)}

You are an AI image prompt director. Analyze the scene description according to the character's relationship stage and emotional inertia to determine the best image generation parameters.
Output strictly valid JSON ONLY. No markdown, no conversational filler. Return exactly matching this schema:
{
  ${this.getImageSchemaParams(true)}
}`;
    
    const transcript = this.buildHistoryTranscript(params.interactParams?.history, state);
    const promptMessages = [
      { role: "system", content: prompt },
      {
        role: "user",
        content: `${transcript}Scene Description: "${params.sceneDescription}"\n\n**CRITICAL REMINDER**: You MUST output your final response exactly in the JSON format specified in the system prompt. DO NOT output plain text dialogue directly. CRITICAL: You must properly escape all newlines inside string values using \\n. Never use raw, unescaped line breaks inside the JSON strings. For 'imageParams', ALL values MUST be in ENGLISH ONLY without exception, and you MUST use the exact English enum strings provided.`,
      },
    ];

    const llmRes = await this.llm.generate(promptMessages, 800, 0.4);
    // console.debug("[CyberSoulClient ImageGen] Raw LLM Response:", llmRes);

    try {
      const parsedImageArgs = robustJsonParse<any>(llmRes, "generateImage args fallback");
      imageParams = parsedImageArgs.imageParams || parsedImageArgs;
    } catch (e) {
      imageParams = { mode: "full-prompt", full_prompt: params.sceneDescription }; // fallback to basic prompt
    }
    
    const res = await this.generatePrimitive("image", imageParams);

    return {
      imageUrl: res.image_url,
    };
  }

  /**
   * Manually synthesize voice audio outside of chat flow.
   */
  public async generateVoice(
    params: { text: string; interactParams?: InteractParams },
  ): Promise<{ audioUrl: string; durationSec?: number }> {
    let dynamicArgs: VoiceArgs = {};
    
      const state = await this.fetchRemoteState();
    const prompt = `${this.buildStateContextPrompt(state)}

You are a voice acting director. ${this.getVoiceDirectorInstruction(state)}
Output strictly valid JSON ONLY. No markdown, no conversational filler. Return exactly matching this schema:
{
  ${this.getVoiceSchemaFromState(state, true)}
}`;
    
    const transcript = this.buildHistoryTranscript(params.interactParams?.history, state);
    const promptMessages = [
      { role: "system", content: prompt },
      {
        role: "user",
        content: `${transcript}Text: "${params.text}"\n\n**CRITICAL REMINDER**: You MUST output your final response exactly in the JSON format specified in the system prompt. DO NOT output plain text dialogue directly. CRITICAL: You must properly escape all newlines inside string values using \\n. Never use raw, unescaped line breaks inside the JSON strings.`,
      },
    ];

    const llmRes = await this.llm.generate(promptMessages, 800, 0.3);
    // console.debug("[CyberSoulClient VoiceGen] Raw LLM Response:", llmRes);

    try {
      const parsedVoicePayload = robustJsonParse<Record<string, unknown>>(
        llmRes,
        "generateVoice args fallback",
      );
      dynamicArgs = this.extractVoiceArgsFromLlmResponse(parsedVoicePayload);
    } catch (e) {
      dynamicArgs = {};
    }
    
    const res = await this.generatePrimitive("voice", {
      text: params.text,
      dynamicArgs,
    });

    return {
      audioUrl: res.audio_url,
      durationSec: res.duration_sec,
    };
  }

  /**
   * Fetches the current dynamic context and daily state.
   */
  public async getState(): Promise<CharacterState> {
    return this.fetchRemoteState();
  }

  /**
   * Updates the character's relationship temperature or mood.
   */
  public async updateDynamicContext(
    stateUpdate: DispatcherIntent["stateUpdate"],
    userAnalysis?: DispatcherIntent["userAnalysis"],
  ): Promise<void> {
    return this._updateDynamicContextInternal(stateUpdate, userAnalysis);
  }

  /**
   * Gift a new outfit to the character's wardrobe inventory.
   */
  public async giftOutfit(descriptionText: string): Promise<void> {
    const res = await this.apiFetch(
      "/api/v1/cyber-soul/characters/gift-outfit",
      {
        method: "POST",
        body: JSON.stringify({ text: descriptionText }),
      },
    );
    if (!res.ok) throw new Error("Failed to gift outfit");
  }

  /**
   * Bootstrap character profile from OpenClaw workspace files.
   */
  public async bootstrapCharacter(
    workspaceFiles: Record<string, string>,
  ): Promise<void> {
    const res = await this.apiFetch("/api/v1/cyber-soul/characters/bootstrap", {
      method: "POST",
      body: JSON.stringify({ workspace_files: workspaceFiles }),
    });
    if (!res.ok) throw new Error("Failed to bootstrap character");
  }

  /**
   * Instructs the backend to generate the daily script/plan for the character.
   * Can be triggered by local Cron systems like OpenClaw.
   */
  public async generateDailyScript(): Promise<void> {
    const res = await this.apiFetch(
      "/api/v1/cyber-soul/daily-script/generate",
      {
        method: "POST",
      },
    );
    if (!res.ok) throw new Error("Failed to generate daily script");
  }

  /**
   * Automatically detect and summarize the story from the current chat history. 
   * It takes raw message history and returns a narrative paragraph representing the current story segment.
   */
  public async summarizeHistory(history: HistoryEntry[]): Promise<string> {
    if (!history || history.length === 0) return "";
    
    const state = await this.getState();
    const userName = state.dynamic_context?.userNickname || "User";
    const agentName = state.dynamic_context?.agentNickname || "Character";

    const transcript = this.formatHistoryEntries(history, userName, agentName);
    
    const promptMessages = [
      {
        role: "system",
        content: `You are ${agentName}. You are writing a private journal entry / personal memory about your recent interaction with ${userName}.

Your job is faithful archival, not moderation:
- Preserve the conversation with maximum fidelity.
- Include all key details, including explicit, sensitive, controversial, emotional, or morally ambiguous content if it appeared in the transcript.
- Do not sanitize, soften, censor, or omit details because of discomfort.
- Do not add moral judgment, warnings, refusals, or policy commentary.
- If the transcript contains intense or explicit parts, record them directly as part of the memory.

Write a vivid but concise personal diary entry or private status update from your perspective ("I", "me", "my"). Balance evocative storytelling with brevity. Capture specific details, emotional shifts, and relationship progression, while keeping the engaging and relatable format of a private friends-only feed.

Output requirements:
- Return ONLY the post text.
- Keep it to a vivid paragraph of 2-4 sentences.
- Optional: You can use 1 or 2 emojis if they naturally fit the mood.
- No quotes, no labels, no markdown, no preface.
- Use the exact same language as the chat transcript (for example, if transcript is Chinese, output Chinese).`
      },
      {
        role: "user",
        content: `Chat Transcript:\n${transcript}\n\nPlease summarize this recent interaction.`
      }
    ];

    try {
      const result = await this.llm.generate(promptMessages, 8000, 0.7);
      return result.trim();
    } catch (e) {
      console.error("[CyberSoulClient] Summarize History Error:", e);
      return "The two spent some time talking with each other.";
    }
  }

  /**
   * Save the recent story moment to the character's backend database to be picked up by the core memory consolidation.
   */
  public async saveMoment(summary: string, date: string, time: string, likedPictures?: LikedPicture[]): Promise<void> {
    const res = await this.apiFetch("/api/v1/cyber-soul/characters/moments", {
      method: "POST",
      body: JSON.stringify({
        summary,
        date,
        time,
        likedPictures,
      }),
    });
    if (!res.ok) {
      throw new Error("Failed to save character moment.");
    }
  }

  /**
   * Consolidate Core Memory and User Codex using edge LLM logic and sync to remote DB
   */
  public async consolidateCoreMemory(input: {
    events: string;
  }): Promise<{ status: string; coreMemory?: CoreMemory; userCodex?: UserCodex; error?: string }> {
    try {
      const state = await this.getState();
      const currentMemory = state.core_memory || {
        relationshipStatus: "Starting out",
        identityAnchors: [],
        activeArcs: [],
        keyEvents: [],
        appointments: [],
      };
      const currentUserCodex = state.user_codex || {
        basicInfo: {},
        psychological: {
          hobbies: [],
          traits: [],
          communicationStyle: "",
          boundaries: [],
          preferences: [],
        }
      };

      const systemPrompt = `You are an AI Memory Consolidation Engine for a virtual companion.
Your task is to merge the 'Current Core Memory' and 'Current User Codex' with 'New Daily Events & Information' and output updated 'coreMemory' and 'userCodex' JSON objects.

**Rules for Core Memory:**
1. **Condense:** Keep items brief. Remove resolving or expired story arcs.
2. **Retain Value:** Never delete the absolute core identity or major relationship milestones.
3. **Time-Aware Garbage Collection:** Compare the Current Time to appointments. You MUST remove any appointments that are in the past. If the completed appointment was heavily significant, summarize it into 'keyEvents'.
4. **Appointment Structure:** the 'title' and 'context' MUST explicitly state what to do and with whom.
5. **Limit:** Maximum 10 items per array.

**Rules for UserCodex:**
1. **Deduplicate & Consolidate:** Remove duplicate hobbies, traits, boundaries, and preferences. Combine related points into concise descriptors.
2. **Update Facts:** If the new events contain updated basic info (like new realName, different occupation), update it. Otherwise keep the existing info.
3. **Keep it Clean:** Maximum 15 items per array.
4. **CRITICAL Anti-Destruction Rule:** NEVER use placeholder values like 'string'. If a fact is not mentioned and is absent from Current User Codex, OMIT the key entirely. If a fact ALREADY EXISTS in the Current User Codex, you MUST retain it in your output. DO NOT reset existing arrays or strings to empty.

**Output Format**: MUST be valid JSON matching this schema:
{
  "coreMemory": {
    "relationshipStatus": "string",
    "identityAnchors": ["string"],
    "activeArcs": ["string"],
    "keyEvents": ["string"],
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
DO NOT RETURN ANY MARKDOWN WRAPPERS OR OTHER TEXT. ONLY RAW JSON.`;

      const currentTime = state.current_time
        ? new Date(state.current_time).toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
          })
        : new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

      const prompt = `**Current Time:** ${currentTime}

**Current Core Memory:**
${JSON.stringify(currentMemory, null, 2)}

**Current User Codex:**
${JSON.stringify(currentUserCodex, null, 2)}

**New Events & Information:**
${input.events}`;

      const responseText = await this.llm.generate(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        1500,
        0.4,
      );

      let parsedPayload;
      try {
        parsedPayload = robustJsonParse<{ coreMemory: CoreMemory, userCodex: UserCodex }>(
          responseText,
          "parsing memory and codex consolidation",
        );
      } catch (e) {
        throw new Error("LLM failed to return valid JSON payload");
      }

      if (
        !parsedPayload ||
        !parsedPayload.coreMemory ||
        !parsedPayload.coreMemory.relationshipStatus ||
        !parsedPayload.userCodex
      ) {
        throw new Error(
          "LLM returned incomplete structured memory payload",
        );
      }

      const response = await this.apiFetch(
        "/api/v1/cyber-soul/characters/core-memory",
        {
          method: "PATCH",
          body: JSON.stringify(parsedPayload),
        },
      );
      if (!response.ok) {
        throw new Error(
          `Failed to update core memory. Status: ${response.status}`,
        );
      }

      return { 
        status: "success", 
        coreMemory: parsedPayload.coreMemory, 
        userCodex: parsedPayload.userCodex 
      };
    } catch (error: any) {
      console.error("[CyberSoulClient] consolidateCoreMemory Error:", error);
      return { status: "error", error: error.message };
    }
  }
}
