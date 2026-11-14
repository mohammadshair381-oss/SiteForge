import assert from "node:assert/strict";
import test from "node:test";

import { resolvePublishedPageSections } from "../../backend/lib/sections";

/** Draft/published separation for public page rendering (Phase 5). */

const draft = [{ id: "draft-1", type: "hero", order: 0, visible: true, settings: { headline: "Draft" } }];
const live = [{ id: "live-1", type: "hero", order: 0, visible: true, settings: { headline: "Live" } }];

test("published-but-empty snapshot never falls back to the draft", () => {
  assert.deepEqual(resolvePublishedPageSections({ publishedSections: [], sections: draft }), []);
});

test("published content wins over a newer draft", () => {
  assert.deepEqual(resolvePublishedPageSections({ publishedSections: live, sections: draft }), live);
});

test("a legacy record without the snapshot field renders its stored sections", () => {
  assert.deepEqual(resolvePublishedPageSections({ sections: live }), live);
  assert.deepEqual(resolvePublishedPageSections({}), []);
});

test("a present but null or malformed snapshot fails closed (no draft fallback)", () => {
  assert.deepEqual(resolvePublishedPageSections({ publishedSections: null, sections: draft }), []);
  assert.deepEqual(resolvePublishedPageSections({ publishedSections: { not: "an array" }, sections: draft }), []);
  assert.deepEqual(resolvePublishedPageSections({ publishedSections: "x", sections: draft }), []);
});

test("legacy records with non-array sections yield no sections", () => {
  assert.deepEqual(resolvePublishedPageSections({ sections: "bad" }), []);
});
