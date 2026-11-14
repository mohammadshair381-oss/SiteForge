import assert from "node:assert/strict";
import test, { before } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// TSX in this test runner compiles to classic React.createElement calls.
(globalThis as unknown as { React?: typeof React }).React = React;

type HeaderProps = {
  title: string;
  description: string;
  action?: { href: string; label: string; primary?: boolean };
  actions?: React.ReactNode;
};

let ManagementPageHeader: (props: HeaderProps) => React.ReactElement;

before(async () => {
  const module = await import("../../frontend/components/dashboard/ManagementPageHeader");
  ManagementPageHeader = module.default;
});

function render(props: HeaderProps): string {
  return renderToStaticMarkup(React.createElement(ManagementPageHeader, props));
}

test("management page header: renders exactly one page heading with its description", () => {
  const html = render({
    title: "Products",
    description: "Add and organize the items shown on your website.",
  });

  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /<h1[^>]*>Products<\/h1>/);
  assert.match(html, /Add and organize the items shown on your website\./);
});

test("management page header: keeps the legacy action link API", () => {
  const html = render({
    title: "Products",
    description: "Add and organize the items shown on your website.",
    action: { href: "#add-product", label: "Add product", primary: true },
  });

  assert.match(html, /<a [^>]*href="#add-product"/);
  assert.match(html, />Add product</);
  assert.match(html, /bg-brand-600/);
});

test("management page header: styles a secondary action link differently", () => {
  const html = render({
    title: "Pages",
    description: "Manage the pages on your website.",
    action: { href: "/dashboard", label: "Back to dashboard" },
  });

  assert.match(html, /border-slate-300/);
  assert.match(html, /Back to dashboard/);
  assert.doesNotMatch(html, /bg-brand-600/);
});

test("management page header: renders client-side action controls and prefers them over the link API", () => {
  const html = render({
    title: "Website navigation",
    description: "Choose which published pages appear in your header and footer.",
    action: { href: "/legacy", label: "Legacy action" },
    actions: React.createElement("button", { type: "button" }, "Save navigation"),
  });

  assert.match(html, /<div class="flex flex-wrap items-center gap-2">/);
  assert.match(html, /<button type="button">Save navigation<\/button>/);
  assert.doesNotMatch(html, /Legacy action/);
});

test("management page header: renders no action slot when neither is supplied", () => {
  const html = render({
    title: "Media",
    description: "Images for your storefront.",
  });

  assert.doesNotMatch(html, /<a /);
  assert.doesNotMatch(html, /<button/);
});
