import assert from "node:assert/strict";
import test from "node:test";

import { BRAND_PRESETS, brandPresetFor, primaryContrastWithWhite } from "../../lib/brand-presets";
import { PRESET_KEYS } from "../../lib/storefront-presets";
import { THEME_IDS } from "../../lib/constants";
import {
  SETUP_STEPS,
  nextStep,
  previousStep,
  readSetupProgress,
  resumeStep,
  stepStates,
  storeReadiness,
  type SetupFacts,
} from "../../lib/store-setup";

const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  name: "Corner Shop",
  description: "",
  contactEmail: "",
  phone: "",
  logoUrl: "",
  activeProducts: 0,
  activeProductsWithoutImage: 0,
  shippingConfigured: false,
  policies: { shipping: false, returns: false },
  codEnabled: false,
  accountsEnabled: false,
  onlinePaymentsConnected: false,
  emailVerified: true,
  planActive: true,
  suspended: false,
  published: false,
  ...over,
});

test("setup progress is read tolerantly and never trusts unknown step names", () => {
  assert.deepEqual(readSetupProgress(undefined), { step: null, done: [], skipped: [], completedAt: null });
  const read = readSetupProgress({ step: "brand", done: ["business", "business", "nope"], skipped: ["products", 3], completedAt: "2026-10-30T10:00:00.000Z" });
  assert.equal(read.step, "brand");
  assert.deepEqual(read.done, ["business"]);
  assert.deepEqual(read.skipped, ["products"]);
  assert.ok(read.completedAt instanceof Date);
  assert.equal(readSetupProgress({ step: "hack" }).step, null);
});

test("step completion comes from real data; confirmations only where data cannot tell", () => {
  const empty = readSetupProgress(undefined);
  assert.deepEqual(stepStates(facts(), empty), { business: "todo", brand: "todo", structure: "todo", products: "todo", settings: "todo", launch: "todo" });
  const filled = facts({ description: "Fresh produce daily.", phone: "+1 555 0100", activeProducts: 2, published: true });
  const progress = readSetupProgress({ done: ["brand"], skipped: ["settings"] });
  assert.deepEqual(stepStates(filled, progress), { business: "complete", brand: "complete", structure: "todo", products: "complete", settings: "skipped", launch: "complete" });
  // Confirming the business step without a description does not make it complete.
  assert.equal(stepStates(facts(), readSetupProgress({ done: ["business"] })).business, "todo");
});

test("resume point: the saved step, else the first open step, else launch", () => {
  assert.equal(resumeStep(facts(), readSetupProgress({ step: "products" })), "products");
  assert.equal(resumeStep(facts(), readSetupProgress(undefined)), "business");
  const done = facts({ description: "x", phone: "1", activeProducts: 1 });
  assert.equal(resumeStep(done, readSetupProgress({ done: ["brand", "structure"], skipped: ["settings"] })), "launch");
  assert.equal(nextStep("business"), "brand");
  assert.equal(nextStep("launch"), null);
  assert.equal(previousStep("business"), null);
  assert.equal(previousStep("launch"), "settings");
  assert.equal(SETUP_STEPS.length, 6);
});

test("readiness: only the publish route's own requirements block publishing", () => {
  const ready = storeReadiness(facts());
  assert.equal(ready.canPublish, true, "recommendations never block publishing");
  assert.ok(ready.remainingRecommended > 0);
  const blocked = storeReadiness(facts({ emailVerified: false, planActive: false, suspended: true }));
  assert.equal(blocked.canPublish, false);
  assert.deepEqual(blocked.items.filter((i) => i.required && !i.done).map((i) => i.key), ["email", "plan", "suspended"]);
  // Product photos: done only when there are active products and none lacks a photo.
  const photos = (f: Partial<SetupFacts>) => storeReadiness(facts(f)).items.find((i) => i.key === "images")!;
  assert.equal(photos({}).done, false);
  assert.equal(photos({ activeProducts: 3, activeProductsWithoutImage: 1 }).detail, "1 active product has no photo yet.");
  assert.equal(photos({ activeProducts: 3, activeProductsWithoutImage: 0 }).done, true);
  // Payments: COD counts only while customer accounts are available (COD needs signed-in customers).
  const pay = (f: Partial<SetupFacts>) => storeReadiness(facts(f)).items.find((i) => i.key === "payments")!.done;
  assert.equal(pay({ codEnabled: true, accountsEnabled: false }), false);
  assert.equal(pay({ codEnabled: true, accountsEnabled: true }), true);
  assert.equal(pay({ onlinePaymentsConnected: true }), true);
  assert.match(storeReadiness(facts()).items.find((i) => i.key === "payments")!.detail, /orders arrive unpaid/);
});

test("brand presets: every business type gets a real theme and readable palettes", () => {
  for (const key of PRESET_KEYS) {
    const preset = BRAND_PRESETS[key];
    assert.ok((THEME_IDS as readonly string[]).includes(preset.theme), `${key}: theme`);
    assert.ok(preset.palettes.length >= 3, `${key}: palettes`);
    for (const palette of preset.palettes) {
      assert.match(palette.primary, /^#[0-9a-f]{6}$/);
      assert.match(palette.accent, /^#[0-9a-f]{6}$/);
      assert.ok(primaryContrastWithWhite(palette.primary)!.readable, `${key}/${palette.id}: white text on the primary colour`);
    }
  }
  // Each store type is suggested its dedicated theme (a suggestion only; never applied automatically).
  assert.equal(brandPresetFor("clothing").theme, "atelier");
  assert.equal(brandPresetFor("electronics").theme, "volt");
  assert.equal(brandPresetFor("grocery").theme, "harvest");
  assert.equal(brandPresetFor("furniture").theme, "forma");
  assert.equal(brandPresetFor("food").key, "grocery");
  assert.equal(brandPresetFor("anything-else").key, "general");
  assert.equal(primaryContrastWithWhite("#ffff00")!.readable, false);
  assert.equal(primaryContrastWithWhite("not a colour"), null);
});
