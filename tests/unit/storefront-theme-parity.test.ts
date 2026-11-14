import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";

(globalThis as unknown as { React?: typeof React }).React = React;

import type { StorefrontView } from "../../backend/lib/storefront";
import type { Section } from "../../backend/lib/sections";

import { THEME_IDS } from "../../backend/lib/constants";

function makeView(themeId: StorefrontView["themeId"]): StorefrontView {
  return {
    id: "business-1",
    name: "Demo Business",
    subdomain: "demo",
    category: "retail",
    about: "About the business",
    logoUrl: "",
    contactEmail: "hello@example.com",
    phone: "555-0100",
    address: "123 Main St",
    currency: "USD",
    themeId,
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Theme fallback",
      heroSubheadline: "Fallback copy",
      about: "",
      showProducts: true,
    },
    products: [{
      id: "product-1",
      name: "Widget",
      slug: "widget",
      description: "A useful widget",
      price: 12,
      currency: "USD",
      imageUrl: "",
      category: "retail",
    }],
    removeBranding: false,
    navigation: {
      header: [{ pageId: "header-page", label: "About", slug: "about" }],
      footer: [{ pageId: "footer-page", label: "Contact", slug: "contact" }],
    },
  };
}

const configuredSections: Section[] = [
  {
    id: "products",
    type: "products",
    order: 0,
    visible: true,
    settings: { title: "Configured products", columns: "2" },
  },
  {
    id: "custom-footer",
    type: "footer",
    order: 1,
    visible: true,
    settings: { text: "Configured footer text" },
  },
];

async function renderTheme(
  themeId: StorefrontView["themeId"],
  props: { preview?: boolean; editable?: boolean } = {},
): Promise<string> {
  const { default: ThemeRenderer } = await import("../../frontend/components/storefront/ThemeRenderer");
  return renderToString(React.createElement(ThemeRenderer, {
    view: makeView(themeId),
    productHrefBase: "/product",
    sections: configuredSections,
    ...props,
  }));
}

test("configured editor previews use one theme header and retain editor targets", async () => {
  for (const themeId of THEME_IDS) {
    const html = await renderTheme(themeId, { preview: true, editable: true });

    assert.equal((html.match(/<header\b/g) ?? []).length, 1, `${themeId} has one header`);
    assert.ok(html.includes(`data-theme="${themeId}"`), `${themeId} identity is preserved`);
    assert.ok(html.includes("data-editor-id"), `${themeId} keeps editor targets`);
    assert.ok(html.includes("Configured products"), `${themeId} renders configured sections`);
  }
});

test("published configured pages use theme chrome and preserve one configured footer", async () => {
  for (const themeId of THEME_IDS) {
    const html = await renderTheme(themeId);

    assert.equal((html.match(/<header\b/g) ?? []).length, 1, `${themeId} has one header`);
    assert.equal((html.match(/<footer\b/g) ?? []).length, 1, `${themeId} has one footer`);
    assert.ok(html.includes(`data-theme="${themeId}"`), `${themeId} identity is preserved`);
    assert.ok(html.includes("Configured footer text"), `${themeId} preserves configured footer text`);
    assert.ok(html.includes('href="/about"'), `${themeId} preserves header navigation`);
    assert.ok(html.includes('href="/contact"'), `${themeId} preserves footer navigation`);
    assert.ok(!html.includes("data-editor-id"), `${themeId} omits editor selection controls`);
    assert.ok(!html.includes('draggable="true"'), `${themeId} omits drag controls`);
    assert.ok(html.includes('href="/product/widget"'), `${themeId} uses published product links`);
    assert.ok(!html.includes('href="#"'), `${themeId} omits preview-only product links`);
  }
});
