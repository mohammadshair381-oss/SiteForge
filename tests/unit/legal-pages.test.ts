import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import fs from "node:fs";

import TermsPage from "../../app/terms/page";
import PrivacyPage from "../../app/privacy/page";

// Make React available globally so page JSX compiles to React.createElement
// calls that resolve React from globalThis in the unit test environment.
(globalThis as unknown as { React?: typeof React }).React = React;

async function renderComponent(Component: React.ComponentType<unknown>) {
  const html = renderToString(React.createElement(Component));
  return html;
}

function readSource(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("/terms page renders without authentication and contains primary heading", async () => {
  const html = await renderComponent(TermsPage);
  assert.ok(html.includes("Terms of Service"), "Terms page should show primary heading");
  assert.ok(html.includes("Acceptance of Terms"), "Terms page should contain section content");
});

test("/privacy page renders without authentication and contains primary heading", async () => {
  const html = await renderComponent(PrivacyPage);
  assert.ok(html.includes("Privacy Policy"), "Privacy page should show primary heading");
  assert.ok(html.includes("Information We Collect"), "Privacy page should contain section content");
});

test("/terms page does not invent company contact details", async () => {
  const html = await renderComponent(TermsPage);
  assert.ok(
    html.includes("contact SiteForge through the support channel"),
    "Terms page should direct users to dashboard support channel rather than inventing an address",
  );
});

test("/privacy page does not invent specific retention periods", async () => {
  const html = await renderComponent(PrivacyPage);
  assert.ok(
    html.includes("retain account and business information as long as your account remains active"),
    "Privacy page should describe retention without inventing specific periods",
  );
});

test("landing page footer links to terms and privacy", () => {
  const source = readSource("app/page.tsx");
  assert.ok(source.includes('href="/terms"'), "Landing page footer should link to /terms");
  assert.ok(source.includes('href="/privacy"'), "Landing page footer should link to /privacy");
});

test("registration page links to terms and privacy", () => {
  const source = readSource("app/register/page.tsx");
  assert.ok(source.includes('href="/terms"'), "Registration page should link to /terms");
  assert.ok(source.includes('href="/privacy"'), "Registration page should link to /privacy");
});

test("registration page does not include an unbacked consent checkbox", () => {
  const source = readSource("app/register/page.tsx");
  // The register page should not add a new <input> checkbox for acceptance.
  // It already has name/email/password inputs; we just verify no new checkbox input was added
  // beyond the existing form fields by checking for absence of an acceptance-related input.
  assert.ok(
    !source.includes('type="checkbox"'),
    "Registration page should not add an unbacked acceptance checkbox",
  );
});
