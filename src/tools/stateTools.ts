/**
 * State tools — relationship-temperature + scene mutation, plus the
 * user-analysis payload that rides along on the same PATCH.
 *
 * Phase 1 extraction (see
 * `cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md`
 * §3.1). The executor logic is lifted verbatim from
 * `CyberSoulClient._updateDynamicContextInternal` — the same
 * dispatcher-intent → backend-payload translation
 * (`temperatureDelta` → `temperature`, ongoing-scene normalization),
 * the same null-on-nothing-to-send / null-on-failure semantics.
 *
 * Server-authoritative snapshot rule (§7): the result returned here is
 * the ONLY authoritative temperature/stage; the harness never
 * recomputes the delta locally. Generalized in Phase 2 to "no tool
 * result is authoritative until the backend has confirmed it."
 */

import type { Tool, AgentEventSink } from "../agent/types.js";
import type {
  PersistedDynamicContext,
  DispatcherIntent,
  OngoingSceneState,
} from "../types.js";
import { normalizeOngoingSceneState } from "../utils/state.utils.js";

/**
 * Build the PATCH payload exactly as the legacy
 * `_updateDynamicContextInternal` did: spread `stateUpdate`, rename
 * `temperatureDelta` → `temperature`, normalize `ongoingScene`.
 *
 * Kept as a standalone helper so it can be unit-tested without
 * standing up a tool.
 */
export function buildStatePatchPayload(
  stateUpdate: DispatcherIntent["stateUpdate"],
  userAnalysis?: DispatcherIntent["userAnalysis"],
): Record<string, unknown> | null {
  if (!stateUpdate && !userAnalysis) return null;

  const payload: any = { ...stateUpdate };
  if (userAnalysis) {
    payload.userAnalysis = userAnalysis;
  }
  if (payload.temperatureDelta !== undefined) {
    payload.temperature = payload.temperatureDelta;
    delete payload.temperatureDelta;
  }

  if (payload.ongoingScene !== undefined) {
    const normalizedOngoingScene: OngoingSceneState | undefined =
      normalizeOngoingSceneState(payload.ongoingScene);
    payload.ongoingScene = normalizedOngoingScene || null;
  }

  return payload;
}

export interface UpdateStateResult {
  /** Server-authoritative snapshot, or null when nothing was sent / the call failed. */
  persisted: PersistedDynamicContext | null;
}

/**
 * Build the `update_state` tool. Wraps the legacy
 * `_updateDynamicContextInternal` behavior byte-for-byte.
 *
 * Note: unlike the media tools, this tool does NOT take an EventSink
 * for `state-ready`. The harness emits that event itself because the
 * legacy code wired `onStateReady` to the in-flight promise with
 * special "fire `{}` even on failure" semantics (§5.4 item 2) — that
 * orchestration belongs in the harness, not the tool.
 */
export function buildUpdateStateTool(): Tool<
  {
    stateUpdate?: DispatcherIntent["stateUpdate"];
    userAnalysis?: DispatcherIntent["userAnalysis"];
  },
  UpdateStateResult
> {
  return {
    name: "update_state",
    description:
      "PATCH the character's dynamic context (relationship temperature, scene, nicknames, user analysis). Returns the server-authoritative post-write snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        stateUpdate: {
          type: "object",
          properties: {
            temperatureDelta: { type: ["string", "number"] },
            userNickname: { type: "string" },
            agentNickname: { type: "string" },
            talkingStyle: { type: "string" },
            ongoingScene: {
              type: ["object", "string", "null"],
              properties: {
                scene: { type: "string" },
                outfit: { type: "string" },
              },
            },
          },
        },
        userAnalysis: {
          type: "object",
          properties: {
            newFactsLearned: { type: "array" },
          },
        },
      },
    },
    async execute(args, ctx) {
      const payload = buildStatePatchPayload(
        args.stateUpdate,
        args.userAnalysis,
      );
      if (!payload) {
        return { persisted: null };
      }
      // Legacy behavior: failure is non-fatal for the chat turn, surface null.
      try {
        const persisted = await ctx.api.patchDynamicContext(payload);
        return { persisted };
      } catch (e) {
        return { persisted: null };
      }
    },
  };
}
