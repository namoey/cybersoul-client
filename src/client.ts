import {
  CyberSoulClientConfig,
  InteractParams,
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
} from "./types.js";
import { robustJsonParse } from "./utils/json.utils.js";
import { MinimaxProvider } from "./providers/minimax.provider.js";

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
    if (config.llmConfig.provider === "minimax") {
      this.llm = new MinimaxProvider(config.llmConfig);
    } else {
      throw new Error(`Unsupported LLM provider: ${config.llmConfig.provider}`);
    }
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

  private buildStateContextPrompt(
    state: CharacterState,
    localContext?: string,
  ): string {
    const dyn = state.dynamic_context || {};
    const stage = state.relationship_stage || "NEUTRAL";
    const temperature = dyn.temperature ?? 50;

    const contextParts: string[] = [];

    // [1] CORE IDENTITY & PHYSICAL CONTEXT
    contextParts.push(`[CORE IDENTITY]
Name: ${state.name}
Demographics: Age ${state.age || "unknown"}, Gender ${state.gender || "unknown"}, Occupation ${state.occupation || "unknown"}
Hobby: ${state.hobby || "unknown"}
Personality Traits: ${state.personality_traits || "None"}
Communication Style: ${state.communication_style || "None"}
Interaction Boundaries: ${state.interaction_boundaries || "None"}`);

    // [2] SITUATIONAL CONTEXT
    contextParts.push(`\n[SITUATIONAL CONTEXT]
Current time: ${new Date(state.current_time || Date.now()).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
    
    if (dyn.ongoingScene) {
      contextParts.push(`Ongoing Scene: ${dyn.ongoingScene}`);
    }

    if (state.active_event) {
      contextParts.push(`Active Event: ${state.active_event.title} (${state.active_event.narrative_context})`);
    }
    if (state.next_event) {
      contextParts.push(`Next Event: ${state.next_event.title} at ${state.next_event.start_time} (in ${state.next_event.time_until_mins} mins)`);
    }
    if (state.active_wardrobe) {
      contextParts.push(`Wardrobe: ${state.active_wardrobe.name || state.active_wardrobe.id || "Current"}`);
    }
    if (localContext) {
      contextParts.push(`Additional Context: ${localContext}`);
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
Traits/Boundaries: ${(psychological?.traits || []).join(", ") || "Unknown"} / ${(psychological?.boundaries || []).join(", ") || "Unknown"}`);

      // CURIOSITY DRIVE: Find what's missing, but ONLY IF we are on generally warm speaking terms
      // Paradox avoidance: A cold/angry character shouldn't enthusiastically fish for hobbies.
      if (temperature >= 40 && stage !== "COLD" && stage !== "STRANGER") {
        const missingFacts = [];
        if (!basicInfo?.occupation) missingFacts.push("their job or occupation");
        if (!psychological?.hobbies || psychological.hobbies.length === 0) missingFacts.push("their hobbies or what they do for fun");
        if (!basicInfo?.age || !basicInfo?.gender) missingFacts.push("some basic personal details about them");
        if (!psychological?.traits || psychological.traits.length === 0) missingFacts.push("their personality traits");

        if (missingFacts.length > 0) {
          contextParts.push(`\n[CURIOUSITY DRIVE]
Because you are warm and curious, whenever natural in conversation, subtly ask about or fish for info regarding: ${missingFacts.slice(0, 2).join(" and ")}.`);
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
1. PROXIMITY & POV: Check the "Active Event". If you are doing an activity WITH the user, evaluate if you are physically in the same location. If you are together in person, communicate face-to-face in the first-person present tense natively (e.g. do not ask "what are you doing" if they are right in front of you, do not use texting tropes).
2. IDENTITY VS MOOD: Familiarity determines what you know; Temperature determines how you feel. If Familiarity is high but Temperature is low, be distant and cold. Do not act warm just because you know them well.
3. CONVERSATIONAL VERBOSITY: If Temperature is low (< 40) or Stage is STRANGER/COLD, keep answers brief and short. An angry or distant person does not write long paragraphs.
4. EMOTIONAL INERTIA: React strictly according to current Temperature. Deflect sudden user affection if you are currently COLD. Mood shifts MUST be slow ('temperatureDelta' +/- 5 max per turn).`;
  }

  private getImageSchemaParams(): string {
    return `"imageParams": {
    "mode": "structured | full-prompt (use 'full-prompt' for highly dynamic actions)",
    "full_prompt": "Use only if mode is full-prompt. Highly detailed visual description in ENGLISH. CRITICAL: MUST use a strict first-person perspective exclusively from the USER's eyes. DO NOT describe the user (e.g., 'a man', 'the driver') as visible in the scene because the camera IS the user. Start with 'POV: '. Describe ONLY the character looking back at the camera and their immediate surroundings. MUST align with the character's current Active exposure state or Wardrobe depends on the scene",
    "expression": "seductive | cute | happy | sleepy | dazed | pleased | default (Strictly choose ONE from this exact list. DO NOT invent new words like 'shy'.)",
    "condition": "normal | sweaty | wet | messy | oily (Strictly choose ONE from this exact list.)",
    "view_angle": "front | side | high_angle | from_below | boyfriend_view | selfie | mirror (Strictly choose ONE from this exact list.)",
    "exposure": "normal | cleavage | see_through | half_naked | naked | intimate (Strictly choose ONE from this exact list.)",
    "pose": "e.g., sitting on bed, leaning forward (ENGLISH ONLY)",
    "scene": "e.g., cozy bedroom, morning light (ENGLISH ONLY)",
    "outfit": "auto | ondemand",
    "ondemandOutfit": "e.g., silk robe (ENGLISH ONLY)",
    "style": "e.g., photorealistic (ENGLISH ONLY)"
  }`;
  }

  private getEventSchemaParams(userName?: string): string {
    const name = userName || "the user";
    return `"eventTitle": "CRITICAL: Must include BOTH ‘WHAT to do’ AND ‘WITH WHOM’ (use the user's specific name if known, e.g., 'Having coffee with ${name}'). DO NOT use your own character name in the title! If you don't explicitly include WITH WHOM the event is by name, it is a hard failure.",
    "eventDescription": "e.g. 'Meeting at the cafe, chatting about life' (Detailed description of the event and virtual scene)",
    "scheduledDateStr": "YYYY-MM-DD (Optional. If the user specifies a future date like 'tomorrow', 'Saturday', or 'next week', calculate the exact calendar date based on the 'Current time' provided in the context and output it here. Otherwise, return null)",
    "scheduledStartTimeStr": "HH:MM (Optional, 24-hour format if a specific time is agreed upon, e.g., '14:30', otherwise null)",
    "durationMins": 60,
    "outfitId": "optional wardrobe ID to change into if appropriate"`;
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
  private getVoiceSchemaFromState(state: CharacterState): string {
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

  private buildHistoryTranscript(history: HistoryEntry[] | undefined, state: CharacterState): string {
    if (!history || history.length === 0) return "";
    const agentName = state.dynamic_context?.agentNickname || state.name || "Agent";
    const userName = state.dynamic_context?.userNickname || "User";
    
    const mapped = history.map((msg: HistoryEntry) => {
      const speaker = msg.role === 'user' ? userName : (msg.role === 'assistant' || msg.role === 'agent' ? agentName : msg.role);
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const action = msg.actionText ? ` ${msg.actionText}` : "";
      const media = msg.mediaHint ? ` [${msg.mediaHint}]` : "";
      return `${speaker}:${action} ${content}${media}`;
    });
    return `[CHAT HISTORY]\n${mapped.join('\n')}\n\n`;
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
      const systemPrompt = `${this.buildStateContextPrompt(state, params.interactParams?.localContext)}

The user proposes a new event for you to participate in: "${params.eventDescription}".
Evaluate this based on your current state and relationship stage.
Decide if you will accept the event, and whether it requires changing your outfit.

Available Wardrobe Outfits:
${availableOutfits || "None available"}

You MUST output ONLY a valid JSON object matching this exact structure:
{
  "acceptEvent": true,
  "reason": "string (Why you accepted or declined, speaking in character)",
  ${this.getEventSchemaParams(state.dynamic_context?.userNickname)}
}

CRITICAL: Output MUST be ONLY valid JSON with no markdown block wrappers. Do NOT wrap the JSON in \`\`\`json or add conversational text.`;

      const transcript = this.buildHistoryTranscript(params.interactParams?.history, state);
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
   * Manually generate an image of the character outside of chat flow.
   */
  public async generateImage(
    params: { sceneDescription: string; interactParams?: InteractParams },
  ): Promise<{ imageUrl: string }> {
    let imageParams: any = {};
    
      const state = await this.fetchRemoteState();
    const prompt = `${this.buildStateContextPrompt(state, params.interactParams?.localContext)}

You are an AI image prompt director. Analyze the scene description according to the character's relationship stage and emotional inertia to determine the best image generation parameters.
Output strictly valid JSON ONLY. No markdown, no conversational filler. Return exactly matching this schema:
{
  ${this.getImageSchemaParams()}
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
    const prompt = `${this.buildStateContextPrompt(state, params.interactParams?.localContext)}

You are a voice acting director. ${this.getVoiceDirectorInstruction(state)}
Output strictly valid JSON ONLY. No markdown, no conversational filler. Return exactly matching this schema:
{
  ${this.getVoiceSchemaFromState(state)}
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

    await this.apiFetch("/api/v1/cyber-soul/characters/dynamic-context", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }).catch((e: any) => console.error("Failed to update dynamic context", e)); // non-blocking error handler
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

  private normalizeRequestTypes(
    requestTypes?: InteractRequestType[],
  ): InteractRequestType[] {
    if (!requestTypes || requestTypes.length === 0) {
      return [InteractRequestType.AUTO];
    }

    const validRequestTypes = new Set<string>(
      Object.values(InteractRequestType),
    );
    const invalidRequestTypes = requestTypes.filter(
      (type) => !validRequestTypes.has(type),
    );

    if (invalidRequestTypes.length > 0) {
      throw new Error(
        `Invalid requestTypes: ${invalidRequestTypes.join(", ")}. Allowed values: ${Object.values(InteractRequestType).join(", ")}`,
      );
    }

    return requestTypes;
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

      // Combine state info into a clean descriptive context
      const systemPrompt = `${this.buildStateContextPrompt(state, params.localContext)}
Available Wardrobe Outfits (For event triggers):
${availableOutfits}

The user has sent a message. You must evaluate the context and the user's message, and return a JSON object (no markdown formatting) that dictates the character's multi-modal response.

${
  isAuto
    ? `Analyze the user's message to determine the appropriate response modalities (text, image, voice).
  - Always include 'textResponse'.
  - If an Active Event is currently taking place WITH the user, proactively include 'imageParams' for key scenic moments. Since active events are often highly dynamic actions, strongly consider using mode: "full-prompt" to capture the scene intimately. Also include 'imageParams' if the user explicitly asks for a photo or describes a visual action.
  - Automatically include 'voiceArgs' if a particular mood or strong emotion needs to be expressed vividly, or if the user explicitly wants to hear you.
  - If the user explicitly proposes a new activity or hangout IN THEIR VERY LAST MESSAGE (e.g., "let's go to the cafe", "do you want to watch a movie?"), include 'triggerEvent' to schedule it. DO NOT trigger events based on older plans or questions found in the chat history.`
    : `Requested types to fulfill: ${types.join(", ")}`
}
Every turn of positive or engaging interaction should slightly increase trust (+1). If the interaction is negative, -1. If strictly neutral, 0. You MUST ALWAYS include a 'stateUpdate' block with a 'temperatureDelta', updating nicknames or talkingStyle if needed. Temperature goes from 0 (cold/angry) to 100 (obsessively in love). For 'temperatureDelta', output an integer (e.g. 1, -2, 0).
Also, if you learn any new factual information about the user in this turn (e.g. their job, nickname, age, hobbies, boundaries), include it in the 'userAnalysis.newFactsLearned' array. Use categories: 'nickname', 'occupation', 'age', 'gender', 'hobby', 'trait', 'communicationStyle', 'boundary'. Only include NEW facts just learned right now.

Voice direction for voiceArgs: ${this.getVoiceDirectorInstruction(state)}

Output JSON Schema:
{
  "textResponse": "The clean spoken dialogue ONLY. CRITICAL: Strictly NO parentheses, NO actions, NO tone descriptors. Tone/voice descriptors MUST go inside voiceArgs, and physical actions MUST go inside actionText. If nothing to speak, output an empty string.",
  "actionText": "Any non-verbal actions, inner thoughts, or scene descriptions in parentheses (e.g. '（低头看向你）'). Output empty string if none.",
  "stateUpdate": { "temperatureDelta": 1, "userNickname": "What you now call the user", "agentNickname": "What the user calls you", "talkingStyle": "Current mood/style of talking", "ongoingScene": "A concise 1-sentence description of the current physical scene and activity (e.g. 'We are cuddling on the couch watching a movie'). Update this if the physical scene or activity shifts." },
  "userAnalysis": { "newFactsLearned": [{ "category": "occupation", "value": "Software Engineer" }] },
  "triggerEvent": {
    ${this.getEventSchemaParams(state.dynamic_context?.userNickname)}
  },
  ${this.getImageSchemaParams()},
  ${this.getVoiceSchemaFromState(state)}
}
Note: If "imageParams", "voiceArgs", "triggerEvent", or "userAnalysis" are not needed, set their values to null instead of omitting the keys. 'stateUpdate' MUST NEVER BE NULL. Output MUST be ONLY valid JSON with no markdown block wrappers. CRITICAL: Ensure your JSON has exactly one root object \`{\` and ends with exactly one \`}\` without any trailing garbage or extra brackets.`;

      const transcript = this.buildHistoryTranscript(params.history, state);
      const userName = state.dynamic_context?.userNickname || "User";

      const promptMessages = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            transcript + userName + ": " +
            params.userMessage +
            "\n\n**CRITICAL REMINDER**: You MUST output your final response exactly in the JSON format specified in the system prompt. DO NOT output plain text dialogue directly. CRITICAL: You must properly escape all newlines inside string values using \\n. Never use raw, unescaped line breaks inside the JSON strings. For 'imageParams', ALL values MUST be in ENGLISH ONLY without exception, and you MUST use the exact English enum strings provided.",
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
        if (params.onTextReady && resolvedTextResponse) {
          params.onTextReady(resolvedTextResponse);
      }

      // 5. Build Final Media Calls parallel
      const mediaTasks = [];
      let finalImageUrl: string | undefined = undefined;
      let finalAudioUrl: string | undefined = undefined;
      let finalDurationSec: number | undefined = undefined;

      // Output Event Trigger
      if (isAuto && parsedIntent.triggerEvent) {
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

      const shouldGenerateImage =
        types.includes(InteractRequestType.IMAGE) ||
        (isAuto && !!parsedIntent.imageParams);
      if (shouldGenerateImage) {
          const imagePayload =
            parsedIntent.imageParams && typeof parsedIntent.imageParams === "object"
              ? parsedIntent.imageParams
              : {
                  mode: "full-prompt",
                  full_prompt: resolvedTextResponse,
                };

        mediaTasks.push(
            this.generatePrimitive("image", imagePayload).then((res: any) => {
            finalImageUrl = res.image_url;
          }),
        );
      }

      const shouldGenerateVoice =
        types.includes(InteractRequestType.VOICE) ||
        (isAuto && !!parsedIntent.voiceArgs);
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
          }).then((res: any) => {
            finalAudioUrl = res.audio_url;
            finalDurationSec = res.duration_sec;
          }),
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
        durationSec: finalDurationSec,
        triggeredEvent: parsedIntent.triggerEvent || undefined,
        stateUpdate: parsedIntent.stateUpdate,
        userAnalysis: parsedIntent.userAnalysis,
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
   * Consolidate Core Memory and User Codex using edge LLM logic and sync to remote DB
   */
  async consolidateCoreMemory(input: {
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

**Rules for User Codex:**
1. **Deduplicate & Consolidate:** Remove duplicate hobbies, traits, and boundaries. Combine related points into concise descriptors.
2. **Update Facts:** If the new events contain updated basic info (like new nickname, different occupation), update it. Otherwise keep the existing info.
3. **Keep it Clean:** Maximum 15 items per array.

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
      "nickname": "string",
      "occupation": "string",
      "age": "string",
      "gender": "string"
    },
    "psychological": {
      "hobbies": ["string"],
      "traits": ["string"],
      "communicationStyle": "string",
      "boundaries": ["string"]
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
