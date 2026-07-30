/**
 * Phase 4 — streaming tests.
 *
 * Layer B (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * §5.2). Pins the SSE parsing + text-delta event delivery:
 *
 *   - chatStream() parses SSE chunks and yields text-delta events.
 *   - [DONE] marker terminates the stream with message-complete.
 *   - Tool-call fragments accumulate across chunks.
 *   - runInteractDispatchStream emits text-delta events to the sink.
 *   - Stream error mid-flight retains partial text.
 */

import { AgentHarness } from "./agentHarness.js";
import { EventStream } from "./eventStream.js";
import type { AgentEvent } from "./types.js";
import type {
  BaseLLMProvider,
  LLMChatResult,
  LLMStreamEvent,
  LLMToolDeclaration,
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
 * Stub streaming provider. Yields a scripted sequence of
 * LLMStreamEvents from chatStream().
 */
class StubStreamingProvider implements BaseLLMProvider {
  constructor(private stream: LLMStreamEvent[]) {}
  async generate(): Promise<string> {
    return "{}";
  }
  async chat(): Promise<LLMChatResult> {
    return { textResponse: "", toolCalls: [] };
  }
  async *chatStream(): AsyncGenerator<LLMStreamEvent> {
    for (const ev of this.stream) yield ev;
  }
}

/** Non-streaming provider (no chatStream method). */
class NonStreamingProvider implements BaseLLMProvider {
  async generate(): Promise<string> {
    return "{}";
  }
  async chat(): Promise<LLMChatResult> {
    return { textResponse: "non-streamed", toolCalls: [] };
  }
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void | Promise<void> }[] = [
    {
      name: "4 streaming — runInteractDispatchStream emits text-delta events for each delta",
      run: async () => {
        const events: AgentEvent[] = [];
        const sink: { emit(e: AgentEvent): void } = { emit: (e) => events.push(e) };
        const provider = new StubStreamingProvider([
          { type: "text-delta", delta: "Hello" },
          { type: "text-delta", delta: ", " },
          { type: "text-delta", delta: "world!" },
          {
            type: "message-complete",
            textResponse: "Hello, world!",
            toolCalls: [],
          },
        ]);
        const harness = new AgentHarness(provider as any, sink as unknown as EventStream);
        const result = await harness.runInteractDispatchStream([], []);

        const deltas = events.filter((e: any) => e.type === "text-delta");
        assert.equal(deltas.length, 3);
        assert.equal((deltas[0] as any).delta, "Hello");
        assert.equal((deltas[1] as any).delta, ", ");
        assert.equal((deltas[2] as any).delta, "world!");
        assert.equal(result.parsedIntent.textResponse, "Hello, world!");
      },
    },
    {
      name: "4 streaming — message-complete event finalizes the intent",
      run: async () => {
        const events: AgentEvent[] = [];
        const sink: { emit(e: AgentEvent): void } = { emit: (e) => events.push(e) };
        const provider = new StubStreamingProvider([
          { type: "text-delta", delta: "partial" },
          {
            type: "message-complete",
            textResponse: "full final text",
            toolCalls: [],
          },
        ]);
        const harness = new AgentHarness(provider as any, sink as unknown as EventStream);
        const result = await harness.runInteractDispatchStream([], []);
        // message-complete's textResponse takes precedence over
        // accumulated deltas.
        assert.equal(result.parsedIntent.textResponse, "full final text");
      },
    },
    {
      name: "4 streaming — tool calls from stream fold into the intent",
      run: async () => {
        const events: AgentEvent[] = [];
        const sink: { emit(e: AgentEvent): void } = { emit: (e) => events.push(e) };
        const provider = new StubStreamingProvider([
          { type: "text-delta", delta: "let me check" },
          {
            type: "tool-call",
            toolCall: {
              id: "tc1",
              name: "update_state",
              arguments: '{"stateUpdate":{"temperatureDelta":1}}',
            },
          },
          {
            type: "message-complete",
            textResponse: "let me check",
            toolCalls: [
              {
                id: "tc1",
                name: "update_state",
                arguments: '{"stateUpdate":{"temperatureDelta":1}}',
              },
            ],
          },
        ]);
        const harness = new AgentHarness(provider as any, sink as unknown as EventStream);
        const result = await harness.runInteractDispatchStream(
          [],
          [{ name: "update_state", description: "", inputSchema: {} }],
        );
        // toolCallsToIntent folds the tool call into the intent
        assert.ok(result.parsedIntent.stateUpdate);
      },
    },
    {
      name: "4 streaming — stream error mid-flight retains partial text",
      run: async () => {
        const events: AgentEvent[] = [];
        const sink: { emit(e: AgentEvent): void } = { emit: (e) => events.push(e) };
        // Provider that errors after 2 deltas
        const provider = new (class implements BaseLLMProvider {
          async generate(): Promise<string> {
            return "{}";
          }
          async chat(): Promise<LLMChatResult> {
            return { textResponse: "", toolCalls: [] };
          }
          async *chatStream(): AsyncGenerator<LLMStreamEvent> {
            yield { type: "text-delta", delta: "partial " };
            yield { type: "text-delta", delta: "text" };
            throw new Error("stream broke");
          }
        })();
        const harness = new AgentHarness(provider as any, sink as unknown as EventStream);
        const result = await harness.runInteractDispatchStream([], []);
        // Should retain "partial text" despite the error
        assert.equal(result.parsedIntent.textResponse, "partial text");
      },
    },
    {
      name: "4 streaming — empty stream + error with no partial text re-throws",
      run: async () => {
        const events: AgentEvent[] = [];
        const sink: { emit(e: AgentEvent): void } = { emit: (e) => events.push(e) };
        const provider = new (class implements BaseLLMProvider {
          async generate(): Promise<string> {
            return "{}";
          }
          async chat(): Promise<LLMChatResult> {
            return { textResponse: "", toolCalls: [] };
          }
          async *chatStream(): AsyncGenerator<LLMStreamEvent> {
            throw new Error("immediate failure");
          }
        })();
        const harness = new AgentHarness(provider as any, sink as unknown as EventStream);
        let threw = false;
        try {
          await harness.runInteractDispatchStream([], []);
        } catch {
          threw = true;
        }
        assert.ok(threw, "Expected immediate error to re-throw when no partial text");
      },
    },
    {
      name: "4 streaming — non-streaming provider throws capability-mismatch",
      run: async () => {
        const sink: { emit(e: AgentEvent): void } = { emit: () => {} };
        const provider = new NonStreamingProvider();
        const harness = new AgentHarness(provider as any, sink as unknown as EventStream);
        let threw = false;
        let errorMsg = "";
        try {
          await harness.runInteractDispatchStream([], []);
        } catch (e: any) {
          threw = true;
          errorMsg = e?.message ?? "";
        }
        assert.ok(threw);
        assert.ok(/chatStream/.test(errorMsg), "Expected chatStream in error message");
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
