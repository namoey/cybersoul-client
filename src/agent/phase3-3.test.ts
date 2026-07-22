/**
 * Phase 3.3 — multi-step agent loop tests.
 *
 * Layer B (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * §5.2). Pins the loop's three termination modes + tool-result
 * feedback semantics:
 *
 *   - Single iteration (no tool calls) terminates naturally.
 *   - Multi-iteration (tool calls in iter 1, no calls in iter 2)
 *     feeds results back and accumulates intent.
 *   - maxIterations cap fires after N iterations.
 *   - maxTotalTokensEstimate cap fires when budget exceeded.
 *   - Tool errors become JSON error objects the model can react to.
 *   - Unknown tools produce an error result, don't crash the loop.
 */

import { AgentHarness } from "./agentHarness.js";
import { EventStream } from "./eventStream.js";
import { ToolRegistry } from "../tools/toolRegistry.js";
import type { AgentEvent, Tool } from "./types.js";
import type {
  BaseLLMProvider,
  LLMChatResult,
  LLMToolCall,
} from "../types.js";

const assert = {
  equal: (a: any, b: any, msg?: string) => {
    if (a !== b)
      throw new Error(msg || `Assertion failed: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  },
  ok: (condition: any, msg?: string) => {
    if (!condition) throw new Error(msg || "Assertion failed: expected truthy value");
  },
};

/**
 * Scripted LLM that returns a sequence of LLMChatResults, one per
 * `chat()` call. Lets tests deterministically drive the loop's
 * iterations.
 */
class ScriptedLLM implements BaseLLMProvider {
  public callCount = 0;
  public capturedMessages: any[] = [];
  constructor(private script: LLMChatResult[]) {}
  async generate(): Promise<string> {
    return "{}";
  }
  async chat(params: {
    messages: any[];
    tools: any[];
  }): Promise<LLMChatResult> {
    this.callCount++;
    // Capture the message history so tests can verify tool-result
    // messages were appended between iterations.
    this.capturedMessages.push([...params.messages]);
    const result = this.script[Math.min(this.callCount - 1, this.script.length - 1)];
    return result;
  }
}

function buildToolCtx(stubApi: any = {}): any {
  return {
    api: stubApi,
    state: { name: "TestChar", dynamic_context: {} },
    params: {},
  };
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void | Promise<void> }[] = [
    {
      name: "3.3 loop — single iteration when model returns no tool calls (natural completion)",
      run: async () => {
        const events: AgentEvent[] = [];
        const sink: { emit(e: AgentEvent): void } = { emit: (e) => events.push(e) };
        const llm = new ScriptedLLM([
          { textResponse: "hi", toolCalls: [] },
        ]);
        const harness = new AgentHarness(llm as any, sink as unknown as EventStream);
        const registry = new ToolRegistry();
        const result = await harness.runInteractDispatchLoop(
          [{ role: "system", content: "sys" }, { role: "user", content: "u" }],
          [],
          registry,
          buildToolCtx(),
          {},
        );
        assert.equal(llm.callCount, 1);
        assert.equal(result.parsedIntent.textResponse, "hi");
      },
    },
    {
      name: "3.3 loop — multi-iteration: tool call in iter 1, no calls in iter 2",
      run: async () => {
        const events: AgentEvent[] = [];
        const sink: { emit(e: AgentEvent): void } = { emit: (e) => events.push(e) };
        const llm = new ScriptedLLM([
          // Iter 1: model calls a tool
          {
            textResponse: "",
            toolCalls: [
              { id: "c1", name: "remember_birthday", arguments: '{"date":"2026-01-01"}' },
            ],
          },
          // Iter 2: model produces final reply
          { textResponse: "Got it!", toolCalls: [] },
        ]);
        const harness = new AgentHarness(llm as any, sink as unknown as EventStream);

        // Register a custom tool the model calls
        const customTool: Tool = {
          name: "remember_birthday",
          description: "",
          inputSchema: {},
          async execute(args: any) {
            return { saved: args.date };
          },
        };
        const registry = new ToolRegistry([customTool]);

        const result = await harness.runInteractDispatchLoop(
          [{ role: "user", content: "remember my birthday" }],
          [{ name: "remember_birthday", description: "", inputSchema: {} }],
          registry,
          buildToolCtx(),
          {},
        );

        assert.equal(llm.callCount, 2);
        // Iter 2 should have seen the tool-result message appended
        const iter2Messages = llm.capturedMessages[1];
        assert.ok(
          iter2Messages.some((m: any) => m.role === "tool"),
          "Expected a tool-result message in iter 2's history",
        );
        // Final intent should have the text reply
        assert.equal(result.parsedIntent.textResponse, "Got it!");
        // Tool-call / tool-result events fired
        const toolCallEvents = events.filter((e: any) => e.type === "tool-call");
        const toolResultEvents = events.filter((e: any) => e.type === "tool-result");
        assert.ok(toolCallEvents.length >= 1);
        assert.ok(toolResultEvents.length >= 1);
      },
    },
    {
      name: "3.3 loop — maxIterations cap fires after N iterations",
      run: async () => {
        const events: AgentEvent[] = [];
        const sink: { emit(e: AgentEvent): void } = { emit: (e) => events.push(e) };
        // Model keeps calling tools forever
        const llm = new ScriptedLLM([
          {
            textResponse: "",
            toolCalls: [{ id: "c", name: "noop", arguments: "{}" }],
          },
        ]);
        const harness = new AgentHarness(llm as any, sink as unknown as EventStream);
        const registry = new ToolRegistry([
          {
            name: "noop",
            description: "",
            inputSchema: {},
            async execute() {
              return {};
            },
          },
        ]);

        await harness.runInteractDispatchLoop(
          [{ role: "user", content: "loop forever" }],
          [],
          registry,
          buildToolCtx(),
          { maxIterations: 3 },
        );

        // Should stop after 3 iterations
        assert.equal(llm.callCount, 3);
        // Cap-hit surfaced as a synthetic tool-result
        const capEvents = events.filter(
          (e: any) =>
            e.type === "tool-result" &&
            e.tool === "__agent_loop__" &&
            e.result?.__termination === "max-iterations",
        );
        assert.ok(capEvents.length === 1, "Expected one cap-hit event");
      },
    },
    {
      name: "3.3 loop — maxTotalTokensEstimate cap fires",
      run: async () => {
        const events: AgentEvent[] = [];
        const sink: { emit(e: AgentEvent): void } = { emit: (e) => events.push(e) };
        const llm = new ScriptedLLM([
          {
            textResponse: "",
            toolCalls: [{ id: "c", name: "noop", arguments: "{}" }],
          },
        ]);
        const harness = new AgentHarness(llm as any, sink as unknown as EventStream);
        const registry = new ToolRegistry([
          {
            name: "noop",
            description: "",
            inputSchema: {},
            async execute() {
              return {};
            },
          },
        ]);

        await harness.runInteractDispatchLoop(
          [{ role: "user", content: "x".repeat(1000) }], // already over a tiny budget
          [],
          registry,
          buildToolCtx(),
          { maxIterations: 10, maxTotalTokensEstimate: 50 },
        );

        // Should have stopped early due to token cap, before reaching 10 iters
        assert.ok(llm.callCount < 10, `Expected early termination, got ${llm.callCount} calls`);
        const capEvents = events.filter(
          (e: any) =>
            e.type === "tool-result" &&
            e.tool === "__agent_loop__" &&
            e.result?.__termination === "max-tokens",
        );
        assert.ok(capEvents.length === 1, "Expected max-tokens cap event");
      },
    },
    {
      name: "3.3 loop — tool execution error becomes JSON error result fed back",
      run: async () => {
        const events: AgentEvent[] = [];
        const sink: { emit(e: AgentEvent): void } = { emit: (e) => events.push(e) };
        const llm = new ScriptedLLM([
          {
            textResponse: "",
            toolCalls: [{ id: "c1", name: "failing_tool", arguments: "{}" }],
          },
          { textResponse: "sorry it failed", toolCalls: [] },
        ]);
        const harness = new AgentHarness(llm as any, sink as unknown as EventStream);
        const registry = new ToolRegistry([
          {
            name: "failing_tool",
            description: "",
            inputSchema: {},
            async execute() {
              throw new Error("tool broke");
            },
          },
        ]);

        const result = await harness.runInteractDispatchLoop(
          [{ role: "user", content: "try" }],
          [],
          registry,
          buildToolCtx(),
          {},
        );

        // Iter 2 saw the error JSON
        const iter2Messages = llm.capturedMessages[1];
        const toolMsg = iter2Messages.find((m: any) => m.role === "tool");
        assert.ok(toolMsg, "Expected tool-result message");
        assert.ok(
          toolMsg.content.includes("tool broke"),
          "Expected error message in tool result",
        );
        assert.equal(result.parsedIntent.textResponse, "sorry it failed");
      },
    },
    {
      name: "3.3 loop — unknown tool call produces error result, doesn't crash",
      run: async () => {
        const events: AgentEvent[] = [];
        const sink: { emit(e: AgentEvent): void } = { emit: (e) => events.push(e) };
        const llm = new ScriptedLLM([
          {
            textResponse: "",
            toolCalls: [{ id: "c1", name: "nonexistent_tool", arguments: "{}" }],
          },
          { textResponse: "ok", toolCalls: [] },
        ]);
        const harness = new AgentHarness(llm as any, sink as unknown as EventStream);
        const registry = new ToolRegistry(); // empty — no tools registered

        const result = await harness.runInteractDispatchLoop(
          [{ role: "user", content: "try" }],
          [],
          registry,
          buildToolCtx(),
          {},
        );

        const iter2Messages = llm.capturedMessages[1];
        const toolMsg = iter2Messages.find((m: any) => m.role === "tool");
        assert.ok(toolMsg.content.includes("Unknown tool"));
        assert.equal(result.parsedIntent.textResponse, "ok");
      },
    },
  ];

  for (const t of tests) {
    try {
      await t.run();
      console.log(`✅ ${t.name}`);
      passed++;
    } catch (e: any) {
      console.error(`❌ ${t.name}`);
      console.error(`   ${e?.message ?? e}`);
      failed++;
    }
  }

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error("Tests failed");
  }
}

void runTests();
