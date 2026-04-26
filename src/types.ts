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

export enum InteractRequestType {
  AUTO = 'auto',
  TEXT = 'text',
  IMAGE = 'image',
  VOICE = 'voice',
}

export interface InteractParams {
  userMessage: string;
  localContext?: string;
  requestTypes?: InteractRequestType[];
  history?: { role: string; content: string }[];
  onTextReady?: (textResponse: string) => void;
}

export interface OndemandEventParams {
  eventDescription: string;
  durationMins?: number;
  interactParams?: InteractParams;
}

export interface OndemandEventResponse {
  status: 'success' | 'error';
  acceptEvent?: boolean;
  reason?: string;
  requiresOutfitChange?: boolean;
  selectedOutfitId?: string;
  error?: string;
}

export interface WardrobeItem {
  id: string;
  itemName: string;
  category: string;
  promptModifier: string;
}

export interface InteractResponse {
  status: 'success' | 'error';
  textResponse: string;
  imageUrl?: string;
  audioUrl?: string;
  durationSec?: number;
  triggeredEvent?: {
    eventDescription: string;
    durationMins?: number;
    outfitId?: string | null;
  };
  error?: string;
}

export interface DispatcherIntent {
  textResponse?: string;
  imageParams?: any;
  voiceArgs?: VoiceArgs | null;
  stateUpdate?: {
    temperatureDelta?: string | number;
    userNickname?: string;
    agentNickname?: string;
    talkingStyle?: string;
  };
  triggerEvent?: {
    eventDescription: string;
    durationMins?: number;
    outfitId?: string | null;
  } | null;
}

export interface CoreMemory {
  relationshipStatus: string;
  identityAnchors: string[];
  activeArcs: string[];
  keyEvents: string[];
  appointments: string[];
}

/**
 * Generic dynamic voice args returned by the LLM and forwarded to backend TTS.
 *
 * - T lets callers/project code narrow this to model-specific fields when needed.
 * - Defaults to fully dynamic key/value pairs for provider-agnostic SDK behavior.
 */
export type VoiceArgs<
  T extends Record<string, unknown> = Record<string, unknown>,
> = T;

/**
 * Optional compatibility shape for currently common fields.
 * Not used as the SDK contract to avoid coupling to specific providers.
 */
export interface CommonVoiceArgs {
  style_instruction?: string;
  emotion?: string;
}

export interface VoiceModelState {
  tts_provider?: string;
  dynamic_param_prompt_template?: string;
  dynamic_params?: Array<{
    name: string;
    description: string;
    type: string;
    required: boolean;
    default?: unknown;
  }>;
}

export interface CharacterState {
  current_time: string;
  active_event?: any;
  next_event?: any;
  active_wardrobe?: any;
  core_memory?: CoreMemory;
  dynamic_context?: any;
  voice_model?: VoiceModelState | null;
  relationship_stage?: string;
  name?: string;
  age?: number;
  gender?: string;
  occupation?: string;
  hobby?: string;
  personality_traits?: string;
  interaction_boundaries?: string;
  communication_style?: string;
}

export interface BaseLLMProvider {
  generate(messages: { role: string; content: string }[], maxTokens?: number, temperature?: number): Promise<string>;
}
