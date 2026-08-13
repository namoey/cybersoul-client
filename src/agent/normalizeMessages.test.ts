/**
 * `normalizeMessagesForProvider` regression tests.
 *
 * Pins the DeepSeek thinking-mode reasoning_content passthrough — the
 * root cause of the HTTP 400 "The reasoning_content in the thinking
 * mode must be passed back to the API" bug (2026-08-14).
 *
 * THE BUG: the old passthrough used a truthiness check
 * (`if (msg.reasoning_content)`) which STRIPPED empty strings. So when
 * the agent loop echoed an assistant tool-call turn whose
 * reasoning_content was "" (legitimate — the model doesn't always
 * think before every tool call), the provider layer deleted the field
 * before the request went out, and DeepSeek rejected the request.
 *
 * THE FIX: pass `reasoning_content` through whenever it's a string AND
 * the message carries `tool_calls` (the exact combination DeepSeek
 * requires). Non-tool-call messages keep the truthiness gate so plain
 * turns don't sprout empty reasoning fields.
 */

import { normalizeMessagesForProvider } from "../llm.provider.js";

const assert = {
  equal: (a: any, b: any, msg?: string) => {
    if (a !== b)
      throw new Error(
        msg || `Assertion failed: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`,
      );
  },
  ok: (condition: any, msg?: string) => {
    if (!condition) throw new Error(msg || "Assertion failed: expected truthy value");
  },
};

async function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void | Promise<void> }[] = [
    {
      name: "assistant tool_call message preserves NON-EMPTY reasoning_content",
      run() {
        const out = normalizeMessagesForProvider([
          {
            role: "assistant",
            content: "",
            reasoning_content: "thinking about Paris",
            tool_calls: [{ id: "c1", type: "function", function: { name: "speak", arguments: "{}" } }],
          } as any,
        ]);
        assert.equal(out[0].reasoning_content, "thinking about Paris");
        assert.ok(Array.isArray(out[0].tool_calls));
      },
    },
    {
      name: "REGRESSION: assistant tool_call message preserves EMPTY-STRING reasoning_content (DeepSeek 400 root cause)",
      run() {
        // This is the exact shape that caused the HTTP 400. The model
        // returned tool_calls with no reasoning, the loop echoed
        // reasoning_content: "" , and the old truthiness gate stripped
        // it → DeepSeek rejected the request.
        const out = normalizeMessagesForProvider([
          {
            role: "assistant",
            content: "",
            reasoning_content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "recall_chat_history", arguments: "{}" } }],
          } as any,
        ]);
        assert.equal(
          out[0].reasoning_content,
          "",
          "empty-string reasoning_content MUST be preserved on tool_call messages",
        );
        assert.ok(Array.isArray(out[0].tool_calls));
      },
    },
    {
      name: "assistant message WITHOUT tool_calls omits reasoning_content when empty (no field pollution)",
      run() {
        const out = normalizeMessagesForProvider([
          { role: "assistant", content: "hi there", reasoning_content: "" } as any,
        ]);
        assert.ok(
          out[0].reasoning_content === undefined,
          "empty reasoning on a non-tool-call message should NOT be emitted",
        );
      },
    },
    {
      name: "tool-result message normalizes to {role:'tool', tool_call_id, content}",
      run() {
        const out = normalizeMessagesForProvider([
          { role: "tool", content: '{"hitCount":3}', toolCallId: "c1" } as any,
        ]);
        assert.equal(out[0].role, "tool");
        assert.equal(out[0].content, '{"hitCount":3}');
        assert.equal(out[0].tool_call_id, "c1");
        // No reasoning_content or tool_calls on tool messages.
        assert.ok(out[0].reasoning_content === undefined);
        assert.ok(out[0].tool_calls === undefined);
      },
    },
    {
      name: "plain user/system messages pass through with role + content only",
      run() {
        const out = normalizeMessagesForProvider([
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ]);
        assert.equal(out[0].role, "system");
        assert.equal(out[0].content, "sys");
        assert.equal(out[1].role, "user");
        assert.equal(out[1].content, "hi");
        assert.ok(out[0].reasoning_content === undefined);
        assert.ok(out[1].reasoning_content === undefined);
      },
    },
    {
      name: "multi-message conversation: tool_call assistant keeps reasoning even when neighbors lack it",
      run() {
        // Mirrors the real failing trace: [2] reasoning+tools,
        // [4] reasoning+tools, [7] NO-reasoning+tools (the 400 site).
        const out = normalizeMessagesForProvider([
          { role: "system", content: "sys" },
          { role: "user", content: "u" },
          { role: "assistant", content: "", reasoning_content: "r2", tool_calls: [{ id: "c2", type: "function", function: { name: "speak", arguments: "{}" } }] } as any,
          { role: "tool", content: "res2", toolCallId: "c2" } as any,
          { role: "assistant", content: "", reasoning_content: "r4", tool_calls: [{ id: "c4", type: "function", function: { name: "recall_chat_history", arguments: "{}" } }] } as any,
          { role: "tool", content: "res4", toolCallId: "c4" } as any,
          { role: "assistant", content: "", reasoning_content: "", tool_calls: [{ id: "c7", type: "function", function: { name: "recall_chat_history", arguments: "{}" } }] } as any,
          { role: "tool", content: "res7", toolCallId: "c7" } as any,
        ]);
        // [2] + [4] keep their reasoning.
        assert.equal(out[2].reasoning_content, "r2");
        assert.equal(out[4].reasoning_content, "r4");
        // [7] keeps its empty-string reasoning — the regression.
        assert.equal(out[6].reasoning_content, "");
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

await runTests();
