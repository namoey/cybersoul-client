/**
 * AgentHarness — the degenerate single-shot loop body for Phase 1.
 *
 * Phase 1 target (see
 * `cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md`
 * §3.2). Encapsulates the generic mechanics that today are inlined in
 * `client.ts`'s `interact()` / `proactiveInteract()`:
 *
 *   1. dispatcher LLM call with bounded retry on non-actionable output
 *   2. parallel side-effect dispatch (state PATCH + media + event + gift)
 *   3. event emission via EventStream (text-ready / state-ready /
 *      media-ready / outfit-gifted) with EXACTLY the same timing and
 *      args the legacy code used
 *
 * What stays in `client.ts`:
 *   - prompt assembly (builds the {system,user} message pair per flow)
 *   - per-flow gating (skip checks, allowSkip, assert-actionable,
 *     proactive spam guard)
 *   - response-shape assembly (InteractResponse / ProactiveResponse)
 *
 * This split keeps the public response types in `client.ts` (where
 * callers expect them) while pulling the loop mechanics out into a
 * unit-testable seam. Phase 2 swaps the dispatcher for native tool-
 * calling without touching client.ts's response shaping.
 *
 * CRITICAL — Phase 1 zero-diff guarantee (§5.3):
 *   - The harness's `runInteractDispatch` reproduces
 *     `dispatchInteractWithRetry` byte-for-byte: same 3-attempt cap,
 *     same "hasUsableText || hasMediaIntent || hasSkipIntent" break
 *     condition, same fallback to raw text on parse error, same warn
 *     log format.
 *   - `runInteractSideEffects` reproduces `runInteractMediaTasks` byte-
 *     for-byte: same task list ordering (triggerEvent, giftOutfit,
 *     image, voice), same per-task `.catch` semantics, same
 *     `firstMediaError` / `affected` capture, same Promise.all.
 *   - The `state-ready` event fires via the legacy
 *     `startInteractStateUpdate` pattern: `onStateReady` is wired to
 *     the in-flight PATCH promise with the "fire `{}` even on failure"
 *     behavior from §5.4 item 2.
 */

import type {
  BaseLLMProvider,
  DispatcherIntent,
  InteractParams,
  OutfitGiftedPayload,
  PersistedDynamicContext,
  ProactiveParams,
} from "../types.js";
import { InteractRequestType, supportsToolCalling, supportsStreaming } from "../types.js";
import type { ToolContext, ToolFailure, AgentLoopConfig, AgentLoopTerminationReason } from "./types.js";
import type { EventStream } from "./eventStream.js";
import {
  buildGenerateImageTool,
  buildGenerateVoiceTool,
  buildGiftOutfitTool,
  buildTriggerEventTool,
  buildUpdateStateTool,
  toolCallsToIntent,
} from "../tools/index.js";
import type {
  GenerateImageResult,
  GenerateVoiceResult,
  GiftOutfitResult,
  TriggerEventResult,
  UpdateStateResult,
} from "../tools/index.js";
import { robustJsonParse } from "../utils/json.utils.js";
import { sanitizeTextForVoice } from "../utils/voice.utils.js";
import {
  CyberSoulError,
  CyberSoulInsufficientPointsError,
  CyberSoulSensitiveContentError,
  CyberSoulWalletError,
} from "../errors.js";

/** Bounded retry cap for the dispatcher (§5.4 item 9 — must stay 3). */
const MAX_DISPATCH_ATTEMPTS = 3;

/**
 * Result of the dispatcher phase. Mirrors what
 * `dispatchInteractWithRetry` returned.
 */
export interface DispatchResult {
  parsedIntent: DispatcherIntent;
  /**
   * Phase 3.3.1 — when the multi-step loop ran and dispatched media
   * tools (generate_image, generate_voice) inline, this lists which
   * side-effect tools were ALREADY executed so the client can skip
   * re-running them in `runInteractSideEffects`. Prevents double
   * generation.
   *
   * Empty set for single-shot paths (classic JSON-dispatcher, single-
   * shot tool-calling) — those paths need the side-effect layer to
   * run all media.
   */
  loopDispatchedTools?: Set<string>;
}

/**
 * Result of the side-effect phase. Mirrors what
 * `runInteractMediaTasks` returned (with the `triggered` field added
 * — the legacy code dropped the trigger-event success on the floor;
 * we preserve that by leaving it unused in client.ts, but tracking it
 * here makes Phase 2 observability trivial).
 */
export interface InteractSideEffectResult {
  imageUrl?: string;
  imageMediaId?: string;
  audioUrl?: string;
  audioMediaId?: string;
  durationSec?: number;
  giftedOutfit?: OutfitGiftedPayload;
  triggeredEvent?: NonNullable<DispatcherIntent["triggerEvent"]>;
  firstMediaError: CyberSoulError | null;
  affected: Array<"image" | "voice">;
}

export class AgentHarness {
  constructor(
    private readonly llm: BaseLLMProvider,
    private readonly sink: EventStream,
  ) {}

  /* ============================================================ */
  /* Phase 1 — dispatcher (single-shot JSON, with retry)          */
  /* ============================================================ */

  /**
   * Reproduce `dispatchInteractWithRetry` byte-for-byte.
   *
   * A "non-actionable" parse yields no usable `textResponse` AND no
   * media intent AND no skip intent — i.e. the LLM hiccuped. Retrying
   * the generation is far better than silently echoing the user's
   * own message back as the character's reply.
   */
  async runInteractDispatch(
    promptMessages: Array<{ role: string; content: string }>,
  ): Promise<DispatchResult> {
    let parsedIntent: DispatcherIntent = { textResponse: "" };
    for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) {
      const rawLlmResponse = await this.llm.generate(promptMessages, 15000, 0.7);

      try {
        parsedIntent = robustJsonParse<DispatcherIntent>(
          rawLlmResponse,
          "Dispatcher fallback",
          { textResponse: "", actionText: "", isEndTurn: false },
        );
      } catch (e) {
        console.warn(
          "[CyberSoulClient] JSON parse failed, falling back to raw text:",
          e,
        );
        parsedIntent = {
          textResponse: rawLlmResponse.replace(/^[\`\s]+|[\`\s]+$/g, "").trim(),
        };
      }

      const hasUsableText =
        typeof parsedIntent.textResponse === "string" &&
        parsedIntent.textResponse.trim().length > 0;
      const hasMediaIntent =
        !!parsedIntent.imageParams || !!parsedIntent.voiceArgs;
      const hasSkipIntent = parsedIntent.shouldSkipInteract === true;
      if (hasUsableText || hasMediaIntent || hasSkipIntent) {
        break;
      }
      console.warn(
        `[CyberSoulClient] interact produced a non-actionable intent (attempt ${attempt}/${MAX_DISPATCH_ATTEMPTS}); ${
          attempt < MAX_DISPATCH_ATTEMPTS ? "retrying" : "giving up"
        }.`,
      );
    }
    return { parsedIntent };
  }

  /* ============================================================ */
  /* Phase 2 — native tool-calling dispatch path                  */
  /* ============================================================ */

  /**
   * Throw a typed `CyberSoulError` (kind `"llm-capability-mismatch"`)
   * if the configured LLM provider doesn't implement `chat()`.
   *
   * Called at the top of both tool-calling dispatch methods so a
   * capability mismatch surfaces as an actionable, typed error
   * instead of a confusing `TypeError: this.llm.chat is not a
   * function` from the non-null assertion at the call site. The
   * error is a `CyberSoulError` (not a plain `Error`) so `client.ts`'s
   * outer catch re-throws it instead of wrapping it in the legacy
   * `{ status: "error" }` envelope — callers can branch on
   * `instanceof CyberSoulError` + `err.kind`.
   *
   * The error message is intentionally prescriptive — it tells the
   * operator exactly which knob to turn (unset
   * `capabilities.toolCalling` to fall back to the JSON-dispatcher).
   * This is the Scenario-D fix from the Phase 2.1 design review.
   */
  private assertToolCallingSupported(): void {
    if (!supportsToolCalling(this.llm)) {
      throw new CyberSoulError(
        "llm-capability-mismatch",
        "Tool-calling dispatch path selected (llmConfig.capabilities.toolCalling === true) but the LLM provider does not implement chat(). Either implement chat() on the provider, or unset capabilities.toolCalling to fall back to the JSON-dispatcher path.",
      );
    }
  }

  /**
   * Phase 3.1c — wrap a tool execution with `tool-call` + `tool-result`
   * events so `CyberSoulAgent` consumers see each side-effect fire on
   * the AsyncIterable surface. The events are emitted BEFORE the
   * executor starts and AFTER it settles, regardless of success or
   * failure — consumers always see the closing `tool-result`.
   *
   * Result shape:
   *   - Success → `{ type: "tool-result", tool, result: <TResult> }`
   *   - Failure → `{ type: "tool-result", tool, result: { __error: ... } }`
   *
   * The error is re-thrown after emission so the harness's existing
   * typed-error-capture logic (`captureMediaError` etc.) still runs.
   * Events are an OBSERVATION channel — they do not change the
   * control flow of the side-effect layer.
   *
   * For backward compatibility with `client.ts` callers using the
   * legacy EventStream, the EventStream treats `tool-call` /
   * `tool-result` as no-op (no legacy callback to fan out to) — only
   * `CyberSoulAgent` consumers actually see them via the
   * AsyncEventQueue.
   */
  private async withToolEvents<T>(
    toolName: string,
    args: Record<string, unknown>,
    exec: () => Promise<T>,
  ): Promise<T> {
    this.sink.emit({ type: "tool-call", tool: toolName, args });
    try {
      const result = await exec();
      this.sink.emit({ type: "tool-result", tool: toolName, result });
      return result;
    } catch (e) {
      this.sink.emit({
        type: "tool-result",
        tool: toolName,
        result: {
          __error: e instanceof Error ? e.message : String(e),
          __kind: e instanceof CyberSoulError ? e.kind : undefined,
        },
      });
      throw e;
    }
  }

  /**
   * Phase 2 native tool-calling dispatcher (see
   * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
   * §3.3.1 + §4 Phase 2). Replaces the JSON-schema-in-prompt +
   * robustJsonParse + retry loop with a single `provider.chat()` call
   * that passes the tool declarations natively.
   *
   * Why no retry loop? With constrained decoding (§3.3.1), the
   * provider guarantees the returned `tool_calls[i].arguments` is
   * valid JSON conforming to the declared schema. The malformed-JSON
   * failure class that `dispatchInteractWithRetry` exists to handle
   * is structurally impossible here.
   *
   * Returns the SAME `DispatchResult` shape as `runInteractDispatch`
   * — `toolCallsToIntent` folds the structured tool calls into a
   * `DispatcherIntent`, so every downstream consumer
   * (`runInteractSideEffects`, `startInteractStateUpdate`,
   * `client.ts` response assembly) is byte-for-byte identical between
   * the two paths. This is what makes the Phase 2 swap a single
   * routing decision in client.ts.
   *
   * Capability contract: this method checks `supportsToolCalling(
   * this.llm)` at the top and throws a typed `CyberSoulError` (kind
   * `"llm-capability-mismatch"`) with actionable guidance if the
   * provider doesn't implement `chat()`. The harness deliberately
   * does NOT silently degrade to the JSON-dispatcher here — that
   * would hide a misconfiguration where the caller opted into
   * tool-calling (`capabilities.toolCalling === true`) but is using
   * a provider that doesn't support it.
   *
   * @param promptMessages Same {system, user} pair as
   *   `runInteractDispatch`. NOTE: the system prompt passed here
   *   SHOULD NOT embed the JSON schema — the prompt-builder variant
   *   for the tool-calling path is a separate concern (Phase 1.5 /
   *   Phase 2 follow-up). For Phase 2 as shipped, the same prompt is
   *   used and the model receives both the embedded schema AND the
   *   native tool declarations; the native declarations win because
   *   the provider's constrained-decoding mask takes priority over
   *   prose instructions. This is acceptable for the shadow-mode
   *   rollout (§5.5) and a follow-up cleans up the prompt.
   * @param toolDeclarations The `LLMToolDeclaration[]` built from the
   *   ToolRegistry.
   */
  async runInteractDispatchWithTools(
    promptMessages: Array<{ role: string; content: string }>,
    toolDeclarations: import("../types.js").LLMToolDeclaration[],
  ): Promise<DispatchResult> {
    this.assertToolCallingSupported();
    const result = await this.llm.chat!({
      messages: promptMessages,
      tools: toolDeclarations,
      maxTokens: 15000,
      temperature: 0.7,
    });

    // Fold the structured tool calls into the same DispatcherIntent
    // shape the JSON-dispatcher path produces. Downstream is identical.
    const parsedIntent = toolCallsToIntent(result.toolCalls);

    // The model may emit text alongside tool calls (or as a pure-text
    // reply with no tool calls). Preserve either — BUT prefer the
    // `speak` tool's `text` arg when present: for tool-calling models
    // (e.g. DeepSeek reasoner/thinking mode) the raw `content` field can
    // hold reasoning/preamble while the actual dialogue lives in the
    // speak tool call. Only fall back to raw content when no speak text
    // was provided, otherwise that reasoning leaks into notifications.
    const speakText = parsedIntent.textResponse?.trim() ?? "";
    if (
      typeof result.textResponse === "string" &&
      result.textResponse.trim().length > 0 &&
      speakText.length === 0
    ) {
      parsedIntent.textResponse = result.textResponse;
    }

    return { parsedIntent };
  }

  /**
   * Phase 2 native tool-calling proactive dispatcher. Mirrors
   * `runProactiveDispatch`'s return shape so the proactive gating in
   * client.ts stays untouched.
   *
   * Same capability contract as `runInteractDispatchWithTools`:
   * throws `CyberSoulError` (kind `"llm-capability-mismatch"`) if the
   * provider doesn't implement `chat()`.
   */
  async runProactiveDispatchWithTools(
    promptMessages: Array<{ role: string; content: string }>,
    toolDeclarations: import("../types.js").LLMToolDeclaration[],
  ): Promise<
    | { kind: "skip"; reason: string }
    | { kind: "proceed"; intent: DispatcherIntent }
  > {
    this.assertToolCallingSupported();
    const result = await this.llm.chat!({
      messages: promptMessages,
      tools: toolDeclarations,
      maxTokens: 800,
      temperature: 0.5,
    });

    let parsedIntent = toolCallsToIntent(result.toolCalls);

    // Defensive fallback: if the LLM returned NO tool calls but DID
    // return text that looks like JSON (happens when the model ignores
    // the tool declarations and outputs JSON directly), try to parse
    // it as a classic JSON intent. This prevents raw JSON from leaking
    // into the chat as a proactive message.
    if (
      result.toolCalls.length === 0 &&
      typeof result.textResponse === "string" &&
      result.textResponse.trim().startsWith("{")
    ) {
      try {
        const jsonIntent = JSON.parse(result.textResponse);
        if (jsonIntent && typeof jsonIntent === "object") {
          parsedIntent = {
            ...parsedIntent,
            ...jsonIntent,
          };
          // Clear the textResponse so the raw JSON doesn't leak —
          // it will be re-read from the parsed intent below.
          parsedIntent.textResponse = jsonIntent.textResponse || "";
        }
      } catch {
        // Not valid JSON — leave parsedIntent as-is (empty textResponse
        // → treated as implicit skip below).
      }
    } else if (
      typeof result.textResponse === "string" &&
      result.textResponse.trim().length > 0 &&
      (parsedIntent.textResponse?.trim() ?? "").length === 0
    ) {
      // Prefer the `speak` tool's `text` arg over raw `content` (which
      // may be reasoning/preamble for thinking-mode models). See note in
      // runInteractDispatchWithTools above.
      parsedIntent.textResponse = result.textResponse;
    }

    if (parsedIntent.shouldSkipProactive) {
      return {
        kind: "skip",
        reason: parsedIntent.skipReason || "Character chose not to reach out.",
      };
    }

    if (
      typeof parsedIntent.textResponse !== "string" ||
      parsedIntent.textResponse.trim().length === 0
    ) {
      return {
        kind: "skip",
        reason: "LLM produced no textResponse (treated as implicit skip).",
      };
    }

    return { kind: "proceed", intent: parsedIntent };
  }

  /* ============================================================ */
  /* Phase 3.3 — multi-step agent dispatch loop                   */
  /* ============================================================ */

  /**
   * Phase 3.3 — multi-step agent dispatch loop (see
   * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
   * Phase 3.3). Iterates: call `provider.chat()` → dispatch any tool
   * calls via the registry → append tool-result messages → repeat.
   * Terminates when the LLM emits no further tool calls, OR when a
   * cap (max iterations / max tokens) is hit.
   *
   * Returns the SAME `DispatchResult` shape as the single-shot
   * dispatchers — `toolCallsToIntent` folds ALL accumulated tool
   * calls across iterations into one `DispatcherIntent`. Downstream
   * (`runInteractSideEffects`, `client.ts` response assembly) is
   * identical between single-shot and multi-step paths.
   *
   * Tool dispatch reuses the existing `withToolEvents` helper, so
   * `tool-call` / `tool-result` events fire for EVERY tool call
   * across every iteration — `CyberSoulAgent` consumers see the full
   * trajectory.
   *
   * SAFETY RAILS (cannot be disabled):
   *   - `maxIterations` (default 5): hard stop on iteration count.
   *   - `maxTotalTokensEstimate` (default 50000): best-effort cost
   *     guard using the 4-chars-≈-1-token heuristic.
   *
   * When a cap fires, the loop terminates with whatever intent has
   * been accumulated. A warning is logged; the `onError` hook fires
   * with kind `agent-loop-cap-hit` so telemetry can track it.
   *
   * Capability contract: same as `runInteractDispatchWithTools` —
   * pre-check `supportsToolCalling(this.llm)`.
   *
   * @param promptMessages Initial {system, user} pair.
   * @param toolDeclarations Tools the LLM may call.
   * @param toolRegistry Resolves tool names → executors. Tools not in
   *   the registry are skipped (their result is an error JSON).
   * @param toolCtx Context passed to every tool executor.
   * @param loopOpts Loop config. Undefined → loop OFF (use
   *   `runInteractDispatchWithTools` instead). The caller chooses.
   */
  async runInteractDispatchLoop(
    promptMessages: Array<{ role: string; content: string }>,
    toolDeclarations: import("../types.js").LLMToolDeclaration[],
    toolRegistry: import("../tools/toolRegistry.js").ToolRegistry,
    toolCtx: ToolContext,
    loopOpts: AgentLoopConfig,
  ): Promise<DispatchResult> {
    this.assertToolCallingSupported();

    const maxIterations = loopOpts.maxIterations ?? 5;
    const maxTokens = loopOpts.maxTotalTokensEstimate ?? 50000;

    // Mutable conversation history — we append assistant tool-call
    // echoes + tool-result messages as the loop progresses. Start
    // from the initial prompt pair.
    const conversation: Array<
      import("../types.js").LLMConversationMessage |
      import("../types.js").LLMPlainMessage
    > = [...promptMessages];

    // Accumulate tool calls across iterations — the final
    // DispatcherIntent folds them all (e.g. iteration 1 calls
    // get_state, iteration 2 calls generate_image based on the state).
    const allToolCalls: import("../types.js").LLMToolCall[] = [];
    let finalTextResponse = "";
    // Track which side-effect tools the loop already executed so the
    // client can skip re-running them.
    const loopDispatchedTools = new Set<string>();
    // Track whether text-ready has been emitted so a second speak
    // call (in a subsequent iteration) doesn't create a duplicate
    // text bubble. The first speak emits text-ready; subsequent
    // speak calls only update the folded intent's textResponse.
    let textReadyEmitted = false;
    let totalChars = conversation.reduce(
      (sum, m) => sum + (m.content?.length ?? 0),
      0,
    );

    let termination: AgentLoopTerminationReason = "no-tool-calls";

    for (let iter = 1; iter <= maxIterations; iter++) {
      // Cost guard — check BEFORE the LLM call so we don't blow the
      // budget on the iteration that would exceed it.
      const estimatedTokens = Math.ceil(totalChars / 4);
      if (estimatedTokens > maxTokens) {
        termination = "max-tokens";
        console.warn(
          `[CyberSoulClient] Agent loop terminated: token estimate ${estimatedTokens} exceeds cap ${maxTokens} (iteration ${iter}/${maxIterations}).`,
        );
        break;
      }

      const result = await this.llm.chat!({
        messages: conversation,
        tools: toolDeclarations,
        maxTokens: 15000,
        temperature: 0.7,
      });

      if (
        typeof result.textResponse === "string" &&
        result.textResponse.trim().length > 0
      ) {
        finalTextResponse = result.textResponse;
      }

      // No tool calls = natural completion. Model produced a final reply.
      if (!result.toolCalls || result.toolCalls.length === 0) {
        termination = "no-tool-calls";
        break;
      }

      // The loop runs until the LLM stops calling tools (natural
      // completion above) or hits a safety cap (below). We do NOT
      // break early after speak — the LLM is free to call speak,
      // then generate_image, then update_state across multiple
      // iterations, finishing only when it has nothing left to do.
      // The textReadyEmitted guard prevents duplicate text bubbles
      // from a second speak call.

      // Dispatch tools for THIS iteration (below). Set termination if
      // speak was called so we break after dispatching.
      // (The dispatch code follows — we can't break before it because
      // we still need to execute update_state, generate_image, etc.
      // that arrived alongside speak in the same response.)

      // Echo the assistant's tool-call turn back into the conversation.
      // OpenAI/DeepSeek REQUIRE the assistant message to carry the
      // actual tool_calls array (not a text summary) so the provider
      // can correlate each subsequent tool-result message to its
      // originating call via tool_call_id.
      //
      // CRITICAL for DeepSeek thinking mode: reasoning_content MUST be
      // passed back on the assistant message when tool_calls are
      // present. Without it, DeepSeek returns 400 "The reasoning_content
      // in the thinking mode must be passed back to the API."
      conversation.push({
        role: "assistant",
        content: finalTextResponse || "",
        reasoning_content: result.reasoningContent || undefined,
        // Attach the raw tool_calls in OpenAI format so the provider
        // can match them with the tool-result messages below.
        tool_calls: result.toolCalls.map((c, idx) => ({
          id: c.id || `call_${idx}_${Date.now()}`,
          type: "function",
          function: {
            name: c.name,
            arguments: c.arguments || "{}",
          },
        })),
      } as any);
      totalChars += (conversation[conversation.length - 1] as any).content.length;

      // Synthesize stable IDs for tool calls that didn't have one
      // (Anthropic native shape). The tool-result messages below
      // reference these IDs.
      const callIds = result.toolCalls.map((c, idx) =>
        c.id || (conversation[conversation.length - 1] as any).tool_calls[idx].id
      );

      // Pre-scan: detect whether this iteration includes voice/image
      // generation alongside speak. This lets us set willGenerateVoice
      // on the speak text-ready event so the UI can suppress the early
      // text bubble (avoiding the text→voice flicker).
      const hasVoiceInIteration = result.toolCalls.some(
        (c) => c.name === "generate_voice",
      );

      // Dispatch each tool call via the registry. Run them
      // concurrently — most tools are independent within one
      // iteration. Errors are captured as JSON error objects so the
      // model can react to them on the next iteration.
      const toolResultPromises = result.toolCalls.map(async (call) => {
        const tool = toolRegistry.get(call.name);
        let resultStr: string;
        if (!tool) {
          resultStr = JSON.stringify({
            __error: `Unknown tool: ${call.name}`,
          });
        } else {
          try {
            // Parse args — constrained decoding guarantees validity.
            const args = call.arguments
              ? JSON.parse(call.arguments)
              : {};

            // Phase 3.3.1 — when the LLM calls speak, emit text-ready
            // IMMEDIATELY so the UI renders the text bubble before
            // waiting for media tools. This enables the "text first,
            // photo next" UX.
            //
            // Set willGenerateVoice when generate_voice is also called
            // in this iteration — the UI uses this to suppress the
            // early text bubble and show only the voice bubble.
            //
            // Suppress text-ready for the SECOND speak call in the
            // same loop (textReadyEmitted guard) — the first speak
            // already rendered the bubble.
            if (call.name === "speak" && !textReadyEmitted) {
              textReadyEmitted = true;
              this.sink.emit({
                type: "text-ready",
                text: args.text || "",
                actionText: args.actionText,
                metadata: {
                  willGenerateVoice: hasVoiceInIteration,
                },
              });
            }

            const r = await this.withToolEvents(call.name, args, () =>
              tool.execute(args, toolCtx),
            );
            resultStr = JSON.stringify(r);

            // Track that this tool was dispatched by the loop so the
            // client doesn't re-emit text-ready (for speak), re-PATCH
            // state (for update_state), or re-run side-effects
            // (for media/gift/event tools).
            if (
              call.name === "speak" ||
              call.name === "update_state" ||
              call.name === "generate_image" ||
              call.name === "generate_voice" ||
              call.name === "trigger_event" ||
              call.name === "gift_outfit"
            ) {
              loopDispatchedTools.add(call.name);
            }
          } catch (e) {
            resultStr = JSON.stringify({
              __error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        // Stash for the conversation + the accumulator.
        // `errored` = true when the tool execution threw (or the tool
        // was unknown). Errored calls are fed back to the LLM but
        // excluded from intent folding to prevent spurious re-attempts.
        return { call, resultStr, errored: !!resultStr && resultStr.includes('"__error"') };
      });

      const toolResults = await Promise.all(toolResultPromises);

      // Append tool-result messages to the conversation + accumulate.
      // Skip errored tool calls from intent folding — a failed
      // generate_image must NOT set intent.imageParams (otherwise
      // the side-effect layer tries to run it again). The error
      // result IS still fed back to the LLM via the conversation
      // (so the model can react), but the intent stays clean.
      for (let i = 0; i < toolResults.length; i++) {
        const { call, resultStr, errored } = toolResults[i];
        if (!errored) {
          allToolCalls.push(call);
        }
        // Use the stable ID from the assistant message's tool_calls
        // array so the provider can correlate.
        const toolCallId = callIds[i];
        conversation.push({
          role: "tool",
          toolCallId,
          content: resultStr,
        });
        totalChars += resultStr.length;
      }

      // The loop continues — the LLM decides when it's done by
      // returning no tool calls. No early break after speak.

      // If this was the last allowed iteration, terminate with the cap.
      if (iter === maxIterations) {
        termination = "max-iterations";
        console.warn(
          `[CyberSoulClient] Agent loop terminated: max iterations (${maxIterations}) reached.`,
        );
      }
    }

    // Fold all accumulated tool calls into the final intent.
    const parsedIntent = toolCallsToIntent(allToolCalls);
    // Only fall back to the raw LLM `content` field when NO `speak` tool
    // call populated intent.textResponse. For tool-calling models (e.g.
    // DeepSeek reasoner/thinking mode), the `speak` tool's `text` arg is
    // the canonical dialogue, while the raw `content` field may hold
    // reasoning/preamble. Unconditionally overriding leaked that reasoning
    // into reply.textResponse — which is what notifications read — even
    // though the chat bubble (fed by the early streamed `speak` text)
    // showed the correct line. Symptom: "notification shows reasoning
    // text instead of the real final response."
    const speakText = parsedIntent.textResponse?.trim() ?? "";
    if (finalTextResponse && speakText.length === 0) {
      parsedIntent.textResponse = finalTextResponse;
    }

    // Surface cap-hit via the onError hook for telemetry. Non-fatal —
    // the partial intent still resolves.
    if (termination === "max-iterations" || termination === "max-tokens") {
      // The hook channel is the EventStream's sink. We don't have a
      // direct hook list here; emit a synthetic tool-result that
      // surfaces the cap so consumers see it.
      this.sink.emit({
        type: "tool-result",
        tool: "__agent_loop__",
        result: {
          __termination: termination,
          __warning: `Agent loop terminated via safety cap (${termination}).`,
        },
      });
    }

    return { parsedIntent, loopDispatchedTools };
  }

  /* ============================================================ */
  /* Phase 4 — streaming text dispatch                            */
  /* ============================================================ */

  /**
   * Phase 4 — streaming text dispatch (see
   * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
   * §4 Phase 4). Uses `provider.chatStream()` to get text deltas as
   * they arrive, emitting `text-delta` events through the sink so
   * `CyberSoulAgent` consumers see the "typing" effect in real time.
   *
   * Returns the SAME `DispatchResult` shape as the non-streaming
   * dispatchers — downstream (`runInteractSideEffects`, etc.) is
   * identical. Only the delivery timing of text changes: deltas
   * stream as they arrive, then the full text is in the returned
   * `parsedIntent.textResponse`.
   *
   * Capability contract: pre-check `supportsStreaming(this.llm)`.
   *
   * @param promptMessages Same {system, user} pair as other dispatchers.
   * @param toolDeclarations For tool-calling providers; pass [] if N/A.
   */
  async runInteractDispatchStream(
    promptMessages: Array<{ role: string; content: string }>,
    toolDeclarations: import("../types.js").LLMToolDeclaration[],
  ): Promise<DispatchResult> {
    if (!supportsStreaming(this.llm)) {
      throw new CyberSoulError(
        "llm-capability-mismatch",
        "Streaming dispatch path selected (llmConfig.capabilities.streaming === true) but the LLM provider does not implement chatStream(). Either implement chatStream() on the provider, or unset capabilities.streaming.",
      );
    }

    let fullText = "";
    const allToolCalls: import("../types.js").LLMToolCall[] = [];

    try {
      for await (const ev of this.llm.chatStream!({
        messages: promptMessages,
        tools: toolDeclarations,
        maxTokens: 15000,
        temperature: 0.7,
      })) {
        switch (ev.type) {
          case "text-delta":
            // Stream the delta to consumers immediately. This is the
            // whole point of Phase 4 — perceived latency drops from
            // ~5s to ~300ms.
            this.sink.emit({ type: "text-delta", delta: ev.delta });
            fullText += ev.delta;
            break;
          case "tool-call":
            if (ev.toolCall) allToolCalls.push(ev.toolCall);
            break;
          case "message-complete":
            // Provider's final assembled text may be more accurate
            // (e.g. if some deltas were dropped). Prefer it.
            if (ev.textResponse) fullText = ev.textResponse;
            if (ev.toolCalls) {
              allToolCalls.length = 0;
              allToolCalls.push(...ev.toolCalls);
            }
            break;
          case "tool-call-delta":
            // Ignore — we wait for the complete tool-call event.
            break;
          case "error":
            console.warn(
              "[CyberSoulClient] LLM stream warning:",
              ev.error,
            );
            break;
        }
      }
    } catch (e) {
      // Stream errored mid-flight. If we got partial text, keep it
      // (better than losing the turn entirely). Re-throw so the
      // client's outer catch surfaces the typed error.
      if (fullText.length === 0) throw e;
      console.warn(
        "[CyberSoulClient] LLM stream errored mid-flight; using partial text:",
        e,
      );
    }

    // Fold accumulated tool calls into the intent.
    const parsedIntent = toolCallsToIntent(allToolCalls);
    if (fullText) parsedIntent.textResponse = fullText;

    return { parsedIntent };
  }

  /**
   * Reproduce the proactive dispatcher (`dispatchProactiveDecision`)
   * byte-for-byte. Lower maxTokens (800) + temperature (0.5) than
   * interact — this is a judgment call, not creative reply.
   *
   * Returns the same discriminated union the legacy code returned so
   * the proactive gating in client.ts stays untouched.
   */
  async runProactiveDispatch(
    promptMessages: Array<{ role: string; content: string }>,
  ): Promise<
    | { kind: "skip"; reason: string }
    | { kind: "proceed"; intent: DispatcherIntent }
  > {
    const rawLlmResponse = await this.llm.generate(promptMessages, 800, 0.5);
    const parsedIntent = robustJsonParse<DispatcherIntent>(
      rawLlmResponse,
      "Proactive fallback",
    );

    if (parsedIntent.shouldSkipProactive) {
      return {
        kind: "skip",
        reason: parsedIntent.skipReason || "Character chose not to reach out.",
      };
    }

    if (
      typeof parsedIntent.textResponse !== "string" ||
      parsedIntent.textResponse.trim().length === 0
    ) {
      return {
        kind: "skip",
        reason: "LLM produced no textResponse (treated as implicit skip).",
      };
    }

    return { kind: "proceed", intent: parsedIntent };
  }

  /* ============================================================ */
  /* Phase 1 — side-effect orchestration                          */
  /* ============================================================ */

  /**
   * Reproduce `startInteractStateUpdate` byte-for-byte.
   *
   * Kicks off the dynamic-context PATCH in parallel with everything
   * else. Returns the in-flight promise (awaited at the end of the
   * turn to surface the server-authoritative snapshot). Also wires
   * `state-ready` via EventStream so the UI updates temperature/stage
   * the moment the PATCH resolves — independent of (potentially slow)
   * image generation. The "fire `{}` even when the PATCH fails or
   * there's nothing to send" behavior from §5.4 item 2 is preserved.
   */
  startInteractStateUpdate(
    parsedIntent: DispatcherIntent,
    toolCtx: ToolContext,
  ): Promise<PersistedDynamicContext | null> {
    let persistedStatePromise: Promise<PersistedDynamicContext | null> =
      Promise.resolve(null);

    if (parsedIntent.stateUpdate || parsedIntent.userAnalysis) {
      const updateState = buildUpdateStateTool().execute(
        {
          stateUpdate: parsedIntent.stateUpdate,
          userAnalysis: parsedIntent.userAnalysis,
        },
        toolCtx,
      );
      // unwrap the tool's { persisted } envelope so the returned promise
      // has the same type as the legacy startInteractStateUpdate.
      persistedStatePromise = updateState.then((r: UpdateStateResult) => r.persisted);
    }

    // Wire onStateReady with the legacy "fire {} on failure / no-op" pattern.
    persistedStatePromise
      .then((persisted) => {
        this.sink.emit({
          type: "state-ready",
          persisted: persisted ?? {},
        });
      })
      .catch(() => {
        this.sink.emit({ type: "state-ready", persisted: {} });
      });

    return persistedStatePromise;
  }

  /**
   * Reproduce `startProactiveStateUpdate` byte-for-byte. Mirrors the
   * interact path but only fires on `stateUpdate` (proactive turns
   * never emit `userAnalysis`).
   */
  startProactiveStateUpdate(
    parsedIntent: DispatcherIntent,
    toolCtx: ToolContext,
  ): Promise<PersistedDynamicContext | null> {
    let persistedStatePromise: Promise<PersistedDynamicContext | null> =
      Promise.resolve(null);

    if (parsedIntent.stateUpdate) {
      const updateState = buildUpdateStateTool().execute(
        { stateUpdate: parsedIntent.stateUpdate },
        toolCtx,
      );
      persistedStatePromise = updateState.then((r: UpdateStateResult) => r.persisted);
    }

    persistedStatePromise
      .then((persisted) => {
        this.sink.emit({
          type: "state-ready",
          persisted: persisted ?? {},
        });
      })
      .catch(() => {
        this.sink.emit({ type: "state-ready", persisted: {} });
      });

    return persistedStatePromise;
  }

  /**
   * Reproduce `runInteractMediaTasks` byte-for-byte.
   *
   * Dispatches the four side-effect branches (triggerEvent, giftOutfit,
   * image, voice) in parallel via Promise.all, capturing typed media
   * failures into `firstMediaError` / `affected` and swallowing
   * everything else. Each successful branch emits its
   * media-ready / outfit-gifted event via the EventStream with the
   * same args the legacy code passed to the callbacks.
   *
   * The harness decides which branches to dispatch by mirroring the
   * legacy gating:
   *   - triggerEvent: dispatched iff parsedIntent.triggerEvent is set.
   *   - giftOutfit:   dispatched iff the LLM emitted a valid
   *                    giftOutfit.descriptionText.
   *   - image:        dispatched iff `types.includes(IMAGE)` AND
   *                    (`!isAuto` OR parsedIntent.imageParams is set).
   *   - voice:        dispatched iff `types.includes(VOICE)` AND
   *                    (`!isAuto` OR parsedIntent.voiceArgs is set),
   *                    using the resolved text response (sanitized +
   *                    "..." fallback inside the tool).
   */
  async runInteractSideEffects(
    ctx: { types: InteractRequestType[]; isAuto: boolean },
    parsedIntent: DispatcherIntent,
    params: InteractParams,
    resolvedTextResponse: string,
    toolCtx: ToolContext,
    /**
     * Phase 3.3.1 — when the multi-step loop already dispatched
     * certain tools inline (e.g. generate_image, generate_voice),
     * this set contains their names. The side-effect layer SKIPS
     * them to prevent double generation. Undefined or empty for
     * single-shot paths.
     */
    dispatchedTools?: Set<string>,
  ): Promise<InteractSideEffectResult> {
    const skip = new Set(dispatchedTools ?? []);
    let imageUrl: string | undefined = undefined;
    let imageMediaId: string | undefined = undefined;
    let audioUrl: string | undefined = undefined;
    let audioMediaId: string | undefined = undefined;
    let durationSec: number | undefined = undefined;
    let giftedOutfit: OutfitGiftedPayload | undefined = undefined;
    let triggeredEvent: NonNullable<DispatcherIntent["triggerEvent"]> | undefined;

    const affected: Array<"image" | "voice"> = [];
    let firstMediaError: CyberSoulError | null = null;
    const captureMediaError = (
      modality: "image" | "voice",
      failure: ToolFailure | undefined,
    ): void => {
      if (!failure) return;
      const e = failure.error;
      // Retain ANY typed CyberSoulError so non-wallet/non-sensitive
      // failures (network, timeout, generic API error) still surface
      // in-band as `mediaError` instead of being silently dropped.
      // `buildMediaError` maps the un-typed ones to `kind: "unknown"`,
      // which the host app renders as a friendly generic bubble.
      if (!(e instanceof CyberSoulError)) {
        return;
      }
      if (!affected.includes(modality)) {
        affected.push(modality);
      }
      if (!firstMediaError) firstMediaError = e;
    };

    const tasks: Promise<unknown>[] = [];

    // [1] triggerEvent — same catch-and-swallow as the legacy code.
    if (parsedIntent.triggerEvent && !skip.has("trigger_event")) {
      const triggerEvent = buildTriggerEventTool();
      tasks.push(
        this.withToolEvents("trigger_event", parsedIntent.triggerEvent as Record<string, unknown>, () =>
          triggerEvent.execute(parsedIntent.triggerEvent!, toolCtx),
        )
          .then((r: TriggerEventResult) => {
            if (r.triggered) triggeredEvent = r.triggered;
          }),
      );
    }

    // [2] giftOutfit — same validation + capture as the legacy code.
    if (
      !skip.has("gift_outfit") &&
      parsedIntent.giftOutfit &&
      typeof parsedIntent.giftOutfit === "object" &&
      typeof parsedIntent.giftOutfit.descriptionText === "string" &&
      parsedIntent.giftOutfit.descriptionText.trim().length > 0
    ) {
      const giftOutfit = buildGiftOutfitTool(this.sink);
      const giftArgs = { descriptionText: parsedIntent.giftOutfit.descriptionText };
      tasks.push(
        this.withToolEvents("gift_outfit", giftArgs, () =>
          giftOutfit.execute(giftArgs, toolCtx),
        )
          .then((r: GiftOutfitResult) => {
            if (r.giftedOutfit) giftedOutfit = r.giftedOutfit;
          }),
      );
    }

    // [3] image — mirrors the legacy shouldGenerateImage gate.
    // Skip if the loop already dispatched generate_image inline.
    const shouldGenerateImage =
      !skip.has("generate_image") &&
      ctx.types.includes(InteractRequestType.IMAGE) &&
      (!ctx.isAuto || !!parsedIntent.imageParams);
    if (shouldGenerateImage) {
      const imagePayload =
        parsedIntent.imageParams && typeof parsedIntent.imageParams === "object"
          ? parsedIntent.imageParams
          : { mode: "full-prompt", full_prompt: resolvedTextResponse };
      const imageArgs = imagePayload as Record<string, unknown>;

      const generateImage = buildGenerateImageTool(this.sink);
      tasks.push(
        this.withToolEvents("generate_image", imageArgs, () =>
          generateImage.execute(imageArgs, toolCtx),
        )
          .then((r: GenerateImageResult) => {
            imageUrl = r.imageUrl;
            imageMediaId = r.imageMediaId;
            captureMediaError("image", r.failure);
          }),
      );
    }

    // [4] voice — mirrors the legacy shouldGenerateVoice gate.
    // Skip if the loop already dispatched generate_voice inline.
    const shouldGenerateVoice =
      !skip.has("generate_voice") &&
      ctx.types.includes(InteractRequestType.VOICE) &&
      (!ctx.isAuto || !!parsedIntent.voiceArgs);
    if (shouldGenerateVoice) {
      const normalizedVoiceArgs =
        parsedIntent.voiceArgs && typeof parsedIntent.voiceArgs === "object"
          ? (parsedIntent.voiceArgs as Record<string, unknown>)
          : {};
      const voiceArgs = {
        textForVoice: resolvedTextResponse,
        dynamicArgs: normalizedVoiceArgs,
      };

      const generateVoice = buildGenerateVoiceTool(this.sink);
      tasks.push(
        this.withToolEvents("generate_voice", voiceArgs as unknown as Record<string, unknown>, () =>
          generateVoice.execute(voiceArgs, toolCtx),
        )
          .then((r: GenerateVoiceResult) => {
            audioUrl = r.audioUrl;
            audioMediaId = r.audioMediaId;
            durationSec = r.durationSec;
            captureMediaError("voice", r.failure);
          }),
      );
    }

    await Promise.all(tasks);

    return {
      imageUrl,
      imageMediaId,
      audioUrl,
      audioMediaId,
      durationSec,
      giftedOutfit,
      triggeredEvent,
      firstMediaError,
      affected,
    };
  }

  /**
   * Reproduce the proactive image task (`runProactiveImageTask`)
   * byte-for-byte. Single image branch only (voice is forced off for
   * proactive turns). Returns the typed media failure for in-band
   * surfacing.
   */
  async runProactiveImageTask(
    parsedIntent: DispatcherIntent,
    toolCtx: ToolContext,
  ): Promise<{
    imageUrl?: string;
    imageMediaId?: string;
    mediaError: CyberSoulError | null;
    affected: Array<"image" | "voice">;
  }> {
    const affected: Array<"image" | "voice"> = [];
    if (!parsedIntent.imageParams) {
      return {
        imageUrl: undefined,
        imageMediaId: undefined,
        mediaError: null,
        affected,
      };
    }

    const generateImage = buildGenerateImageTool(this.sink);
    const r = await generateImage.execute(
      parsedIntent.imageParams as Record<string, unknown>,
      toolCtx,
    );

    let mediaError: CyberSoulError | null = null;
    if (r.failure) {
      const e = r.failure.error;
      // Retain ANY typed CyberSoulError so the proactive path also
      // surfaces non-wallet/non-sensitive failures in-band (see the
      // matching change in runInteractSideEffects). buildMediaError
      // maps the un-typed ones to `kind: "unknown"`.
      if (e instanceof CyberSoulError) {
        mediaError = e;
        affected.push("image");
      } else {
        // Legacy: non-typed errors are already logged inside the tool.
      }
    }

    return {
      imageUrl: r.imageUrl,
      imageMediaId: r.imageMediaId,
      mediaError,
      affected,
    };
  }

  /**
   * Reproduce the proactive gift-outfit path. Mirrors the legacy
   * `processGiftOutfit` invocation (returns the payload or undefined
   * on failure / nothing-to-gift; outfit-gifted event fires from
   * inside the tool).
   */
  async runProactiveGiftOutfit(
    parsedIntent: DispatcherIntent,
    toolCtx: ToolContext,
  ): Promise<OutfitGiftedPayload | undefined> {
    const giftOutfit = buildGiftOutfitTool(this.sink);
    const r = await giftOutfit.execute(
      { descriptionText: parsedIntent.giftOutfit?.descriptionText ?? "" },
      toolCtx,
    );
    return r.giftedOutfit;
  }
}

/**
 * Convenience: legacy `sanitizeTextForVoice` is re-exported so client.ts
 * can drop the voice.utils import (it was only used in two places,
 * both now inside the harness/tools layer).
 */
export { sanitizeTextForVoice };
