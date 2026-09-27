/**
 * Tests for the sanitized image schema (App Store 1.1.4 remediation).
 *
 * Pins the invariant that NO sexual vocabulary is structurally reachable
 * by the model through either schema surface (native tool inputSchema or
 * the classic embedded JSON hint). If someone reintroduces `exposure`,
 * `seductive`, `boyfriend_view`, etc., these tests fail.
 */

import {
  IMAGE_FIELDS,
  IMAGE_TOOL_DESCRIPTION,
  buildImageToolInputSchema,
  buildImageJsonSchemaString,
} from "./image.js";

const assert = {
  ok: (condition: any, msg?: string) => {
    if (!condition) throw new Error(msg || "Assertion failed: expected truthy value");
  },
};

/** Vocabulary that must never appear in any schema surface. */
const FORBIDDEN = [
  /\bnaked\b/i,
  /\bnude/i,
  /seductive/i,
  /cleavage/i,
  /see_through/i,
  /exposure/i,
  /\bintimate\b/i,
  /wardrobe/i,
  /clothing/i,
  /dressed/i,
  /revealing/i,
];

function assertClean(text: string, label: string) {
  for (const re of FORBIDDEN) {
    assert.ok(!re.test(text), `${label} must not contain ${re} — got: ${text}`);
  }
}

function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void }[] = [
    {
      name: "tool inputSchema contains no sexual vocabulary",
      run: () => {
        assertClean(JSON.stringify(buildImageToolInputSchema()), "tool schema");
      },
    },
    {
      name: "classic JSON hint contains no sexual vocabulary",
      run: () => {
        assertClean(buildImageJsonSchemaString(true), "json hint");
      },
    },
    {
      name: "tool description contains no sexual vocabulary",
      run: () => {
        assertClean(IMAGE_TOOL_DESCRIPTION, "tool description");
      },
    },
    {
      name: "exposure field is removed from IMAGE_FIELDS",
      run: () => {
        assert.ok(!("exposure" in IMAGE_FIELDS), "exposure must not exist");
      },
    },
    {
      name: "expression enum has no seductive",
      run: () => {
        const enum_ = IMAGE_FIELDS.expression.enum ?? [];
        assert.ok(!enum_.includes("seductive"));
      },
    },
    {
      name: "view_angle keeps the tame boyfriend_view but never its explicit variants",
      run: () => {
        const enum_ = IMAGE_FIELDS.view_angle.enum ?? [];
        // Base value is a legitimate POV framing — the backend expands it to
        // a tame wide-angle lens description with no exposure side-effects.
        assert.ok(enum_.includes("boyfriend_view"), "base POV angle stays available");
        // The backend variants are the objectionable ones (from_behind
        // force-overrides exposure to nudity; between_legs is explicit) —
        // they must NEVER become client-selectable.
        for (const variant of [
          "boyfriend_view_from_above",
          "boyfriend_view_faceto_face",
          "boyfriend_view_from_behind",
          "boyfriend_view_between_legs",
        ]) {
          assert.ok(!enum_.includes(variant), `${variant} must never be client-selectable`);
        }
      },
    },
    {
      name: "guidance carries the generic-look tastefulness boundary",
      run: () => {
        assert.ok(/tasteful/i.test(IMAGE_TOOL_DESCRIPTION));
        assert.ok(/everyday/i.test(IMAGE_TOOL_DESCRIPTION));
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
