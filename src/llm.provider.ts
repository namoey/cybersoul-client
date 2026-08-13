import { BaseLLMProvider, GenericLLMConfig, LLMToolCall, LLMChatResult, LLMToolDeclaration, LLMConversationMessage, LLMPlainMessage, LLMStreamEvent } from './types.js';
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
 * Phase 3.3 — translate the canonical `LLMConversationMessage[]` into
 * the OpenAI-compatible message format that most provider templates
 * expect. Plain `{role, content}` messages pass through unchanged;
 * tool-result messages (`role: "tool"`) become
 * `{role:"tool", tool_call_id, content}`.
 *
 * Pure function, no IO. Exported so callers building custom providers
 * can reuse the same translation.
 *
 * Providers with non-OpenAI formats (e.g. Anthropic native API without
 * the OpenAI-compat shim) need their own translation; for now we ship
 * the OpenAI shape because that's what MiniMax + most compatible APIs
 * use, and Anthropic has an OpenAI-compat endpoint that accepts it.
 */
export function normalizeMessagesForProvider(
  messages: Array<LLMConversationMessage | { role: string; content: string; [key: string]: unknown }>,
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "tool") {
      const tool = m as Extract<LLMConversationMessage, { role: "tool" }>;
      return {
        role: "tool",
        content: m.content,
        tool_call_id: tool.toolCallId,
      };
    }
    // Pass through any extra fields on assistant messages (e.g.
    // tool_calls, reasoning_content) so the provider can correlate
    // tool results and continue thinking-mode reasoning.
    const out: Record<string, unknown> = { role: m.role, content: m.content };
    const hasToolCalls = !!((m as any).tool_calls);
    if (hasToolCalls) {
      out.tool_calls = (m as any).tool_calls;
    }
    const reasoning = (m as any).reasoning_content;
    // DeepSeek thinking mode requires `reasoning_content` to be PRESENT
    // on assistant messages that carry tool_calls — even when the value
    // is an empty string. The previous `if (reasoning)` truthiness
    // check stripped empty strings, which caused HTTP 400
    // "The reasoning_content in the thinking mode must be passed back
    // to the API." So: pass it through whenever it's a string. For
    // non-tool-call messages we keep the truthiness gate so unrelated
    // turns don't sprout empty reasoning fields.
    if (typeof reasoning === "string") {
      if (reasoning.length > 0 || hasToolCalls) {
        out.reasoning_content = reasoning;
      }
    }
    return out;
  });
}

/**
 * Transform the SDK's canonical LLMToolDeclaration[] into the
 * OpenAI-compatible tool format that most providers expect:
 *
 *   SDK canonical:  { name, description, inputSchema }
 *   OpenAI format:  { type: "function", function: { name, description, parameters } }
 *
 * Without this transformation, DeepSeek/OpenAI/MiniMax return 400
 * Bad Request because the `tools` array doesn't match their expected
 * schema (missing `type: "function"` wrapper, wrong key name
 * `inputSchema` vs `parameters`).
 *
 * Exported so custom providers can reuse the same transformation.
 */
export function toOpenAiToolFormat(
  tools: LLMToolDeclaration[],
): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/**
 * Phase 2.1.1 — extract a human-readable error message from a
 * provider's error response body. Handles the three common shapes:
 *
 *   OpenAI/DeepSeek: { error: { message: "..." } }
 *   Anthropic:       { error: { message: "..." } }
 *   Flat:            { message: "..." } or { error: "..." }
 *
 * Returns a string; falls back to "HTTP {status}" when nothing
 * useful is found. Without this, `String(body.error)` produces
 * "[object Object]" when the error field is an object.
 */
function extractProviderError(body: unknown, status: number): string {

  if (!body || typeof body !== 'object') return `HTTP ${status}`;
  const obj = body as Record<string, unknown>;

  // { error: { message: "..." } }
  if (obj.error && typeof obj.error === 'object') {
    const errObj = obj.error as Record<string, unknown>;
    if (typeof errObj.message === 'string') return errObj.message;
    if (typeof errObj.type === 'string') return errObj.type;
    return JSON.stringify(errObj);
  }

  // { error: "string message" }
  if (typeof obj.error === 'string') return obj.error;

  // { message: "..." }
  if (typeof obj.message === 'string') return obj.message;

  // Fallback — stringify the whole thing (truncated for readability)
  const str = JSON.stringify(body);
  return str.length > 200 ? str.slice(0, 197) + '...' : str;
}

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

  /**
   * Phase 5 — cached capability detection result. Populated on first
   * `detectCapabilities()` call, reused thereafter so the template
   * is only fetched once per provider instance.
   */
  private cachedCapabilities: { toolCalling: boolean; streaming: boolean } | null = null;

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
      const detail = extractProviderError(body, resp.status);
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

  /**
   * Phase 5 — dynamic capability detection. Fetches the backend LLM
   * template (cached) and resolves which dispatch features this
   * provider/model combination actually supports:
   *
   *   - `toolCalling`: template has `toolsPayloadTemplate` +
   *     `toolCallsResponsePath` + `toolCallArgsResponsePath` → the
   *     agent/tool-calling path is available.
   *   - `streaming`: template has `streamMode === "sse"` +
   *     `streamDeltaPath` → streaming text deltas are available.
   *
   * This lets the SDK AUTO-ROUTE: modern models (DeepSeek, GPT-4o,
   * Claude) with configured templates use the agent path; traditional
   * models (MiniMax abab, older models without tool-call fields) use
   * the classic JSON-dispatcher path. Callers no longer need to set
   * `capabilities.toolCalling` manually.
   *
   * The result is cached per-instance so repeated calls are free.
   * Failures (template fetch error, etc.) return all-false → the SDK
   * safely falls back to the classic path rather than crashing.
   */
  async detectCapabilities(): Promise<{ toolCalling: boolean; streaming: boolean }> {
    if (this.cachedCapabilities) return this.cachedCapabilities;
    try {
      const template = await this.fetchTemplate();
      this.cachedCapabilities = {
        toolCalling: this.templateSupportsToolCalling(template),
        streaming: this.templateStreamSupported(template),
      };
    } catch {
      // Template fetch failure → assume classic path (safe default).
      this.cachedCapabilities = { toolCalling: false, streaming: false };
    }
    return this.cachedCapabilities;
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
      const providerMsg = extractProviderError(body, response.status);

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
      // Phase 3.3 — translate the canonical LLMConversationMessage[]
      // shape into the OpenAI-compatible message format that most
      // provider templates expect. Plain {role, content} messages
      // pass through unchanged; tool-result messages become
      // {role:"tool", tool_call_id, content}.
      //
      // Providers with non-OpenAI formats (e.g. Anthropic native)
      // need their own translation; for now we ship the OpenAI shape
      // because that's what MiniMax + most compatible APIs use, and
      // Anthropic has an OpenAI-compat shim endpoint that accepts it.
      payload.messages = normalizeMessagesForProvider(params.messages);
    }

    // Inject the tool declarations per the template's instructions.
    // Transform to OpenAI-compatible format first — DeepSeek/OpenAI/
    // MiniMax all expect { type: "function", function: { name, description,
    // parameters } }, not the SDK's canonical { name, description, inputSchema }.
    const openAiTools = toOpenAiToolFormat(params.tools);
    const toolsTemplate = template.toolsPayloadTemplate as Record<string, unknown>;
    for (const [key, value] of Object.entries(toolsTemplate)) {
      if (value === '{{tools}}') {
        // Bare placeholder — inject the array directly so the provider
        // receives it as a real JSON array, not a stringified one.
        payload[key] = openAiTools;
      } else if (typeof value === 'string' && value.includes('{{tools}}')) {
        // Inline placeholder within a larger string (e.g. "prefix{{tools}}suffix").
        // Stringify because the surrounding string context requires it.
        payload[key] = value.replace('{{tools}}', JSON.stringify(openAiTools));
      } else {
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
      const providerMsg = extractProviderError(body, response.status);

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

    // Extract reasoning_content from thinking-mode models (DeepSeek-V4).
    // When present, the multi-step loop MUST pass it back on the
    // assistant message — DeepSeek returns 400 if it's missing.
    const reasoningContent =
      this.resolvePath(data, 'choices.0.message.reasoning_content') as string ?? '';

    return { textResponse, toolCalls, reasoningContent };
  }

  /**
   * Phase 4 streaming variant of `chat()` (see
   * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
   * §4 Phase 4). When the backend template declares `streamMode: "sse"`,
   * this method sets `stream: true` on the request and parses the
   * Server-Sent Events response body into an `AsyncIterable<
   * LLMStreamEvent>`.
   *
   * Streaming delivers text as deltas — the biggest perceived-latency
   * win for companion UX (first token in ~300ms vs ~3-8s today).
   *
   * SSE format (OpenAI-compatible, also used by MiniMax):
   *   Each chunk is `data: {json}\n\n`. The final chunk is `data:
   *   [DONE]\n\n`. The JSON's text delta lives at `template.
   *   streamDeltaPath` (typically `choices.0.delta.content`).
   *
   * Tool calls in streaming mode: most providers emit tool-call
   * arguments as fragments across multiple chunks. This implementation
   * buffers them and emits a single `tool-call` event when the call
   * completes (when the model finishes the tool-call turn).
   *
   * Capability contract: callers MUST pre-check
   * `templateStreamSupported(template)` AND
   * `supportsStreaming(provider)`. Throws
   * `CyberSoulLlmBadResponseError` if the template isn't configured
   * for streaming.
   */
  async *chatStream(params: {
    messages: Array<LLMConversationMessage | LLMPlainMessage>;
    tools: LLMToolDeclaration[];
    maxTokens?: number;
    temperature?: number;
  }): AsyncGenerator<LLMStreamEvent> {
    const template = await this.fetchTemplate();
    if (!this.templateStreamSupported(template)) {
      throw new CyberSoulLlmBadResponseError(
        this.config.provider,
        this.config.model,
        `chatStream() called on a template that does not support streaming. Configure streamMode: "sse" + streamDeltaPath on the backend LlmModel, or call chat() instead.`,
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
    // SSE requires Accept header
    (headers as Record<string, string>)['Accept'] = 'text/event-stream';

    const payload: Record<string, unknown> = { ...template.basePayload };
    if (this.config.customSettings) {
      Object.assign(payload, this.config.customSettings);
    }
    if (!payload.messages || (Array.isArray(payload.messages) && payload.messages.length === 0)) {
      payload.messages = normalizeMessagesForProvider(params.messages);
    }
    // Inject tools (same as chat() — transform to OpenAI format first).
    if (template.toolsPayloadTemplate) {
      const openAiTools = toOpenAiToolFormat(params.tools);
      const toolsTemplate = template.toolsPayloadTemplate as Record<string, unknown>;
      for (const [key, value] of Object.entries(toolsTemplate)) {
        if (value === '{{tools}}') {
          // Bare placeholder — inject the array directly.
          payload[key] = openAiTools;
        } else if (typeof value === 'string' && value.includes('{{tools}}')) {
          // Inline placeholder within a larger string.
          payload[key] = value.replace('{{tools}}', JSON.stringify(openAiTools));
        } else {
          payload[key] = value;
        }
      }
    }
    // Enable streaming.
    payload.stream = true;

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
      let body: unknown;
      try { body = await response.json(); } catch { body = undefined; }
      const providerMsg = extractProviderError(body, response.status);
      if (response.status === 401 || response.status === 403) {
        throw new CyberSoulLlmAuthError(
          this.config.provider,
          this.config.model,
          response.status,
          apiUrl,
          `LLM provider rejected credentials (${providerMsg}).`,
          body,
        );
      }
      throw new CyberSoulLlmApiError(
        this.config.provider,
        this.config.model,
        response.status,
        apiUrl,
        `LLM provider returned HTTP ${response.status}: ${providerMsg}`,
        body,
      );
    }

    // Parse the SSE stream.
    const body = response.body;
    if (!body) {
      throw new CyberSoulLlmBadResponseError(
        this.config.provider,
        this.config.model,
        'Streaming response had no body — provider may not actually support SSE despite the template config.',
      );
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    // Accumulate reasoning_content from thinking-mode models
    // (DeepSeek-V4). Streamed as `delta.reasoning_content` chunks
    // alongside `delta.content`. Captured here so a streaming-capable
    // agent loop can echo it back on the assistant message (DeepSeek
    // returns 400 "The reasoning_content in the thinking mode must be
    // passed back to the API" if a prior thinking turn's reasoning is
    // dropped). Mirrors the non-streaming `chat()` extraction.
    let reasoningText = '';
    const toolCallBuffers = new Map<number, { id?: string; name?: string; arguments: string }>();
    const deltaPath = template.streamDeltaPath || 'choices.0.delta.content';
    const deltaPathParts = deltaPath.split('.');

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by `\n\n`. Process complete events.
        let sepIdx: number;
        while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
          const eventBlock = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);

          // Each event may have multiple `data:` lines. Concatenate them.
          const dataLines = eventBlock
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim());
          if (dataLines.length === 0) continue;
          const dataStr = dataLines.join('');

          // [DONE] marker = stream end.
          if (dataStr === '[DONE]') {
            // Emit accumulated tool calls.
            for (const [, buf] of toolCallBuffers) {
              yield {
                type: 'tool-call',
                toolCall: {
                  id: buf.id,
                  name: buf.name ?? '',
                  arguments: buf.arguments || '{}',
                },
              };
            }
            yield {
              type: 'message-complete',
              textResponse: fullText,
              toolCalls: Array.from(toolCallBuffers.values()).map((buf) => ({
                id: buf.id,
                name: buf.name ?? '',
                arguments: buf.arguments || '{}',
              })),
              reasoningContent: reasoningText || undefined,
            };
            return;
          }

          // Parse the JSON chunk.
          let chunk: any;
          try {
            chunk = JSON.parse(dataStr);
          } catch {
            // Skip malformed chunks — SSE streams sometimes emit
            // partial JSON across reads; the next read will complete it.
            continue;
          }

          // Extract text delta.
          const delta = this.resolvePath(chunk, deltaPath);
          if (typeof delta === 'string' && delta.length > 0) {
            fullText += delta;
            yield { type: 'text-delta', delta };
          }

          // Accumulate reasoning_content delta from thinking-mode
          // models (DeepSeek-V4). NOT emitted as its own event — we
          // only need it on the final message-complete so a loop can
          // echo it back. See `reasoningText` declaration above.
          const reasoningDelta = this.resolvePath(chunk, 'choices.0.delta.reasoning_content');
          if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
            reasoningText += reasoningDelta;
          }

          // Accumulate tool-call fragments (OpenAI streaming format:
          // tool_calls[].function.name + .arguments arrive as deltas).
          const streamToolCalls = this.resolvePath(chunk, 'choices.0.delta.tool_calls');
          if (Array.isArray(streamToolCalls)) {
            for (const frag of streamToolCalls) {
              const idx = typeof frag.index === 'number' ? frag.index : 0;
              if (!toolCallBuffers.has(idx)) {
                toolCallBuffers.set(idx, { id: frag.id, name: '', arguments: '' });
              }
              const buf = toolCallBuffers.get(idx)!;
              if (frag.id) buf.id = frag.id;
              if (frag.function?.name) buf.name = frag.function.name;
              if (frag.function?.arguments) buf.arguments += frag.function.arguments;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Stream ended without [DONE] — emit message-complete with what we have.
    for (const [, buf] of toolCallBuffers) {
      yield {
        type: 'tool-call',
        toolCall: {
          id: buf.id,
          name: buf.name ?? '',
          arguments: buf.arguments || '{}',
        },
      };
    }
    yield {
      type: 'message-complete',
      textResponse: fullText,
      toolCalls: Array.from(toolCallBuffers.values()).map((buf) => ({
        id: buf.id,
        name: buf.name ?? '',
        arguments: buf.arguments || '{}',
      })),
      reasoningContent: reasoningText || undefined,
    };
  }

  /**
   * Phase 4 capability detection for the template. Returns true iff
   * the template declares `streamMode: "sse"` + a non-empty
   * `streamDeltaPath`. Their absence means "streaming not supported"
   * and the SDK falls back to the non-streaming chat() path.
   */
  templateStreamSupported(template: any): boolean {
    return !!(
      template &&
      template.streamMode === 'sse' &&
      typeof template.streamDeltaPath === 'string' &&
      template.streamDeltaPath.length > 0
    );
  }
}
