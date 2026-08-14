import {
  CharacterState,
  DispatcherIntent,
  PersistedDynamicContext,
  SupportedLLMModel,
  WardrobeItem,
  LikedPicture,
  CoreMemory,
  UserCodex,
  LlmMarket,
  MomentSummary,
} from "../types.js";
import {
  CyberSoulApiError,
  CyberSoulAuthError,
  CyberSoulError,
  CyberSoulInsufficientPointsError,
  CyberSoulNetworkError,
  CyberSoulSensitiveContentError,
  CyberSoulTimeoutError,
  CyberSoulWalletError,
} from "../errors.js";

/**
 * Configuration for the [CyberSoulApi] HTTP layer. Mirrors the relevant
 * subset of [CyberSoulClientConfig] so the API module can be reused
 * independently of the orchestration layer.
 */
export interface CyberSoulApiConfig {
  backendUrl: string;
  characterKey: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  /**
   * Optional fetch override. When provided, the API layer uses this in
   * place of the global `fetch` for every HTTP call. Intended for
   * environments where the global fetch is suspended by the host
   * platform — e.g. React Native on Samsung BBA / Doze — and a native
   * HTTP path must be used instead. Must conform to the standard
   * `fetch` signature.
   */
  fetchImpl?: typeof fetch;
}

/** Result of a successful image generation call. */
export interface GeneratedImage {
  image_url: string;
  id: string;
}

/** Result of a successful voice generation call. */
export interface GeneratedVoice {
  audio_url: string;
  id: string;
  duration_sec?: number;
}

/** Payload accepted by PATCH /characters/dynamic-context. */
export interface DynamicContextPatchPayload {
  temperature?: number;
  temperatureAbsolute?: number;
  ongoingScene?: { scene: string; outfit: string } | null;
  userNickname?: string;
  agentNickname?: string;
  talkingStyle?: string;
  userAnalysis?: DispatcherIntent["userAnalysis"];
}

/** Payload accepted by POST /characters/ondemand-event. */
export interface OndemandEventPayload {
  eventTitle?: string;
  eventDescription: string;
  durationMins?: number;
  outfitId?: string;
  scheduledStartTimeStr?: string;
  scheduledDateStr?: string;
}

/** Payload accepted by POST /characters/moments. */
export interface SaveMomentPayload {
  summary: string;
  date: string;
  time: string;
  likedPictures?: LikedPicture[];
}

/**
 * Encapsulates every backend HTTP call used by the SDK. Owns the
 * transport (timeout, retry, typed error mapping) and exposes one typed
 * method per endpoint so the orchestration layer in `client.ts` never
 * touches `fetch` or status codes directly.
 *
 * Error contract:
 *  - Transport-level failures are wrapped as [CyberSoulNetworkError] /
 *    [CyberSoulTimeoutError].
 *  - Backend typed failures (402 / wallet / sensitive-content / auth)
 *    are surfaced as the dedicated subclasses of [CyberSoulError] so
 *    callers can branch on `instanceof` instead of string-sniffing.
 */
export class CyberSoulApi {
  private backendUrl: string;
  private characterKey: string;
  private requestTimeoutMs: number;
  private maxRetries: number;
  private fetchImpl?: typeof fetch;

  constructor(config: CyberSoulApiConfig) {
    this.backendUrl = config.backendUrl;
    this.characterKey = config.characterKey;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 120000;
    this.maxRetries = Math.max(0, config.maxRetries ?? 1);
    this.fetchImpl = config.fetchImpl;
  }

  /* -------------------------------------------------------------------- */
  /* Transport                                                            */
  /* -------------------------------------------------------------------- */

  /**
   * Internal wrapper for fetch that injects the backend URL and the
   * Character Auth token, applies per-request timeout, and retries
   * transient server-side failures (HTTP >= 500) for idempotent
   * methods (GET / HEAD).
   *
   * Exposed as `public` so callers that need a raw `Response` (e.g. to
   * branch on status without paying for an exception) can reuse the
   * same transport path. Most consumers should prefer the typed
   * helpers below.
   */
  async apiFetch(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const url = `${this.backendUrl}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.characterKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    const method = (options.method || "GET").toUpperCase();
    const isIdempotent = method === "GET" || method === "HEAD";
    const retryLimit = isIdempotent ? this.maxRetries : 0;

    let lastError: unknown;

    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.requestTimeoutMs,
      );

      try {
        // NOTE: When no custom fetchImpl is provided, fall back to the global
        // `fetch` bound to `globalThis`. Browsers throw "Illegal invocation"
        // if the global `fetch` is invoked while detached from its Window
        // receiver (e.g. via a captured reference).
        const fetchFn = this.fetchImpl ?? fetch.bind(globalThis);
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

  /* -------------------------------------------------------------------- */
  /* State & wardrobe                                                     */
  /* -------------------------------------------------------------------- */

  /**
   * GET /api/v1/cyber-soul/state. Returns the full character state
   * (identity, dynamic context, codex, memory, active event/wardrobe).
   *
   * 401/403 → [CyberSoulAuthError] (character may have been deleted).
   * Other non-2xx → [CyberSoulApiError].
   */
  async getState(): Promise<CharacterState> {
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
    return json.data as CharacterState;
  }

  /**
   * GET /api/v1/cyber-soul/wardrobe. Returns the raw wardrobe items;
   * the caller is responsible for any caching / formatting. Resolves
   * to an empty array when the backend returns no items or a non-2xx
   * (failures are swallowed because wardrobe is best-effort context
   * for prompt assembly — a missing list must not abort a chat turn).
   */
  async getWardrobe(): Promise<WardrobeItem[]> {
    const wardrobeRes = await this.apiFetch("/api/v1/cyber-soul/wardrobe");
    if (!wardrobeRes.ok) return [];
    let payload: any = {};
    try {
      payload = await wardrobeRes.json();
    } catch (e) {
      return [];
    }
    return Array.isArray(payload?.data) ? (payload.data as WardrobeItem[]) : [];
  }

  /* -------------------------------------------------------------------- */
  /* Primitive media generation                                           */
  /* -------------------------------------------------------------------- */

  /**
   * POST /api/v1/cyber-soul/{type}/generate. Generates an image or a
   * voice clip. Backend typed failures are surfaced as dedicated
   * subclasses of [CyberSoulError] so callers can branch precisely:
   *   - 402 / INSUFFICIENT_POINTS → [CyberSoulInsufficientPointsError]
   *   - WALLET_DEDUCTION_ERROR    → [CyberSoulWalletError]
   *   - E005 (sensitive content)  → [CyberSoulSensitiveContentError]
   *   - 401 / 403                 → [CyberSoulAuthError]
   *   - anything else             → [CyberSoulApiError] (with legacy
   *                                 duck-typed `code` preserved)
   */
  async generatePrimitive(
    type: "image" | "voice",
    payload: any,
  ): Promise<GeneratedImage & GeneratedVoice> {
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

  /* -------------------------------------------------------------------- */
  /* Dynamic context                                                      */
  /* -------------------------------------------------------------------- */

  /**
   * PATCH /api/v1/cyber-soul/characters/dynamic-context.
   *
   * The server applies stage-based dampening, familiarity soft-caps,
   * hard floor, and stage re-evaluation, then returns the
   * *authoritative* persisted `temperature` and `relationshipStage`.
   *
   * Returns the post-write snapshot, or `null` when there's nothing
   * to send / the request fails (failure is non-fatal for a chat
   * turn — callers must treat `null` as "no fresh snapshot").
   *
   * The caller is responsible for any payload normalization (e.g.
   * mapping `temperatureDelta` → `temperature`); this method sends
   * `payload` as-is.
   */
  async patchDynamicContext(
    payload: DynamicContextPatchPayload,
  ): Promise<PersistedDynamicContext | null> {
    if (
      payload.temperature === undefined &&
      payload.temperatureAbsolute === undefined &&
      payload.ongoingScene === undefined &&
      payload.userNickname === undefined &&
      payload.agentNickname === undefined &&
      payload.talkingStyle === undefined &&
      payload.userAnalysis === undefined
    ) {
      return null;
    }

    let res: Response;
    try {
      res = await this.apiFetch(
        "/api/v1/cyber-soul/characters/dynamic-context",
        {
          method: "PATCH",
          body: JSON.stringify(payload),
        },
      );
    } catch (e) {
      console.error("Failed to update dynamic context", e);
      return null;
    }

    if (!res.ok) {
      console.error(`Failed to update dynamic context: HTTP ${res.status}`);
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

  /**
   * PATCH /api/v1/cyber-soul/characters/dynamic-context with an exact
   * absolute temperature. Used by chat recall, where inverse deltas are
   * not accurate once the backend has applied dampening, caps, and
   * stage re-evaluation. The value is clamped to [0,100] with one
   * decimal of precision before being sent.
   *
   * Returns `null` on transport failure or invalid input — strict,
   * no silent fallback. Caller should treat `null` as "restore did
   * not succeed" and surface the inconsistency.
   */
  async restoreDynamicContextTemperature(
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

  /* -------------------------------------------------------------------- */
  /* Events, wardrobe writes, lifecycle                                   */
  /* -------------------------------------------------------------------- */

  /**
   * POST /api/v1/cyber-soul/characters/ondemand-event. Schedules an
   * on-demand event. Throws when the backend rejects the schedule.
   */
  async triggerOndemandEvent(payload: OndemandEventPayload): Promise<void> {
    const res = await this.apiFetch(
      "/api/v1/cyber-soul/characters/ondemand-event",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      throw new Error("Backend failed to schedule the on-demand event");
    }
  }

  /**
   * POST /api/v1/cyber-soul/characters/gift-outfit. Adds a new outfit
   * (or several — the backend may expand a single description into
   * multiple items) to the wardrobe inventory. Returns the number of
   * items created, or `undefined` when the server didn't report a
   * count (never fabricated).
   */
  async giftOutfit(
    descriptionText: string,
  ): Promise<number | undefined> {
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
   * POST /api/v1/cyber-soul/characters/bootstrap. Bootstraps a
   * character profile from OpenClaw workspace files.
   */
  async bootstrapCharacter(
    workspaceFiles: Record<string, string>,
  ): Promise<void> {
    const res = await this.apiFetch(
      "/api/v1/cyber-soul/characters/bootstrap",
      {
        method: "POST",
        body: JSON.stringify({ workspace_files: workspaceFiles }),
      },
    );
    if (!res.ok) throw new Error("Failed to bootstrap character");
  }

  /**
   * POST /api/v1/cyber-soul/daily-script/generate. Triggers the
   * backend to generate the daily script/plan for the character.
   */
  async generateDailyScript(): Promise<void> {
    const res = await this.apiFetch(
      "/api/v1/cyber-soul/daily-script/generate",
      {
        method: "POST",
      },
    );
    if (!res.ok) throw new Error("Failed to generate daily script");
  }

  /* -------------------------------------------------------------------- */
  /* LLM models                                                           */
  /* -------------------------------------------------------------------- */

  /**
   * GET /api/v1/cyber-soul/llm-models. Lists the public LLM models the
   * backend currently supports, including each model's
   * `customConfigDefinition` schema for `customSettings`. Pass `market`
   * to filter by storefront availability (App Store Guideline 5).
   */
  async listLLMModels(market?: LlmMarket): Promise<SupportedLLMModel[]> {
    const path = market
      ? `/api/v1/cyber-soul/llm-models?market=${encodeURIComponent(market)}`
      : "/api/v1/cyber-soul/llm-models";
    const res = await this.apiFetch(path);
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

  /* -------------------------------------------------------------------- */
  /* Memory pipeline                                                      */
  /* -------------------------------------------------------------------- */

  /**
   * POST /api/v1/cyber-soul/characters/moments. Saves a story moment
   * so it can be picked up by the core-memory consolidation pass.
   */
  async saveMoment(payload: SaveMomentPayload): Promise<void> {
    const res = await this.apiFetch(
      "/api/v1/cyber-soul/characters/moments",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      throw new Error("Failed to save character moment.");
    }
  }

  /**
   * GET /api/v1/cyber-soul/characters/moments. Returns the character's
   * saved story moments (first-person narrative summaries of past
   * conversation sessions), newest first. Used by the ContextManager
   * to populate `state.recent_moments`, which the prompt builder
   * injects as `[RECENT MOMENTS]` so the character recalls prior
   * conversations in detail — not just the limited key events in
   * `core_memory`.
   *
   * `limit` caps how many moments are returned (default 10). The
   * backend returns all moments sorted newest-first; we slice here
   * to keep the transport layer simple.
   */
  async getMoments(limit = 10): Promise<MomentSummary[]> {
    const res = await this.apiFetch(
      "/api/v1/cyber-soul/characters/moments",
    );
    if (!res.ok) {
      throw new Error("Failed to fetch character moments.");
    }
    const json = await res.json();
    const moments: MomentSummary[] = (json.data || []).map(
      (m: any) => ({
        id: m.id,
        date: m.date,
        time: m.time,
        summary: m.summary,
        likedPictures: m.likedPictures,
      }),
    );
    return moments.slice(0, limit);
  }

  /**
   * PATCH /api/v1/cyber-soul/characters/core-memory. Replaces the
   * consolidated core memory and user codex in one shot.
   */
  async updateCoreMemory(payload: {
    coreMemory: CoreMemory;
    userCodex: UserCodex;
  }): Promise<void> {
    const res = await this.apiFetch(
      "/api/v1/cyber-soul/characters/core-memory",
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      throw new Error(
        `Failed to update core memory. Status: ${res.status}`,
      );
    }
  }
}

/**
 * Convenience type guard re-exported so callers don't need to import
 * from `errors.js` just to branch on a caught value.
 */
export function isCyberSoulError(e: unknown): e is CyberSoulError {
  return e instanceof CyberSoulError;
}
