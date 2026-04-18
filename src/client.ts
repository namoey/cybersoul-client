import {
  CyberSoulClientConfig,
  InteractParams,
  InteractRequestType,
  DispatcherIntent,
  InteractResponse,
  BaseLLMProvider,
  CharacterState,
  ImageGenerationParams,
  VoiceGenerationParams
} from "./types.js";
import { robustJsonParse } from "./utils/json.utils.js";
import { MinimaxProvider } from "./providers/minimax.provider.js";

export class CyberSoulClient {
  private config: CyberSoulClientConfig;
  private llm: BaseLLMProvider;

  constructor(config: CyberSoulClientConfig) {
    this.config = config;

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
  private async apiFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.config.backendUrl}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.config.characterKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    return fetch(url, { ...options, headers });
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
  ): Promise<void> {
    if (!stateUpdate) return;
    
    // Map TS schema intent (temperatureDelta) to match Backend payload schema (temperature)
    const payload: any = { ...stateUpdate };
    if (payload.temperatureDelta !== undefined) {
      payload.temperature = payload.temperatureDelta;
      delete payload.temperatureDelta;
    }

    await this.apiFetch("/api/v1/cyber-soul/characters/dynamic-context", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }).catch((e: any) => console.error("Failed to update dynamic context", e)); // non-blocking error handler
  }

  /**
   * Manually generate an image of the character outside of chat flow.
   */
  public async generateImage(params: ImageGenerationParams): Promise<{ imageUrl: string }> {
    return this.generatePrimitive("image", params);
  }

  /**
   * Manually synthesize voice audio outside of chat flow.
   */
  public async generateVoice(params: VoiceGenerationParams): Promise<{ audioUrl: string, durationSec?: number }> {
    return this.generatePrimitive("voice", params);
  }

  /**
   * Gift a new outfit to the character's wardrobe inventory.
   */
  public async giftOutfit(descriptionText: string): Promise<void> {
    const res = await this.apiFetch("/api/v1/cyber-soul/characters/gift-outfit", {
      method: "POST",
      body: JSON.stringify({ text: descriptionText }),
    });
    if (!res.ok) throw new Error("Failed to gift outfit");
  }

  /**
   * Bootstrap character profile from OpenClaw workspace files.
   */
  public async bootstrapCharacter(workspaceFiles: Record<string, string>): Promise<void> {
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
    const res = await this.apiFetch("/api/v1/cyber-soul/daily-script/generate", {
      method: "POST",
    });
    if (!res.ok) throw new Error("Failed to generate daily script");
  }

  private async fetchRemoteState() {
    const res = await this.apiFetch("/api/v1/cyber-soul/state");
    if (!res.ok) throw new Error("Failed to fetch character state");
    const json = await res.json();
    return json.data;
  }

  private async _updateDynamicContextInternal(
    stateUpdate: DispatcherIntent["stateUpdate"],
  ): Promise<void> {
    if (!stateUpdate) return;
    
    // Map TS schema intent (temperatureDelta) to match Backend payload schema (temperature)
    const payload: any = { ...stateUpdate };
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
    if (!res.ok) throw new Error(`Failed to generate ${type}`);
    return res.json();
  }

  private normalizeRequestTypes(requestTypes?: InteractRequestType[]): InteractRequestType[] {
    if (!requestTypes || requestTypes.length === 0) {
      return [InteractRequestType.AUTO];
    }

    const validRequestTypes = new Set<string>(Object.values(InteractRequestType));
    const invalidRequestTypes = requestTypes.filter((type) => !validRequestTypes.has(type));

    if (invalidRequestTypes.length > 0) {
      throw new Error(
        `Invalid requestTypes: ${invalidRequestTypes.join(", ")}. Allowed values: ${Object.values(InteractRequestType).join(", ")}`,
      );
    }

    return requestTypes;
  }

  public async interact(params: InteractParams): Promise<InteractResponse> {
    try {
      // 1. Sync remote context
      const state = await this.fetchRemoteState();

      // 2. Build local Prompt
      const types = this.normalizeRequestTypes(params.requestTypes);
      const isAuto = types.includes(InteractRequestType.AUTO);

      // Combine state info into a clean descriptive context
      const contextParts: string[] = [];
      if (state.active_event) {
        contextParts.push(`- Active Event: ${state.active_event.title} (${state.active_event.narrative_context})`);
      }
      if (state.next_event) {
        contextParts.push(`- Next Event: ${state.next_event.title} at ${state.next_event.start_time} (in ${state.next_event.time_until_mins} mins)`);
      }
      if (state.active_wardrobe) {
        contextParts.push(`- Wardrobe: ${state.active_wardrobe.name || state.active_wardrobe.id || "Current"}`);
      }

      const dyn = state.dynamic_context || {};
      const stage = state.relationship_stage || "NEUTRAL";
      contextParts.push(`- Relationship Info (Stage: ${stage}): You call the user '${dyn.userNickname || "User"}'. The user calls you '${dyn.agentNickname || "Agent"}'. Mood: ${dyn.talkingStyle || "Normal"}. Temp (0-100): ${dyn.temperature || 50}.`);
      
      if (params.localContext) {
        contextParts.push(`- Additional Context: ${params.localContext}`);
      }
      const scenarioContext = contextParts.join("\n");

      const systemPrompt = `You are ${state.name}, acting as a virtual companion.
  Demographics: Age ${state.age || 'unknown'}, Gender ${state.gender || 'unknown'}, Occupation ${state.occupation || 'unknown'}
Current time: ${new Date(state.current_time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
Current context/schedule: ${scenarioContext}
Relationship stage: ${state.relationship_stage}
Personality Traits: ${state.personality_traits || 'None'}
Interaction Boundaries: ${state.interaction_boundaries || 'None'}
Communication Style: ${state.communication_style || 'None'}

EMOTIONAL INERTIA RULES:
1. You must act strictly according to the current Relationship Stage (${state.relationship_stage || 'NEUTRAL'}).
2. If the user expresses sudden high affection (e.g. "I miss you") but your stage is COLD, you MUST react with skepticism, coldness, or appropriately distanced deflection. Do NOT instantly become warm.
3. Emotional mood changes must be slow. The 'temperatureDelta' should rarely exceed +/- 5 points per turn.

The user has sent a message. You must evaluate the context and the user's message, and return a JSON object (no markdown formatting) that dictates the character's multi-modal response.

${
  isAuto
    ? `Analyze the user's message to determine the appropriate response modalities (text, image, voice).
  - Always include 'textResponse'.
  - If the user explicitly asks to see a photo, look at you, or describing an action that warrants a photo, include 'imageParams'.
  - If the user wants to hear you, or if appropriate for a voice message, include 'voiceArgs'.`
    : `Requested types to fulfill: ${types.join(", ")}`
}
If the user's message shifts the emotional mood, establishes new nicknames, or warrants a relationship temperature change, you MUST include a 'stateUpdate' block. Temperature goes from 0 (cold/angry) to 100 (obsessively in love).

Output JSON Schema:
{
  "textResponse": "The direct spoken dialogue in Chinese",
  "stateUpdate": { "temperatureDelta": "+1 to -1", "userNickname": "What you now call the user", "agentNickname": "What the user calls you", "talkingStyle": "Current mood/style of talking" },
  "imageParams": {
    "mode": "structured | full-prompt (use 'full-prompt' for highly dynamic actions)",
    "full_prompt": "Use only if mode is full-prompt. Highly detailed visual description in ENGLISH.",
    "expression": "seductive | cute | happy | sleepy | dazed | pleased | default (Strictly choose ONE from this exact list. DO NOT invent new words like 'shy'.)",
    "condition": "normal | sweaty | wet | messy | oily (Strictly choose ONE from this exact list.)",
    "view_angle": "front | side | high_angle | from_below | boyfriend_view | selfie | mirror (Strictly choose ONE from this exact list.)",
    "exposure": "normal | cleavage | see_through | half_naked | naked | intimate (Strictly choose ONE from this exact list.)",
    "pose": "e.g., sitting on bed, leaning forward (ENGLISH ONLY)",
    "scene": "e.g., cozy bedroom, morning light (ENGLISH ONLY)",
    "outfit": "auto | ondemand",
    "ondemandOutfit": "e.g., silk robe (ENGLISH ONLY)",
    "style": "e.g., photorealistic (ENGLISH ONLY)"
  },
  "voiceArgs": { "style_instruction": "How the line should be spoken (Qwen3 format)", "emotion": "e.g., happy (MiniMax format, MUST BE ENGLISH, no Chinese)" }
}
Note: If "imageParams", "voiceArgs", or "stateUpdate" are not needed, set their values to null instead of omitting the keys completely (e.g., "imageParams": null). Output MUST be ONLY valid JSON with no markdown block wrappers. CRITICAL: Ensure your JSON has exactly one root object \`{\` and ends with exactly one \`}\` without any trailing garbage or extra brackets.`;

      const promptMessages = [
        { role: "system", content: systemPrompt },
        ...(params.history || []),
        {
          role: "user",
          content:
            params.userMessage +
            "\n\n**CRITICAL REMINDER**: You MUST output your final response exactly in the JSON format specified in the system prompt. DO NOT output plain text dialogue directly. For 'imageParams', ALL values MUST be in ENGLISH ONLY without exception, and you MUST use the exact English enum strings provided.",
        },
      ];

      // 3. Local Execute LLM
      const rawLlmResponse = await this.llm.generate(promptMessages, 1500, 0.7);
      console.log("[CyberSoulClient] Raw LLM Response:", rawLlmResponse);

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
      console.log("[CyberSoulClient] Parsed Intent:", parsedIntent);

      // 4. Update Backend State async
      if (parsedIntent && parsedIntent.stateUpdate) {
        this._updateDynamicContextInternal(parsedIntent.stateUpdate);
      }

      // Fire text ready callback if provided
      if (params.onTextReady && parsedIntent.textResponse) {
        params.onTextReady(parsedIntent.textResponse);
      }

      // 5. Build Final Media Calls parallel
      const mediaTasks = [];
      let finalImageUrl: string | undefined = undefined;
      let finalAudioUrl: string | undefined = undefined;
      let finalDurationSec: number | undefined = undefined;

      const shouldGenerateImage =
        types.includes(InteractRequestType.IMAGE) || (isAuto && !!parsedIntent.imageParams);
      if (shouldGenerateImage) {
        mediaTasks.push(
          this.generatePrimitive("image", {
            ...parsedIntent.imageParams,
            ...(params.imageOverrides || {}),
          }).then((res: any) => {
            finalImageUrl = res.image_url;
          }),
        );
      }

      const shouldGenerateVoice =
        types.includes(InteractRequestType.VOICE) || (isAuto && !!parsedIntent.voiceArgs);
      if (shouldGenerateVoice) {
        const dynamicArgs = { 
          ...(parsedIntent.voiceArgs || {}),
          ...(params.voiceOverrides || {})
        };
        
        mediaTasks.push(
          this.generatePrimitive("voice", {
            text: parsedIntent.textResponse,
            dynamicArgs,
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
        textResponse: parsedIntent.textResponse || "...",
        imageUrl: finalImageUrl,
        audioUrl: finalAudioUrl,
        durationSec: finalDurationSec,
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
}
