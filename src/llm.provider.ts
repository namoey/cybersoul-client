import { BaseLLMProvider, GenericLLMConfig, LLMToolCall, LLMChatResult, LLMToolDeclaration } from './types.js';
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

  /**
   * Resolve a dotted path against a nested object, returning whatever
   * value lives there (or `undefined`). Used for both the text-response
   * path and the tool-calls response path. Unlike `extractResponse`,
   * this variant does NOT throw — it returns undefined so the chat()
   * path can decide whether missing tool_calls is an error or just
   * "the model chose not to call any tools."
   */
  private resolvePath(data: any, path: string): unknown {
    if (!path) return undefined;
    const parts = path.split('.');
    let cursor: any = data;
    for (const part of parts) {
      if (cursor === undefined || cursor === null) return undefined;
      cursor = cursor[part];
    }
    return cursor;
  }

  /**
   * Phase 2 capability detection. A template supports tool-calling iff
   * all three tool-related fields are present and non-empty. Their
   * absence means "this provider/model's template was not configured
   * for tool-calling" and the SDK falls back to the JSON-dispatcher
   * path. Public (exported via the type) so the harness can pre-check
   * before even fetching the template.
   */
  templateSupportsToolCalling(template: any): boolean {
    return !!(
      template &&
      template.toolsPayloadTemplate &&
      typeof template.toolsPayloadTemplate === 'object' &&
      template.toolCallsResponsePath &&
      typeof template.toolCallsResponsePath === 'string' &&
      template.toolCallArgsResponsePath &&
      typeof template.toolCallArgsResponsePath === 'string'
    );
  }

  /**
   * Parse tool calls from the raw LLM response. Handles two shapes
   * transparently based on the configured response path:
   *
   *   1. OpenAI/MiniMax shape — `toolCallsResponsePath` points at an
   *      array of `{ id, type: "function", function: { name, arguments } }`.
   *      Each item's args live at `function.{toolCallArgsResponsePath}`.
   *
   *   2. Anthropic native shape — `toolCallsResponsePath` points at a
   *      `content` array containing `{ type: "tool_use", name, input }`
   *      items. Each item's args live at `{toolCallArgsResponsePath}`
   *      (typically `"input"`).
   *
   * Items that don't resolve to a recognizable shape are skipped — the
   * model sometimes interleaves text blocks with tool_use blocks, and
   * only the tool_use entries are tool calls.
   */
  private extractToolCalls(
    data: any,
    toolCallsResponsePath: string,
    toolCallArgsResponsePath: string,
  ): LLMToolCall[] {
    const raw = this.resolvePath(data, toolCallsResponsePath);
    if (!Array.isArray(raw)) return [];

    const argsParts = toolCallArgsResponsePath.split('.');
    const calls: LLMToolCall[] = [];

    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;

      // OpenAI/MiniMax shape: { function: { name, arguments } }
      // Anthropic shape: { type: "tool_use", name, input }
      let name: string | undefined;
      let args: unknown;

      if (typeof item.function === 'object' && item.function !== null) {
        // OpenAI/MiniMax
        name = typeof item.function.name === 'string' ? item.function.name : undefined;
        // Walk the args path from the `function` object so `function.arguments`
        // works as well as `function.input`.
        let cursor: any = item.function;
        for (const part of argsParts) {
          if (part === 'function') continue; // tolerate paths like "function.arguments"
          if (cursor === undefined || cursor === null) break;
          cursor = cursor[part];
        }
        args = cursor;
      } else if (item.type === 'tool_use' || (typeof item.name === 'string' && item.input !== undefined)) {
        // Anthropic native
        name = typeof item.name === 'string' ? item.name : undefined;
        let cursor: any = item;
        for (const part of argsParts) {
          if (cursor === undefined || cursor === null) break;
          cursor = cursor[part];
        }
        args = cursor;
      }

      if (!name) continue;

      // The provider returns args either as a JSON string (OpenAI/MiniMax)
      // or as a parsed object (Anthropic). Normalize to string for the
      // LLMToolCall contract.
      let argsStr: string;
      if (typeof args === 'string') {
        argsStr = args;
      } else if (args !== undefined && args !== null) {
        argsStr = JSON.stringify(args);
      } else {
        argsStr = '{}';
      }

      calls.push({ name, arguments: argsStr });
    }

    return calls;
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

  /**
   * Phase 2 native tool-calling entry point (see
   * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
   * §3.3.1). Mirrors `generate()` for transport + error handling, then
   * ALSO injects the tool declarations into the request payload (via
   * the template's `toolsPayloadTemplate`) and parses `tool_calls`
   * back out of the response.
   *
   * The constrained-decoding enforcement (§3.3.1) is provider-side —
   * by the time the response arrives here, `tool_calls[i].arguments`
   * is guaranteed to be valid JSON conforming to the declared schema.
   * `JSON.parse()` cannot fail on it.
   *
   * Throws `CyberSoulLlmBadResponseError` when the template was not
   * configured for tool-calling — the harness MUST pre-check with
   * `templateSupportsToolCalling()` and not call `chat()` on a
   * template that doesn't support it. This is a defensive throw so
   * misconfiguration fails loudly instead of silently degrading.
   */
  async chat(params: {
    messages: { role: string; content: string }[];
    tools: LLMToolDeclaration[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<LLMChatResult> {
    const template = await this.fetchTemplate();
    if (!this.templateSupportsToolCalling(template)) {
      throw new CyberSoulLlmBadResponseError(
        this.config.provider,
        this.config.model,
        `chat() called on a template that does not support tool-calling. Configure toolsPayloadTemplate + toolCallsResponsePath + toolCallArgsResponsePath on the backend LlmModel, or call generate() instead.`,
      );
    }

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
    if (!payload.messages || (Array.isArray(payload.messages) && payload.messages.length === 0)) {
      payload.messages = params.messages;
    }

    // Inject the tool declarations per the template's instructions.
    // The template author chooses how tools appear in the provider's
    // request format — `{{tools}}` is the placeholder. Some providers
    // want the tools inline; some want them JSON-stringified. The
    // template's `toolsPayloadTemplate` object is merged onto the
    // payload with the placeholder resolved.
    const toolsTemplate = template.toolsPayloadTemplate as Record<string, unknown>;
    for (const [key, value] of Object.entries(toolsTemplate)) {
      if (typeof value === 'string' && value.includes('{{tools}}')) {
        // Replace the placeholder inline (preserves any wrapper structure
        // the template specified around `{{tools}}`).
        payload[key] = value.replace('{{tools}}', JSON.stringify(params.tools));
      } else if (value === '{{tools}}') {
        // Bare placeholder — inject the array directly so the provider
        // receives it as a real JSON array, not a stringified one.
        payload[key] = params.tools;
      } else {
        // Static value the template wants shipped verbatim (e.g.
        // `tool_choice: { type: "auto" }`). Copy through.
        payload[key] = value;
      }
    }

    const apiUrl: string = template.apiUrl;
    let response: Response;
    try {
      response = await this.fetchFn(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw wrapLlmFetchError(err, apiUrl, 'POST');
    }

    if (!response.ok) {
      // Same error mapping as generate(). Re-implemented rather than
      // refactored into a shared helper so the stack trace points at
      // chat() for diagnosis — the failure modes are identical but
      // the call origin matters in logs.
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
      // transient failure. For the chat() path specifically, a 400 with
      // a message about `tools` or `functions` almost always means the
      // provider/model doesn't actually support tool-calling despite
      // the template being configured for it — append actionable
      // guidance so the operator knows which knob to turn. This is the
      // Scenario-B fix from the Phase 2.1 design review.
      const looksToolRelated = /tool|function|unsupported|unknown.*param/i.test(
        providerMsg,
      );
      const hint = looksToolRelated
        ? " This provider may not support tool-calling. If so, unset llmConfig.capabilities.toolCalling to fall back to the JSON-dispatcher path, or verify the template's toolsPayloadTemplate matches this provider's API."
        : "";
      throw new CyberSoulLlmApiError(
        this.config.provider,
        this.config.model,
        response.status,
        apiUrl,
        `LLM provider returned HTTP ${response.status}: ${providerMsg}.${hint}`,
        body,
      );
    }

    let data: any;
    try {
      data = await response.json() as any;
    } catch (err) {
      throw new CyberSoulLlmBadResponseError(
        this.config.provider,
        this.config.model,
        `LLM provider returned a non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Text portion may be absent on a pure tool-call turn (OpenAI returns
    // null content). Tolerate that — an empty string is the contract.
    let textResponse = '';
    try {
      textResponse = this.extractResponse(
        data,
        template.responsePath || 'choices.0.message.content',
      );
    } catch {
      // Missing/null text on a tool-call turn is legitimate. Leave
      // textResponse as empty string.
    }

    const toolCalls = this.extractToolCalls(
      data,
      template.toolCallsResponsePath,
      template.toolCallArgsResponsePath,
    );

    return { textResponse, toolCalls };
  }
}
