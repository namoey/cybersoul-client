/**
 * ContextManager characterization tests.
 *
 * Layer B (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * §5.2). The ContextManager extraction is a Phase-1 low-risk win
 * (§6.3) that consolidates the duplicated `prepare*Context` preambles.
 * These tests pin its behavior so a regression in any of the three
 * concerns it owns — state fetch, wardrobe caching, request-type
 * normalization — fails CI before it ships.
 *
 * Follows the existing SDK test style (assert + runner), matching
 * `src/utils/json.utils.test.ts`.
 */

import { ContextManager } from "../agent/contextManager.js";
import {
  InteractRequestType,
  type CharacterState,
  type WardrobeItem,
  type WardrobeCategory,
} from "../types.js";
import type { CyberSoulApi } from "../api/cyberSoulApi.js";

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

const FIXTURE_STATE: CharacterState = {
  current_time: "2026-07-21T10:00:00+08:00",
  name: "TestChar",
  relationship_stage: "FRIENDLY",
  dynamic_context: { temperature: 60 },
};

const FIXTURE_WARDROBE: WardrobeItem[] = [
  {
    id: "w1",
    itemName: "Casual Tee",
    category: "CASUAL" as WardrobeCategory,
    promptModifier: "",
  },
  {
    id: "w2",
    itemName: "Formal Suit",
    category: "FORMAL" as WardrobeCategory,
    promptModifier: "",
  },
];

function makeMockApi(opts: {
  state?: CharacterState;
  wardrobe?: WardrobeItem[];
  wardrobeThrows?: boolean;
}): CyberSoulApi {
  return {
    getState: async () => opts.state ?? FIXTURE_STATE,
    getWardrobe: async () => {
      if (opts.wardrobeThrows) throw new Error("wardrobe fetch failed");
      return opts.wardrobe ?? FIXTURE_WARDROBE;
    },
  } as unknown as CyberSoulApi;
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void | Promise<void> }[] = [
    {
      name: "ContextManager.prepareInteract — derives isAuto from AUTO + drops AUTO/TEXT from requestedOthers",
      run: async () => {
        const api = makeMockApi({});
        const cm = new ContextManager(api);
        const ctx = await cm.prepareInteract({
          userMessage: "hi",
          requestTypes: [InteractRequestType.AUTO, InteractRequestType.TEXT],
        });
        assert.ok(ctx.isAuto, "AUTO should set isAuto=true");
        assert.ok(!ctx.requestedOthers.includes(InteractRequestType.AUTO));
        assert.ok(!ctx.requestedOthers.includes(InteractRequestType.TEXT));
        assert.equal(ctx.state.name, "TestChar");
      },
    },
    {
      name: "ContextManager.prepareInteract — explicit IMAGE+VOICE requestTypes preserves them in requestedOthers",
      run: async () => {
        const api = makeMockApi({});
        const cm = new ContextManager(api);
        const ctx = await cm.prepareInteract({
          userMessage: "hi",
          requestTypes: [InteractRequestType.IMAGE, InteractRequestType.VOICE],
        });
        // TEXT is force-added by normalizeRequestTypes
        assert.ok(ctx.types.includes(InteractRequestType.TEXT), "TEXT must always be present");
        assert.ok(ctx.requestedOthers.includes(InteractRequestType.IMAGE));
        assert.ok(ctx.requestedOthers.includes(InteractRequestType.VOICE));
        assert.ok(!ctx.isAuto, "no AUTO → isAuto should be false");
      },
    },
    {
      name: "ContextManager.prepareProactive — imageAllowed derived from requestedOthers (no AUTO gate)",
      run: async () => {
        const api = makeMockApi({});
        const cm = new ContextManager(api);
        const ctx = await cm.prepareProactive({
          requestTypes: [InteractRequestType.IMAGE],
        });
        assert.ok(ctx.imageAllowed, "IMAGE in requestTypes → imageAllowed=true");
      },
    },
    {
      name: "ContextManager.prepareProactive — imageAllowed false when IMAGE absent",
      run: async () => {
        const api = makeMockApi({});
        const cm = new ContextManager(api);
        const ctx = await cm.prepareProactive({ requestTypes: [] });
        // Empty requestTypes defaults to [AUTO, TEXT]; AUTO/TEXT filtered out of requestedOthers
        assert.ok(!ctx.imageAllowed, "no IMAGE → imageAllowed=false");
      },
    },
    {
      name: "ContextManager.getWardrobePromptStr — formats wardrobe items as ID/Name/Category lines",
      run: async () => {
        const api = makeMockApi({});
        const cm = new ContextManager(api);
        const str = await cm.getWardrobePromptStr();
        assert.ok(str.includes("- ID: w1 | Name: Casual Tee | Category: CASUAL"));
        assert.ok(str.includes("- ID: w2 | Name: Formal Suit | Category: FORMAL"));
      },
    },
    {
      name: "ContextManager.getWardrobePromptStr — falls back to 'None available' on empty wardrobe",
      run: async () => {
        const api = makeMockApi({ wardrobe: [] });
        const cm = new ContextManager(api);
        const str = await cm.getWardrobePromptStr();
        assert.equal(str, "None available");
      },
    },
    {
      name: "ContextManager.getWardrobePromptStr — swallows errors and caches 'None available' (legacy behavior)",
      run: async () => {
        const api = makeMockApi({ wardrobeThrows: true });
        const cm = new ContextManager(api);
        const str = await cm.getWardrobePromptStr();
        assert.equal(str, "None available", "error should be swallowed → 'None available'");
      },
    },
    {
      name: "ContextManager.getWardrobePromptStr — 5-minute cache TTL (no refetch within window)",
      run: async () => {
        let fetchCount = 0;
        const api: CyberSoulApi = {
          getState: async () => FIXTURE_STATE,
          getWardrobe: async () => {
            fetchCount++;
            return FIXTURE_WARDROBE;
          },
        } as unknown as CyberSoulApi;
        const cm = new ContextManager(api);
        await cm.getWardrobePromptStr();
        await cm.getWardrobePromptStr();
        await cm.getWardrobePromptStr();
        assert.equal(fetchCount, 1, "wardrobe should be fetched exactly once within the TTL");
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
    throw new Error('Tests failed');
  }
}

void runTests();
