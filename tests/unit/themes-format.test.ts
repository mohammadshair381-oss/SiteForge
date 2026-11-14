import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import { formatPrice } from "../../backend/lib/format";
import { getThemeMeta, isValidThemeId, THEMES } from "../../backend/lib/themes";
import { THEME_IDS, type ThemeId } from "../../backend/lib/constants";

test("there are nine themes with unique ids, in THEME_IDS order (the original five first)", () => {
  assert.equal(THEMES.length, 9);
  assert.equal(new Set(THEMES.map((theme) => theme.id)).size, 9);
  assert.deepEqual(THEMES.map((theme) => theme.id), [...THEME_IDS]);
  assert.deepEqual(THEME_IDS.slice(0, 5), ["aurora", "market", "bistro", "studio", "launch"], "stored ids stay valid");
});

test("isValidThemeId accepts known ids and rejects unknown ones", () => {
  assert.equal(isValidThemeId("aurora"), true);
  assert.equal(isValidThemeId("launch"), true);
  for (const id of ["atelier", "volt", "harvest", "forma"]) assert.equal(isValidThemeId(id), true, id);
  assert.equal(isValidThemeId("nope"), false);
});

test("getThemeMeta returns a match or falls back to the first theme", () => {
  assert.equal(getThemeMeta("market").id, "market");
  assert.equal(getThemeMeta("bogus" as ThemeId).id, THEMES[0].id);
});

test("formatPrice formats USD by default", () => {
  assert.equal(formatPrice(1234.5), "$1,234.50");
});

test("formatPrice honors a valid currency code", () => {
  assert.equal(formatPrice(1000, "EUR"), "€1,000.00");
});

test("formatPrice falls back to a plain string for an invalid currency", () => {
  assert.equal(formatPrice(5, "XX"), "XX 5.00");
});
