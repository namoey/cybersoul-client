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
  /**
   * Phase 3.1 — host-application prompt fragment. Forwarded to
   * `buildStateContextPrompt` which prepends it after the compliance
   * directive. Undefined → no injection.
   */
  systemPromptFragment?: string;
  /**
   * When true (default), embed the JSON schema block + the "return
   * valid raw JSON only" instruction in the system prompt. This is
   * what the classic JSON-dispatcher path needs — the LLM is text-
   * then-parsed via robustJsonParse.
   *
   * When false, OMIT the schema entirely. The agent path uses native
   * tool declarations via `toolsPayloadTemplate` instead, and the
   * provider's constrained decoding enforces the response shape (see
   * §3.3.1 of the tech-approach doc). Embedding a duplicate schema
   * would waste tokens AND could conflict with the constrained-
   * decoding mask.
   *
   * Single source of truth: both paths call the SAME
   * `buildInteractSystemPrompt`; only this flag differs.
   */
  embedJsonSchemaHint?: boolean;
}

export interface ProactivePromptInputs {
  state: CharacterState;
  availableOutfits: string;
  imageAllowed: boolean;
  /**
   * Phase 3.1 — host-application prompt fragment. Same contract as
   * `InteractPromptInputs.systemPromptFragment`.
   */
  systemPromptFragment?: string;
  /**
   * Same contract as `InteractPromptInputs.embedJsonSchemaHint` —
   * see there. Defaults to true (classic path).
   */
  embedJsonSchemaHint?: boolean;
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
