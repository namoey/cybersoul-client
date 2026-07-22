/**
 * CyberSoulAgent characterization tests.
 *
 * Layer B (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * §5.2). The agent is the public Phase 3 surface — if its event
 * ordering, turn-complete semantics, or error propagation drift,
 * every consumer using the AsyncIterable API breaks.
 *
 * The tests mock a `CyberSoulClient` so they can drive the legacy
 * callbacks deterministically (fire text-ready, then state-ready,
 * then resolve the response) and assert the agent re-emits them as
 * `AgentEvent`s in the right order with `turn-complete` last.
 *
 * Error contract is also pinned:
 *  - CyberSoulError throws from client.interact() → iterator rejects.
 *  - { status: "error" } response → turn-complete fires (no reject).
 *  - { status: "skipped" } response → turn-complete fires (no reject).
 */

import { CyberSoulAgent } from "./cyberSoulAgent.js";
import type { AgentEvent } from "./types.js";
import type {
  InteractParams,
  InteractResponse,
  ProactiveParams,
  ProactiveResponse,
} from "../types.js";
import type { CyberSoulClient } from "../client.js";
import { CyberSoulError } from "../errors.js";

const assert = {
  equal: (a: any, b: any, msg?: string) => {
    if (a !== b)
      throw new Error(msg || `Assertion failed: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  },
  deepEqual: (a: any, b: any, msg?: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(msg || `Deep assertion failed`);
  },
  ok: (condition: any, msg?: string) => {
    if (!condition) throw new Error(msg || "Assertion failed: expected truthy value");
  },
  throws: async (
    fn: () => unknown | Promise<unknown>,
    predicate: (e: unknown) => boolean,
    msg?: string,
  ) => {
    try {
      await fn();
      throw new Error(msg || "Expected throw, but nothing was thrown");
    } catch (e: any) {
      if (!predicate(e)) {
        throw new Error(
          msg || `Expected predicate to match thrown error, got: ${e?.message ?? e}`,
        );
      }
    }
  },
};

/**
 * Mock client. Captures the `interact()` params so the test can fire
 * the legacy callbacks in any order, then resolves the response.
 */
class MockClient {
  public capturedInteractParams: InteractParams | null = null;
  public capturedProactiveParams: ProactiveParams | null = null;
  public interactResponse: InteractResponse = {
    status: "success",
    textResponse: "hi",
  };
  public interactThrow: unknown = undefined;

  async interact(params: InteractParams): Promise<InteractResponse> {
    this.capturedInteractParams = params;
    // Fire callbacks in the legacy order: text → state → media → gift.
    // Each one scheduled via microtask so the agent's queue actually
    // has to handle interleaved push/consume.
    if (params.onTextReady) {
      await Promise.resolve();
      params.onTextReady("hi", "(smiles)", { isEndTurn: false });
    }
    if (params.onStateReady) {
      await Promise.resolve();
      params.onStateReady({ temperature: 65 });
    }
    if (params.onMediaReady) {
      await Promise.resolve();
      params.onMediaReady({
        modality: "image",
        url: "https://x/i.png",
        mediaId: "m1",
      });
    }
    if (this.interactThrow) throw this.interactThrow;
    return this.interactResponse;
  }

  async proactiveInteract(params: ProactiveParams): Promise<ProactiveResponse> {
    this.capturedProactiveParams = params;
    if (params.onTextReady) {
      await Promise.resolve();
      params.onTextReady("hey there", undefined, {});
    }
    return {
      status: "success",
      textResponse: "hey there",
    };
  }
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void | Promise<void> }[] = [
    {
      name: "CyberSoulAgent.run — emits text-ready, state-ready, media-ready, turn-complete in order",
      run: async () => {
        const mock = new MockClient();
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
        });

        const events: AgentEvent[] = [];
        for await (const ev of agent.run({ userMessage: "hi" })) {
          events.push(ev);
        }

        // Verify order
        assert.equal(events[0].type, "text-ready");
        assert.equal(events[1].type, "state-ready");
        assert.equal(events[2].type, "media-ready");
        assert.equal(events[3].type, "turn-complete");

        // Verify content
        assert.equal((events[0] as any).text, "hi");
        assert.equal((events[0] as any).actionText, "(smiles)");
        assert.equal((events[1] as any).persisted.temperature, 65);
        assert.equal((events[2] as any).payload.url, "https://x/i.png");
        assert.equal((events[3] as any).response.status, "success");
      },
    },
    {
      name: "CyberSoulAgent.run — turn-complete is ALWAYS last",
      run: async () => {
        const mock = new MockClient();
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
        });

        const events: AgentEvent[] = [];
        for await (const ev of agent.run({ userMessage: "hi" })) {
          events.push(ev);
        }

        const lastEvent = events[events.length - 1];
        assert.equal(lastEvent.type, "turn-complete");
      },
    },
    {
      name: "CyberSoulAgent.run — CyberSoulError throws propagate via iterator rejection",
      run: async () => {
        const mock = new MockClient();
        mock.interactThrow = new CyberSoulError(
          "insufficient-points",
          "out of points",
        );
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
        });

        await assert.throws(
          async () => {
            // Drain the iterator. The throw should propagate.
            for await (const _ev of agent.run({ userMessage: "hi" })) {
              // no-op
            }
          },
          (e) =>
            e instanceof CyberSoulError &&
            (e as CyberSoulError).kind === "insufficient-points",
          "Expected CyberSoulError to propagate via iterator rejection",
        );
      },
    },
    {
      name: "CyberSoulAgent.run — { status: 'error' } response fires turn-complete, does NOT reject",
      run: async () => {
        const mock = new MockClient();
        // Override the post-callback response to be a legacy error envelope.
        mock.interactResponse = {
          status: "error",
          textResponse: "System Error...",
          error: "something broke",
        };
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
        });

        const events: AgentEvent[] = [];
        // The for-await must NOT throw — the iterator should complete normally.
        for await (const ev of agent.run({ userMessage: "hi" })) {
          events.push(ev);
        }
        const last = events[events.length - 1] as any;
        assert.equal(last.type, "turn-complete");
        assert.equal(last.response.status, "error");
      },
    },
    {
      name: "CyberSoulAgent.run — { status: 'skipped' } response fires turn-complete",
      run: async () => {
        const mock = new MockClient();
        mock.interactResponse = {
          status: "skipped",
          reason: "Character chose not to reply.",
          textResponse: "",
        };
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
        });

        const events: AgentEvent[] = [];
        for await (const ev of agent.run({ userMessage: "hi", allowSkip: true })) {
          events.push(ev);
        }
        const last = events[events.length - 1] as any;
        assert.equal(last.type, "turn-complete");
        assert.equal(last.response.status, "skipped");
      },
    },
    {
      name: "CyberSoulAgent.runProactive — emits proactive events + turn-complete",
      run: async () => {
        const mock = new MockClient();
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
        });

        const events: AgentEvent[] = [];
        for await (const ev of agent.runProactive({})) {
          events.push(ev);
        }
        // text-ready fires, then turn-complete
        assert.ok(events.length >= 2);
        assert.equal(events[0].type, "text-ready");
        assert.equal(events[events.length - 1].type, "turn-complete");
        const last = events[events.length - 1] as any;
        assert.equal(last.response.status, "success");
      },
    },
    {
      name: "CyberSoulAgent — hooks fire onTurnComplete on success",
      run: async () => {
        const mock = new MockClient();
        const seen: string[] = [];
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
          hooks: [
            (name) => {
              seen.push(name);
            },
          ],
        });

        for await (const _ev of agent.run({ userMessage: "hi" })) {
          // drain
        }
        assert.ok(
          seen.includes("onTurnComplete"),
          "Expected onTurnComplete hook to fire",
        );
      },
    },
    {
      name: "CyberSoulAgent — hooks fire onError when interact throws",
      run: async () => {
        const mock = new MockClient();
        mock.interactThrow = new CyberSoulError("test", "boom");
        const seen: string[] = [];
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
          hooks: [
            (name) => {
              seen.push(name);
            },
          ],
        });

        try {
          for await (const _ev of agent.run({ userMessage: "hi" })) {
            // drain
          }
        } catch {
          // expected
        }
        assert.ok(seen.includes("onError"), "Expected onError hook to fire");
      },
    },
    {
      name: "CyberSoulAgent — hook that throws is swallowed (doesn't break event delivery)",
      run: async () => {
        const mock = new MockClient();
        const agent = new CyberSoulAgent({
          client: mock as unknown as CyberSoulClient,
          hooks: [
            () => {
              throw new Error("hook bug");
            },
          ],
        });

        // The agent must NOT propagate the hook error — the iterator
        // should still emit turn-complete normally.
        const events: AgentEvent[] = [];
        for await (const ev of agent.run({ userMessage: "hi" })) {
          events.push(ev);
        }
        assert.equal(events[events.length - 1].type, "turn-complete");
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
