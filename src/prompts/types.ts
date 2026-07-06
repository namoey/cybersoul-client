import {
  CharacterState,
  CoreMemory,
  HistoryEntry,
  InteractRequestType,
  UserCodex,
} from "../types.js";

/**
 * Input shapes for the prompt assemblers in [promptBuilders].
 *
 * Kept in a dedicated module so [promptBuilders] can stay focused on
 * template assembly without the visual noise of type declarations,
 * and so callers can import the input types without pulling the whole
 * prompt-construction surface.
 */

export interface InteractPromptInputs {
  state: CharacterState;
  availableOutfits: string;
  types: InteractRequestType[];
  isAuto: boolean;
  requestedOthers: InteractRequestType[];
  /**
   * When true, the interact prompt offers the character the option to
   * SKIP replying (mirrors proactive's `shouldSkipProactive`). The LLM
   * decides based on personality, context, and relationship state.
   */
  allowSkip?: boolean;
}

export interface ProactivePromptInputs {
  state: CharacterState;
  availableOutfits: string;
  imageAllowed: boolean;
}

export interface OndemandEventPromptInputs {
  state: CharacterState;
  availableOutfits: string;
  /** Free-form description of the proposed event. */
  eventDescription: string;
  /**
   * Optional chat context carried over from an in-progress interact
   * turn (history + last user message). When absent, the proposal is
   * treated as standalone.
   */
  interactParams?: {
    history?: HistoryEntry[];
    localContext?: string;
    userMessage?: string;
  };
}

export interface SummarizerIdentity {
  /** Authoritative character name (falls back to agent nickname). */
  charName: string;
  /** Human user display name (falls back to "User"). */
  userName: string;
  /**
   * The nickname the user actually calls the character by in chat —
   * used as the transcript line label so the LLM can match spoken
   * lines back to the right party. May differ from `charName`.
   */
  transcriptAgentLabel: string;
  /** The nickname the character calls the user by in chat. */
  transcriptUserLabel: string;
}

export interface ConsolidationPromptInputs {
  /** Localized current timestamp string for appointment expiry evaluation. */
  currentTime: string;
  /** Existing core memory (pre-merge). */
  currentMemory: CoreMemory;
  /** Existing user codex (pre-merge). */
  currentUserCodex: UserCodex;
  /** New daily events / information text to fold in. */
  events: string;
}

export interface StandaloneImagePromptInputs {
  state: CharacterState;
  sceneDescription: string;
  transcript: string;
}

export interface StandaloneVoicePromptInputs {
  state: CharacterState;
  text: string;
  transcript: string;
}
