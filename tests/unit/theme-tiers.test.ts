import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import { THEME_IDS } from "../../lib/constants";
import {
  FREE_THEMES,
  MAX_THEMES,
  STARTER_THEMES,
  canSelectTheme,
  cheapestPlanFor,
  defaultThemeFor,
  normalizeThemeList,
  planThemes,
  themePreferenceFor,
  type ThemeTierPlan,
} from "../../lib/theme-tiers";

test("default tiers: Free 3, Starter 6, Max all 9", () => {
  assert.deepEqual([...FREE_THEMES], ["bistro", "market", "studio"]);
  assert.deepEqual([...STARTER_THEMES].sort(), ["aurora", "bistro", "harvest", "launch", "market", "studio"]);
  assert.deepEqual([...MAX_THEMES], [...THEME_IDS]);
  for (const id of FREE_THEMES) assert.ok(STARTER_THEMES.includes(id), `${id} is in Starter`);
  for (const id of ["atelier", "volt", "forma"] as const) assert.ok(!STARTER_THEMES.includes(id), `${id} is Max only`);
});

test("planThemes uses the plan's key when no explicit list is configured", () => {
  assert.deepEqual(planThemes({ key: "free", price: 0 }), [...FREE_THEMES]);
  assert.deepEqual(planThemes({ key: "starter", price: 19 }), [...STARTER_THEMES]);
  assert.deepEqual(planThemes({ key: "pro", price: 49 }), [...MAX_THEMES]);
  assert.deepEqual(planThemes({ key: "MAX", price: 99 }), [...MAX_THEMES]);
  // Unknown keys: free plans get the Free tier, paid plans every theme.
  assert.deepEqual(planThemes({ key: "plan-x", price: 0 }), [...FREE_THEMES]);
  assert.deepEqual(planThemes({ key: "plan-y", price: 5 }), [...MAX_THEMES]);
  assert.deepEqual(planThemes(null), [...FREE_THEMES]);
  assert.deepEqual(planThemes(undefined), [...FREE_THEMES]);
});

test("planThemes prefers a valid explicit list and ignores invalid values", () => {
  assert.deepEqual(planThemes({ key: "free", price: 0, features: { themes: ["volt", "bistro"] } }), ["bistro", "volt"]);
  // Unknown ids and duplicates are dropped; an empty result falls back to the tier.
  assert.deepEqual(planThemes({ key: "starter", price: 9, features: { themes: ["nope", "volt", "volt"] } }), ["volt"]);
  assert.deepEqual(planThemes({ key: "starter", price: 9, features: { themes: ["nope"] } }), [...STARTER_THEMES]);
  assert.deepEqual(planThemes({ key: "free", price: 0, features: { themes: [] } }), [...FREE_THEMES]);
  assert.deepEqual(planThemes({ key: "free", price: 0, features: { themes: "volt" } }), [...FREE_THEMES]);
});

test("normalizeThemeList keeps catalogue order, known ids only, no duplicates", () => {
  assert.deepEqual(normalizeThemeList(["forma", "aurora", "forma", 3, null, "x"]), ["aurora", "forma"]);
  assert.deepEqual(normalizeThemeList(undefined), []);
});

test("defaultThemeFor picks the best theme the plan includes, never a locked one", () => {
  assert.equal(defaultThemeFor("clothing", MAX_THEMES), "atelier");
  assert.equal(defaultThemeFor("clothing", STARTER_THEMES), "studio");
  assert.equal(defaultThemeFor("electronics", MAX_THEMES), "volt");
  assert.equal(defaultThemeFor("electronics", STARTER_THEMES), "launch");
  assert.equal(defaultThemeFor("electronics", FREE_THEMES), "market");
  assert.equal(defaultThemeFor("food", FREE_THEMES), "bistro");
  assert.equal(defaultThemeFor("furniture", MAX_THEMES), "forma");
  assert.equal(defaultThemeFor("furniture", FREE_THEMES), "studio");
  assert.equal(defaultThemeFor("grocery", STARTER_THEMES), "harvest");
  for (const type of ["retail", "clothing", "shoes", "electronics", "grocery", "furniture", "cosmetics", "hardware", "food", "services", "other", "", null]) {
    assert.ok(FREE_THEMES.includes(defaultThemeFor(type, FREE_THEMES)), `free default for ${String(type)}`);
    assert.ok(STARTER_THEMES.includes(defaultThemeFor(type, STARTER_THEMES)), `starter default for ${String(type)}`);
  }
  assert.equal(defaultThemeFor("clothing", []), "bistro");
});

test("themePreferenceFor has no duplicates and only known themes", () => {
  for (const type of ["retail", "clothing", "electronics", "food", "furniture", "unknown"]) {
    const order = themePreferenceFor(type);
    assert.equal(new Set(order).size, order.length);
    for (const id of order) assert.ok((THEME_IDS as readonly string[]).includes(id));
  }
});

test("cheapestPlanFor names the cheapest active plan including each theme", () => {
  const plans: ThemeTierPlan[] = [
    { key: "pro", name: "Pro", price: 49, currency: "USD", interval: "month", themes: [...MAX_THEMES] },
    { key: "free", name: "Free", price: 0, currency: "USD", interval: "month", themes: [...FREE_THEMES] },
    { key: "starter", name: "Starter", price: 19, currency: "USD", interval: "month", themes: [...STARTER_THEMES] },
  ];
  const map = cheapestPlanFor(plans);
  assert.equal(map.bistro?.key, "free");
  assert.equal(map.aurora?.key, "starter");
  assert.equal(map.volt?.key, "pro");
  assert.equal(cheapestPlanFor([plans[1]]).volt, null);
});

test("canSelectTheme: allowed themes and the current (grandfathered) theme only", () => {
  const access = { current: "volt" as const, allowed: [...FREE_THEMES] };
  assert.equal(canSelectTheme(access, "volt"), true);
  assert.equal(canSelectTheme(access, "bistro"), true);
  assert.equal(canSelectTheme(access, "forma"), false);
  assert.equal(canSelectTheme(access, "unknown"), false);
});
