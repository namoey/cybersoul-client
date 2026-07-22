/**
 * HistoryCompactor characterization tests.
 *
 * Layer B (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * §5.2). Pins the two critical contracts:
 *
 *   1. When history.length ≤ maxRawEntries, output is BYTE-IDENTICAL
 *      to today's buildHistoryTranscript (no behavior change for
 *      existing callers).
 *   2. When history.length > maxRawEntries, older entries are folded
 *      into a [BEFORE THAT] block; recent window stays verbatim.
 *
 * Also pins the bullet-summary format and the cache invalidation
 * semantics for the llm-summary strategy.
 */

import {
  HistoryCompactor,
  buildBulletSummary,
} from "./historyCompactor.js";
import type { HistoryEntry } from "../types.js";

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
      throw new Error(msg || `Expected "${needle}" in transcript`);
  },
};

function makeEntry(
  role: "user" | "assistant",
  content: string,
  minutesAgo = 0,
): HistoryEntry {
  return {
    role,
    content,
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
}

function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void | Promise<void> }[] = [
    {
      name: "HistoryCompactor — empty history returns empty transcript, not compacted",
      run: () => {
        const c = new HistoryCompactor();
        const result = c.compact([], "User", "Agent");
        assert.equal(result.transcript, "");
        assert.equal(result.wasCompacted, false);
      },
    },
    {
      name: "HistoryCompactor — history ≤ maxRawEntries: verbatim, not compacted",
      run: () => {
        const c = new HistoryCompactor({ maxRawEntries: 20 });
        const history = [
          makeEntry("user", "hi"),
          makeEntry("assistant", "hello"),
        ];
        const result = c.compact(history, "User", "Agent");
        assert.equal(result.wasCompacted, false);
        assert.equal(result.recentCount, 2);
        assert.equal(result.compactedCount, 0);
        // Verbatim transcript format must match buildHistoryTranscript
        assert.includes(result.transcript, "[CHAT HISTORY]");
        assert.includes(result.transcript, "User: hi");
        assert.includes(result.transcript, "Agent: hello");
      },
    },
    {
      name: "HistoryCompactor — history > maxRawEntries: compacts older, keeps recent verbatim",
      run: () => {
        const c = new HistoryCompactor({ maxRawEntries: 3 });
        const history: HistoryEntry[] = [
          makeEntry("user", "old1"),
          makeEntry("assistant", "old2"),
          makeEntry("user", "old3"),
          makeEntry("assistant", "recent1"),
          makeEntry("user", "recent2"),
        ];
        const result = c.compact(history, "User", "Agent");
        assert.equal(result.wasCompacted, true);
        assert.equal(result.recentCount, 3);
        assert.equal(result.compactedCount, 2);
        // Older entries folded into BEFORE THAT block
        assert.includes(result.transcript, "[BEFORE THAT");
        assert.includes(result.transcript, "old1");
        assert.includes(result.transcript, "old2");
        // Recent entries verbatim
        assert.includes(result.transcript, "recent1");
        assert.includes(result.transcript, "recent2");
      },
    },
    {
      name: "HistoryCompactor — bullet summary truncates long content to ~80 chars",
      run: () => {
        const longContent = "x".repeat(200);
        const summary = buildBulletSummary(
          [makeEntry("user", longContent)],
          "User",
          "Agent",
        );
        // Truncation marker present
        assert.includes(summary, "...");
        // Total content body < 200 chars (truncated)
        assert.ok(summary.length < longContent.length + 50);
      },
    },
    {
      name: "HistoryCompactor — bullet summary includes action text + media hint",
      run: () => {
        const summary = buildBulletSummary(
          [
            {
              role: "assistant",
              content: "look",
              actionText: "(turns around)",
              mediaHint: "photo",
              timestamp: new Date().toISOString(),
            },
          ],
          "User",
          "Agent",
        );
        assert.includes(summary, "(turns around)");
        assert.includes(summary, "[photo]");
      },
    },
    {
      name: "HistoryCompactor — llm-summary strategy uses cache, only re-summarizes past threshold",
      run: async () => {
        let summarizeCalls = 0;
        const summarizeFn = async (entries: HistoryEntry[]) => {
          summarizeCalls++;
          return `Summary of ${entries.length} entries`;
        };

        const c = new HistoryCompactor({
          maxRawEntries: 3,
          strategy: "llm-summary",
          reSummarizeThreshold: 2,
        });

        // First call with 5 entries (2 compacted): should summarize.
        let result = await c.compactAsync(
          [
            makeEntry("user", "1"),
            makeEntry("assistant", "2"),
            makeEntry("user", "3"),
            makeEntry("assistant", "4"),
            makeEntry("user", "5"),
          ],
          "User",
          "Agent",
          summarizeFn,
        );
        assert.equal(summarizeCalls, 1);
        assert.includes(result.transcript, "Summary of 2 entries");

        // Second call with same length: cache hit, no new summarize.
        result = await c.compactAsync(
          [
            makeEntry("user", "1"),
            makeEntry("assistant", "2"),
            makeEntry("user", "3"),
            makeEntry("assistant", "4"),
            makeEntry("user", "5"),
          ],
          "User",
          "Agent",
          summarizeFn,
        );
        assert.equal(summarizeCalls, 1); // still 1

        // Third call with 7 entries (4 compacted, 2 new since last summary):
        // crosses threshold → re-summarize.
        result = await c.compactAsync(
          [
            makeEntry("user", "1"),
            makeEntry("assistant", "2"),
            makeEntry("user", "3"),
            makeEntry("assistant", "4"),
            makeEntry("user", "5"),
            makeEntry("assistant", "6"),
            makeEntry("user", "7"),
          ],
          "User",
          "Agent",
          summarizeFn,
        );
        assert.equal(summarizeCalls, 2);
        assert.includes(result.transcript, "Summary of 4 entries");
      },
    },
    {
      name: "HistoryCompactor — summarizeFn failure falls back to bullet (never blocks turn)",
      run: async () => {
        const summarizeFn = async () => {
          throw new Error("summarize LLM down");
        };
        const c = new HistoryCompactor({
          maxRawEntries: 2,
          strategy: "llm-summary",
        });
        const result = await c.compactAsync(
          [
            makeEntry("user", "old1"),
            makeEntry("assistant", "old2"),
            makeEntry("user", "recent"),
          ],
          "User",
          "Agent",
          summarizeFn,
        );
        // Should NOT throw — falls back to bullet summary
        assert.includes(result.transcript, "[BEFORE THAT");
        assert.includes(result.transcript, "old1");
      },
    },
    {
      name: "HistoryCompactor — reset() invalidates the cache",
      run: async () => {
        let calls = 0;
        const summarizeFn = async (entries: HistoryEntry[]) => {
          calls++;
          return `summary ${entries.length}`;
        };
        const c = new HistoryCompactor({
          maxRawEntries: 2,
          strategy: "llm-summary",
        });
        const history = [
          makeEntry("user", "1"),
          makeEntry("assistant", "2"),
          makeEntry("user", "3"),
        ];
        await c.compactAsync(history, "User", "Agent", summarizeFn);
        assert.equal(calls, 1);
        await c.compactAsync(history, "User", "Agent", summarizeFn);
        assert.equal(calls, 1); // cached
        c.reset();
        await c.compactAsync(history, "User", "Agent", summarizeFn);
        assert.equal(calls, 2); // re-summarized after reset
      },
    },
    {
      name: "HistoryCompactor — default maxRawEntries is 20 (today's behavior)",
      run: () => {
        const c = new HistoryCompactor(); // no opts
        const history: HistoryEntry[] = [];
        for (let i = 0; i < 20; i++) {
          history.push(makeEntry("user", `msg${i}`));
        }
        const result = c.compact(history, "User", "Agent");
        // 20 entries = boundary, still verbatim
        assert.equal(result.wasCompacted, false);
      },
    },
  ];

  for (const t of tests) {
    try {
      t.run();
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
