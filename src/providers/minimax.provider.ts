import { LLMConfig, BaseLLMProvider } from '../types';

export class MinimaxProvider implements BaseLLMProvider {
  constructor(private config: LLMConfig) {}

  async generate(messages: { role: string; content: string }[], maxTokens: number = 1500, temperature: number = 0.7): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error("Missing MiniMax API Key");
    }
    
    // Ensure we handle correct minimax URL
    const host = 'https://api.minimaxi.com'; 

    const payload = {
      model: this.config.model || 'MiniMax-M2.7',
      messages,
      temperature,
      max_tokens: maxTokens,
      tokens_to_generate: maxTokens
    };

    const response = await fetch(`${host}/v1/text/chatcompletion_v2`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`MiniMax API returned status: ${response.status}`);
    }

    const data = await response.json() as any;
    console.log("[MinimaxProvider] API Response Payload:", data);
    
    if (data?.base_resp?.status_code && data.base_resp.status_code !== 0) {
      throw new Error(`MiniMax SDK Error [${data.base_resp.status_code}]: ${data.base_resp.status_msg}`);
    }

    const choices = data?.choices || [];
    if (choices.length > 0) {
      const msg = choices[0].message;
      if (!msg || typeof msg.content !== 'string') {
        throw new Error("Invalid response format from MiniMax API: missing message content.");
      }
      return msg.content;
    }

    throw new Error("MiniMax API returned no choices.");
  }
}
