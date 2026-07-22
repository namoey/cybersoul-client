/**
 * Phase 3.2 — auto-wired history compaction tests.
 *
 * Layer B (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * §5.2). Pins the wiring that closes Phase 3.1's deferrals:
 *
 *   3.2a — llm-summary strategy auto-wires client.summarizeHistory
 *          as the summarizeFn (callers don't pass it).
 *   3.2b — ContextManager-equivalent auto-invocation via the client's
 *          buildTranscript helper. Default OFF (today's slice); opt-in
 *          via CyberSoulClientConfig.historyCompaction; per-turn
 *          override via InteractParams.historyCompaction (null =
 *          explicitly disable).
 *
 * The test uses a stub LLM + API so it can deterministically verify
 * the transcript that reaches the LLM, without needing real backend
 * or LLM calls.
 */

import { CyberSoulClient } from "../client.js";
import type {
  CyberSoulClientConfig,
  HistoryEntry,
} from "../types.js";
import type { CyberSoulApi } from "../api/cyberSoulApi.js";

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
      throw new Error(msg || `Expected "${needle}" in:\n${haystack}`);
  },
  notIncludes: (haystack: string, needle: string, msg?: string) => {
    if (haystack.includes(needle))
      throw new Error(msg || `Expected "${needle}" NOT in transcript`);
  },
};

/**
 * Stub LLM that captures the user-message content it received, so the
 * test can assert what the transcript looked like. Returns a valid
 * dispatcher JSON so interact() succeeds.
 */
class CapturingLLM {
  public capturedUserContent: string | null = null;
  public summarizeCalls = 0;
  async generate(
    messages: { role: string; content: string }[],
  ): Promise<string> {
    // Capture the user-message content (which contains the transcript).
    const userMsg = messages.find((m) => m.role === "user");
    if (userMsg) this.capturedUserContent = userMsg.content;

    // Detect summarizeHistory call by its distinctive prompt shape.
    // The summarizer prompt is uniquely identified by "private journal"
    // — the dispatcher prompt also matches "first-person" so we can't
    // use that as the discriminator.
    const systemMsg = messages.find((m) => m.role === "system");
    if (
      systemMsg &&
      /private journal/i.test(systemMsg.content)
    ) {
      this.summarizeCalls++;
      return "They had a meaningful conversation earlier.";
    }

    // Dispatcher reply
    return JSON.stringify({
      textResponse: "ok",
      actionText: "",
      stateUpdate: null,
      isEndTurn: false,
    });
  }
}

function makeEntry(
  role: "user" | "assistant",
  content: string,
): HistoryEntry {
  return { role, content, timestamp: new Date().toISOString() };
}

function makeClient(
  config: Partial<CyberSoulClientConfig>,
  llm: CapturingLLM,
): CyberSoulClient {
  // Cast to access private fields for inspection; only used in tests.
  const client = new CyberSoulClient({
    characterKey: "test-key",
    backendUrl: "http://test",
    llmConfig: {
      provider: "test",
      apiKey: "k",
      model: "m",
    },
    ...config,
  });
  // Inject our stub LLM over the GenericLLMProvider the constructor built.
  (client as any).llm = llm;
  // Inject a stub API so we don't hit the network. The ContextManager
  // holds its own API reference (set at construction time) so we must
  // rebuild it with the stub too — otherwise state fetches still go
  // through the real API instance.
  const stubApi = {
    getState: async () => ({
      current_time: new Date().toISOString(),
      name: "TestChar",
      relationship_stage: "NEUTRAL",
      dynamic_context: { temperature: 50 },
    }),
    getWardrobe: async () => [],
    patchDynamicContext: async () => ({}),
    generatePrimitive: async () => ({ image_url: "", id: "" }),
  } as unknown as CyberSoulApi;
  (client as any).api = stubApi;
  (client as any).context = {
    // ContextManager-equivalent — just the methods the client uses.
    fetchState: async () => stubApi.getState(),
    getWardrobePromptStr: async () => "None available",
    prepareInteract: async (params: any) => {
      const state = await stubApi.getState();
      return {
        mode: "interact" as const,
        state,
        availableOutfits: "None available",
        types: params?.requestTypes ?? ["text"],
        isAuto: true,
        requestedOthers: [],
      };
    },
    prepareProactive: async (params: any) => {
      const state = await stubApi.getState();
      return {
        mode: "proactive" as const,
        state,
        availableOutfits: "None available",
        types: params?.requestTypes ?? [],
        requestedOthers: [],
        imageAllowed: false,
      };
    },
  };
  return client;
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void | Promise<void> }[] = [
    {
      name: "3.2 default (no config) — short history uses today's verbatim slice",
      run: async () => {
        const llm = new CapturingLLM();
        const client = makeClient({}, llm);
        await client.interact({
          userMessage: "hi",
          history: [
            makeEntry("user", "earlier message"),
            makeEntry("assistant", "earlier reply"),
          ],
        });
        assert.ok(llm.capturedUserContent !== null);
        assert.includes(llm.capturedUserContent!, "earlier message");
        assert.includes(llm.capturedUserContent!, "earlier reply");
      },
    },
    {
      name: "3.2 default (no config) — long history silently drops older entries (today's behavior preserved)",
      run: async () => {
        const llm = new CapturingLLM();
        const client = makeClient({}, llm);
        const history: HistoryEntry[] = [];
        for (let i = 0; i < 25; i++) {
          history.push(makeEntry("user", `msg-${i}`));
        }
        await client.interact({ userMessage: "hi", history });
        // Today's slice(-20) keeps the last 20, drops the first 5.
        // msg-0 through msg-4 should NOT appear; msg-5 should.
        assert.notIncludes(llm.capturedUserContent!, "msg-0");
        assert.notIncludes(llm.capturedUserContent!, "msg-4");
        assert.includes(llm.capturedUserContent!, "msg-5");
        assert.includes(llm.capturedUserContent!, "msg-24");
      },
    },
    {
      name: "3.2a opt-in bullet strategy — long history folds older entries into [BEFORE THAT]",
      run: async () => {
        const llm = new CapturingLLM();
        const client = makeClient(
          { historyCompaction: { strategy: "bullet", maxRawEntries: 5 } },
          llm,
        );
        const history: HistoryEntry[] = [];
        for (let i = 0; i < 10; i++) {
          history.push(makeEntry("user", `msg-${i}`));
        }
        await client.interact({ userMessage: "hi", history });
        // Bullet summary should fold msg-0..msg-4 into BEFORE THAT block
        assert.includes(llm.capturedUserContent!, "[BEFORE THAT");
        assert.includes(llm.capturedUserContent!, "msg-0");
        assert.includes(llm.capturedUserContent!, "msg-4");
        // Recent 5 entries should also be present (msg-5..msg-9)
        assert.includes(llm.capturedUserContent!, "msg-9");
      },
    },
    {
      name: "3.2a opt-in llm-summary strategy — auto-wires client.summarizeHistory, re-summarizes once then caches",
      run: async () => {
        const llm = new CapturingLLM();
        const client = makeClient(
          {
            historyCompaction: {
              strategy: "llm-summary",
              maxRawEntries: 3,
              reSummarizeThreshold: 2,
            },
          },
          llm,
        );
        const history: HistoryEntry[] = [];
        for (let i = 0; i < 5; i++) {
          history.push(makeEntry("user", `msg-${i}`));
        }
        await client.interact({ userMessage: "hi", history });
        // First turn: summarize fires once for the older 2 entries
        assert.equal(llm.summarizeCalls, 1);
        assert.includes(llm.capturedUserContent!, "[BEFORE THAT");
        assert.includes(llm.capturedUserContent!, "meaningful conversation");

        // Second turn with same history length — cache hit, no re-summarize
        await client.interact({ userMessage: "hi again", history });
        assert.equal(llm.summarizeCalls, 1);
      },
    },
    {
      name: "3.2b per-turn null override disables compaction for one turn",
      run: async () => {
        const llm = new CapturingLLM();
        const client = makeClient(
          { historyCompaction: { strategy: "bullet", maxRawEntries: 5 } },
          llm,
        );
        const history: HistoryEntry[] = [];
        for (let i = 0; i < 10; i++) {
          history.push(makeEntry("user", `msg-${i}`));
        }
        // Per-turn null disables → today's slice behavior
        await client.interact({
          userMessage: "hi",
          history,
          historyCompaction: null,
        });
        assert.notIncludes(llm.capturedUserContent!, "[BEFORE THAT");
        // Slice(-20) on 10 entries keeps all 10
        assert.includes(llm.capturedUserContent!, "msg-0");
      },
    },
    {
      name: "3.2b per-turn config override takes precedence over client default",
      run: async () => {
        const llm = new CapturingLLM();
        // Client default: bullet strategy, maxRaw 5
        const client = makeClient(
          { historyCompaction: { strategy: "bullet", maxRawEntries: 5 } },
          llm,
        );
        const history: HistoryEntry[] = [];
        for (let i = 0; i < 10; i++) {
          history.push(makeEntry("user", `msg-${i}`));
        }
        // Per-turn: bullet strategy, maxRaw 8 → fewer entries compacted
        await client.interact({
          userMessage: "hi",
          history,
          historyCompaction: { strategy: "bullet", maxRawEntries: 8 },
        });
        // With maxRaw=8, only msg-0 and msg-1 fold into BEFORE THAT
        assert.includes(llm.capturedUserContent!, "[BEFORE THAT");
        assert.includes(llm.capturedUserContent!, "msg-0");
        assert.includes(llm.capturedUserContent!, "msg-1");
        // msg-2..msg-9 are in the recent window
        assert.includes(llm.capturedUserContent!, "msg-9");
      },
    },
    {
      name: "3.2 compaction cache survives across turns (same config, no rebuild)",
      run: async () => {
        const llm = new CapturingLLM();
        const client = makeClient(
          {
            historyCompaction: {
              strategy: "llm-summary",
              maxRawEntries: 3,
              reSummarizeThreshold: 100, // high so we never re-summarize
            },
          },
          llm,
        );
        const history: HistoryEntry[] = [];
        for (let i = 0; i < 5; i++) {
          history.push(makeEntry("user", `msg-${i}`));
        }
        await client.interact({ userMessage: "turn 1", history });
        const callsAfterTurn1 = llm.summarizeCalls;
        await client.interact({ userMessage: "turn 2", history });
        await client.interact({ userMessage: "turn 3", history });
        // Same history length → no re-summarize across turns
        assert.equal(llm.summarizeCalls, callsAfterTurn1);
      },
    },
    {
      name: "3.2 proactive path also respects historyCompaction config",
      run: async () => {
        const llm = new CapturingLLM();
        const client = makeClient(
          { historyCompaction: { strategy: "bullet", maxRawEntries: 3 } },
          llm,
        );
        const history: HistoryEntry[] = [];
        for (let i = 0; i < 6; i++) {
          history.push(makeEntry("user", `msg-${i}`));
        }
        await client.proactiveInteract({ history });
        assert.includes(llm.capturedUserContent!, "[BEFORE THAT");
        assert.includes(llm.capturedUserContent!, "msg-0");
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
