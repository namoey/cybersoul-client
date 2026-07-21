/**
 * EventStream characterization tests.
 *
 * Layer B (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * §5.2). The EventStream is the §6.4 low-risk win that unifies the
 * four ad-hoc callbacks into a single sink. These tests pin the
 * legacy-callback re-emission semantics:
 *
 *  - Each legacy callback fires with EXACTLY the same args it had
 *    before (§5.4 items 1, 2).
 *  - Callback exceptions are caught and swallowed, NOT rethrown
 *    (matches today's inlined try/catch around every callback site).
 *  - Phase 2+ events (text-delta, tool-call, tool-result, turn-
 *    complete) are accepted but no-op (Phase 1 doesn't emit them).
 */

import { EventStream } from "../agent/eventStream.js";
import type {
  InteractMetadata,
  MediaReadyPayload,
  OutfitGiftedPayload,
  PersistedDynamicContext,
} from "../types.js";

const assert = {
  equal: (a: any, b: any, msg?: string) => {
    if (a !== b) throw new Error(msg || `Assertion failed: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  },
  deepEqual: (a: any, b: any, msg?: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(msg || `Deep assertion failed`);
  },
  ok: (condition: any, msg?: string) => {
    if (!condition) throw new Error(msg || "Assertion failed: expected truthy value");
  },
};

function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void }[] = [
    {
      name: "EventStream — text-ready re-emits to onTextReady with identical args",
      run: () => {
        let captured: any = null;
        const sink = new EventStream().attachLegacy({
          onTextReady: (text, actionText, metadata) => {
            captured = { text, actionText, metadata };
          },
        });
        const metadata: InteractMetadata = { isEndTurn: false };
        sink.emit({
          type: "text-ready",
          text: "hello",
          actionText: "(smiles)",
          metadata,
        });
        assert.equal(captured.text, "hello");
        assert.equal(captured.actionText, "(smiles)");
        assert.deepEqual(captured.metadata, metadata);
      },
    },
    {
      name: "EventStream — state-ready re-emits to onStateReady with persisted snapshot",
      run: () => {
        let captured: PersistedDynamicContext | null = null;
        const sink = new EventStream().attachLegacy({
          onStateReady: (persisted) => {
            captured = persisted;
          },
        });
        const persisted: PersistedDynamicContext = {
          temperature: 65,
          relationshipStage: "CLOSE",
        };
        sink.emit({ type: "state-ready", persisted });
        assert.deepEqual(captured, persisted);
      },
    },
    {
      name: "EventStream — state-ready fires with empty object {} (§5.4 item 2 contract)",
      run: () => {
        let captured: any = null;
        const sink = new EventStream().attachLegacy({
          onStateReady: (persisted) => {
            captured = persisted;
          },
        });
        sink.emit({ type: "state-ready", persisted: {} });
        assert.deepEqual(captured, {});
      },
    },
    {
      name: "EventStream — media-ready re-emits to onMediaReady with payload",
      run: () => {
        const seen: MediaReadyPayload[] = [];
        const sink = new EventStream().attachLegacy({
          onMediaReady: (payload) => seen.push(payload),
        });
        sink.emit({
          type: "media-ready",
          payload: { modality: "image", url: "https://x/i.png", mediaId: "m1" },
        });
        sink.emit({
          type: "media-ready",
          payload: {
            modality: "voice",
            url: "https://x/a.mp3",
            mediaId: "m2",
            durationSec: 3.2,
          },
        });
        assert.equal(seen.length, 2);
        assert.equal(seen[0].modality, "image");
        assert.equal(seen[1].modality, "voice");
        assert.equal(seen[1].durationSec, 3.2);
      },
    },
    {
      name: "EventStream — outfit-gifted re-emits to onOutfitGifted with payload",
      run: () => {
        let captured: OutfitGiftedPayload | null = null;
        const sink = new EventStream().attachLegacy({
          onOutfitGifted: (payload) => {
            captured = payload;
          },
        });
        const payload: OutfitGiftedPayload = {
          descriptionText: "Red dress",
          count: 2,
        };
        sink.emit({ type: "outfit-gifted", payload });
        assert.deepEqual(captured, payload);
      },
    },
    {
      name: "EventStream — callback throws are caught and swallowed (never rethrown)",
      run: () => {
        const originalWarn = console.warn;
        let warned = false;
        console.warn = () => {
          warned = true;
        };
        try {
          const sink = new EventStream().attachLegacy({
            onTextReady: () => {
              throw new Error("boom");
            },
          });
          // MUST NOT throw — legacy code wraps every callback call in try/catch.
          sink.emit({
            type: "text-ready",
            text: "x",
            metadata: {},
          });
          assert.ok(warned, "callback error should be logged via console.warn");
        } finally {
          console.warn = originalWarn;
        }
      },
    },
    {
      name: "EventStream — Phase 2+ events are accepted but no-op (no legacy equivalent yet)",
      run: () => {
        let called = false;
        const sink = new EventStream().attachLegacy({
          onTextReady: () => {
            called = true;
          },
        });
        // These should NOT trigger onTextReady — they have no legacy mapping.
        sink.emit({ type: "text-delta", delta: "hi" });
        sink.emit({ type: "tool-call", tool: "x", args: {} });
        sink.emit({ type: "tool-result", tool: "x", result: null });
        sink.emit({ type: "turn-complete", response: {} });
        assert.ok(!called, "Phase 2+ events must not fire Phase 1 callbacks");
      },
    },
    {
      name: "EventStream — missing callbacks are tolerated (no throw)",
      run: () => {
        const sink = new EventStream(); // no attachLegacy
        // All four Phase 1 events should be safe to emit with no callbacks attached.
        sink.emit({ type: "text-ready", text: "x", metadata: {} });
        sink.emit({ type: "state-ready", persisted: {} });
        sink.emit({
          type: "media-ready",
          payload: { modality: "image", url: "u" },
        });
        sink.emit({
          type: "outfit-gifted",
          payload: { descriptionText: "x" },
        });
        assert.ok(true, "no throw");
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
    throw new Error('Tests failed');
  }
}

runTests();
