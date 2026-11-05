import type { Metadata } from "next";
import { headers } from "next/headers";
import { getStorefrontPageMetadata } from "@/lib/seo";
import { notFound, permanentRedirect } from "next/navigation";
import { getPublicStorefront } from "@/lib/tenant";
import { getVisibleSections } from "@/lib/sections";
import { findPageRedirect, resolveStorefrontPage } from "@/lib/storefront-pages";
import ThemeRenderer from "@/components/storefront/ThemeRenderer";
import { loadStorefrontFrame } from "@/lib/storefront-commerce";
import { recentApprovedReviews, reviewsWanted } from "@/lib/reviews";
import { hiddenOnEveryScreen } from "@/lib/section-responsive";
import { pageDescriptionFrom, pageFaqFrom } from "@/lib/page-seo-defaults";
import { jsonLdScript, pageJsonLd, storeJsonLd } from "@/lib/structured-data";
import { storefrontOrigin } from "@/lib/seo";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const headerList = await headers();
  return getStorefrontPageMetadata(
    headerList.get("host"),
    slug && slug.length > 0 ? slug[0] : null,
  );
}

export default async function StorefrontPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const headerList = await headers();
  const host = headerList.get("host");
  const result = await getPublicStorefront(host);
  if (!result) notFound();

  const pageSlug = slug && slug.length > 0 ? slug[0] : null;
  const resolution = await resolveStorefrontPage(result.business._id, pageSlug);
  if (resolution.kind === "not-found") {
    // A page that moved keeps its old links working.
    const moved = pageSlug ? await findPageRedirect(result.business._id, pageSlug) : null;
    if (moved) permanentRedirect(moved);
    notFound();
  }

  // Header, footer and homepage data from PUBLISHED store data only.
  const { view: frame, commerce } = await loadStorefrontFrame(result, headerList.get("cookie"));
  // Reviews are read only when what this request renders has a visible reviews section.
  const rendered = resolution.kind === "page" ? resolution.sections : getVisibleSections(frame.theme.sections);
  const reviewLimit =
    rendered.length > 0 ? reviewsWanted(rendered) : reviewsWanted(commerce.sections.filter((section) => !hiddenOnEveryScreen(commerce.sectionResponsive[section.id])));
  const view = reviewLimit > 0 ? { ...frame, reviews: await recentApprovedReviews(result.business._id, reviewLimit) } : frame;
  // Organization/WebSite structured data on the homepage only (real data).
  const homeJsonLd = pageSlug
    ? null
    : (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: jsonLdScript(
              storeJsonLd({
                name: view.name,
                origin: storefrontOrigin(result.business.subdomain),
                description: result.business.description,
                logoUrl: view.logoUrl,
                email: view.contactEmail,
                phone: view.phone,
                hasProducts: view.products.length > 0,
              }),
            ),
          }}
        />
      );

  // No published Home page yet (no pages, or Home is still a draft): homepage
  // from business theme settings, or the commerce homepage without sections.
  if (resolution.kind === "legacy-business") {
    const sections = getVisibleSections(view.theme.sections);
    return (
      <>
        {homeJsonLd}
        <ThemeRenderer view={view} productHrefBase="/product" sections={sections.length > 0 ? sections : undefined} commerce={commerce} />
      </>
    );
  }

  // Multi-page mode: published content only. An empty published snapshot
  // renders the commerce homepage and never falls back to draft sections.
  const visibleSections = resolution.sections;
  if (visibleSections.length > 0) {
    const pageView = { ...view, theme: { ...view.theme, sections: visibleSections } };
    return (
      <>
        {homeJsonLd}
        {pageSlug && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: jsonLdScript(
                pageJsonLd({
                  name: resolution.title,
                  url: `${storefrontOrigin(result.business.subdomain)}/${encodeURIComponent(pageSlug)}`,
                  description: pageDescriptionFrom(visibleSections),
                  faq: pageFaqFrom(visibleSections),
                }),
              ),
            }}
          />
        )}
        <ThemeRenderer view={pageView} productHrefBase="/product" sections={visibleSections} commerce={commerce} />
      </>
    );
  }
  return (
    <>
      {homeJsonLd}
      <ThemeRenderer view={view} productHrefBase="/product" commerce={commerce} />
    </>
  );
}
