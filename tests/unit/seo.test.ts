import assert from "node:assert/strict";
import test from "node:test";

import { buildPageMetadata, resolvePublishedSeoText } from "@/lib/seo";

const business = { name: "Acme Bakery", description: "Fresh bread daily.", aboutFallback: "" };

test("published SEO snapshot wins over a newer draft", () => {
  const seo = resolvePublishedSeoText({
    title: "About",
    seoTitle: "Draft title",
    seoDescription: "Draft description",
    publishedSeoTitle: "Live title",
    publishedSeoDescription: "Live description",
  });
  assert.deepEqual(seo, { title: "Live title", description: "Live description" });
});

test("an empty published snapshot means no custom SEO (it does not fall back to the draft)", () => {
  const seo = resolvePublishedSeoText({
    title: "About",
    seoTitle: "Draft title",
    publishedSeoTitle: "",
    publishedSeoDescription: "",
  });
  assert.deepEqual(seo, { title: "", description: "" });
});

test("legacy pages without a snapshot fall back to the stored SEO fields", () => {
  const seo = resolvePublishedSeoText({
    title: "About",
    seoTitle: "  Legacy   title ",
    seoDescription: "Legacy description",
  });
  assert.deepEqual(seo, { title: "Legacy title", description: "Legacy description" });
});

test("metadata uses custom SEO text when present", () => {
  const meta = buildPageMetadata(business, {
    title: "About",
    publishedSeoTitle: "Our story",
    publishedSeoDescription: "How we started.",
  });
  assert.deepEqual(meta.title, { absolute: "Our story" });
  assert.equal(meta.description, "How we started.");
  assert.equal(meta.openGraph?.title, "Our story");
});

test("fallbacks: homepage uses the business name, other pages add the page title", () => {
  const home = buildPageMetadata(business, { title: "Home", isHome: true });
  assert.deepEqual(home.title, { absolute: "Acme Bakery" });
  assert.equal(home.description, "Fresh bread daily.");

  const about = buildPageMetadata(business, { title: "About us" });
  assert.deepEqual(about.title, { absolute: "About us | Acme Bakery" });
});

test("fallback description is trimmed to a search-friendly length and omitted when empty", () => {
  const long = buildPageMetadata({ name: "X", description: "word ".repeat(100) }, null);
  assert.ok(typeof long.description === "string" && long.description.length <= 160);

  const none = buildPageMetadata({ name: "X", description: "" }, null);
  assert.equal("description" in none, false);
  assert.deepEqual(none.title, { absolute: "X" });
});

test("SEO text is never interpreted as markup by metadata (plain strings only)", () => {
  const meta = buildPageMetadata(business, {
    title: "Page",
    publishedSeoTitle: "<script>alert(1)</script>",
  });
  // Next.js escapes metadata when rendering; we only guarantee it stays a string.
  assert.equal(typeof (meta.title as { absolute: string }).absolute, "string");
});
