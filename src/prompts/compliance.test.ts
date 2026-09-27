/**
 * Tests for the compliance-boundary directive resolution.
 *
 * The directive is DB-driven: the backend COMPLIANCE_RULE PromptSegment
 * (admin-configured, per-character gated) is the single source of truth.
 * The client adds NO built-in fallback — when the segment is absent or
 * empty, getComplianceDirective returns "" and nothing is injected.
 */

import { getComplianceDirective } from "./promptBuilders.js";
import type { CharacterState } from "../types.js";

const assert = {
  equal: (a: any, b: any, msg?: string) => {
    if (a !== b)
      throw new Error(msg || `Assertion failed: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
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
      name: "missing compliance_boundary → empty string (no injection)",
      run: () => {
        const state = {} as CharacterState;
        assert.equal(getComplianceDirective(state), "");
      },
    },
    {
      name: "null compliance_boundary → empty string",
      run: () => {
        const state = { compliance_boundary: null } as unknown as CharacterState;
        assert.equal(getComplianceDirective(state), "");
      },
    },
    {
      name: "whitespace-only template → empty string",
      run: () => {
        const state = {
          compliance_boundary: { promptTemplate: "   " },
        } as unknown as CharacterState;
        assert.equal(getComplianceDirective(state), "");
      },
    },
    {
      name: "backend template is returned trimmed",
      run: () => {
        const state = {
          compliance_boundary: { promptTemplate: "  PLATFORM RULE  " },
        } as unknown as CharacterState;
        assert.equal(getComplianceDirective(state), "PLATFORM RULE");
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
