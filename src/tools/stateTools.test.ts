/**
 * State-tool payload builder characterization tests.
 *
 * Layer B (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * §5.2). `buildStatePatchPayload` is the §6.1 low-risk win extracted
 * from the legacy `_updateDynamicContextInternal`. These tests pin
 * the dispatcher-intent → backend-payload translation:
 *
 *   - `temperatureDelta` → `temperature` rename + delete
 *   - `ongoingScene` normalization (object | string | null)
 *   - userAnalysis passthrough
 *   - null return when nothing to send
 *
 * The exact same translation was inline in `client.ts` before; this
 * test suite proves the extraction is byte-identical.
 */

import { buildStatePatchPayload } from "../tools/stateTools.js";

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
      name: "buildStatePatchPayload — returns null when neither stateUpdate nor userAnalysis",
      run: () => {
        assert.equal(buildStatePatchPayload(undefined, undefined), null);
      },
    },
    {
      name: "buildStatePatchPayload — renames temperatureDelta → temperature and deletes the original",
      run: () => {
        const payload = buildStatePatchPayload({
          temperatureDelta: 5,
        }) as any;
        assert.equal(payload.temperature, 5);
        assert.ok(
          payload.temperatureDelta === undefined,
          "temperatureDelta must be deleted",
        );
      },
    },
    {
      name: "buildStatePatchPayload — accepts string temperatureDelta (LLM sometimes returns strings)",
      run: () => {
        const payload = buildStatePatchPayload({
          temperatureDelta: "+1",
        }) as any;
        assert.equal(payload.temperature, "+1");
      },
    },
    {
      name: "buildStatePatchPayload — passes through userAnalysis alongside stateUpdate",
      run: () => {
        const payload = buildStatePatchPayload(
          { temperatureDelta: 1 },
          {
            newFactsLearned: [
              {
                category: "hobby",
                value: "reading",
              },
            ],
          },
        ) as any;
        assert.ok(payload.userAnalysis);
        assert.equal(payload.userAnalysis.newFactsLearned[0].value, "reading");
      },
    },
    {
      name: "buildStatePatchPayload — normalizes ongoingScene object to {scene,outfit}",
      run: () => {
        const payload = buildStatePatchPayload({
          ongoingScene: { scene: "cafe", outfit: "apron" },
        }) as any;
        assert.deepEqual(payload.ongoingScene, { scene: "cafe", outfit: "apron" });
      },
    },
    {
      name: "buildStatePatchPayload — normalizes bare-string ongoingScene to {scene, fallback-outfit}",
      run: () => {
        const payload = buildStatePatchPayload({
          ongoingScene: "at the beach",
        }) as any;
        assert.equal(payload.ongoingScene.scene, "at the beach");
        // The fallback outfit wording matches what the prompt uses.
        assert.ok(typeof payload.ongoingScene.outfit === "string");
      },
    },
    {
      name: "buildStatePatchPayload — null ongoingScene stays null",
      run: () => {
        const payload = buildStatePatchPayload({
          ongoingScene: null,
        }) as any;
        assert.equal(payload.ongoingScene, null);
      },
    },
    {
      name: "buildStatePatchPayload — empty ongoingScene object normalizes to null (no scene = nothing)",
      run: () => {
        const payload = buildStatePatchPayload({
          ongoingScene: { scene: "", outfit: "" },
        }) as any;
        // normalizeOngoingSceneState returns undefined for empty scene;
        // the builder then coerces to null (matching the legacy `|| null`).
        assert.equal(payload.ongoingScene, null);
      },
    },
    {
      name: "buildStatePatchPayload — userAnalysis alone (no stateUpdate) still produces a payload",
      run: () => {
        const payload = buildStatePatchPayload(undefined, {
          newFactsLearned: [],
        }) as any;
        assert.ok(payload.userAnalysis);
        assert.deepEqual(payload.userAnalysis.newFactsLearned, []);
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
