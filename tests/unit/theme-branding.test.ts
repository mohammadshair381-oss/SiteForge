import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";

// Make React available globally so theme JSX (compiled to React.createElement)
// can resolve it in the unit test environment.
(globalThis as unknown as { React?: typeof React }).React = React;

import type { StorefrontView } from "../../lib/storefront";

function makeView(removeBranding: boolean): StorefrontView {
  return {
    id: "b1",
    name: "Demo Business",
    subdomain: "demo",
    category: "retail",
    about: "",
    logoUrl: "",
    contactEmail: "",
    phone: "",
    address: "",
    currency: "USD",
    themeId: "aurora",
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
    },
    products: [],
    removeBranding,
  };
}

async function renderTheme(componentId: string, removeBranding: boolean): Promise<string> {
  // Dynamic import runs after globalThis.React is set, so theme JSX compiles
  // to React.createElement calls that resolve React from globalThis.
  const mod = await import(`../../themes/${componentId}Theme`);
  const Component = mod.default;
  const html = renderToString(
    React.createElement(Component, {
      view: makeView(removeBranding),
      productHrefBase: "/product",
    }),
  );
  return html;
}

for (const componentId of ["Aurora", "Market", "Bistro", "Studio", "Launch", "Atelier", "Volt", "Harvest", "Forma"]) {
  // "Remove branding" is sold as removing SITEFORGE branding (pricing and
  // billing copy); the store's own name always stays visible.
  test(`${componentId}: SiteForge credit visible when removeBranding is false`, async () => {
    const html = await renderTheme(componentId, false);
    assert.ok(html.includes("Demo Business"), `${componentId} should show business name`);
    assert.ok(html.includes("Powered by SiteForge"), `${componentId} should show the platform credit`);
  });

  test(`${componentId}: SiteForge credit hidden when removeBranding is true`, async () => {
    const html = await renderTheme(componentId, true);
    assert.ok(html.includes("Demo Business"), `${componentId} keeps the store name`);
    assert.ok(!html.includes("SiteForge"), `${componentId} should hide SiteForge branding`);
  });
}
