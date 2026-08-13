/**
 * Phase 4.1 — streaming reasoning_content capture tests.
 *
 * Pins the SSE parser's accumulation of `delta.reasoning_content` from
 * thinking-mode models (DeepSeek-V4) into the `message-complete`
 * event's `reasoningContent` field.
 *
 * WHY THIS MATTERS: DeepSeek's thinking mode requires that a prior
 * thinking turn's `reasoning_content` be passed back on the assistant
 * message when continuing the conversation — otherwise the API returns
 * HTTP 400 "The reasoning_content in the thinking mode must be passed
 * back to the API." The streaming parser must therefore capture the
 * streamed reasoning deltas so a streaming-capable loop (or any
 * caller) can echo them back, mirroring the non-streaming `chat()`
 * extraction at `llm.provider.ts:711`.
 *
 * Test strategy: feed real SSE bytes through `GenericLLMProvider.
 * chatStream()` via a mock `fetchImpl` that returns a `ReadableStream`.
 * The mock distinguishes the template-fetch URL from the chat URL by
 * path so both calls resolve correctly.
 */

import { GenericLLMProvider } from "../llm.provider.js";
import type { LLMStreamEvent } from "../types.js";

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

/**
 * A minimal LLM template advertising streaming support, shaped exactly
 * like the backend `/api/v1/cyber-soul/llm-models/template` response.
 */
const TEMPLATE = {
  apiUrl: "https://llm.example.com/v1/chat/completions",
  headersTemplate: { Authorization: "Bearer {{apiKey}}" },
  basePayload: { model: "deepseek-v4" },
  responsePath: "choices.0.message.content",
  // Tool-calling fields (so the template "supports" it — not exercised
  // by these streaming tests, but realistic for DeepSeek-V4).
  toolsPayloadTemplate: { tools: "{{tools}}" },
  toolCallsResponsePath: "choices.0.message.tool_calls",
  toolCallArgsResponsePath: "function.arguments",
  // Streaming fields.
  streamMode: "sse",
  streamDeltaPath: "choices.0.delta.content",
};

/**
 * Build a mock fetchImpl. Template-fetch URLs return the template
 * JSON; the chat URL returns a `ReadableStream` of the supplied SSE
 * bytes. This mirrors how the provider calls fetch for both.
 */
function buildMockFetch(sseBody: string) {
  return async (url: string | URL, _init?: any): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/llm-models/template")) {
      return new Response(JSON.stringify(TEMPLATE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Chat completions endpoint → stream the SSE body.
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
}

/** Collect all events from an async iterable into an array. */
async function collect(iter: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void | Promise<void> }[] = [
    {
      name: "4.1 stream — reasoning_content deltas accumulate into message-complete.reasoningContent",
      async run() {
        const sse = [
          // Reasoning deltas arrive BEFORE the content deltas (DeepSeek
          // thinking-mode emits reasoning first, then the answer).
          "data: " + JSON.stringify({
            choices: [{ delta: { reasoning_content: "Let me think. " } }],
          }) + "\n\n",
          "data: " + JSON.stringify({
            choices: [{ delta: { reasoning_content: "The user said Paris." } }],
          }) + "\n\n",
          // Content deltas.
          "data: " + JSON.stringify({
            choices: [{ delta: { content: "Yes, " } }],
          }) + "\n\n",
          "data: " + JSON.stringify({
            choices: [{ delta: { content: "Paris!" } }],
          }) + "\n\n",
          "data: [DONE]\n\n",
        ].join("");
        const provider = new GenericLLMProvider(
          { provider: "test-stream-reasoning", model: "v4", apiKey: "k" },
          "https://backend.example.com",
          undefined,
          buildMockFetch(sse) as any,
        );
        const events = await collect(provider.chatStream!({
          messages: [{ role: "user", content: "hi" }],
          tools: [],
        }));
        const complete = events.find((e) => e.type === "message-complete") as
          Extract<LLMStreamEvent, { type: "message-complete" }>;
        assert.ok(complete, "expected a message-complete event");
        assert.equal(
          complete.reasoningContent,
          "Let me think. The user said Paris.",
          "reasoning_content deltas must be concatenated",
        );
        assert.equal(complete.textResponse, "Yes, Paris!");
      },
    },
    {
      name: "4.1 stream — no reasoning_content → message-complete.reasoningContent is undefined (not empty string)",
      async run() {
        const sse = [
          "data: " + JSON.stringify({
            choices: [{ delta: { content: "hello" } }],
          }) + "\n\n",
          "data: [DONE]\n\n",
        ].join("");
        const provider = new GenericLLMProvider(
          { provider: "test-stream-no-reasoning", model: "v4", apiKey: "k" },
          "https://backend.example.com",
          undefined,
          buildMockFetch(sse) as any,
        );
        const events = await collect(provider.chatStream!({
          messages: [{ role: "user", content: "hi" }],
          tools: [],
        }));
        const complete = events.find((e) => e.type === "message-complete") as
          Extract<LLMStreamEvent, { type: "message-complete" }>;
        assert.ok(complete);
        assert.equal(
          complete.reasoningContent,
          undefined,
          "reasoningContent must be omitted when no reasoning deltas arrived",
        );
      },
    },
    {
      name: "4.1 stream — reasoning captured even when stream ends WITHOUT [DONE]",
      async run() {
        // Stream that closes mid-flight (no [DONE] marker). The parser
        // must still emit message-complete with the reasoning it saw.
        const sse = [
          "data: " + JSON.stringify({
            choices: [{ delta: { reasoning_content: "partial reasoning" } }],
          }) + "\n\n",
          "data: " + JSON.stringify({
            choices: [{ delta: { content: "partial text" } }],
          }) + "\n\n",
        ].join("");
        const provider = new GenericLLMProvider(
          { provider: "test-stream-undone", model: "v4", apiKey: "k" },
          "https://backend.example.com",
          undefined,
          buildMockFetch(sse) as any,
        );
        const events = await collect(provider.chatStream!({
          messages: [{ role: "user", content: "hi" }],
          tools: [],
        }));
        const complete = events.find((e) => e.type === "message-complete") as
          Extract<LLMStreamEvent, { type: "message-complete" }>;
        assert.ok(complete, "stream without [DONE] must still emit message-complete");
        assert.equal(complete.reasoningContent, "partial reasoning");
        assert.equal(complete.textResponse, "partial text");
      },
    },
    {
      name: "4.1 stream — reasoning deltas intermixed with content deltas concatenate in arrival order",
      async run() {
        // Some providers interleave reasoning + content deltas. Each
        // stream appends in arrival order independently.
        const sse = [
          "data: " + JSON.stringify({
            choices: [{ delta: { reasoning_content: "R1 ", content: "C1 " } }],
          }) + "\n\n",
          "data: " + JSON.stringify({
            choices: [{ delta: { reasoning_content: "R2", content: "C2" } }],
          }) + "\n\n",
          "data: [DONE]\n\n",
        ].join("");
        const provider = new GenericLLMProvider(
          { provider: "test-stream-interleaved", model: "v4", apiKey: "k" },
          "https://backend.example.com",
          undefined,
          buildMockFetch(sse) as any,
        );
        const events = await collect(provider.chatStream!({
          messages: [{ role: "user", content: "hi" }],
          tools: [],
        }));
        const complete = events.find((e) => e.type === "message-complete") as
          Extract<LLMStreamEvent, { type: "message-complete" }>;
        assert.ok(complete);
        assert.equal(complete.reasoningContent, "R1 R2");
        assert.equal(complete.textResponse, "C1 C2");
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
