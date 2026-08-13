/**
 * Recall chat-history tool characterization tests.
 *
 * Layer B style — see `cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md`
 * §5.2. Pins the formatter caps, the OR-matching contract forwarded to
 * the searcher, the description's "Today is …" injection, and the
 * builder wiring.
 *
 * Plain Node script (matches the repo's no-jest convention): compile to
 * `dist/` and run via `node dist/tools/recallChatHistoryTool.test.js`.
 */

import {
  buildRecallChatHistoryTool,
  formatRecallTranscript,
  buildRecallChatHistoryDescription,
  DEFAULT_MAX_HITS,
  DEFAULT_MAX_TRANSCRIPT_CHARS,
  type ChatHistorySearcher,
  type RecallChatHistoryHit,
} from "../tools/recallChatHistoryTool.js";
import type { Tool } from "../agent/types.js";

const assert = {
  equal: (a: any, b: any, msg?: string) => {
    if (a !== b)
      throw new Error(
        msg || `Assertion failed: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`,
      );
  },
  deepEqual: (a: any, b: any, msg?: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(
        msg ||
          `Deep assertion failed: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`,
      );
  },
  ok: (condition: any, msg?: string) => {
    if (!condition)
      throw new Error(msg || "Assertion failed: expected truthy value");
  },
};

/** Build a hit quickly. */
function hit(
  role: "user" | "assistant",
  content: string,
  isoTs: string,
): RecallChatHistoryHit {
  return { role, content, timestamp: new Date(isoTs).getTime() };
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void | Promise<void> }[] = [
    /* ---------------------------- formatter --------------------------- */

    {
      name: "formatRecallTranscript — empty hits → empty transcript, not truncated",
      run: () => {
        const out = formatRecallTranscript([]);
        assert.deepEqual(out, { transcript: "", hitCount: 0, truncated: false });
      },
    },
    {
      name: "formatRecallTranscript — one hit → single line with stamp + role + content",
      run: () => {
        const out = formatRecallTranscript([
          hit("user", "I fought with my boss", "2026-08-11T22:14:00.000Z"),
        ]);
        assert.equal(out.hitCount, 1);
        assert.equal(out.truncated, false);
        // Line shape: [YYYY-MM-DD HH:MM] role: content. Date is rendered
        // in the runtime's local timezone, so assert structurally rather
        // than on the exact stamp.
        assert.ok(/^\[.*\] user: I fought with my boss$/.test(out.transcript));
      },
    },
    {
      name: "formatRecallTranscript — multiple hits joined with newline, chronological order preserved",
      run: () => {
        const out = formatRecallTranscript([
          hit("user", "first", "2026-08-11T22:14:00.000Z"),
          hit("assistant", "second", "2026-08-11T22:15:00.000Z"),
        ]);
        assert.equal(out.hitCount, 2);
        assert.ok(out.transcript.includes("user: first"));
        assert.ok(out.transcript.includes("assistant: second"));
        // First hit appears before the second in the output.
        assert.ok(
          out.transcript.indexOf("user: first") <
            out.transcript.indexOf("assistant: second"),
        );
        assert.equal(out.truncated, false);
      },
    },
    {
      name: "formatRecallTranscript — maxHits cap sets truncated",
      run: () => {
        const hits: RecallChatHistoryHit[] = Array.from({ length: 15 }, (_, i) =>
          hit("user", `m${i}`, `2026-08-01T00:0${i % 10}:00.000Z`),
        );
        const out = formatRecallTranscript(hits, 5, 10000);
        assert.equal(out.hitCount, 5);
        assert.equal(out.truncated, true);
        assert.ok(out.transcript.includes("m0"));
        assert.ok(out.transcript.includes("[…more matches omitted]"));
      },
    },
    {
      name: "formatRecallTranscript — maxChars cap sets truncated, stops before exceeding",
      run: () => {
        const hits: RecallChatHistoryHit[] = Array.from({ length: 10 }, (_, i) =>
          hit("assistant", `x`.repeat(50), `2026-08-01T00:0${i}:00.000Z`),
        );
        const out = formatRecallTranscript(hits, 10, 120);
        assert.equal(out.truncated, true);
        assert.ok(
          out.transcript.length <= 120,
          `transcript must not exceed cap (was ${out.transcript.length})`,
        );
      },
    },
    {
      name: "formatRecallTranscript — collapses internal whitespace and trims content",
      run: () => {
        const out = formatRecallTranscript([
          hit("user", "  hello\n\n   world  ", "2026-08-11T22:14:00.000Z"),
        ]);
        assert.ok(/user: hello world$/.test(out.transcript));
        assert.ok(!out.transcript.includes("\n\n"));
      },
    },

    /* --------------------------- description -------------------------- */

    {
      name: "buildRecallChatHistoryDescription — injects the provided date as ISO",
      run: () => {
        const fixed = new Date("2026-08-12T03:45:00.000Z");
        const desc = buildRecallChatHistoryDescription(() => fixed);
        assert.ok(desc.includes("Today is 2026-08-12T03:45:00.000Z"));
        // Triggering guidance is intact.
        assert.ok(desc.includes("do you remember"));
        assert.ok(desc.includes("query"));
      },
    },

    /* ----------------------------- builder ---------------------------- */

    {
      name: "buildRecallChatHistoryTool — identity + schema shape",
      run: () => {
        const noop: ChatHistorySearcher = () => [];
        const tool: Tool = buildRecallChatHistoryTool(noop);
        assert.equal(tool.name, "recall_chat_history");
        assert.ok(tool.description.length > 0);
        const schema = tool.inputSchema as any;
        assert.equal(schema.type, "object");
        assert.ok(schema.properties.query);
        assert.equal(schema.properties.query.type, "array");
        assert.ok(schema.properties.dateFrom);
        assert.ok(schema.properties.dateTo);
        assert.deepEqual(schema.properties.role.enum, ["user", "assistant"]);
        assert.ok(schema.properties.limit);
      },
    },
    {
      name: "buildRecallChatHistoryTool — execute returns formatted transcript from searcher hits",
      async run() {
        const searcher: ChatHistorySearcher = () => [
          hit("user", "Paris trip booked", "2026-08-05T10:00:00.000Z"),
          hit("assistant", "How exciting!", "2026-08-05T10:01:00.000Z"),
        ];
        const tool = buildRecallChatHistoryTool(searcher);
        const result = await tool.execute(
          { query: ["Paris"] },
          {} as any, // ToolContext unused by this tool.
        );
        assert.equal(result.hitCount, 2);
        assert.equal(result.truncated, false);
        assert.ok(result.transcript.includes("Paris trip booked"));
        assert.ok(result.transcript.includes("How exciting!"));
      },
    },
    {
      name: "buildRecallChatHistoryTool — execute forwards args verbatim to the searcher",
      async run() {
        let captured: any = null;
        const searcher: ChatHistorySearcher = (args) => {
          captured = args;
          return [];
        };
        const tool = buildRecallChatHistoryTool(searcher);
        await tool.execute(
          {
            query: ["boss", "Sarah"],
            dateFrom: "2026-08-04T00:00:00.000Z",
            dateTo: "2026-08-10T00:00:00.000Z",
            role: "user",
            limit: 7,
          },
          {} as any,
        );
        assert.deepEqual(captured.query, ["boss", "Sarah"]);
        assert.equal(captured.dateFrom, "2026-08-04T00:00:00.000Z");
        assert.equal(captured.dateTo, "2026-08-10T00:00:00.000Z");
        assert.equal(captured.role, "user");
        // `limit` is clamped to maxHits only when it exceeds the cap.
        assert.equal(captured.limit, 7);
      },
    },
    {
      name: "buildRecallChatHistoryTool — execute clamps limit to maxHits when LLM asks for more",
      async run() {
        let captured: any = null;
        const searcher: ChatHistorySearcher = (args) => {
          captured = args;
          return [];
        };
        const tool = buildRecallChatHistoryTool(searcher, { maxHits: 5 });
        await tool.execute({ limit: 100 }, {} as any);
        assert.equal(captured.limit, 5);
      },
    },
    {
      name: "buildRecallChatHistoryTool — execute defaults limit to maxHits when omitted",
      async run() {
        let captured: any = null;
        const searcher: ChatHistorySearcher = (args) => {
          captured = args;
          return [];
        };
        const tool = buildRecallChatHistoryTool(searcher); // default cap 10
        await tool.execute({}, {} as any);
        assert.equal(captured.limit, DEFAULT_MAX_HITS);
      },
    },
    {
      name: "buildRecallChatHistoryTool — awaits an async searcher",
      async run() {
        const searcher: ChatHistorySearcher = async () => {
          // Yield once to genuinely produce a promise.
          await Promise.resolve();
          return [hit("user", "async hello", "2026-08-11T22:14:00.000Z")];
        };
        const tool = buildRecallChatHistoryTool(searcher);
        const result = await tool.execute({}, {} as any);
        assert.equal(result.hitCount, 1);
        assert.ok(result.transcript.includes("async hello"));
      },
    },
    {
      name: "buildRecallChatHistoryTool — searcher caps apply on top of formatter caps (formatter is backstop)",
      async run() {
        // The host searcher is responsible for keyword/date filtering.
        // Here it returns more than maxHits to prove the formatter caps.
        const searcher: ChatHistorySearcher = () =>
          Array.from({ length: 50 }, (_, i) =>
            hit("user", `m${i}`, `2026-08-01T00:00:0${i % 10}:00.000Z`),
          );
        const tool = buildRecallChatHistoryTool(searcher, {
          maxHits: 3,
          maxTranscriptChars: DEFAULT_MAX_TRANSCRIPT_CHARS,
        });
        const result = await tool.execute({}, {} as any);
        assert.equal(result.hitCount, 3);
        assert.equal(result.truncated, true);
      },
    },
    {
      name: "buildRecallChatHistoryTool — now() flows into the description",
      run: () => {
        const fixed = new Date("2026-01-02T00:00:00.000Z");
        const tool = buildRecallChatHistoryTool(() => [], { now: () => fixed });
        assert.ok(tool.description.includes("Today is 2026-01-02T00:00:00.000Z"));
      },
    },
    {
      name: "buildRecallChatHistoryTool — empty transcript on empty searcher result, not truncated",
      async run() {
        const tool = buildRecallChatHistoryTool(() => []);
        const result = await tool.execute({ query: ["nothing"] }, {} as any);
        assert.equal(result.transcript, "");
        assert.equal(result.hitCount, 0);
        assert.equal(result.truncated, false);
      },
    },
  ];

  // Sequential await so an async failure is attributed to the right test.
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
