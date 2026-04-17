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

export interface CharacterState {
  current_time: string;
  active_event?: any;
  next_event?: any;
  active_wardrobe?: any;
  active_story_arcs?: string[];
  dynamic_context?: any;
  relationship_stage?: string;
  name?: string;
  age?: number;
  gender?: string;
  occupation?: string;
  personality_traits?: string;
  interaction_boundaries?: string;
  communication_style?: string;
}

export interface BaseLLMProvider {
  generate(messages: { role: string; content: string }[], maxTokens?: number, temperature?: number): Promise<string>;
}

export interface ImageGenerationParams {
  mode: 'structured' | 'full-prompt';
  full_prompt?: string;
  expression?: string;
  condition?: string;
  pose?: string;
  view_angle?: string;
  exposure?: string;
  outfit?: string;
  scene?: string;
  ondemandOutfit?: string;
  style?: string;
  triggerWord?: string;
  appearanceBody?: string;
  appearanceFace?: string;
}

export interface VoiceGenerationParams {
  text: string;
  dynamicArgs: {
    style_instruction?: string;
    emotion?: string;
  };
}
