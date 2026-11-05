import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";

(globalThis as unknown as { React?: typeof React }).React = React;

import type { StorefrontProduct, StorefrontView } from "../../lib/storefront";
import { buildCommerceData, type CommerceExtras } from "../../lib/storefront-home";
import { chooseEditorMode, selectEditorPage } from "../../lib/editor-mode";

import { THEME_IDS } from "../../lib/constants";

const THEMES = THEME_IDS;

function product(id: string, over: Partial<StorefrontProduct> = {}): StorefrontProduct {
  return {
    id: id.padStart(24, "a"), name: `Product ${id}`, slug: `product-${id}`, description: "", price: 100, currency: "USD",
    imageUrl: "", category: id === "1" ? "Tea" : "Coffee", compareAtPrice: null, availability: "in_stock", createdAt: null, ...over,
  };
}

function view(themeId: StorefrontView["themeId"]): StorefrontView {
  return {
    id: "b".repeat(24), name: "Demo Store", subdomain: "demo", category: "retail", about: "We roast coffee.", logoUrl: "", contactEmail: "hi@example.com",
    phone: "", address: "", currency: "USD", themeId,
    theme: { primaryColor: "#4f46e5", accentColor: "#0ea5e9", font: "sans", heroHeadline: "Fresh coffee", heroSubheadline: "", about: "", showProducts: true },
    products: [product("1"), product("2")], removeBranding: false,
  };
}

async function render(themeId: StorefrontView["themeId"], extras: CommerceExtras, props: Record<string, unknown> = {}) {
  const { default: ThemeRenderer } = await import("../../components/storefront/ThemeRenderer");
  const v = view(themeId);
  const commerce = buildCommerceData(v, undefined, extras);
  return renderToString(React.createElement(ThemeRenderer, { view: v, productHrefBase: "/product", commerce, ...props }));
}

test("editor routing: homepages use the store editor unless classic sections exist", () => {
  // Legacy store (no pages) without sections, and a home page without sections.
  assert.deepEqual(chooseEditorMode({ selectedPage: null, legacySections: [] }), { editingHome: true, hasClassicHomepage: false, useStoreEditor: true });
  assert.equal(chooseEditorMode({ selectedPage: { isHome: true, sections: [], publishedSections: [] }, legacySections: [] }).useStoreEditor, true);
  // Classic homepage (draft or published sections): section editor, unless mode=store.
  const classic = chooseEditorMode({ selectedPage: { isHome: true, sections: [], publishedSections: [{ id: "hero" }] }, legacySections: [] });
  assert.deepEqual(classic, { editingHome: true, hasClassicHomepage: true, useStoreEditor: false });
  assert.equal(chooseEditorMode({ selectedPage: { isHome: true, sections: [{ id: "hero" }] }, legacySections: [], mode: "store" }).useStoreEditor, true);
  assert.equal(chooseEditorMode({ selectedPage: null, legacySections: [{ id: "hero" }] }).useStoreEditor, false);
  // Other pages always use the section editor; mode=store does not apply to them.
  assert.equal(chooseEditorMode({ selectedPage: { isHome: false, sections: [] }, legacySections: [], mode: "store" }).useStoreEditor, false);
});

test("account navigation: hidden when accounts are off, sign-in for guests, account menu when signed in", async () => {
  for (const themeId of THEMES) {
    const off = await render(themeId, { accountsEnabled: false });
    assert.ok(!off.includes("/account"), `${themeId}: no account entry while customer accounts are disabled`);
    assert.ok(!off.includes("/login\""), `${themeId}: never the platform login`);

    const guest = await render(themeId, { accountsEnabled: true });
    assert.ok(guest.includes('href="/account/login"'), `${themeId}: guest sign-in link`);
    assert.ok(guest.includes("Sign in"), `${themeId}: sign-in label`);

    const signedIn = await render(themeId, { accountsEnabled: true, signedInName: "Ada" });
    assert.ok(signedIn.includes("Hi, Ada"), `${themeId}: signed-in name`);
    assert.ok(signedIn.includes('aria-expanded="false"') && signedIn.includes("Your account"), `${themeId}: account menu button`);
    assert.ok(!signedIn.includes('href="/account/login"'), `${themeId}: no sign-in link when signed in`);

    const unverified = await render(themeId, { accountsEnabled: true, signedInUnverified: true });
    assert.ok(unverified.includes("Your account") && !unverified.includes('href="/account/login"'), `${themeId}: unverified customers get the account menu`);
  }
});

test("the editor preview renders the SAME homepage as the store, plus selection targets only", async () => {
  for (const themeId of THEMES) {
    const published = await render(themeId, { accountsEnabled: false });
    const editor = await render(themeId, { accountsEnabled: false }, { preview: true, editable: true, selectedElementId: "home:featured" });
    // Same content: every section heading of the store appears in the editor.
    for (const heading of ["Fresh coffee", "Featured products", "Shop by category", "About Demo Store"]) {
      assert.ok(published.includes(heading), `${themeId}: store shows ${heading}`);
      assert.ok(editor.includes(heading), `${themeId}: editor shows ${heading}`);
    }
    assert.ok(!published.includes("data-editor-id"), `${themeId}: no editor targets on the store`);
    assert.ok(editor.includes('data-editor-id="home:hero"'), `${themeId}: hero is selectable`);
    assert.ok(editor.includes('data-editor-id="home:featured"'), `${themeId}: sections are selectable`);
    assert.ok(/aria-current="true"[^>]*data-editor-id="home:featured"|data-editor-id="home:featured"[^>]*aria-current="true"/.test(editor), `${themeId}: selected section is marked`);
    assert.ok(!editor.includes("Information coming soon") && !published.includes("Information coming soon"));
  }
});

test("device preview: phone and tablet keep their width, desktop is at least 1024px, zoomed to fit", async () => {
  const { fitPreview, previewLayoutLabel, previewElement } = await import("../../components/dashboard/editor/PreviewFrame");
  assert.deepEqual(fitPreview("mobile", 700), { viewport: 375, scale: 1 });
  assert.deepEqual(fitPreview("mobile", 343), { viewport: 375, scale: 343 / 375 });
  assert.deepEqual(fitPreview("tablet", 1000), { viewport: 768, scale: 1 });
  assert.deepEqual(fitPreview("tablet", 600), { viewport: 768, scale: 600 / 768 });
  // A narrow canvas still shows the desktop layout (zoomed out), a wide one at actual size.
  assert.deepEqual(fitPreview("desktop", 600), { viewport: 1024, scale: 600 / 1024 });
  assert.deepEqual(fitPreview("desktop", 1400), { viewport: 1400, scale: 1 });
  assert.equal(previewLayoutLabel({ device: "tablet", viewport: 768, scale: 0.79 }), "Tablet · 768px · 79%");
  assert.equal(previewLayoutLabel({ device: "mobile", viewport: 375, scale: 1 }), "Mobile · 375px");
  // Event targets inside the frame belong to another window: duck-typed, not instanceof.
  const node = { closest: () => null, tagName: "DIV" };
  assert.equal(previewElement(node as unknown as EventTarget), node);
  assert.equal(previewElement(null), null);
  assert.equal(previewElement({} as EventTarget), null);
});

test("without a published Home page the editor opens the fallback homepage, never an unrelated page", () => {
  const about = { _id: "about", isHome: false, status: "draft", sections: [{ id: "a" }] };
  const emptyDraftHome = { _id: "home", isHome: true, status: "draft", sections: [] };
  const draftHome = { _id: "home", isHome: true, status: "draft", sections: [{ id: "hero" }] };
  const liveHome = { _id: "home", isHome: true, status: "published", sections: [] };

  assert.equal(selectEditorPage([]), undefined);
  assert.equal(selectEditorPage([about]), undefined, "not the first page");
  assert.equal(selectEditorPage([about, emptyDraftHome]), undefined);
  assert.equal(selectEditorPage([about, draftHome]), undefined, "visitors do not see a draft Home page");
  assert.equal(selectEditorPage([about, liveHome]), liveHome);

  // An explicit page still opens, except an empty draft Home (nothing to edit).
  assert.equal(selectEditorPage([about, draftHome], "about"), about);
  assert.equal(selectEditorPage([about, draftHome], "home"), draftHome);
  assert.equal(selectEditorPage([about, emptyDraftHome], "home"), undefined);

  // The fallback uses the store editor, or the section editor for saved classic sections.
  assert.deepEqual(chooseEditorMode({ selectedPage: undefined, legacySections: [] }), { editingHome: true, hasClassicHomepage: false, useStoreEditor: true });
  assert.deepEqual(chooseEditorMode({ selectedPage: undefined, legacySections: [{ id: "hero" }] }), { editingHome: true, hasClassicHomepage: true, useStoreEditor: false });
  assert.equal(chooseEditorMode({ selectedPage: undefined, legacySections: [{ id: "hero" }], mode: "store" }).useStoreEditor, true);
});
