import { notFound } from "next/navigation";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { getEntitlements } from "@/lib/billing";
import { Business } from "@/models/Business";
import { Product } from "@/models/Product";
import { Page } from "@/models/Page";
import { selectEditorPage } from "@/lib/editor-mode";
import { toStorefrontView } from "@/lib/storefront";
import SectionRenderer from "@/components/storefront/SectionRenderer";
import ThemeRenderer from "@/components/storefront/ThemeRenderer";
import { getVisibleSections, sectionsArraySchema } from "@/lib/sections";
import { WebsiteProposal } from "@/models/WebsiteProposal";
import { buildCommerceData } from "@/lib/storefront-home";
import { loadBestSellerIds } from "@/lib/storefront-commerce";
import { isOnlinePaymentAvailable } from "@/lib/payments/order-payments";
import { isCustomerAccountsEnabled } from "@/lib/env";
import { loadPublicCategories } from "@/lib/categories";
import { CLASSIC_PREVIEW_ID, type WebsitePreview } from "@/lib/ai-website/blueprint";
import { websitePreviewExtras, websitePreviewSections, websitePreviewView } from "@/lib/ai-website/preview";
import { THEME_IDS } from "@/lib/constants";
import { getThemeMeta } from "@/lib/themes";

export const dynamic = "force-dynamic";

const PREVIEW_NOTE = "sticky top-0 z-50 bg-slate-900 px-4 py-2 text-center text-sm font-medium text-white";

export default async function BusinessPreview({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; proposal?: string; mode?: string; theme?: string }>;
}) {
  const { id } = await params;
  const { page: pageId, proposal: proposalId, mode, theme: themeParam } = await searchParams;
  const { membership } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
  if (membership.role !== "owner" && membership.role !== "manager") notFound();
  await dbConnect();

  const [business, products, pages] = await Promise.all([
    Business.findById(id).lean(),
    Product.find({ business: id, status: "active" }).sort({ createdAt: -1 }).lean(),
    Page.find({ business: id }).lean(),
  ]);
  if (!business) notFound();

  const view = toStorefrontView(business, products, (await getEntitlements(id)).removeBranding, pages, { useDraft: true });
  // Data extras of the store renderer (same as the public store).
  const previewExtras = async () => {
    const [bestSellerIds, onlinePayments, managedCategories] = await Promise.all([loadBestSellerIds(id), isOnlinePaymentAvailable(id), loadPublicCategories(id)]);
    const accountsEnabled = isCustomerAccountsEnabled();
    return {
      bestSellerIds,
      pageSlugs: pages.filter((p) => p.status === "published").map((p) => p.slug),
      accountsEnabled,
      onlinePayments,
      codAvailable: business.codEnabled === true && (accountsEnabled || business.guestCodEnabled === true),
      managedCategories,
    };
  };

  // Proposal preview: render the proposal's stored, validated preview of one
  // page with this business's theme. Read-only; nothing is saved. The
  // proposal is loaded by (id, business), so another tenant's id is a 404.
  if (proposalId) {
    if (!/^[a-f0-9]{24}$/i.test(proposalId)) notFound();
    const proposal = await WebsiteProposal.findOne({ _id: proposalId, business: id }).select("preview summary status target expiresAt").lean();
    if (!proposal) notFound();
    if (proposal.target === "website") {
      // A whole website: the homepage or one page, with the proposed design and menus, in the store
      // renderer. Stored, validated data, for owners and managers on this address only; a store's own
      // address never reads it. A proposal that ran out cannot be opened.
      if ((proposal.status === "pending" || proposal.status === "approved") && proposal.expiresAt.getTime() <= Date.now()) notFound();
      const preview = proposal.preview as WebsitePreview;
      const theme = themeParam && (THEME_IDS as readonly string[]).includes(themeParam) ? themeParam : null;
      const base = websitePreviewView(view, preview, theme);
      const sections = websitePreviewSections(preview, pageId);
      const websiteView = sections.length > 0 ? { ...base, theme: { ...base.theme, sections } } : base;
      const commerce = buildCommerceData(websiteView, preview.config, websitePreviewExtras(await previewExtras(), preview));
      const hrefFor = (page: string | null, chosenTheme: string | null) => `?proposal=${proposalId}${page ? `&page=${encodeURIComponent(page)}` : ""}${chosenTheme ? `&theme=${chosenTheme}` : ""}`;
      const link = "rounded px-2 py-1 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";
      return (
        <>
          <div role="note" className={`${PREVIEW_NOTE} space-y-1`}>
            <p>Website proposal preview ({proposal.status}) · not saved and not published · links and cart are disabled</p>
            <nav aria-label="Pages in this preview" className="flex flex-wrap justify-center gap-1 text-xs font-normal">
              <a className={link} aria-current={!pageId ? "page" : undefined} href={hrefFor(null, theme)}>{preview.classicHomepage ? "Homepage once you publish it" : "Homepage"}</a>
              {preview.classicHomepage && <a className={link} aria-current={pageId === CLASSIC_PREVIEW_ID ? "page" : undefined} href={hrefFor(CLASSIC_PREVIEW_ID, theme)}>Your custom homepage (what visitors see now)</a>}
              {preview.pages.map((page) => <a key={page.id} className={link} aria-current={page.id === pageId ? "page" : undefined} href={hrefFor(page.id, theme)}>{page.title}</a>)}
            </nav>
            <nav aria-label="Themes to look at" className="flex flex-wrap justify-center gap-1 text-xs font-normal">
              {THEME_IDS.map((themeId) => <a key={themeId} className={link} aria-current={(theme ?? preview.design.themeId) === themeId ? "true" : undefined} href={hrefFor(pageId ?? null, themeId === preview.design.themeId ? null : themeId)}>{getThemeMeta(themeId).name}</a>)}
            </nav>
          </div>
          <ThemeRenderer view={websiteView} productHrefBase="#" preview commerce={commerce} sections={sections.length > 0 ? sections : undefined} />
        </>
      );
    }
    if (proposal.target === "storefront") {
      // Homepage proposal: the store renderer with the proposed draft homepage
      // and brand (validated when the proposal was created). Read-only.
      const preview = (proposal.preview ?? {}) as { config?: unknown; brand?: { primaryColor: string; accentColor: string; font: string } };
      const brandedView = preview.brand
        ? { ...view, theme: { ...view.theme, primaryColor: preview.brand.primaryColor, accentColor: preview.brand.accentColor, font: preview.brand.font } }
        : view;
      const commerce = buildCommerceData(brandedView, preview.config, await previewExtras());
      return (
        <>
          <div role="note" className={PREVIEW_NOTE}>
            Homepage proposal preview ({proposal.status}) · not saved and not published
          </div>
          <ThemeRenderer view={brandedView} productHrefBase="#" preview commerce={commerce} />
        </>
      );
    }
    const previewPages = ((proposal.preview as { pages?: Array<{ id: string; sections: unknown }> })?.pages ?? []);
    const previewPage = previewPages.find((p) => p.id === pageId) ?? previewPages[0];
    const parsed = sectionsArraySchema.safeParse(previewPage?.sections ?? []);
    if (!parsed.success || parsed.data.length === 0) notFound();
    const previewView = { ...view, theme: { ...view.theme, sections: parsed.data } };
    return (
      <>
        <div role="note" className={PREVIEW_NOTE}>
          Proposal preview ({proposal.status}) · not saved and not published
        </div>
        <SectionRenderer view={previewView} productHrefBase="#" preview />
      </>
    );
  }

  // Same renderer as the public store (ThemeRenderer: header, page body,
  // footer) with DRAFT content: the page's draft sections, or the store
  // homepage with the draft storefront settings. `?mode=store` previews the
  // store homepage for a homepage that still has classic sections.
  let sections: unknown[] = [];
  if (pageId) {
    if (!/^[a-f0-9]{24}$/i.test(pageId)) notFound();
    const page = await Page.findOne({ _id: pageId, business: id }).lean();
    if (!page) notFound();
    sections = Array.isArray(page.sections) ? page.sections : [];
  } else if (mode !== "store") {
    const home = selectEditorPage(pages);
    // Without a published Home page the store renders from its theme settings.
    sections = !home
      ? (Array.isArray((business.themeSettings as Record<string, unknown> | undefined)?.sections) ? ((business.themeSettings as Record<string, unknown>).sections as unknown[]) : [])
      : Array.isArray(home.sections) ? home.sections : [];
  }

  const commerce = buildCommerceData(view, (business.themeSettings as Record<string, unknown> | undefined)?.storefront, await previewExtras());
  // Same filtering as the public storefront (getVisibleSections).
  const visible = getVisibleSections(sections);
  const pageView = visible.length > 0 ? { ...view, theme: { ...view.theme, sections: visible } } : view;
  return (
    <>
      <div role="note" className={PREVIEW_NOTE}>
        Preview with your saved draft · links and cart are disabled here
      </div>
      <ThemeRenderer view={pageView} productHrefBase="#" preview commerce={commerce} sections={visible.length > 0 ? visible : undefined} />
    </>
  );
}