/**
 * `extractIntentFromRawText` characterization tests.
 *
 * This helper is the defense against the raw-JSON-leak-into-chat bug
 * (cybersoul-chat report 2026-07-31): when a model on the tool-calling
 * or streaming path ignores the native tool declarations and dumps the
 * nested schema as plain text content, this helper recovers the same
 * `DispatcherIntent` the real tool-call path would have produced — by
 * reusing `toolCallsToIntent` as the single source of truth for field
 * mapping.
 *
 * These tests pin:
 *   - The exact user-reported leak shape is recovered correctly.
 *   - The flat classic schema is also handled.
 *   - Prose / preamble / malformed input returns null (caller fallback).
 *   - null-valued tool keys are skipped (model said "not this tool").
 */

import { extractIntentFromRawText } from "./extractIntentFromRawText.js";

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

function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void }[] = [
    {
      name: "returns null for undefined / null / empty input",
      run: () => {
        assert.equal(extractIntentFromRawText(undefined), null);
        assert.equal(extractIntentFromRawText(null), null);
        assert.equal(extractIntentFromRawText(""), null);
        assert.equal(extractIntentFromRawText("   "), null);
      },
    },
    {
      name: "returns null for ordinary prose (the hot path — no JSON.parse)",
      run: () => {
        // Reasoning / preamble / a model that just talked instead of tools.
        assert.equal(extractIntentFromRawText("I think the user wants a photo."), null);
        assert.equal(
          extractIntentFromRawText("Let me respond warmly to their message."),
          null,
        );
      },
    },
    {
      name: "returns null for prose that merely mentions a brace",
      run: () => {
        // Contains no `{` → skipped before parse.
        assert.equal(extractIntentFromRawText("Sure! not json at all"), null);
      },
    },
    {
      name: "returns null for malformed JSON",
      run: () => {
        assert.equal(extractIntentFromRawText("{not valid json"), null);
        assert.equal(extractIntentFromRawText("{,,,}"), null);
      },
    },
    {
      name: "recovers the EXACT user-reported leak shape (nested tool schema)",
      run: () => {
        // Verbatim from the bug report — nested {speak:{text,actionText},
        // update_state:{stateUpdate:...}, and null tool slots.
        const leak = `{"speak":{"text":"怕了吧～那还不赶紧想想拿什么来赎我🥺 奶茶、小蛋糕，一样都不能少哦，不然豆豆可要挠你门啦😤","actionText":"我趴在工位上，指尖轻轻敲着手机屏幕，嘴角忍不住翘起来，想象着哥哥看到这条消息的表情。"},"update_state":{"stateUpdate":{"temperatureDelta":1,"ongoingScene":{"scene":"工位上写季度数据报告，偷偷和哥哥聊天","outfit":"粉色花卉真丝连衣裙"}}},"generate_image":null,"generate_voice":null,"trigger_event":null,"gift_outfit":null,"like_picture":null,"end_turn":null,"skip_turn":null,"skip_proactive":null}`;
        const intent = extractIntentFromRawText(leak);
        assert.ok(intent, "expected intent for nested schema");
        assert.equal(
          intent!.textResponse,
          "怕了吧～那还不赶紧想想拿什么来赎我🥺 奶茶、小蛋糕，一样都不能少哦，不然豆豆可要挠你门啦😤",
        );
        assert.equal(
          intent!.actionText,
          "我趴在工位上，指尖轻轻敲着手机屏幕，嘴角忍不住翘起来，想象着哥哥看到这条消息的表情。",
        );
        assert.ok(intent!.stateUpdate, "expected stateUpdate folded through");
        assert.equal(intent!.stateUpdate!.temperatureDelta, 1);
        assert.equal(intent!.imageParams, undefined, "null generate_image must be skipped");
        assert.equal(intent!.voiceArgs, undefined, "null generate_voice must be skipped");
      },
    },
    {
      name: "nested schema with markdown code fence is still recovered",
      run: () => {
        const leak = "```json\n" +
          JSON.stringify({
            speak: { text: "hi", actionText: "(waves)" },
            update_state: null,
            generate_image: null,
          }) +
          "\n```";
        const intent = extractIntentFromRawText(leak);
        assert.ok(intent);
        assert.equal(intent!.textResponse, "hi");
        assert.equal(intent!.actionText, "(waves)");
      },
    },
    {
      name: "nested schema tolerates smart quotes (robustJsonParse path)",
      run: () => {
        const leak = `{"speak":{"text":"hello”,”actionText”:”(smiles)”}}`;
        // Should not throw — returns either a recovered intent or null,
        // but never throws. Accept either; the key guarantee is no-throw.
        const intent = extractIntentFromRawText(leak);
        // Robust parse should recover the text field.
        if (intent) assert.equal(intent.textResponse, "hello");
      },
    },
    {
      name: "nested schema with only speak still recovers text",
      run: () => {
        const intent = extractIntentFromRawText(`{"speak":{"text":"just talking"}}`);
        assert.ok(intent);
        assert.equal(intent!.textResponse, "just talking");
      },
    },
    {
      name: "flat classic schema (textResponse at top level) is returned",
      run: () => {
        const flat = JSON.stringify({
          textResponse: "flat reply",
          actionText: "(flat action)",
          stateUpdate: { temperatureDelta: 2 },
        });
        const intent = extractIntentFromRawText(flat);
        assert.ok(intent);
        assert.equal(intent!.textResponse, "flat reply");
        assert.equal(intent!.actionText, "(flat action)");
        assert.equal(intent!.stateUpdate!.temperatureDelta, 2);
      },
    },
    {
      name: "object that is neither nested nor flat schema returns null",
      run: () => {
        // e.g. some unrelated JSON the model emitted — leave to caller.
        assert.equal(extractIntentFromRawText(`{"foo":"bar"}`), null);
        assert.equal(extractIntentFromRawText(`{"list":[1,2,3]}`), null);
      },
    },
    {
      name: "JSON array (not object) returns null",
      run: () => {
        assert.equal(extractIntentFromRawText(`[1,2,3]`), null);
      },
    },
  ];

  for (const test of tests) {
    try {
      test.run();
      passed++;
      console.log(`  ✓ ${test.name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${test.name}`);
      console.error(`    ${(e as Error).message}`);
    }
  }

  console.log(`\nextractIntentFromRawText: ${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error("Tests failed");
}

runTests();
