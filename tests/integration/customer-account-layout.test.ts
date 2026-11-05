import assert from "node:assert/strict";
import test, { after, before, beforeEach, mock } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { setMockRequestHeaders } from "./helpers/mock-next-headers-setup";
import { store } from "./helpers/customer-accounts";
import { Business } from "@/models/Business";

/**
 * Feature gate of the storefront account pages (app/store/account/layout.tsx).
 *
 * The layout is called directly as an async server component, with the mocked
 * `headers()` supplying the Host. This proves the layout's own decision (it
 * throws Next's `notFound()` before reading headers or the database when the
 * gate is off). It does NOT exercise Next's router: that `notFound()` becomes
 * an HTTP 404 page, and that the pages render inside this layout, are Next.js
 * behaviour, not tested here.
 */

// TSX in this test runner compiles to classic React.createElement calls.
(globalThis as unknown as { React?: typeof React }).React = React;

type Layout = (props: { children: React.ReactNode }) => Promise<React.ReactElement>;
let AccountLayout: Layout;
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
  AccountLayout = (await import("@/app/store/account/layout")).default as unknown as Layout;
});
after(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  setMockRequestHeaders(null);
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  setMockRequestHeaders(null);
  await clearAllCollections();
});

async function expectNotFound(promise: Promise<unknown>) {
  await assert.rejects(promise, (error: unknown) => (error as { digest?: string }).digest === NOT_FOUND);
}

test("with the gate off the layout is notFound() before any store lookup, even for an eligible store", async () => {
  const { host } = await store();
  setMockRequestHeaders({ host });
  const lookups = mock.method(Business, "findOne");
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", "yes"]) {
      if (value === undefined) delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
      else process.env.CUSTOMER_ACCOUNTS_ENABLED = value;
      await expectNotFound(AccountLayout({ children: "page" }));
    }
    assert.equal(lookups.mock.callCount(), 0, "no database access while disabled");
  } finally {
    lookups.mock.restore();
  }
});

test("with the gate on, an eligible store renders the frame with a contrast-checked accent", async () => {
  const { business, host } = await store();
  setMockRequestHeaders({ host });
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  const element = await AccountLayout({ children: "page" });
  // The styled element sits inside the store's frame.
  const style = (element.props as { children: { props: { style: Record<string, string> } } }).children.props.style;
  assert.match(style["--sf-accent"], /^#[0-9a-f]{6}$/i);
  assert.match(style["--sf-accent-text"], /^#(?:ffffff|000000)$/);
  const markup = renderToStaticMarkup(element);
  assert.ok(markup.includes(business.name), "renders the store name");
  assert.ok(markup.includes("page"), "renders the page inside the frame");
});

test("with the gate on, unknown and ineligible stores are still notFound()", async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  const hosts = [
    "nobody.localhost:3000",
    (await store({ status: "draft" })).host,
    (await store({ status: "suspended" })).host,
    (await store({ entitled: false })).host,
  ];
  for (const host of hosts) {
    setMockRequestHeaders({ host });
    await expectNotFound(AccountLayout({ children: "page" }));
  }
  setMockRequestHeaders(null); // no Host at all
  await expectNotFound(AccountLayout({ children: "page" }));
});
