import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import {
  buildPageMetadata,
  buildStorefrontSitemapEntries,
  canonicalRootDomain,
  storefrontOrigin,
} from "../../lib/seo";
import { isHostAwareMetadataPath, middleware } from "../../middleware";

/** Pure SEO helpers and middleware routing for robots/sitemap (Phase 5). */

const ORIGIN = "https://shop.siteforge.test";
const hero = { id: "hero-1", type: "hero", order: 0, visible: true, settings: { headline: "Hi" } };
const hiddenHero = { ...hero, id: "hero-2", visible: false };

test("legacy storefronts (no Page documents) list only the homepage, the catalog and products", () => {
  const entries = buildStorefrontSitemapEntries({
    origin: ORIGIN,
    hasPageDocuments: false,
    publishedPages: [],
    productSlugs: ["mug", "tea pot"],
  });
  assert.deepEqual(
    entries.map((entry) => entry.url),
    [`${ORIGIN}/`, `${ORIGIN}/products`, `${ORIGIN}/product/mug`, `${ORIGIN}/product/tea%20pot`],
  );
});

test("multi-page sitemaps list the home as / and only pages with visible published content", () => {
  const entries = buildStorefrontSitemapEntries({
    origin: ORIGIN,
    hasPageDocuments: true,
    publishedPages: [
      { slug: "home", isHome: true, publishedSections: [] },
      { slug: "about", isHome: false, publishedSections: [hero] },
      { slug: "empty", isHome: false, publishedSections: [] },
      { slug: "hidden", isHome: false, publishedSections: [hiddenHero] },
      // Legacy page written before snapshots existed (field absent): its
      // stored sections are the published content.
      { slug: "legacy", isHome: false, sections: [hero] },
      // Published with an EMPTY snapshot, then draft-edited: the stored
      // sections are unpublished drafts and must not be advertised.
      { slug: "draft-after-empty-publish", isHome: false, publishedSections: [], sections: [hero] },
      // Shadowed by storefront routes, never listed.
      { slug: "cart", isHome: false, publishedSections: [hero] },
      { slug: "product", isHome: false, publishedSections: [hero] },
    ],
    productSlugs: [],
  });
  assert.deepEqual(
    entries.map((entry) => entry.url),
    [`${ORIGIN}/`, `${ORIGIN}/about`, `${ORIGIN}/legacy`],
  );
});

test("without a published homepage, / is still listed: it renders the commerce homepage", () => {
  const entries = buildStorefrontSitemapEntries({
    origin: ORIGIN,
    hasPageDocuments: true,
    publishedPages: [{ slug: "about", isHome: false, publishedSections: [hero] }],
    productSlugs: [],
  });
  assert.deepEqual(entries.map((entry) => entry.url), [`${ORIGIN}/`, `${ORIGIN}/about`]);
});

test("the catalog is listed only when the store has public products", () => {
  const base = { origin: ORIGIN, hasPageDocuments: false, publishedPages: [] };
  assert.deepEqual(buildStorefrontSitemapEntries({ ...base, productSlugs: [] }).map((e) => e.url), [`${ORIGIN}/`]);
  assert.deepEqual(buildStorefrontSitemapEntries({ ...base, productSlugs: [""] }).map((e) => e.url), [`${ORIGIN}/`]);
  assert.ok(buildStorefrontSitemapEntries({ ...base, productSlugs: ["mug"] }).some((e) => e.url === `${ORIGIN}/products`));
});

test("sitemap entries never carry lastModified (no unpublished-activity leak)", () => {
  const entries = buildStorefrontSitemapEntries({
    origin: ORIGIN,
    hasPageDocuments: true,
    publishedPages: [{ slug: "home", isHome: true, publishedSections: [hero] }],
    productSlugs: ["a"],
  });
  for (const entry of entries) assert.equal("lastModified" in entry, false);
});

test("canonical root prefers NEXT_PUBLIC_ROOT_DOMAIN only when it is a served root", () => {
  assert.equal(canonicalRootDomain(["siteforge.app", "www.siteforge.app"], "siteforge.app"), "siteforge.app");
  assert.equal(canonicalRootDomain(["siteforge.app"], "other.example"), "siteforge.app");
  assert.equal(canonicalRootDomain(["siteforge.app"], undefined), "siteforge.app");
});

test("storefront origin uses the tenant subdomain and https in production", () => {
  assert.equal(
    storefrontOrigin("Bakery", { root: "siteforge.app", production: true }),
    "https://bakery.siteforge.app",
  );
  assert.equal(
    storefrontOrigin("bakery", { root: "localhost:3000", production: false }),
    "http://bakery.localhost:3000",
  );
});

test("page metadata carries the canonical URL in alternates and Open Graph", () => {
  const meta = buildPageMetadata({ name: "Acme" }, { title: "About" }, `${ORIGIN}/about`);
  assert.deepEqual(meta.alternates, { canonical: `${ORIGIN}/about` });
  assert.equal((meta.openGraph as { url?: string }).url, `${ORIGIN}/about`);
  const without = buildPageMetadata({ name: "Acme" }, { title: "About" });
  assert.equal("alternates" in without, false);
});

test("middleware passes robots.txt and sitemap.xml through on storefront hosts", () => {
  assert.equal(isHostAwareMetadataPath("/robots.txt"), true);
  assert.equal(isHostAwareMetadataPath("/sitemap.xml"), true);
  assert.equal(isHostAwareMetadataPath("/robots.txt/x"), false);
  assert.equal(isHostAwareMetadataPath("/about"), false);
  assert.equal(isHostAwareMetadataPath("/icon.svg"), true);
  assert.equal(isHostAwareMetadataPath("/icon.svg.png"), false);

  const tenant = (path: string) =>
    middleware(new NextRequest(`http://shop.localhost:3000${path}`, { headers: { host: "shop.localhost:3000" } }));

  for (const path of ["/robots.txt", "/sitemap.xml", "/icon.svg"]) {
    const res = tenant(path);
    assert.equal(res.headers.get("x-middleware-rewrite"), null, `${path} must not be rewritten`);
    assert.equal(res.headers.get("x-middleware-next"), "1");
  }

  // Existing behaviour is unchanged for every other storefront path.
  const page = tenant("/about");
  assert.match(page.headers.get("x-middleware-rewrite") ?? "", /\/store\/about$/);
  const home = tenant("/");
  assert.match(home.headers.get("x-middleware-rewrite") ?? "", /\/store$/);
});
