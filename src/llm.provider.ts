import { BaseLLMProvider, GenericLLMConfig } from './types.js';

export class GenericLLMProvider implements BaseLLMProvider {
  private static templateCache = new Map<string, any>();

  constructor(
    private config: GenericLLMConfig,
    private backendApiUrl: string,
    private backendAuthToken?: string
  ) {}

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
    
    const resp = await fetch(`${this.backendApiUrl}/api/v1/cyber-soul/llm-models/template?${qs.toString()}`, {
      headers
    });
    
    if (!resp.ok) {
      throw new Error(`Failed to fetch LLM generic template: ${resp.status}`);
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
      throw new Error(`Extraction resulted in non-string type: ${typeof cursor}`);
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

    const response = await fetch(template.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Generic API returned status: ${response.status}`);
    }

    const data = await response.json() as any;
    
    try {
      return this.extractResponse(data, template.responsePath || 'choices.0.message.content');
    } catch (e: any) {
      throw new Error(`Failed to extract response. Error: ${e?.message}`);
    }
  }
}
