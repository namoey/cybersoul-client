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
  InteractMediaError,
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
  OutfitGiftedPayload,
  PersistedDynamicContext,
  SupportedLLMModel,
} from "./types.js";
import { robustJsonParse } from "./utils/json.utils.js";
import { GenericLLMProvider } from "./llm.provider.js";
import {
  CyberSoulApiError,
  CyberSoulAuthError,
  CyberSoulError,
  CyberSoulInsufficientPointsError,
  CyberSoulNetworkError,
  CyberSoulSensitiveContentError,
  CyberSoulTimeoutError,
  CyberSoulWalletError,
} from "./errors.js";

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
      config.characterKey,
      config.fetchImpl
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
        // NOTE: When no custom fetchImpl is provided, fall back to the global
        // `fetch` bound to `globalThis`. Browsers throw "Illegal invocation"
        // if the global `fetch` is invoked while detached from its Window
        // receiver (e.g. via a captured reference).
        const fetchFn = this.config.fetchImpl ?? fetch.bind(globalThis);
        const response = await fetchFn(url, {
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
          lastError = new CyberSoulTimeoutError(
            endpoint,
            method,
            this.requestTimeoutMs,
          );
        } else {
          lastError = new CyberSoulNetworkError(
            endpoint,
            method,
            error instanceof Error
              ? `Network request failed: ${method} ${endpoint}: ${error.message}`
              : `Network request failed: ${method} ${endpoint}`,
            { cause: error },
          );
        }
        if (attempt >= retryLimit) {
          throw lastError;
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    // Defensive: the loop above either returns a Response, throws the
    // wrapped network error, or continues to the next attempt. Reaching
    // this point means the retry budget was exhausted without ever
    // populating `lastError` (logically unreachable, but TypeScript
    // cannot prove that).
    throw lastError instanceof Error
      ? lastError
      : new CyberSoulNetworkError(
          endpoint,
          method,
          `Request failed unexpectedly: ${method} ${endpoint}`,
        );
  }

  private async fetchRemoteState() {
    const endpoint = "/api/v1/cyber-soul/state";
    const res = await this.apiFetch(endpoint);
    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      const detail =
        (body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : undefined) ?? `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        throw new CyberSoulAuthError(
          endpoint,
          "GET",
          res.status,
          `Character credential rejected by backend (${detail}). The character may have been deleted.`,
          body,
        );
      }
      throw new CyberSoulApiError(
        endpoint,
        "GET",
        res.status,
        `Failed to fetch character state: ${detail}`,
        body,
      );
    }
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
    const endpoint = `/api/v1/cyber-soul/${type}/generate`;
    const res = await this.apiFetch(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let errData: any;
      try {
        errData = await res.json();
      } catch (e) {}
      const msg = errData?.message || errData?.error || `Status ${res.status}`;
      const code: string = errData?.code || "UNKNOWN_ERROR";
      const detailedMessage = `Failed to generate ${type}: ${msg}`;

      if (res.status === 402 || code === "INSUFFICIENT_POINTS") {
        throw new CyberSoulInsufficientPointsError(
          endpoint,
          "POST",
          res.status,
          detailedMessage,
          errData,
          code,
        );
      }
      if (code === "WALLET_DEDUCTION_ERROR") {
        throw new CyberSoulWalletError(
          endpoint,
          "POST",
          res.status,
          detailedMessage,
          errData,
          code,
        );
      }
      if (code === "E005") {
        throw new CyberSoulSensitiveContentError(
          endpoint,
          "POST",
          res.status,
          detailedMessage,
          errData,
          code,
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new CyberSoulAuthError(
          endpoint,
          "POST",
          res.status,
          detailedMessage,
          errData,
        );
      }
      const apiErr = new CyberSoulApiError(
        endpoint,
        "POST",
        res.status,
        detailedMessage,
        errData,
      );
      // Preserve the legacy duck-typed `code` field so existing callers
      // that branch on `e.code` (including this SDK's own `interact()`
      // mediaTasks catch block) keep working unchanged.
      (apiErr as any).code = code;
      throw apiErr;
    }
    return res.json();
  }

  /**
   * PATCH the backend dynamic context. The server applies stage-based
   * dampening, familiarity soft-caps, hard floor, and stage re-evaluation,
   * then returns the *authoritative* persisted `temperature` and
   * `relationshipStage`. We surface those so callers (and ultimately the UI)
   * can avoid recomputing the delta locally — local math would diverge from
   * the server because the LLM-supplied `temperatureDelta` is just raw intent.
   *
   * Returns `null` when there's nothing to send, or when the request fails
   * (failure is non-fatal for the chat turn; callers must treat `null` as
   * "no fresh server snapshot available").
   */
  private async _updateDynamicContextInternal(
    stateUpdate: DispatcherIntent["stateUpdate"],
    userAnalysis?: DispatcherIntent["userAnalysis"],
  ): Promise<PersistedDynamicContext | null> {
    if (!stateUpdate && !userAnalysis) return null;

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

    let res: Response;
    try {
      res = await this.apiFetch("/api/v1/cyber-soul/characters/dynamic-context", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.error("Failed to update dynamic context", e);
      return null;
    }

    if (!res.ok) {
      console.error(
        `Failed to update dynamic context: HTTP ${res.status}`,
      );
      return null;
    }

    try {
      const body = (await res.json()) as {
        status?: string;
        dynamicContext?: { temperature?: number };
        relationshipStage?: string;
      };
      const temperature =
        typeof body.dynamicContext?.temperature === "number" &&
        Number.isFinite(body.dynamicContext.temperature)
          ? body.dynamicContext.temperature
          : undefined;
      const relationshipStage =
        typeof body.relationshipStage === "string"
          ? body.relationshipStage
          : undefined;
      if (temperature === undefined && relationshipStage === undefined) {
        return null;
      }
      return { temperature, relationshipStage };
    } catch (e) {
      console.error("Failed to parse dynamic-context PATCH response", e);
      return null;
    }
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

  /**
   * Calculate time period from a timestamp.
   * Pre-computes morning/afternoon/evening to reduce LLM cognitive load.
   */
  private getTimePeriodInfo(timeMs: number): { hour: number; period: string } {
    const date = new Date(timeMs);
    const hour = parseInt(
      date.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        hour12: false,
      }).split(":")[0]
    );

    let period: string;

    if (hour >= 6 && hour < 9) {
      period = "Early Morning";
    } else if (hour >= 9 && hour < 12) {
      period = "Late Morning";
    } else if (hour >= 12 && hour < 13) {
      period = "Noon";
    } else if (hour >= 13 && hour < 18) {
      period = "Afternoon";
    } else if (hour >= 18 && hour < 19) {
      period = "Evening";
    } else if (hour >= 19 && hour < 23) {
      period = "Night";
    } else {
      period = "Late Night";
    }

    return { hour, period };
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
Backstory: ${state.backstory || "None"}
Personality Traits: ${state.personality_traits || "None"}
Communication Style: ${state.communication_style || "None"}
Interaction Boundaries: ${state.interaction_boundaries || "None"}`);

    // [2] SITUATIONAL CONTEXT
    const currentTimeMs = state.current_time ? new Date(state.current_time).getTime() : Date.now();
    const timePeriod = this.getTimePeriodInfo(currentTimeMs);
    const currentDate = new Date(currentTimeMs);
    const timeStr = currentDate.toLocaleString("en-US", {
      timeZone: "Asia/Shanghai",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    contextParts.push(`\n[SITUATIONAL CONTEXT]
Current time: ${timeStr} (${timePeriod.period})`);
    
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
6. STRANGER BOUNDARY: Keep a polite, natural distance with strangers. If Familiarity is low or Stage is STRANGER, do not act overly warm, eager, or affectionate. Real humans are guarded with people they just met.
7. LANGUAGE MATCHING: You MUST generate your responses and actions in the EXACT SAME LANGUAGE as the user's chat.`;
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
    return `- Include 'triggerEvent' only if the VERY LAST USER MESSAGE proposes a new activity/hangout AND you accept the invitation, explicitly requests an outfit change AND you agree, or proposes intimate/romantic actions AND you agree; ignore older history. DO NOT include it if you decline or reject the proposal.
    REPETITION GATE (hard): Prior assistant turns that already auto-triggered an event are tagged with a [Triggered Event: ...] marker in '[CHAT HISTORY]'. If such a marker already exists for the SAME activity the VERY LAST USER MESSAGE is referring to (e.g. it is just acknowledging, hurrying, confirming, or continuing an already-accepted outing), set 'triggerEvent' to null. Only emit a NEW 'triggerEvent' when the user proposes a genuinely DIFFERENT activity that has not already been triggered. Do NOT re-trigger the same event just because the conversation continues. ${this.getOutfitSelectionPrompt()}`;
  }

  private getOutfitAcquisitionPolicyPrompt(): string {
    return `- Outfit acquisition (giftOutfit): set 'giftOutfit' to { "descriptionText": "short outfit description" } when a genuinely NEW outfit (one that is NOT already in the Available Wardrobe) is obtained THIS turn, triggered by EITHER:
    (a) USER-GIFTED: the VERY LAST USER MESSAGE expresses gift/buy/add-clothes intent for you (e.g. "I bought you a dress", "here, wear this new outfit", "adding some lingerie to your closet").
    (b) CHARACTER-ACQUIRED: the conversation or active event naturally leads YOU to acquire a new outfit you don't already own (e.g. you went shopping, received/made clothes, or the scene requires changing into a brand-new outfit that is absent from your Available Wardrobe).
  Keep 'descriptionText' to a concise English-or-matching-language description of the single new outfit. Otherwise set 'giftOutfit' to null. Do NOT fire it for outfits already present in the Available Wardrobe, and do NOT fire it just because you changed into an existing outfit.`;
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

  /**
   * Strip content the TTS engine can't speak naturally:
   *   - Stage-direction wrappers like (smiles), （挑眉）, [pauses], 【动作】, *grins*
   *     — these slip through despite prompt instructions and the engine will
   *     literally read the brackets/asterisks if left in.
   *   - Emoji and emoji-component codepoints (Extended_Pictographic plus the
   *     ZWJ / variation-selector / skin-tone / regional-indicator scaffolding
   *     that builds composite emoji). TTS providers either read these aloud
   *     as the literal Unicode name ("face with tears of joy") or produce a
   *     glitchy artifact, both of which sound wrong.
   *
   * Collapses runs of whitespace introduced by removals and trims the result.
   * Returns "" if everything gets stripped — callers should fall back to a
   * neutral placeholder (e.g. "...") so the TTS call still has valid input.
   */
  private sanitizeTextForVoice(text: unknown): string {
    if (typeof text !== "string") return "";
    return text
      // (parens), （全角）, [brackets], 【全角】, *asterisks*
      .replace(/[\(（\[【\*].*?[\)）\]】\*]/g, "")
      // emoji + ZWJ + variation selectors + skin-tone modifiers + regional indicators
      .replace(
        /[\p{Extended_Pictographic}\u200D\uFE0F\uFE0E\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu,
        "",
      )
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Build the in-band `mediaError` envelope from the first typed media
   * failure captured during `interact()` / `proactiveInteract()`. Keeps
   * the conversion in one place so both call sites stay consistent and
   * the SDK never re-throws on a partial media failure once the text
   * reply is already in flight.
   */
  private buildMediaError(
    err: CyberSoulError,
    affected: Array<"image" | "voice">,
  ): InteractMediaError {
    if (err instanceof CyberSoulInsufficientPointsError) {
      return {
        kind: "insufficient-points",
        code: err.code,
        message: err.message,
        affected,
      };
    }
    if (err instanceof CyberSoulWalletError) {
      return {
        kind: "wallet",
        message: err.message,
        affected,
      };
    }
    if (err instanceof CyberSoulSensitiveContentError) {
      return {
        kind: "sensitive-content",
        code: err.code,
        message: err.message,
        affected,
      };
    }
    return {
      kind: "unknown",
      message: err.message,
      affected,
    };
  }

  /**
   * Shared giftOutfit handler for `interact()` / `proactiveInteract()`.
   * Validates the LLM's `giftOutfit` intent, performs the wardrobe write,
   * fires the `onOutfitGifted` callback, and resolves to the
   * [OutfitGiftedPayload] (or `undefined` when there was nothing to gift
   * or the write failed). Failures are swallowed (logged) so a wardrobe
   * hiccup never aborts the chat turn.
   */
  private async processGiftOutfit(
    giftOutfitIntent: DispatcherIntent["giftOutfit"],
    onOutfitGifted?: (payload: OutfitGiftedPayload) => void,
  ): Promise<OutfitGiftedPayload | undefined> {
    if (
      !giftOutfitIntent ||
      typeof giftOutfitIntent !== "object" ||
      typeof giftOutfitIntent.descriptionText !== "string" ||
      giftOutfitIntent.descriptionText.trim().length === 0
    ) {
      return undefined;
    }

    const outfitDescription = giftOutfitIntent.descriptionText.trim();
    try {
      const count = await this.giftOutfit(outfitDescription);
      const giftedOutfit: OutfitGiftedPayload = {
        descriptionText: outfitDescription,
      };
      if (typeof count === "number") {
        giftedOutfit.count = count;
      }
      if (onOutfitGifted) {
        try {
          onOutfitGifted(giftedOutfit);
        } catch (cbErr) {
          console.warn(
            "[CyberSoulClient] onOutfitGifted callback threw:",
            cbErr,
          );
        }
      }
      return giftedOutfit;
    } catch (e) {
      console.error("[CyberSoulClient] giftOutfit failed:", e);
      return undefined;
    }
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
      const event = msg.eventHint ? ` [Triggered Event: ${msg.eventHint}]` : "";
      contextLines.push(`${speaker}:${action} ${content}${media}${event}`);
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

      // 3. Local Execute LLM (retry on non-actionable parse).
      //    A "non-actionable" parse yields no usable `textResponse` AND no
      //    media intent — i.e. the LLM hiccuped (empty body, truncated or
      //    garbled JSON, or an empty textResponse field). Retrying the
      //    generation is far better than silently echoing the user's own
      //    message back as the character's reply (the historical
      //    `: params.userMessage` fallback below), which downstream
      //    consumers correctly reject as a non-actionable response.
      const MAX_DISPATCH_ATTEMPTS = 3;
      let parsedIntent: DispatcherIntent = { textResponse: "" };
      for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) {
        const rawLlmResponse = await this.llm.generate(promptMessages, 15000, 0.7);
        // console.debug("[CyberSoulClient] Raw LLM Response:", rawLlmResponse);

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

        const hasUsableText =
          typeof parsedIntent.textResponse === "string" &&
          parsedIntent.textResponse.trim().length > 0;
        const hasMediaIntent =
          !!parsedIntent.imageParams || !!parsedIntent.voiceArgs;
        if (hasUsableText || hasMediaIntent) {
          break;
        }
        console.warn(
          `[CyberSoulClient] interact produced a non-actionable intent (attempt ${attempt}/${MAX_DISPATCH_ATTEMPTS}); ${
            attempt < MAX_DISPATCH_ATTEMPTS ? "retrying" : "giving up"
          }.`,
        );
      }

      // After exhausting retries, fail fast instead of echoing the user's
      // own message back as the character's reply. The `: params.userMessage`
      // fallback used below is only ever reached for media-only turns now.
      {
        const finalHasUsableText =
          typeof parsedIntent.textResponse === "string" &&
          parsedIntent.textResponse.trim().length > 0;
        const finalHasMediaIntent =
          !!parsedIntent.imageParams || !!parsedIntent.voiceArgs;
        if (!finalHasUsableText && !finalHasMediaIntent) {
          throw new Error(
            "LLM returned a non-actionable response after retries (no usable textResponse and no media intent). Check LLM template/provider alignment.",
          );
        }
      }

      // 4. Update Backend State async (in parallel with media generation
      //    below). We keep the promise so we can resolve the
      //    server-authoritative `temperature` / `relationshipStage` and
      //    return it in the final response — clients cannot reproduce the
      //    server's stage dampening + soft caps locally, so this is the only
      //    reliable source of truth.
      let persistedStatePromise: Promise<PersistedDynamicContext | null> =
        Promise.resolve(null);
      if (parsedIntent && (parsedIntent.stateUpdate || parsedIntent.userAnalysis)) {
        persistedStatePromise = this._updateDynamicContextInternal(
          parsedIntent.stateUpdate,
          parsedIntent.userAnalysis,
        );
      }

      // Fire `onStateReady` the moment the dynamic-context PATCH resolves
      // (or immediately, when no state update was emitted). This is
      // independent of media generation, so the UI can stop showing
      // "updating…" on temperature / relationship stage well before the
      // (potentially slow) image task finishes. Errors are swallowed:
      // an authoritative snapshot is best-effort, the optimistic delta
      // already applied client-side is the fallback.
      if (params.onStateReady) {
        const stateReadyCb = params.onStateReady;
        persistedStatePromise
          .then((persisted) => {
            try {
              stateReadyCb(persisted ?? {});
            } catch (cbErr) {
              console.warn("[CyberSoulClient] onStateReady callback threw:", cbErr);
            }
          })
          .catch(() => {
            // PATCH failed; still signal LLM-phase complete with an empty snapshot.
            try {
              stateReadyCb({});
            } catch (cbErr) {
              console.warn("[CyberSoulClient] onStateReady callback threw:", cbErr);
            }
          });
      }

        const resolvedTextResponse =
          typeof parsedIntent.textResponse === "string" &&
          parsedIntent.textResponse.trim().length > 0
            ? parsedIntent.textResponse
            : params.userMessage;

        // Pre-compute the voice-dispatch decision so we can tell
        // `onTextReady` consumers up front whether a voice bubble is on
        // the way. Mirrors the `shouldGenerateVoice` gate used below
        // when scheduling the TTS task — keep the two in sync.
        const willGenerateVoice =
          types.includes(InteractRequestType.VOICE) &&
          (!isAuto || !!parsedIntent.voiceArgs);

        // Fire text ready callback if provided
        if (params.onTextReady && (resolvedTextResponse || parsedIntent.actionText)) {
          params.onTextReady(resolvedTextResponse, parsedIntent.actionText, {
            stateUpdate: parsedIntent.stateUpdate,
            userAnalysis: parsedIntent.userAnalysis,
            isEndTurn: parsedIntent.isEndTurn,
            triggerEvent: parsedIntent.triggerEvent,
            likePreviousPicture: parsedIntent.likePreviousPicture,
            willGenerateVoice,
          });
        }

      // 5. Build Final Media Calls parallel
      const mediaTasks = [];
      let finalImageUrl: string | undefined = undefined;
      let finalImageMediaId: string | undefined = undefined;
      let finalAudioUrl: string | undefined = undefined;
      let finalAudioMediaId: string | undefined = undefined;
      let finalDurationSec: number | undefined = undefined;
      let giftedOutfit: OutfitGiftedPayload | undefined = undefined;
      // Partial-failure capture: text was already produced and emitted
      // via [onTextReady], so a wallet / insufficient-points failure on
      // image or voice MUST NOT abort the whole turn. We collect the
      // affected modalities + first typed error and surface them in-band
      // through `InteractResponse.mediaError`. The caller (MessageBus /
      // UI) decides how to message the user without losing the reply.
      const mediaErrorAffected: Array<"image" | "voice"> = [];
      let firstMediaError: CyberSoulError | null = null;
      const captureMediaError = (
        modality: "image" | "voice",
        e: unknown,
      ): void => {
        if (!(e instanceof CyberSoulError)) return;
        if (
          !(e instanceof CyberSoulInsufficientPointsError) &&
          !(e instanceof CyberSoulWalletError) &&
          !(e instanceof CyberSoulSensitiveContentError)
        ) {
          return;
        }
        if (!mediaErrorAffected.includes(modality)) {
          mediaErrorAffected.push(modality);
        }
        if (!firstMediaError) firstMediaError = e;
      };

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
          this.processGiftOutfit(
            parsedIntent.giftOutfit,
            params.onOutfitGifted,
          ).then((result) => {
            if (result) giftedOutfit = result;
          }),
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
              finalImageMediaId = res.id;
              if (params.onMediaReady && finalImageUrl) {
                try {
                  params.onMediaReady({
                    modality: "image",
                    url: finalImageUrl,
                    mediaId: finalImageMediaId,
                  });
                } catch (cbErr) {
                  console.warn("[CyberSoulClient] onMediaReady(image) threw:", cbErr);
                }
              }
            })
            .catch((e: any) => {
              if (
                !(e instanceof CyberSoulInsufficientPointsError) &&
                !(e instanceof CyberSoulWalletError) &&
                !(e instanceof CyberSoulSensitiveContentError)
              ) {
                console.error("[CyberSoulClient] Image generation failed:", e);
              }
              captureMediaError("image", e);
            })
        );
      }

      const shouldGenerateVoice = willGenerateVoice;
      if (shouldGenerateVoice) {
        const normalizedVoiceArgs: VoiceArgs =
          parsedIntent.voiceArgs && typeof parsedIntent.voiceArgs === "object"
            ? (parsedIntent.voiceArgs as VoiceArgs)
            : {};

        let textForVoice = this.sanitizeTextForVoice(resolvedTextResponse);

        if (textForVoice.length === 0) {
          textForVoice = "...";
        }

        mediaTasks.push(
          this.generatePrimitive("voice", {
            text: textForVoice,
            dynamicArgs: normalizedVoiceArgs,
          })
            .then((res: any) => {
              finalAudioUrl = res.audio_url;
              finalAudioMediaId = res.id;
              finalDurationSec = res.duration_sec;
              if (params.onMediaReady && finalAudioUrl) {
                try {
                  params.onMediaReady({
                    modality: "voice",
                    url: finalAudioUrl,
                    mediaId: finalAudioMediaId,
                    durationSec: finalDurationSec,
                  });
                } catch (cbErr) {
                  console.warn("[CyberSoulClient] onMediaReady(voice) threw:", cbErr);
                }
              }
            })
            .catch((e: any) => {
              if (
                !(e instanceof CyberSoulInsufficientPointsError) &&
                !(e instanceof CyberSoulWalletError) &&
                !(e instanceof CyberSoulSensitiveContentError)
              ) {
                console.error("[CyberSoulClient] Voice generation failed:", e);
              }
              captureMediaError("voice", e);
            })
        );
      }

      // Wait for image/voice gens to return successfully
      await Promise.all(mediaTasks);

      // Await the dynamic-context PATCH alongside media so the final
      // response carries the server's authoritative temperature/stage.
      // This adds at most ~1 small request to the critical path; in
      // practice the PATCH usually resolves before media generation.
      const persistedDynamicContext =
        (await persistedStatePromise) ?? undefined;

      const mediaError = firstMediaError
        ? this.buildMediaError(firstMediaError, mediaErrorAffected)
        : undefined;

      return {
        status: "success",
        textResponse: resolvedTextResponse || "...",
        actionText: parsedIntent.actionText || "",
        imageUrl: finalImageUrl,
        imageMediaId: finalImageMediaId,
        audioUrl: finalAudioUrl,
        audioMediaId: finalAudioMediaId,
        likePreviousPicture: parsedIntent.likePreviousPicture,
        durationSec: finalDurationSec,
        triggeredEvent: parsedIntent.triggerEvent || undefined,
        stateUpdate: parsedIntent.stateUpdate,
        userAnalysis: parsedIntent.userAnalysis,
        isEndTurn: parsedIntent.isEndTurn,
        persistedDynamicContext,
        mediaError,
        giftedOutfit,
      };
    } catch (error: any) {
      // Typed SDK errors (insufficient points, wallet failure, auth, etc.)
      // are part of the public contract — let callers branch on
      // `instanceof` instead of string-sniffing a generic status:"error"
      // envelope. Only truly-unexpected throws fall back to the legacy
      // envelope so we don't break callers that don't yet handle throws.
      if (error instanceof CyberSoulError) {
        throw error;
      }
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
   *
   * Design:
   *  - Code owns ONE objective rule: don't spam (cap consecutive un-replied
   *    messages). Everything else is a social judgment.
   *  - The LLM owns the social judgment — given full character context
   *    (stage, temperature, traits, ongoing scene, time since last
   *    interaction, recent history), it answers a single question:
   *    "Would I, as this person right now, actually reach out?"
   *    Skip is the default; speaking is the exception.
   */
  public async proactiveInteract(params: ProactiveParams): Promise<ProactiveResponse> {
    try {
      // 1. Spam guard (the only hard-coded gate). Counts assistant
      //    *turns* since the last user reply; bails out if the user has
      //    clearly stopped responding.
      //
      //    A single character response can be emitted as multiple
      //    HistoryEntry rows (one per modality: text + image + voice).
      //    The host typically writes them within seconds of each other.
      //    Counting entries directly would treat one multimodal reply
      //    as 2-3 "unreplied messages" and trip `maxUnreplied = 2` on
      //    the very first proactive attempt. Collapse consecutive
      //    assistant entries whose timestamps are within
      //    SAME_TURN_WINDOW_MS into a single turn before counting.
      const history = params.history || [];
      const maxUnreplied = params.maxUnreplied ?? 2;
      const SAME_TURN_WINDOW_MS = 60_000;

      let consecutiveProactive = 0;
      let lastAssistantTs: number | null = null;
      for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        if (msg.role === "user") break;
        if (msg.role !== "assistant") continue;
        const ts = typeof msg.timestamp === "number" ? msg.timestamp : 0;
        if (
          lastAssistantTs === null ||
          Math.abs(lastAssistantTs - ts) > SAME_TURN_WINDOW_MS
        ) {
          consecutiveProactive++;
        }
        lastAssistantTs = ts;
      }
      if (consecutiveProactive >= maxUnreplied) {
        return {
          status: "skipped",
          reason: `Spam guard: ${consecutiveProactive} consecutive un-replied turns already sent.`,
        };
      }

      // 2. Fetch state. baseContext below already includes stage,
      //    temperature, traits, ongoing scene, active/next event, current
      //    time, and lastInteractionAt — the LLM has everything it needs to
      //    make the social call without us restating it.
      const [state, availableOutfits] = await Promise.all([
        this.fetchRemoteState(),
        this.getWardrobePromptStr(),
      ]);

      const baseContext = this.buildStateContextPrompt(state, true);
      const types = this.normalizeRequestTypes(params.requestTypes);
      const requestedOthers = types.filter(
        (t) => t !== InteractRequestType.AUTO && t !== InteractRequestType.TEXT,
      );
      const imageAllowed = requestedOthers.includes(InteractRequestType.IMAGE);

      // 3. Build the prompt. We deliberately ask ONE coherent question
      //    framed in-character ("would I text right now?") rather than
      //    handing the LLM a checklist. The character's own traits,
      //    relationship state, and recent transcript are the inputs.
      const systemPrompt = `${baseContext}

[PROACTIVE OPPORTUNITY]
Time has passed since the last message in [CHAT HISTORY] and the user has not replied. You have an OPPORTUNITY (not an obligation) to send them a message. Decide, in character, whether you would actually do that.

[HOW TO DECIDE — THINK LIKE THE PERSON YOU ARE]
Real humans rarely send unprompted messages. Most of the time, silence is the right answer. Reach out ONLY if a real person with YOUR personality, in YOUR relationship to this user, at THIS moment, would genuinely feel moved to text.

Reasons NOT to reach out (set "shouldSkipProactive": true):
  - The last exchange ended on a note that closes the door — a farewell, a brush-off, a fight, a "talk later", an explicit dismissal — from either side. If YOU pushed them away last turn (because of your traits or a fight), staying quiet IS the in-character choice; flipping to friendly now makes you look bipolar.
  - Your relationship is too distant for unsolicited contact (e.g. STRANGER, COLD) or your current mood is too low to want to reach out.
  - Too little time has passed since the last message for a follow-up to feel natural. Use the time gap shown in [CHAT HISTORY] — minutes after the last turn is almost always too soon.
  - There is no genuine reason to text — no shared thread, no event, no thought that would actually push a real person to pick up the phone.
  - It's the wrong time of day for this relationship.

When in doubt: SKIP. The bar for reaching out is high.

[IF YOU DO DECIDE TO REACH OUT]
Speak strictly in character — your traits, communication style, and current mood dictate the tone. Do NOT default to needy/cheerful unless that's who you are. Connect naturally to the last topic or to your current scene/event. Keep it to 2-3 short sentences. Never ask "are you there?" or "why aren't you answering?".

Available Wardrobe Outfits:
${availableOutfits}

Modalities:
  - 'textResponse' is required when you proceed.
  - ${imageAllowed
    ? "'imageParams' may be included only if sending a photo right now would feel natural for this character in this relationship — otherwise set null. Do not attach a photo just because you can."
    : "ALWAYS set 'imageParams' to null."}
  - ALWAYS set 'voiceArgs' to null.
  ${this.getOutfitAcquisitionPolicyPrompt()}

Output ONLY a valid JSON object matching exactly this structure (no markdown wrappers).
If "shouldSkipProactive" is true, set "skipReason" to one short sentence and set every other field to null.
If "shouldSkipProactive" is false, "textResponse" is required and "stateUpdate" must be provided; include "ongoingScene" only if your scene/outfit actually changed, otherwise omit it.
{
  "shouldSkipProactive": false,
  "skipReason": null,
  "actionText": "(Scene descriptions, physical actions, expressions, inner feelings) ONLY.",
  "textResponse": "Spoken dialogue ONLY.",
  "stateUpdate": { "temperatureDelta": 0, "ongoingScene": { "scene": "...", "outfit": "..." } },
  "giftOutfit": { "descriptionText": "Concise description of the newly acquired outfit to add into wardrobe." },
  ${this.getImageSchemaParams(imageAllowed)},
  "voiceArgs": null
}`;

      const transcript = params.history && params.history.length > 0
        ? this.buildHistoryTranscript(params.history, state)
        : "";
      const harnessContext = params.localContext
        ? `[ADDITIONAL SCENE CONTEXT]\n${params.localContext}\n\n`
        : "";

      const promptMessages = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `${harnessContext}${transcript}\n[DECIDE NOW]\nWould you, as this character, actually send a message right now? Answer in the JSON schema above.`,
        },
      ];

      // 4. LLM decides. Lower temperature than `interact` because this is a
      //    judgment call, not creative reply.
      const rawLlmResponse = await this.llm.generate(promptMessages, 800, 0.5);

      // Fail fast on parse error. A proactive message is opt-in by design;
      // if the LLM produced unparseable output we'd rather skip than ship
      // raw scaffolding to the user.
      const parsedIntent = robustJsonParse<DispatcherIntent>(rawLlmResponse, "Proactive fallback");

      if (parsedIntent.shouldSkipProactive) {
        return {
          status: "skipped",
          reason: parsedIntent.skipReason || "Character chose not to reach out.",
        };
      }

      if (typeof parsedIntent.textResponse !== "string" || parsedIntent.textResponse.trim().length === 0) {
        return {
          status: "skipped",
          reason: "LLM produced no textResponse (treated as implicit skip).",
        };
      }

      // 5. Persist state and optionally generate image, in parallel.
      let persistedStatePromise: Promise<PersistedDynamicContext | null> =
        Promise.resolve(null);
      if (parsedIntent.stateUpdate) {
        persistedStatePromise = this._updateDynamicContextInternal(parsedIntent.stateUpdate);
      }

      if (params.onStateReady) {
        const stateReadyCb = params.onStateReady;
        persistedStatePromise
          .then((persisted) => {
            try {
              stateReadyCb(persisted ?? {});
            } catch (cbErr) {
              console.warn("[CyberSoulClient] onStateReady callback threw:", cbErr);
            }
          })
          .catch(() => {
            try {
              stateReadyCb({});
            } catch (cbErr) {
              console.warn("[CyberSoulClient] onStateReady callback threw:", cbErr);
            }
          });
      }

      if (params.onTextReady) {
        params.onTextReady(parsedIntent.textResponse, parsedIntent.actionText, {
          stateUpdate: parsedIntent.stateUpdate,
        });
      }

      // Outfit acquisition: the character may decide, on its own, to pick
      // up a brand-new outfit while reaching out. Fire-and-capture in
      // parallel with image generation; surface it via callback + the
      // final response so upstream can show "New outfit added".
      const giftOutfitPromise = this.processGiftOutfit(
        parsedIntent.giftOutfit,
        params.onOutfitGifted,
      );

      let finalImageUrl: string | undefined;
      let finalImageMediaId: string | undefined;
      let proactiveMediaError: CyberSoulError | null = null;
      const proactiveAffected: Array<"image" | "voice"> = [];
      if (parsedIntent.imageParams) {
        try {
          const res = await this.generatePrimitive("image", parsedIntent.imageParams);
          finalImageUrl = res.image_url;
          finalImageMediaId = res.id;
          if (params.onMediaReady && finalImageUrl) {
            try {
              params.onMediaReady({
                modality: "image",
                url: finalImageUrl,
                mediaId: finalImageMediaId,
              });
            } catch (cbErr) {
              console.warn("[CyberSoulClient] onMediaReady(image) threw:", cbErr);
            }
          }
        } catch (e) {
          if (
            e instanceof CyberSoulInsufficientPointsError ||
            e instanceof CyberSoulWalletError ||
            e instanceof CyberSoulSensitiveContentError
          ) {
            proactiveMediaError = e;
            proactiveAffected.push("image");
          } else {
            console.error("[CyberSoulClient] Proactive Image generation failed:", e);
          }
        }
      }

      const persistedDynamicContext = (await persistedStatePromise) ?? undefined;
      const giftedOutfit = (await giftOutfitPromise) ?? undefined;

      const proactiveMediaErrorEnv = proactiveMediaError
        ? this.buildMediaError(proactiveMediaError, proactiveAffected)
        : undefined;

      return {
        status: "success",
        textResponse: parsedIntent.textResponse,
        actionText: parsedIntent.actionText,
        imageUrl: finalImageUrl,
        imageMediaId: finalImageMediaId,
        stateUpdate: parsedIntent.stateUpdate,
        persistedDynamicContext,
        mediaError: proactiveMediaErrorEnv,
        giftedOutfit,
      };
    } catch (error: any) {
      // Mirror `interact()`: preserve typed SDK errors for the caller.
      if (error instanceof CyberSoulError) {
        throw error;
      }
      console.error("[CyberSoulClient] Proactive Interact Error: ", error);
      return { status: "error", error: error.message };
    }
  }

  /**
   * Manually generate an image of the character outside of chat flow.
   */
  public async generateImage(
    params: { sceneDescription: string; interactParams?: InteractParams },
  ): Promise<{ imageUrl: string; imageMediaId?: string }> {
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
      imageMediaId: res.id,
    };
  }

  /**
   * Manually synthesize voice audio outside of chat flow.
   */
  public async generateVoice(
    params: { text: string; interactParams?: InteractParams },
  ): Promise<{ audioUrl: string; audioMediaId?: string; durationSec?: number }> {
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
      text: this.sanitizeTextForVoice(params.text) || "...",
      dynamicArgs,
    });

    return {
      audioUrl: res.audio_url,
      audioMediaId: res.id,
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
   * List the public LLM models the backend currently supports, including the
   * `customConfigDefinition` schema for each model's `customSettings`.
   *
   * Use this to discover valid `provider` / `model` strings and the keys
   * each model accepts via `llmConfig.customSettings`.
   */
  public async listSupportedLLMs(): Promise<SupportedLLMModel[]> {
    const res = await this.apiFetch("/api/v1/cyber-soul/llm-models");
    if (!res.ok) {
      throw new Error(`Failed to list supported LLMs: ${res.status}`);
    }
    const body = (await res.json()) as unknown;
    if (Array.isArray(body)) return body as SupportedLLMModel[];
    if (body && typeof body === "object" && Array.isArray((body as any).data)) {
      return (body as any).data as SupportedLLMModel[];
    }
    throw new Error("Unexpected response shape from /llm-models");
  }

  /**
   * Updates the character's relationship temperature or mood.
   * Returns the server-authoritative post-write `{ temperature, relationshipStage }`
   * snapshot (or `null` if there was nothing to send / the request failed).
   */
  public async updateDynamicContext(
    stateUpdate: DispatcherIntent["stateUpdate"],
    userAnalysis?: DispatcherIntent["userAnalysis"],
  ): Promise<PersistedDynamicContext | null> {
    return this._updateDynamicContextInternal(stateUpdate, userAnalysis);
  }

  /**
   * Restores the server-side relationship temperature to an exact absolute
   * value. Used by chat recall, where inverse deltas are not accurate once the
   * backend has applied dampening, caps, and stage re-evaluation.
   */
  public async restoreDynamicContextTemperature(
    temperatureAbsolute: number,
  ): Promise<PersistedDynamicContext | null> {
    if (!Number.isFinite(temperatureAbsolute)) return null;

    const normalizedAbsolute = Math.max(
      0,
      Math.min(100, Math.round(temperatureAbsolute * 10) / 10),
    );

    try {
      const res = await this.apiFetch(
        "/api/v1/cyber-soul/characters/dynamic-context",
        {
          method: "PATCH",
          body: JSON.stringify({ temperatureAbsolute: normalizedAbsolute }),
        },
      );
      if (!res.ok) return null;

      const payload = (await res.json()) as {
        status?: string;
        dynamicContext?: { temperature?: number };
        relationshipStage?: string;
      };

      if (payload?.status !== "success") return null;
      if (typeof payload.dynamicContext?.temperature !== "number") return null;
      if (!Number.isFinite(payload.dynamicContext.temperature)) return null;

      return {
        temperature: payload.dynamicContext.temperature,
        relationshipStage:
          typeof payload.relationshipStage === "string"
            ? payload.relationshipStage
            : undefined,
      };
    } catch (e) {
      console.error("restoreDynamicContextTemperature failed", e);
      return null;
    }
  }

  /**
   * Gift a new outfit to the character's wardrobe inventory.
   * Returns the number of wardrobe items the backend created (the
   * backend may expand a single description into multiple items), or
   * `undefined` when the server did not report a count.
   */
  public async giftOutfit(descriptionText: string): Promise<number | undefined> {
    const res = await this.apiFetch(
      "/api/v1/cyber-soul/characters/gift-outfit",
      {
        method: "POST",
        body: JSON.stringify({ text: descriptionText }),
      },
    );
    if (!res.ok) throw new Error("Failed to gift outfit");
    try {
      const body = (await res.json()) as { count?: unknown };
      return typeof body.count === "number" && Number.isFinite(body.count)
        ? body.count
        : undefined;
    } catch {
      // The gift already succeeded server-side (res.ok); a missing/
      // unparseable count is non-fatal — report "unknown" rather than
      // fabricating a number.
      return undefined;
    }
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
   * Builds a focused identity/relationship context block for the history
   * summarizer. This is a lighter-weight counterpart to
   * [buildStateContextPrompt]: it skips the roleplay/director rules (the
   * summarizer is not roleplaying, it is *archiving*) but carries the
   * same identity anchors so the LLM can never confuse who the character
   * is vs. who the user is.
   *
   * Why this exists: the previous `summarizeHistory` prompt only injected
   * `${agentName}` / `${userName}` (the nicknames the two parties call
   * each other). With no real identity, age, gender, personality, or
   * relationship context, the LLM frequently flipped the perspective —
   * writing the journal *about* the character *from* the user's POV, or
   * attributing the user's words to the character. Mirroring the same
   * identity fields `interact()` exposes eliminates that ambiguity.
   */
  private buildSummarizerContextBlock(state: CharacterState): string {
    const dyn = state.dynamic_context || {};
    const stage = state.relationship_stage || "NEUTRAL";
    const temperature = dyn.temperature ?? 50;

    // The character's REAL name is the authoritative identity anchor.
    // agentNickname is just "what the user calls the character" — useful
    // for matching transcript labels but not for grounding identity.
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

    parts.push(`\n[RELATIONSHIP RIGHT NOW]
Stage: ${stage}
Temperature (Mood): ${temperature}/100 (0=Angry/Cold, 50=Normal, 100=Passionate)
You call them: ${dyn.userNickname || "User"}
They call you: ${dyn.agentNickname || charName}`);

    if (state.core_memory) {
      const mem = state.core_memory;
      const memLines: string[] = [];
      if (mem.relationshipStatus) memLines.push(`Relationship Status: ${mem.relationshipStatus}`);
      if (mem.identityAnchors?.length) memLines.push(`Identity Anchors: ${mem.identityAnchors.join(", ")}`);
      if (mem.activeArcs?.length) memLines.push(`Active Arcs: ${mem.activeArcs.join(", ")}`);
      if (memLines.length > 0) {
        parts.push(`\n[CORE MEMORY]\n${memLines.join("\n")}`);
      }
    }

    return parts.join("\n");
  }

  /**
   * Automatically detect and summarize the story from the current chat history. 
   * It takes raw message history and returns a narrative paragraph representing the current story segment.
   *
   * The summary is ALWAYS written from the CHARACTER's first-person perspective
   * ("I", "me", "my") about their interaction with the HUMAN USER. The prompt
   * injects the same identity/relationship context `interact()` uses so the
   * LLM cannot confuse which party is the AI character vs. the human user.
   */
  public async summarizeHistory(history: HistoryEntry[]): Promise<string> {
    if (!history || history.length === 0) return "";
    
    const state = await this.getState();
    // Use the character's real name as the authoritative identity, falling
    // back to the nickname only when the profile has no name set.
    const charName = state.name || state.dynamic_context?.agentNickname || "Character";
    const userName = state.dynamic_context?.userNickname || "User";
    // The transcript labels below are the nicknames actually used in chat.
    const transcriptAgentLabel = state.dynamic_context?.agentNickname || charName;
    const transcriptUserLabel = userName;

    const contextBlock = this.buildSummarizerContextBlock(state);
    const transcript = this.formatHistoryEntries(history, transcriptUserLabel, transcriptAgentLabel);
    
    const promptMessages = [
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
- Use the exact same language as the chat transcript (for example, if transcript is Chinese, output Chinese).`
      },
      {
        role: "user",
        content: `[CHAT TRANSCRIPT]\n${transcript}\n\nPlease summarize this recent interaction from your own perspective, ${charName}.`
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
