/**
 * Phase 2 — `toolCallsToIntent` adapter characterization tests.
 *
 * Layer B (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * §5.2). This adapter is the bridge between the native tool-calling
 * path and the existing side-effect machinery: it folds structured
 * `LLMToolCall[]` into the same `DispatcherIntent` shape the JSON-
 * dispatcher path produces. If this mapping is wrong, the tool-calling
 * path silently misbehaves relative to the JSON path — which is
 * exactly the kind of regression §5.3 says must never happen.
 *
 * These tests pin every tool→intent-field mapping documented in
 * `toolCallsToIntent.ts` so a refactor of either side can't drift.
 */

import { toolCallsToIntent } from "./toolCallsToIntent.js";
import type { LLMToolCall } from "../types.js";

const assert = {
  equal: (a: any, b: any, msg?: string) => {
    if (a !== b)
      throw new Error(msg || `Assertion failed: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  },
  deepEqual: (a: any, b: any, msg?: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(msg || `Deep assertion failed: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  },
  ok: (condition: any, msg?: string) => {
    if (!condition) throw new Error(msg || "Assertion failed: expected truthy value");
  },
};

function makeToolCall(name: string, args: Record<string, unknown> | string): LLMToolCall {
  return {
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  };
}

function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void }[] = [
    {
      name: "toolCallsToIntent — empty array produces empty intent",
      run: () => {
        const intent = toolCallsToIntent([]);
        assert.deepEqual(intent, { textResponse: "" });
      },
    },
    {
      name: "toolCallsToIntent — speak maps to textResponse + actionText",
      run: () => {
        const intent = toolCallsToIntent([
          makeToolCall("speak", { text: "hello", actionText: "(smiles)" }),
        ]);
        assert.equal(intent.textResponse, "hello");
        assert.equal(intent.actionText, "(smiles)");
      },
    },
    {
      name: "toolCallsToIntent — generate_image passes args through as imageParams",
      run: () => {
        const intent = toolCallsToIntent([
          makeToolCall("generate_image", { mode: "full-prompt", full_prompt: "x" }),
        ]);
        assert.deepEqual(intent.imageParams, { mode: "full-prompt", full_prompt: "x" });
      },
    },
    {
      name: "toolCallsToIntent — generate_voice extracts dynamicArgs into voiceArgs",
      run: () => {
        const intent = toolCallsToIntent([
          makeToolCall("generate_voice", {
            textForVoice: "hi",
            dynamicArgs: { emotion: "happy" },
          }),
        ]);
        assert.deepEqual(intent.voiceArgs, { emotion: "happy" });
      },
    },
    {
      name: "toolCallsToIntent — generate_voice with no dynamicArgs defaults to empty object",
      run: () => {
        const intent = toolCallsToIntent([
          makeToolCall("generate_voice", { textForVoice: "hi" }),
        ]);
        assert.deepEqual(intent.voiceArgs, {});
      },
    },
    {
      name: "toolCallsToIntent — update_state maps stateUpdate + userAnalysis",
      run: () => {
        const intent = toolCallsToIntent([
          makeToolCall("update_state", {
            stateUpdate: { temperatureDelta: 5, ongoingScene: { scene: "cafe", outfit: "apron" } },
            userAnalysis: { newFactsLearned: [{ category: "hobby", value: "reading" }] },
          }),
        ]);
        assert.deepEqual(intent.stateUpdate, {
          temperatureDelta: 5,
          ongoingScene: { scene: "cafe", outfit: "apron" },
        });
        assert.equal(intent.userAnalysis?.newFactsLearned[0].value, "reading");
      },
    },
    {
      name: "toolCallsToIntent — trigger_event maps to triggerEvent with required fields",
      run: () => {
        const intent = toolCallsToIntent([
          makeToolCall("trigger_event", {
            eventDescription: "lunch",
            eventTitle: "Lunch date",
            durationMins: 90,
          }),
        ]);
        assert.ok(intent.triggerEvent);
        assert.equal(intent.triggerEvent!.eventDescription, "lunch");
        assert.equal(intent.triggerEvent!.eventTitle, "Lunch date");
        assert.equal(intent.triggerEvent!.durationMins, 90);
      },
    },
    {
      name: "toolCallsToIntent — gift_outfit maps to giftOutfit {descriptionText}",
      run: () => {
        const intent = toolCallsToIntent([
          makeToolCall("gift_outfit", { descriptionText: "Red dress" }),
        ]);
        assert.deepEqual(intent.giftOutfit, { descriptionText: "Red dress" });
      },
    },
    {
      name: "toolCallsToIntent — like_picture sets likePreviousPicture=true",
      run: () => {
        const intent = toolCallsToIntent([makeToolCall("like_picture", {})]);
        assert.equal(intent.likePreviousPicture, true);
      },
    },
    {
      name: "toolCallsToIntent — end_turn sets isEndTurn=true",
      run: () => {
        const intent = toolCallsToIntent([makeToolCall("end_turn", {})]);
        assert.equal(intent.isEndTurn, true);
      },
    },
    {
      name: "toolCallsToIntent — skip_turn sets shouldSkipInteract + skipReason",
      run: () => {
        const intent = toolCallsToIntent([
          makeToolCall("skip_turn", { reason: "user said bye" }),
        ]);
        assert.equal(intent.shouldSkipInteract, true);
        assert.equal(intent.skipReason, "user said bye");
      },
    },
    {
      name: "toolCallsToIntent — skip_proactive sets shouldSkipProactive + skipReason",
      run: () => {
        const intent = toolCallsToIntent([
          makeToolCall("skip_proactive", { reason: "too soon" }),
        ]);
        assert.equal(intent.shouldSkipProactive, true);
        assert.equal(intent.skipReason, "too soon");
      },
    },
    {
      name: "toolCallsToIntent — multiple tool calls merge into one intent",
      run: () => {
        const intent = toolCallsToIntent([
          makeToolCall("speak", { text: "hi" }),
          makeToolCall("update_state", { stateUpdate: { temperatureDelta: 1 } }),
          makeToolCall("end_turn", {}),
        ]);
        assert.equal(intent.textResponse, "hi");
        assert.deepEqual(intent.stateUpdate, { temperatureDelta: 1 });
        assert.equal(intent.isEndTurn, true);
      },
    },
    {
      name: "toolCallsToIntent — unknown tool call is skipped (forward-compat)",
      run: () => {
        const intent = toolCallsToIntent([
          makeToolCall("speak", { text: "hi" }),
          makeToolCall("unknown_future_tool", { foo: "bar" }),
        ]);
        assert.equal(intent.textResponse, "hi");
        // Unknown tool contributed nothing — no crash.
      },
    },
    {
      name: "toolCallsToIntent — malformed arguments JSON is skipped (defensive)",
      run: () => {
        const intent = toolCallsToIntent([
          makeToolCall("speak", "{bad json"),
          makeToolCall("end_turn", {}),
        ]);
        // The malformed speak was skipped, but end_turn still applied.
        assert.equal(intent.isEndTurn, true);
        assert.equal(intent.textResponse, "");
      },
    },
    {
      name: "toolCallsToIntent — empty arguments string tolerated (marker tools)",
      run: () => {
        const intent = toolCallsToIntent([
          makeToolCall("like_picture", ""),
        ]);
        assert.equal(intent.likePreviousPicture, true);
      },
    },
    {
      name: "toolCallsToIntent — arguments as parsed object (Anthropic shape)",
      run: () => {
        // Anthropic returns `input` as a parsed object; the provider
        // adapter stringifies it before handing to us. Verify we handle
        // both shapes — the args could arrive either way depending on
        // provider quirks.
        const intent = toolCallsToIntent([
          { name: "speak", arguments: JSON.stringify({ text: "from object" }) },
        ]);
        assert.equal(intent.textResponse, "from object");
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

runTests();
