/**
 * Tools barrel.
 *
 * Re-exports every tool builder + the registry. Tools are INTERNAL —
 * not re-exported through `src/contract/` and not part of the SDK's
 * locked public surface (see §5.2 Layer A). Phase 3 may promote them.
 */

export { ToolRegistry } from "./toolRegistry.js";

export {
  buildGenerateImageTool,
  buildGenerateVoiceTool,
} from "./mediaTools.js";
export type {
  GenerateImageResult,
  GenerateVoiceResult,
} from "./mediaTools.js";

export {
  buildUpdateStateTool,
  buildStatePatchPayload,
} from "./stateTools.js";
export type { UpdateStateResult } from "./stateTools.js";

export { buildGiftOutfitTool } from "./wardrobeTools.js";
export type { GiftOutfitResult } from "./wardrobeTools.js";

export { buildTriggerEventTool } from "./eventTools.js";
export type { TriggerEventResult } from "./eventTools.js";

export {
  buildRecallChatHistoryTool,
  formatRecallTranscript,
  buildRecallChatHistoryDescription,
  RECALL_CHAT_HISTORY_DESCRIPTION_PREAMBLE,
  DEFAULT_MAX_HITS,
  DEFAULT_MAX_TRANSCRIPT_CHARS,
} from "./recallChatHistoryTool.js";
export type {
  RecallChatHistoryArgs,
  RecallChatHistoryHit,
  RecallChatHistoryResult,
  ChatHistorySearcher,
} from "./recallChatHistoryTool.js";

export {
  speakTool,
  likePictureTool,
  endTurnTool,
  skipTurnTool,
  skipProactiveTool,
} from "./signalTools.js";
export type {
  SpeakResult,
  LikePictureResult,
  EndTurnResult,
  SkipTurnResult,
  SkipProactiveResult,
} from "./signalTools.js";

export { toolCallsToIntent } from "./toolCallsToIntent.js";

export {
  extractIntentFromRawText,
  mergeRawTextIntoIntent,
} from "./extractIntentFromRawText.js";
