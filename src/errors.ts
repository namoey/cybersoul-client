/**
 * Typed error hierarchy thrown by the CyberSoul SDK.
 *
 * Consumers should branch on `instanceof` rather than parsing error
 * messages — message strings are not a stable API.
 */

export class CyberSoulError extends Error {
  /** Stable discriminator usable in serialized logs / event payloads. */
  readonly kind: string;

  constructor(kind: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    if (options?.cause !== undefined) {
      // ES2022 `cause` field. We assign defensively so older targets
      // don't drop it on the floor.
      (this as { cause?: unknown }).cause = options.cause;
    }
    // Preserve prototype chain for downlevel-transpiled `extends`.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The underlying fetch call never produced a response (DNS failure,
 * connection refused, TLS error, offline, etc.). The remote service may
 * or may not have processed the request; callers should treat this as a
 * transient failure and retry later when connectivity is restored.
 */
export class CyberSoulNetworkError extends CyberSoulError {
  readonly endpoint: string;
  readonly method: string;

  constructor(
    endpoint: string,
    method: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super("network", message, options);
    this.endpoint = endpoint;
    this.method = method;
  }
}

/**
 * The request was aborted because it exceeded the configured
 * `requestTimeoutMs`. A specialization of network error — callers that
 * want to distinguish "no connection" from "slow connection" can use
 * `instanceof CyberSoulTimeoutError`.
 */
export class CyberSoulTimeoutError extends CyberSoulNetworkError {
  readonly timeoutMs: number;

  constructor(endpoint: string, method: string, timeoutMs: number) {
    super(
      endpoint,
      method,
      `Request timed out after ${timeoutMs}ms: ${method} ${endpoint}`,
    );
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The backend returned a non-2xx HTTP response. Callers can inspect
 * `status` to decide how to react (e.g. surface a user-facing message
 * for 4xx vs. retry on 5xx).
 */
export class CyberSoulApiError extends CyberSoulError {
  readonly status: number;
  readonly endpoint: string;
  readonly method: string;
  /** Parsed JSON body when available, otherwise `undefined`. */
  readonly body?: unknown;

  constructor(
    endpoint: string,
    method: string,
    status: number,
    message: string,
    body?: unknown,
    kind: string = "api",
  ) {
    super(kind, message);
    this.status = status;
    this.endpoint = endpoint;
    this.method = method;
    this.body = body;
  }
}

/**
 * The backend rejected the SDK's character credential (HTTP 401/403 on
 * a character-scoped endpoint). The most common cause is that the
 * character profile bound to this `characterKey` has been deleted on
 * the backend; the binding is effectively terminal for this client.
 */
export class CyberSoulAuthError extends CyberSoulApiError {
  constructor(
    endpoint: string,
    method: string,
    status: number,
    message: string,
    body?: unknown,
  ) {
    super(endpoint, method, status, message, body, "auth");
  }
}

/**
 * The backend rejected a paid action because the user's wallet does
 * not have enough points to cover it (HTTP 402 / `INSUFFICIENT_POINTS`).
 * Callers should surface a top-up prompt rather than retrying.
 */
export class CyberSoulInsufficientPointsError extends CyberSoulApiError {
  /**
   * Backend-supplied machine code. Always `"INSUFFICIENT_POINTS"` today;
   * kept as a field so future variants (e.g. per-feature paywalls) can
   * piggy-back on the same class.
   */
  readonly code: string;

  constructor(
    endpoint: string,
    method: string,
    status: number,
    message: string,
    body?: unknown,
    code: string = "INSUFFICIENT_POINTS",
  ) {
    super(endpoint, method, status, message, body, "insufficient-points");
    this.code = code;
  }
}

/**
 * The wallet-deduction call failed for a reason *other than* insufficient
 * balance (e.g. wallet service unavailable, accounting bug). Distinct from
 * `CyberSoulInsufficientPointsError` because the user can't fix this by
 * topping up — it's an upstream infrastructure issue.
 */
export class CyberSoulWalletError extends CyberSoulApiError {
  readonly code: string;

  constructor(
    endpoint: string,
    method: string,
    status: number,
    message: string,
    body?: unknown,
    code: string = "WALLET_DEDUCTION_ERROR",
  ) {
    super(endpoint, method, status, message, body, "wallet");
    this.code = code;
  }
}

/**
 * The backend rejected an image/voice generation request because the
 * prompt (or the model's output) was flagged as sensitive / unsafe
 * (backend code `E005`). The user can recover by sending a different
 * prompt — there's nothing to retry automatically.
 */
export class CyberSoulSensitiveContentError extends CyberSoulApiError {
  readonly code: string;

  constructor(
    endpoint: string,
    method: string,
    status: number,
    message: string,
    body?: unknown,
    code: string = "E005",
  ) {
    super(endpoint, method, status, message, body, "sensitive-content");
    this.code = code;
  }
}

/* ---------------------------------------------------------------------- */
/* BYOK LLM-provider errors                                               */
/* ---------------------------------------------------------------------- */
//
// `GenericLLMProvider` talks DIRECTLY to the user's chosen LLM provider
// (OpenAI, Anthropic, DeepSeek, …) using their BYOK API key. Those calls
// bypass the SDK's central `apiFetch()` wrapper, so they don't automatically
// inherit the typed-error discipline that backend calls do. Without these
// classes the provider threw plain `Error("Generic API returned status:
// 401")`, forcing callers to string-sniff — see the historical workaround
// in MessageBus.classifyLlmFailure.
//
// The hierarchy below mirrors the backend `CyberSoulApiError` shape so
// consumers can branch uniformly:
//
//   try { await client.interact(...) }
//   catch (err) {
//     if (err instanceof CyberSoulLlmAuthError) { /* bad BYOK key */ }
//     if (err instanceof CyberSoulLlmRateLimitError) { /* quota hit */ }
//     if (err instanceof CyberSoulNetworkError) { /* offline / DNS */ }
//   }
//
// Network-layer failures (DNS, offline, TLS) on the LLM call are surfaced
// as the existing `CyberSoulNetworkError` so a single `instanceof` covers
// both backend and LLM transport errors.

/**
 * Base class for all BYOK LLM-provider failures (the call to
 * OpenAI / Anthropic / etc.). Carries the provider + model so UIs can
 * point the user at the exact field that needs fixing.
 */
export class CyberSoulLlmError extends CyberSoulError {
  readonly provider: string;
  readonly model: string;

  constructor(
    kind: string,
    provider: string,
    model: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(kind, message, options);
    this.provider = provider;
    this.model = model;
  }
}

/**
 * The LLM provider returned a non-2xx HTTP response. Callers can inspect
 * `status` (and the more specific subclasses below) to decide how to react.
 */
export class CyberSoulLlmApiError extends CyberSoulLlmError {
  readonly status: number;
  /** Provider endpoint URL that was POSTed to. */
  readonly endpoint: string;
  /** Parsed JSON body when available, otherwise `undefined`. */
  readonly body?: unknown;

  constructor(
    provider: string,
    model: string,
    status: number,
    endpoint: string,
    message: string,
    body?: unknown,
    kind: string = "llm-api",
  ) {
    super(kind, provider, model, message);
    this.status = status;
    this.endpoint = endpoint;
    this.body = body;
  }
}

/**
 * 401 / 403 from the LLM provider — the BYOK API key is missing, revoked,
 * or forbidden for the selected model. The user can fix this by re-entering
 * a valid key in the LLM config UI.
 */
export class CyberSoulLlmAuthError extends CyberSoulLlmApiError {
  constructor(
    provider: string,
    model: string,
    status: number,
    endpoint: string,
    message: string,
    body?: unknown,
  ) {
    super(provider, model, status, endpoint, message, body, "llm-auth");
  }
}

/**
 * 429 from the LLM provider — quota exhausted or rate limit hit. The user
 * should wait and retry rather than re-submitting immediately.
 */
export class CyberSoulLlmRateLimitError extends CyberSoulLlmApiError {
  constructor(
    provider: string,
    model: string,
    status: number,
    endpoint: string,
    message: string,
    body?: unknown,
  ) {
    super(provider, model, status, endpoint, message, body, "llm-rate-limit");
  }
}

/**
 * 5xx from the LLM provider — upstream outage on their side. Retries with
 * backoff are appropriate; the user's config is fine.
 */
export class CyberSoulLlmUnavailableError extends CyberSoulLlmApiError {
  constructor(
    provider: string,
    model: string,
    status: number,
    endpoint: string,
    message: string,
    body?: unknown,
  ) {
    super(
      provider,
      model,
      status,
      endpoint,
      message,
      body,
      "llm-unavailable",
    );
  }
}

/**
 * The LLM provider returned 2xx but the body could not be parsed into the
 * expected shape — the configured `responsePath` missed, the JSON was
 * malformed, or the field wasn't a string. Usually indicates a misaligned
 * template (wrong model name, stale `responsePath`) rather than a
 * transient failure.
 */
export class CyberSoulLlmBadResponseError extends CyberSoulLlmError {
  /** The configured response path that failed extraction, when known. */
  readonly responsePath?: string;

  constructor(
    provider: string,
    model: string,
    message: string,
    options?: { cause?: unknown; responsePath?: string },
  ) {
    super("llm-bad-response", provider, model, message, options);
    if (options?.responsePath !== undefined) {
      this.responsePath = options.responsePath;
    }
  }
}

/**
 * The backend's LLM-template lookup (`GET /api/v1/cyber-soul/llm-models/
 * template`) failed. This is an infrastructure / configuration issue on
 * OUR backend (template missing for the requested provider+model), not
 * something the user's BYOK key can fix. Surfaced as a typed error so the
 * UI can distinguish it from a generic backend `CyberSoulApiError`.
 */
export class CyberSoulLlmTemplateError extends CyberSoulApiError {
  readonly provider: string;
  readonly model: string;

  constructor(
    endpoint: string,
    method: string,
    status: number,
    message: string,
    body: unknown | undefined,
    provider: string,
    model: string,
  ) {
    super(endpoint, method, status, message, body, "llm-template");
    this.provider = provider;
    this.model = model;
  }
}
