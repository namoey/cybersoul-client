/**
 * Phase 3.1 — PersonaConfig + custom tools + tool events tests.
 *
 * Layer B (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * §5.2). Pins the three Phase 3.1 deliverables:
 *
 *   3.1a — PersonaConfig.systemPromptFragment reaches the client
 *          via params.systemPromptFragment.
 *   3.1b — Custom tools passed to the agent constructor reach the
 *          client via params.extraTools.
 *   3.1c — Harness emits tool-call / tool-result events around each
 *          tool execution. (Verified at the harness level since the
 *          agent's mock client doesn't run real side-effects.)
 */

import { CyberSoulAgent } from "./cyberSoulAgent.js";
import { AgentHarness } from "./agentHarness.js";
import { EventStream } from "./eventStream.js";
import { AsyncEventQueue } from "./asyncEventQueue.js";
import type { AgentEvent, Tool } from "./types.js";
import type {
  InteractParams,
  InteractResponse,
  ProactiveParams,
  ProactiveResponse,
} from "../types.js";
import type { CyberSoulClient } from "../client.js";

const assert = {
  equal: (a: any, b: any, msg?: string) => {
    if (a !== b)
      throw new Error(msg || `Assertion failed: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  },
  ok: (condition: any, msg?: string) => {
    if (!condition) throw new Error(msg || "Assertion failed: expected truthy value");
  },
  includes: (haystack: string, needle: string, msg?: string) => {
    if (!haystack.includes(needle))
      throw new Error(msg || `Expected "${needle}" in: ${haystack}`);
  },
};

class MockClient {
  capturedInteractParams: InteractParams | null = null;
  capturedProactiveParams: ProactiveParams | null = null;

  async interact(params: InteractParams): Promise<InteractResponse> {
    this.capturedInteractParams = params;
    return { status: "success", textResponse: "hi" };
  }
  async proactiveInteract(params: ProactiveParams): Promise<ProactiveResponse> {
    this.capturedProactiveParams = params;
    return { status: "success", textResponse: "hi" };
  }
}

async function drainAgent(agent: CyberSoulAgent, params: any): Promise<void> {
  for await (const _ev of agent.run(params)) {
    // drain
  }
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void | Promise<void> }[] = [
    // ---------- 3.1a: PersonaConfig.systemPromptFragment ----------

    {
      name: "3.1a — agent injects persona.systemPromptFragment into interact params",
      run: async () => {
        const mock = new MockClient();
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
          persona: { systemPromptFragment: "Always reply in French" },
        });
        await drainAgent(agent, { userMessage: "hi" });
        assert.equal(
          mock.capturedInteractParams?.systemPromptFragment,
          "Always reply in French",
        );
      },
    },
    {
      name: "3.1a — agent injects persona.systemPromptFragment into proactive params",
      run: async () => {
        const mock = new MockClient();
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
          persona: { systemPromptFragment: "Be extra warm" },
        });
        for await (const _ev of agent.runProactive({})) {
          // drain
        }
        assert.equal(
          mock.capturedProactiveParams?.systemPromptFragment,
          "Be extra warm",
        );
      },
    },
    {
      name: "3.1a — per-turn systemPromptFragment overrides persona-level",
      run: async () => {
        const mock = new MockClient();
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
          persona: { systemPromptFragment: "persona-level" },
        });
        await drainAgent(agent, {
          userMessage: "hi",
          systemPromptFragment: "turn-level override",
        });
        assert.equal(
          mock.capturedInteractParams?.systemPromptFragment,
          "turn-level override",
        );
      },
    },
    {
      name: "3.1a — no persona + no per-turn → undefined (no injection)",
      run: async () => {
        const mock = new MockClient();
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
        });
        await drainAgent(agent, { userMessage: "hi" });
        assert.equal(
          mock.capturedInteractParams?.systemPromptFragment,
          undefined,
        );
      },
    },

    // ---------- 3.1b: custom tool dispatch ----------

    {
      name: "3.1b — agent injects persona tools into interact params.extraTools",
      run: async () => {
        const mock = new MockClient();
        const customTool: Tool = {
          name: "remember_birthday",
          description: "Remember the user's birthday",
          inputSchema: { type: "object" },
          async execute() {
            return { ok: true };
          },
        };
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
          tools: [customTool],
        });
        await drainAgent(agent, { userMessage: "hi" });
        assert.equal(mock.capturedInteractParams?.extraTools?.length, 1);
        assert.equal(
          mock.capturedInteractParams?.extraTools?.[0].name,
          "remember_birthday",
        );
      },
    },
    {
      name: "3.1b — per-turn extraTools overrides persona-level tools",
      run: async () => {
        const mock = new MockClient();
        const personaTool: Tool = {
          name: "persona_tool",
          description: "",
          inputSchema: {},
          async execute() {
            return {};
          },
        };
        const turnTool: Tool = {
          name: "turn_tool",
          description: "",
          inputSchema: {},
          async execute() {
            return {};
          },
        };
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
          tools: [personaTool],
        });
        await drainAgent(agent, {
          userMessage: "hi",
          extraTools: [turnTool],
        });
        assert.equal(mock.capturedInteractParams?.extraTools?.length, 1);
        assert.equal(
          mock.capturedInteractParams?.extraTools?.[0].name,
          "turn_tool",
        );
      },
    },
    {
      name: "3.1b — no persona tools + no per-turn → empty array",
      run: async () => {
        const mock = new MockClient();
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
        });
        await drainAgent(agent, { userMessage: "hi" });
        // resolveExtraTools returns the (empty) customTools array
        assert.equal(mock.capturedInteractParams?.extraTools?.length, 0);
      },
    },

    // ---------- 3.1c: harness tool-call / tool-result events ----------

    {
      name: "3.1c — harness emits tool-call + tool-result around trigger_event execution",
      run: async () => {
        const events: AgentEvent[] = [];
        const sink: { emit(e: AgentEvent): void } = {
          emit: (e) => events.push(e),
        };
        // Build a harness with a stub LLM that returns an intent
        // triggering the trigger_event side-effect.
        const stubLlm = {
          generate: async () =>
            JSON.stringify({
              textResponse: "ok",
              triggerEvent: {
                eventDescription: "lunch",
                eventTitle: "Lunch",
              },
              stateUpdate: null,
            }),
        };
        const harness = new AgentHarness(
          stubLlm as any,
          sink as unknown as EventStream,
        );

        // Tool context with stubbed api
        const toolCtx = {
          api: {
            triggerOndemandEvent: async () => {},
          },
          state: {} as any,
          params: {},
        };

        await harness.runInteractSideEffects(
          { types: ["text" as any], isAuto: true },
          {
            textResponse: "ok",
            triggerEvent: {
              eventDescription: "lunch",
              eventTitle: "Lunch",
            },
          } as any,
          {} as any,
          "ok",
          toolCtx as any,
        );

        const toolCalls = events.filter((e) => e.type === "tool-call");
        const toolResults = events.filter((e) => e.type === "tool-result");
        assert.ok(
          toolCalls.some((e: any) => e.tool === "trigger_event"),
          "Expected trigger_event tool-call event",
        );
        assert.ok(
          toolResults.some((e: any) => e.tool === "trigger_event"),
          "Expected trigger_event tool-result event",
        );
      },
    },
    {
      name: "3.1c — withToolEvents emits tool-result with __error when executor throws",
      run: async () => {
        // Direct test of the withToolEvents helper — built-in tools
        // all swallow their own errors (capture-into-result pattern),
        // so we use a synthetic executor here to verify the error path.
        const events: AgentEvent[] = [];
        const sink: { emit(e: AgentEvent): void } = {
          emit: (e) => events.push(e),
        };
        const stubLlm = { generate: async () => '{"textResponse":"ok"}' };
        const harness = new AgentHarness(
          stubLlm as any,
          sink as unknown as EventStream,
        );

        // Access the private helper via any-cast (it's tested in isolation).
        const harnessAny = harness as any;
        let caught: unknown = undefined;
        try {
          await harnessAny.withToolEvents(
            "synthetic_failing_tool",
            { x: 1 },
            async () => {
              throw new Error("synthetic failure");
            },
          );
        } catch (e) {
          caught = e;
        }
        assert.ok(caught instanceof Error, "Expected executor error to re-throw");
        assert.includes((caught as Error).message, "synthetic failure");

        const toolCalls = events.filter((e: any) => e.type === "tool-call");
        const toolResults = events.filter((e: any) => e.type === "tool-result");
        assert.equal(toolCalls.length, 1);
        assert.equal(toolResults.length, 1);
        assert.equal((toolResults[0] as any).tool, "synthetic_failing_tool");
        assert.equal(
          (toolResults[0] as any).result.__error,
          "synthetic failure",
        );
      },
    },
    {
      name: "3.1c — no side-effects → no tool events emitted",
      run: async () => {
        const events: AgentEvent[] = [];
        const sink: { emit(e: AgentEvent): void } = {
          emit: (e) => events.push(e),
        };
        const stubLlm = { generate: async () => '{"textResponse":"ok"}' };
        const harness = new AgentHarness(
          stubLlm as any,
          sink as unknown as EventStream,
        );
        const toolCtx = {
          api: {},
          state: {} as any,
          params: {},
        };

        await harness.runInteractSideEffects(
          { types: ["text" as any], isAuto: true },
          { textResponse: "ok" } as any,
          {} as any,
          "ok",
          toolCtx as any,
        );

        const toolEvents = events.filter(
          (e) => e.type === "tool-call" || e.type === "tool-result",
        );
        assert.equal(toolEvents.length, 0);
      },
    },

    // ---------- AsyncEventQueue receives tool events ----------

    {
      name: "3.1c — tool events flow through AsyncEventQueue to agent consumers",
      run: async () => {
        const q = new AsyncEventQueue<AgentEvent>();
        q.push({ type: "tool-call", tool: "x", args: {} });
        q.push({
          type: "tool-result",
          tool: "x",
          result: { ok: true },
        });
        q.close();

        const events: AgentEvent[] = [];
        for await (const ev of q) events.push(ev);
        assert.equal(events.length, 2);
        assert.equal(events[0].type, "tool-call");
        assert.equal(events[1].type, "tool-result");
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
