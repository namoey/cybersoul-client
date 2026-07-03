import { BaseLLMProvider, GenericLLMConfig } from './types.js';
import {
  CyberSoulLlmApiError,
  CyberSoulLlmAuthError,
  CyberSoulLlmBadResponseError,
  CyberSoulLlmRateLimitError,
  CyberSoulLlmTemplateError,
  CyberSoulLlmUnavailableError,
  CyberSoulNetworkError,
} from './errors.js';

/**
 * Wrap a raw `fetch`-layer throw (TypeError "Network request failed" /
 * "Failed to fetch" / "fetch failed") as a typed [CyberSoulNetworkError]
 * that carries the LLM endpoint context. Non-TypeError throws are
 * returned untouched so genuine programming bugs aren't misclassified
 * as transport failures.
 */
function wrapLlmFetchError(
  err: unknown,
  endpoint: string,
  method: string,
): Error {
  if (err instanceof Error && err.name === 'AbortError') {
    return new CyberSoulNetworkError(endpoint, method, `LLM request aborted: ${method} ${endpoint}`, { cause: err });
  }
  // RN throws `TypeError: Network request failed`. Web throws
  // `TypeError: Failed to fetch`. Node undici throws `TypeError: fetch
  // failed`. Treat any TypeError from `fetch` as a transport-layer
  // failure — programming errors in the call path don't throw TypeErrors.
  if (err instanceof TypeError) {
    return new CyberSoulNetworkError(
      endpoint,
      method,
      err.message
        ? `LLM network request failed: ${method} ${endpoint}: ${err.message}`
        : `LLM network request failed: ${method} ${endpoint}`,
      { cause: err },
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

export class GenericLLMProvider implements BaseLLMProvider {
  private static templateCache = new Map<string, any>();

  constructor(
    private config: GenericLLMConfig,
    private backendApiUrl: string,
    private backendAuthToken?: string,
    private fetchImpl?: typeof fetch
  ) {}

  private get fetchFn(): typeof fetch {
    // Bind to `globalThis` so the global `fetch` is not invoked detached
    // from its Window receiver (which throws "Illegal invocation" in
    // Chromium-based browsers).
    return this.fetchImpl ?? fetch.bind(globalThis);
  }

  private async fetchTemplate() {
    const cacheKey = `${this.config.provider}:${this.config.model}`;
    if (GenericLLMProvider.templateCache.has(cacheKey)) {
      return GenericLLMProvider.templateCache.get(cacheKey);
    }
    // Need an auth token to call the backend APIs
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (this.backendAuthToken) {
      headers['Authorization'] = `Bearer ${this.backendAuthToken}`;
    }

    const qs = new URLSearchParams({
      provider: this.config.provider,
      model: this.config.model
    });

    const templateUrl = `${this.backendApiUrl}/api/v1/cyber-soul/llm-models/template?${qs.toString()}`;
    let resp: Response;
    try {
      resp = await this.fetchFn(templateUrl, { headers });
    } catch (err) {
      // Template endpoint lives on OUR backend, so transport failures
      // here are normal backend network errors — surface them as such.
      throw wrapLlmFetchError(err, templateUrl, 'GET');
    }

    if (!resp.ok) {
      let body: unknown;
      try { body = await resp.json(); } catch { body = undefined; }
      const detail =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${resp.status}`;
      throw new CyberSoulLlmTemplateError(
        '/api/v1/cyber-soul/llm-models/template',
        'GET',
        resp.status,
        `Failed to fetch LLM generic template: ${detail}`,
        body,
        this.config.provider,
        this.config.model,
      );
    }

    const template = await resp.json();
    GenericLLMProvider.templateCache.set(cacheKey, template);
    return template;
  }

  private extractResponse(data: any, responsePath: string): string {
    const parts = responsePath.split('.');
    let cursor = data;
    for (const part of parts) {
      if (cursor === undefined || cursor === null) return '';
      cursor = cursor[part];
    }
    if (typeof cursor !== 'string') {
      throw new CyberSoulLlmBadResponseError(
        this.config.provider,
        this.config.model,
        `Extraction resulted in non-string type: ${typeof cursor}`,
        { responsePath },
      );
    }
    return cursor;
  }

  async generate(messages: { role: string; content: string }[], maxTokens: number = 1500, temperature: number = 0.7): Promise<string> {
    const template = await this.fetchTemplate();

    const headers = { ...template.headersTemplate };
    if (this.config.apiKey) {
      for (const key of Object.keys(headers)) {
        if (typeof headers[key] === 'string') {
          headers[key] = headers[key].replace('{{apiKey}}', this.config.apiKey);
        }
      }
    }

    const payload = { ...template.basePayload };

    if (this.config.customSettings) {
      Object.assign(payload, this.config.customSettings);
    }

    // We only explicitly map messages. Parameters like temperature or max_tokens
    // should be defined in basePayload, customSettings, or configured via the UI.
    if (!payload.messages || (Array.isArray(payload.messages) && payload.messages.length === 0)) {
      payload.messages = messages;
    }

    const apiUrl: string = template.apiUrl;
    let response: Response;
    try {
      response = await this.fetchFn(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
    } catch (err) {
      // Wrap raw `TypeError: Network request failed` (and friends) so
      // callers can branch on `instanceof CyberSoulNetworkError` instead
      // of message-sniffing. Programming-error throws pass through.
      throw wrapLlmFetchError(err, apiUrl, 'POST');
    }

    if (!response.ok) {
      // Drain the body so the connection can be reused and so we can
      // surface the provider's own error message in the typed throw.
      let body: unknown;
      try { body = await response.json(); } catch { body = undefined; }
      const providerMsg =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : body && typeof body === 'object' && 'message' in body
            ? String((body as { message: unknown }).message)
            : `HTTP ${response.status}`;

      if (response.status === 401 || response.status === 403) {
        throw new CyberSoulLlmAuthError(
          this.config.provider,
          this.config.model,
          response.status,
          apiUrl,
          `LLM provider rejected credentials (${providerMsg}). Check the API key configured for ${this.config.provider}/${this.config.model}.`,
          body,
        );
      }
      if (response.status === 429) {
        throw new CyberSoulLlmRateLimitError(
          this.config.provider,
          this.config.model,
          response.status,
          apiUrl,
          `LLM provider rate-limited the request (${providerMsg}). Retry after a short delay.`,
          body,
        );
      }
      if (response.status >= 500) {
        throw new CyberSoulLlmUnavailableError(
          this.config.provider,
          this.config.model,
          response.status,
          apiUrl,
          `LLM provider is unavailable (${providerMsg}). Retry later.`,
          body,
        );
      }
      // 4xx other than auth/rate-limit (e.g. 400 bad request, 404 wrong
      // model name). Surface as a generic LLM API error — usually
      // indicates a misaligned template / model name rather than a
      // transient failure.
      throw new CyberSoulLlmApiError(
        this.config.provider,
        this.config.model,
        response.status,
        apiUrl,
        `LLM provider returned HTTP ${response.status}: ${providerMsg}`,
        body,
      );
    }

    let data: any;
    try {
      data = await response.json() as any;
    } catch (err) {
      // 2xx but the body isn't valid JSON — the provider is misbehaving.
      throw new CyberSoulLlmBadResponseError(
        this.config.provider,
        this.config.model,
        `LLM provider returned a non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      return this.extractResponse(data, template.responsePath || 'choices.0.message.content');
    } catch (e: any) {
      // extractResponse already throws a typed error; re-throw as-is.
      // The outer try/catch is preserved to keep the stack frame for
      // debugging and to defend against unexpected non-typed throws.
      if (e instanceof CyberSoulLlmBadResponseError) throw e;
      throw new CyberSoulLlmBadResponseError(
        this.config.provider,
        this.config.model,
        `Failed to extract LLM response: ${e?.message ?? String(e)}`,
        {
          cause: e,
          responsePath: template.responsePath || 'choices.0.message.content',
        },
      );
    }
  }
}
