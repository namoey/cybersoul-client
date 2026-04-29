export interface LLMConfig {
  provider: "minimax";
  apiKey: string;
  model: string;
}

export interface CyberSoulClientConfig {
  characterKey: string;
  backendUrl: string;
  llmConfig: LLMConfig;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

export enum InteractRequestType {
  AUTO = "auto",
  TEXT = "text",
  IMAGE = "image",
  VOICE = "voice",
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
  status: "success" | "error";
  acceptEvent?: boolean;
  reason?: string;
  requiresOutfitChange?: boolean;
  selectedOutfitId?: string;
  scheduledStartTimeStr?: string;
  scheduledDateStr?: string;
  error?: string;
}

export interface WardrobeItem {
  id: string;
  itemName: string;
  category: string;
  promptModifier: string;
}

export interface InteractResponse {
  status: "success" | "error";
  textResponse: string;
  actionText?: string;
  imageUrl?: string;
  audioUrl?: string;
  durationSec?: number;
  triggeredEvent?: {
    eventTitle?: string;
    eventDescription: string;
    durationMins?: number;
    outfitId?: string | null;
  };
  stateUpdate?: DispatcherIntent["stateUpdate"];
  userAnalysis?: DispatcherIntent["userAnalysis"];
  error?: string;
}

export interface DispatcherIntent {
  textResponse?: string;
  actionText?: string;
  imageParams?: any;
  voiceArgs?: VoiceArgs | null;
  userAnalysis?: {
    newFactsLearned: {
      category:
        | "nickname"
        | "occupation"
        | "age"
        | "gender"
        | "hobby"
        | "trait"
        | "communicationStyle"
        | "boundary";
      value: string;
    }[];
  };
  stateUpdate?: {
    temperatureDelta?: string | number;
    userNickname?: string;
    agentNickname?: string;
    talkingStyle?: string;
  };
  triggerEvent?: {
    eventTitle?: string;
    eventDescription: string;
    durationMins?: number;
    outfitId?: string | null;
    scheduledStartTimeStr?: string | null;
    scheduledDateStr?: string | null;
  } | null;
}

export interface Appointment {
  date: string;
  time: string;
  title: string;
  context: string;
  withWhom: string;
}

export interface CoreMemory {
  relationshipStatus: string;
  identityAnchors: string[];
  activeArcs: string[];
  keyEvents: string[];
  appointments: Appointment[];
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
  user_codex?: any;
}

export interface BaseLLMProvider {
  generate(
    messages: { role: string; content: string }[],
    maxTokens?: number,
    temperature?: number,
  ): Promise<string>;
}

export type ModelCustomConfigValueType =
  | "string"
  | "stringArray"
  | "number"
  | "integer"
  | "boolean"
  | "enum";

export interface IModelCustomConfigField {
  key: string;
  label: string;
  valueType: ModelCustomConfigValueType;
  customerFacing?: boolean;
  isFile?: boolean;
  description?: string;
  required?: boolean;
  defaultValue?: string | number | boolean | string[];
  minItems?: number;
  maxItems?: number;
  min?: number;
  max?: number;
  step?: number;
  enumOptions?: string[];
  options?: string[];
}

export interface IVoiceModel {
  id: string;
  name: string;
  ttsProvider: string;
  voiceConfigPayload: Record<string, unknown>;
  dynamicParamPromptTemplate: string;
  dynamicParams: Array<{
    name: string;
    description: string;
    type: string;
    required: boolean;
    default?: unknown;
  }>;
  voiceOptions: Array<{
    id: string;
    name: string;
    description?: string;
    configPatch: Record<string, unknown>;
    dynamicParamPromptTemplate?: string;
    sampleUrl?: string;
  }>;
  voiceCustomConfigDefinition?: IModelCustomConfigField[];
  isPublic: boolean;
  pointsPerGeneration: number;
}

export interface ICharacterProfile {
  id: string;
  name: string;
  voiceModelId?: string;
  voiceModelOptionId?: string;
  voiceCustomConfig?: Record<string, Record<string, unknown>>;
  visualModelId?: string;
  visualCustomConfig?: Record<string, Record<string, unknown>>;
  [key: string]: unknown; // Allow other properties to exist without breaking SDK clients that don't need them fully defined
}
