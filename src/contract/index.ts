/**
 * Public SDK contract — Layer A type lock.
 *
 * This barrel re-exports every type and class that is part of the
 * SDK's public surface. The intent (per
 * `cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md`
 * §5.2 Layer A) is to give us ONE place to diff against a snapshot of
 * the published `.d.ts` so accidental renames / signature drift fail
 * CI before they ship.
 *
 * THE RULES:
 *  - Anything re-exported here is public. Adding to this file is a
 *    minor-version change; removing or renaming is a major-version
 *    change.
 *  - Nothing in `src/agent/` or `src/tools/` may be re-exported here
 *    until Phase 3 explicitly promotes them. They are internal.
 *  - `src/index.ts` re-exports from here, not from the implementation
 *    files directly, so future refactors cannot accidentally leak an
 *    internal type through the public barrel.
 *
 * (Phase 1 of the refactor does not yet wire CI to diff this against
 * a snapshot — that's a follow-up. The value today is documentation:
 * the surface below IS the contract.)
 */

// Types — the contract callers branch on.
export type {
  GenericLLMConfig,
  CyberSoulClientConfig,
  HistoryEntry,
  InteractMetadata,
  PersistedDynamicContext,
  MediaReadyPayload,
  OutfitGiftedPayload,
  ProactiveParams,
  ProactiveResponse,
  InteractParams,
  OndemandEventParams,
  OndemandEventResponse,
  WardrobeCategory,
  WardrobeItem,
  InteractResponse,
  InteractMediaError,
  OngoingSceneState,
  DispatcherIntent,
  Appointment,
  CoreMemory,
  UserCodex,
  VoiceArgs,
  CommonVoiceArgs,
  VoiceModelState,
  CharacterState,
  BaseLLMProvider,
  LLMToolDeclaration,
  LLMToolCall,
  LLMChatResult,
  ModelCustomConfigValueType,
  IModelCustomConfigField,
  IVoiceModel,
  SupportedLLMModel,
  ICharacterProfile,
  LikedPicture,
} from "../types.js";

export { InteractRequestType } from "../types.js";
export { supportsToolCalling } from "../types.js";

// Implementation surface that is part of the contract (callers `new` it
// or `instanceof` against it).
export { CyberSoulClient } from "../client.js";
export { GenericLLMProvider } from "../llm.provider.js";
export { CyberSoulApi } from "../api/cyberSoulApi.js";
export type {
  CyberSoulApiConfig,
  GeneratedImage,
  GeneratedVoice,
  DynamicContextPatchPayload,
  OndemandEventPayload,
  SaveMomentPayload,
} from "../api/cyberSoulApi.js";

// Error hierarchy — callers branch on `instanceof CyberSoulError`.
export {
  CyberSoulError,
  CyberSoulNetworkError,
  CyberSoulTimeoutError,
  CyberSoulAuthError,
  CyberSoulInsufficientPointsError,
  CyberSoulWalletError,
  CyberSoulSensitiveContentError,
  CyberSoulApiError,
  CyberSoulLlmError,
  CyberSoulLlmApiError,
  CyberSoulLlmAuthError,
  CyberSoulLlmBadResponseError,
  CyberSoulLlmRateLimitError,
  CyberSoulLlmTemplateError,
  CyberSoulLlmUnavailableError,
} from "../errors.js";

export { VERSION } from "../version.js";
