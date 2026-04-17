export interface LLMConfig {
  provider: 'minimax' | 'openai'; // Extendable
  apiKey: string;
  model: string;
}

export interface CyberSoulClientConfig {
  characterKey: string;
  backendUrl: string;
  llmConfig: LLMConfig;
}

export interface InteractParams {
  userMessage: string;
  localContext?: string;
  requestTypes?: string[];
  history?: { role: string; content: string }[];
  imageOverrides?: any;
  voiceStyleOverride?: string;
  onTextReady?: (textResponse: string) => void;
}

export interface InteractResponse {
  status: 'success' | 'error';
  textResponse: string;
  imageUrl?: string;
  audioUrl?: string;
  durationSec?: number;
  error?: string;
}

export interface DispatcherIntent {
  textResponse?: string;
  imageParams?: any;
  voiceArgs?: any;
  stateUpdate?: {
    temperatureDelta?: string | number;
    userNickname?: string;
    agentNickname?: string;
    talkingStyle?: string;
  };
}

export interface BaseLLMProvider {
  generate(messages: { role: string; content: string }[], maxTokens?: number, temperature?: number): Promise<string>;
}
