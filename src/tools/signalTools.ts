/**
 * Signal tools — pure data carriers that don't perform IO.
 *
 * These represent the control-flow + scalar fields on the legacy
 * `DispatcherIntent` that the LLM emits but the harness does not
 * "execute" as a side-effect. They're declared as `Tool`s so the
 * schema doc (`buildToolSchemasDoc`) has one entry per capability —
 * see §6.2 of the tech-approach doc ("one source of truth for the
 * schema").
 *
 * In Phase 1 these tools are NOT dispatched by the harness — the
 * harness reads the corresponding fields off the parsed
 * `DispatcherIntent` and folds them into the response shape directly.
 * Their executors are placeholders that document the field-level
 * contract. Phase 2's native tool-calling path will invoke them as
 * real tool calls.
 */

import type { Tool } from "../agent/types.js";
import type { InteractMetadata } from "../types.js";

/**
 * `speak` — the character's spoken line + scene action text. The two
 * fields are tightly coupled (text vs. action separation is enforced
 * by the prompt). Returned as a unit so the harness can build the
 * `InteractMetadata` that `onTextReady` expects.
 */
export interface SpeakResult {
  text: string;
  actionText?: string;
  metadata: InteractMetadata;
}

export const speakTool: Tool<
  { text: string; actionText?: string },
  SpeakResult
> = {
  name: "speak",
  description:
    "Emit the character's spoken dialogue and accompanying scene action text. The harness converts this into the text-ready event and the response's textResponse/actionText fields.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      actionText: { type: "string" },
    },
    required: ["text"],
  },
  async execute(args) {
    // Returns the args back — the loop/harness reads them via
    // toolCallsToIntent and also emits text-ready when dispatching.
    return {
      text: args.text,
      actionText: args.actionText,
      metadata: {} as InteractMetadata,
    };
  },
};

/** Marker result — presence of a `like_picture` call == true. */
export interface LikePictureResult {
  liked: true;
}

export const likePictureTool: Tool<Record<string, never>, LikePictureResult> = {
  name: "like_picture",
  description:
    "Marker that the user explicitly praised/loved/starred the VERY LAST picture the character sent (not general appearance). Presence == true.",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    return { liked: true };
  },
};

/** Marker result — `end_turn` signals the conversation naturally concluded. */
export interface EndTurnResult {
  isEndTurn: true;
}

export const endTurnTool: Tool<Record<string, never>, EndTurnResult> = {
  name: "end_turn",
  description:
    "Marker that the interaction naturally concludes (confirmation/bye, event ending, or clear hard scene shift).",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    return { isEndTurn: true };
  },
};

/** Skip-the-turn signal. */
export interface SkipTurnResult {
  skipped: true;
  reason: string;
}

export const skipTurnTool: Tool<{ reason?: string }, SkipTurnResult> = {
  name: "skip_turn",
  description:
    "Reactive-skip signal. Only emitted when the caller opted in via allowSkip. The character chose NOT to reply (simulating a real human who sometimes goes quiet).",
  inputSchema: {
    type: "object",
    properties: { reason: { type: "string" } },
  },
  async execute(args) {
    return { skipped: true, reason: args.reason || "Character chose not to reply." };
  },
};

/** Skip-the-proactive-outreach signal. */
export interface SkipProactiveResult {
  skipped: true;
  reason: string;
}

export const skipProactiveTool: Tool<
  { reason?: string },
  SkipProactiveResult
> = {
  name: "skip_proactive",
  description:
    "Self-initiated outreach was evaluated and the character chose NOT to reach out. The proactive turn returns { status: 'skipped' }.",
  inputSchema: {
    type: "object",
    properties: { reason: { type: "string" } },
  },
  async execute(args) {
    return { skipped: true, reason: args.reason || "Character chose not to reach out." };
  },
};
