/**
 * Phase 2.1 — capability-mismatch + provider-rejects-tools error tests.
 *
 * Layer B (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * §5.2). These pin the two error paths added in Phase 2.1:
 *
 *   Scenario D — `runInteractDispatchWithTools` /
 *   `runProactiveDispatchWithTools` must throw a typed
 *   `CyberSoulError` (kind `"llm-capability-mismatch"`) when the
 *   provider doesn't implement `chat()`, instead of letting the
 *   non-null assertion produce a confusing `TypeError`.
 *
 *   Scenario B — `GenericLLMProvider.chat()`'s 4xx error message must
 *   include the actionable "unset capabilities.toolCalling" hint when
 *   the provider's error message looks tool-related (contains
 *   "tool"/"function"/"unsupported"/"unknown param"). Non-tool 4xx
 *   errors must NOT get the hint.
 *
 * Both paths must throw CyberSoulError subclasses so `client.ts`'s
 * outer catch re-throws them (instead of wrapping in the legacy
 * `{ status: "error" }` envelope) and callers can `instanceof`-branch.
 */

import { AgentHarness } from "../agent/agentHarness.js";
import { EventStream } from "../agent/eventStream.js";
import { GenericLLMProvider } from "../llm.provider.js";
import {
  CyberSoulError,
  CyberSoulLlmApiError,
} from "../errors.js";
import type {
  BaseLLMProvider,
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
  /** Async-only throws helper. Accepts a function that may be sync or
   *  async; awaits it so rejected promises surface as caught errors. */
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
          msg ||
            `Expected predicate to match thrown error, got: ${e?.message ?? e}`,
        );
      }
    }
  },
};

/** Minimal provider that does NOT implement chat() — simulates a custom
 *  provider or an old GenericLLMProvider before Phase 2. */
class GenerateOnlyProvider implements BaseLLMProvider {
  generate(): Promise<string> {
    return Promise.resolve("{}");
  }
  // chat() intentionally absent.
}

/** Provider stub that throws a specific error from chat() — used to
 *  verify the 4xx message-improvement path in GenericLLMProvider. */
class StubProvider implements BaseLLMProvider {
  generate(): Promise<string> {
    return Promise.resolve("{}");
  }
  constructor(private chatImpl: () => Promise<never>) {}
  async chat(): Promise<never> {
    return this.chatImpl();
  }
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void | Promise<void> }[] = [
    // ---------- Scenario D: capability-mismatch guard ----------

    {
      name: "Scenario D — runInteractDispatchWithTools throws CyberSoulError(kind=llm-capability-mismatch) when provider lacks chat()",
      run: async () => {
        const provider = new GenerateOnlyProvider();
        const harness = new AgentHarness(provider, new EventStream());
        await assert.throws(
          async () => {
            await harness.runInteractDispatchWithTools([], []);
          },
          (e) =>
            e instanceof CyberSoulError &&
            (e as CyberSoulError).kind === "llm-capability-mismatch" &&
            /does not implement chat/.test((e as Error).message),
          "Expected typed CyberSoulError with kind=llm-capability-mismatch",
        );
      },
    },
    {
      name: "Scenario D — runProactiveDispatchWithTools throws CyberSoulError(kind=llm-capability-mismatch) when provider lacks chat()",
      run: async () => {
        const provider = new GenerateOnlyProvider();
        const harness = new AgentHarness(provider, new EventStream());
        await assert.throws(
          async () => {
            await harness.runProactiveDispatchWithTools([], []);
          },
          (e) =>
            e instanceof CyberSoulError &&
            (e as CyberSoulError).kind === "llm-capability-mismatch",
          "Expected typed CyberSoulError with kind=llm-capability-mismatch",
        );
      },
    },
    {
      name: "Scenario D — error message names the exact knob (capabilities.toolCalling)",
      run: async () => {
        const provider = new GenerateOnlyProvider();
        const harness = new AgentHarness(provider, new EventStream());
        try {
          await harness.runInteractDispatchWithTools([], []);
          throw new Error("should have thrown");
        } catch (e: any) {
          assert.ok(
            /capabilities\.toolCalling/.test(e?.message),
            "Error message should name the knob: " + e?.message,
          );
          assert.ok(
            /JSON-dispatcher/.test(e?.message),
            "Error message should name the fallback path: " + e?.message,
          );
        }
      },
    },
    {
      name: "Scenario D — guard does NOT fire when provider implements chat()",
      run: async () => {
        // A provider that DOES implement chat() (even if it would fail
        // later) must pass the guard. We stub chat() to throw a
        // non-capability error to prove we got past the guard.
        const provider = new StubProvider(async () => {
          throw new Error("past the guard");
        });
        const harness = new AgentHarness(provider, new EventStream());
        try {
          await harness.runInteractDispatchWithTools([], []);
          throw new Error("should have thrown");
        } catch (e: any) {
          assert.equal(
            e?.message,
            "past the guard",
            "Should reach chat() and surface its error, not the capability-mismatch guard",
          );
        }
      },
    },

    // ---------- Scenario B: chat() 4xx message improvement ----------
    // (Verified via direct GenericLLMProvider construction with a
    // mocked fetchImpl so we don't need a real provider endpoint.)

    {
      name: "Scenario B — tool-related 4xx error appends the unset-toolCalling hint",
      run: async () => {
        let callCount = 0;
        const fetchImpl = (async () => {
          callCount++;
          if (callCount === 1) {
            // Template response
            return new Response(
              JSON.stringify({
                apiUrl: "http://provider/chat",
                headersTemplate: {},
                basePayload: {},
                responsePath: "choices.0.message.content",
                toolsPayloadTemplate: { tools: "{{tools}}" },
                toolCallsResponsePath: "choices.0.message.tool_calls",
                toolCallArgsResponsePath: "function.arguments",
              }),
              { status: 200 },
            );
          }
          // Chat call returns 400 with a tool-related error
          return new Response(
            JSON.stringify({ error: "unknown parameter: tools" }),
            { status: 400 },
          );
        }) as unknown as typeof fetch;

        // Use a UNIQUE provider:model combo per test so the static
        // GenericLLMProvider.templateCache (shared across instances)
        // doesn't leak the previous test's template into this one.
        const providerWithFetch = new GenericLLMProvider(
          { provider: "test-tool-related", apiKey: "k", model: "m" },
          "http://backend",
          undefined,
          fetchImpl,
        );

        try {
          await providerWithFetch.chat({
            messages: [{ role: "user", content: "hi" }],
            tools: [
              {
                name: "speak",
                description: "",
                inputSchema: {},
              } satisfies LLMToolDeclaration,
            ],
          });
          throw new Error("should have thrown");
        } catch (e: any) {
          assert.ok(
            e instanceof CyberSoulLlmApiError,
            "Expected CyberSoulLlmApiError, got: " + e?.constructor?.name,
          );
          assert.ok(
            /unset llmConfig\.capabilities\.toolCalling/.test(e?.message),
            "Expected the actionable hint in the message: " + e?.message,
          );
        }
      },
    },
    {
      name: "Scenario B — non-tool 4xx error does NOT append the hint",
      run: async () => {
        let callCount = 0;
        const fetchImpl = (async () => {
          callCount++;
          if (callCount === 1) {
            return new Response(
              JSON.stringify({
                apiUrl: "http://provider/chat",
                headersTemplate: {},
                basePayload: {},
                responsePath: "choices.0.message.content",
                toolsPayloadTemplate: { tools: "{{tools}}" },
                toolCallsResponsePath: "choices.0.message.tool_calls",
                toolCallArgsResponsePath: "function.arguments",
              }),
              { status: 200 },
            );
          }
          // 400 with a NON-tool-related error
          return new Response(
            JSON.stringify({ error: "model not found" }),
            { status: 400 },
          );
        }) as unknown as typeof fetch;

        // UNIQUE provider:model combo — see note above on the static
        // template cache.
        const provider = new GenericLLMProvider(
          { provider: "test-non-tool", apiKey: "k", model: "m" },
          "http://backend",
          undefined,
          fetchImpl,
        );

        try {
          await provider.chat({
            messages: [{ role: "user", content: "hi" }],
            tools: [],
          });
          throw new Error("should have thrown");
        } catch (e: any) {
          assert.ok(
            e instanceof CyberSoulLlmApiError,
            "Expected CyberSoulLlmApiError, got: " + e?.constructor?.name,
          );
          assert.ok(
            !/unset llmConfig\.capabilities\.toolCalling/.test(e?.message),
            "Non-tool 4xx should NOT get the hint: " + e?.message,
          );
        }
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
