import { notFound } from "next/navigation";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { DEFAULT_THEME_SETTINGS, themeBrandColors, toStorefrontView } from "@/lib/storefront";
import { getEntitlements, getThemeAccess } from "@/lib/billing";
import { getDesignState } from "@/lib/design-service";
import { isCustomerAccountsEnabled } from "@/lib/env";
import { recentApprovedReviews } from "@/lib/reviews";
import { getStorefrontSettings } from "@/lib/storefront-settings";
import { loadPublicCategories } from "@/lib/categories";
import { loadStorefrontPreviewData } from "@/lib/storefront-preview-data";
import { aiPlatformStatus } from "@/lib/ai-builder/provider";
import { loadAiConsentView } from "@/lib/ai-builder/consent";
import { getAiUsageSummary } from "@/lib/ai-builder/usage";
import { readBrand, storefrontStateHash } from "@/lib/ai-builder/storefront-proposals";
import { PRESET_LABELS, presetForBusinessType } from "@/lib/storefront-presets";
import { getThemeMeta } from "@/lib/themes";
import { Business } from "@/models/Business";
import { Product } from "@/models/Product";
import { Page } from "@/models/Page";
import VisualEditor from "@/components/dashboard/VisualEditor";
import LegacyHomepageAdoption from "@/components/dashboard/editor/LegacyHomepageAdoption";
import HomeEditor, { type ClassicHomepage } from "@/components/dashboard/editor/HomeEditor";
import { chooseEditorMode, selectEditorPage } from "@/lib/editor-mode";

export const dynamic = "force-dynamic";

/**
 * Website editor. The HOMEPAGE is edited with the store homepage editor
 * (the same renderer and data as the public storefront) unless it still uses
 * classic custom sections; other pages (About, Contact, …) and classic
 * homepages use the section editor. `?mode=store` opens the store homepage
 * editor for a classic homepage (publishing it retires the classic sections).
 * Without a published Home page it opens the homepage `/` shows instead.
 */
export default async function BusinessEditor({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; mode?: string }>;
}) {
  const { id } = await params;
  const { page: pageId, mode } = await searchParams;
  const { membership } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
  await dbConnect();

  const [business, products, entitlements, pages, themeAccess, designState] = await Promise.all([
    Business.findById(id).lean(),
    Product.find({ business: id, status: "active" }).sort({ createdAt: -1 }).lean(),
    getEntitlements(id),
    Page.find({ business: id }).lean(),
    getThemeAccess(id),
    getDesignState(id),
  ]);
  if (!business) notFound();

  if (pageId && !pages.some((page) => String(page._id) === pageId)) notFound();
  const selectedPage = selectEditorPage(pages, pageId);
  const canManage = membership.role === "owner" || membership.role === "manager";

  // ---- Which homepage content exists? ---------------------------------------
  const themeSettings = (business.themeSettings ?? {}) as unknown as Record<string, unknown>;
  const { hasClassicHomepage, useStoreEditor } = chooseEditorMode({
    selectedPage,
    legacySections: themeSettings.sections,
    mode,
  });

  // A homepage kept only in the theme settings moves to a page record first, so it
  // gets drafts, autosave and publishing. Staff can only read, so nothing moves for them.
  if (!selectedPage && hasClassicHomepage && canManage) {
    return <LegacyHomepageAdoption businessId={id} mode={mode} />;
  }

  const serializedPages = pages.map((p) => ({
    _id: String(p._id),
    title: p.title,
    slug: p.slug,
    status: p.status as "draft" | "published",
    isHome: Boolean(p.isHome),
    // Prepared by default-page generation; policy templates need a review to publish.
    generated: Boolean(p.generated),
    generatedByAi: p.generated?.source === "ai",
    needsReview: Boolean(p.generated?.needsReview),
    seoTitle: p.seoTitle ?? "",
    seoDescription: p.seoDescription ?? "",
    seoImage: p.seoImage ?? "",
    noindex: Boolean(p.noindex),
    canonicalUrl: p.canonicalUrl ?? "",
  }));
  const accountsEnabled = isCustomerAccountsEnabled();

  if (useStoreEditor) {
    // Same projection, data and DRAFT settings as every dashboard preview.
    const data = await loadStorefrontPreviewData(id, { reviews: true });
    if (!data) notFound();
    const aiStatus = await aiPlatformStatus();
    const aiConsent = await loadAiConsentView(id, membership.role === "owner");
    const aiUsage = aiConsent.ready ? await getAiUsageSummary(id, data.entitlements.aiRequestsPerMonth) : null;
    // Remount after the draft changes outside the editor (an applied suggestion).
    const stateKey = storefrontStateHash(data.settings.draft, readBrand(business.themeSettings)).slice(0, 16);
    const classic: ClassicHomepage = hasClassicHomepage
      ? !selectedPage
        ? { kind: "legacy" }
        : { kind: "page", pageId: String(selectedPage._id), version: typeof selectedPage.version === "number" ? selectedPage.version : 0 }
      : null;
    return (
      <HomeEditor
        key={`${id}:store:${stateKey}`}
        businessId={id}
        businessName={business.name}
        view={data.view}
        initialConfig={data.settings.draft}
        initialDraftVersion={data.settings.draftVersion}
        initialThemeId={data.view.themeId}
        initialFont={String((themeSettings.font as string | undefined) ?? "sans")}
        extras={data.extras}
        catalog={{
          businessId: id,
          products: data.products.map((p) => ({ id: String(p._id), name: p.name, imageUrl: p.imageUrl ?? "" })),
          categoryNames: data.categoryNames,
          linkOptions: data.linkOptions,
        }}
        pages={serializedPages}
        currentPageId={selectedPage ? String(selectedPage._id) : undefined}
        classicHomepage={classic}
        storeLive={business.status === "published"}
        hasUnpublishedChanges={data.settings.hasUnpublishedChanges}
        canManage={canManage}
        themeAccess={themeAccess}
        ai={{
          status: aiStatus,
          consent: aiConsent,
          usage: aiUsage,
          typeLabel: PRESET_LABELS[presetForBusinessType(business.category)],
          themeName: getThemeMeta(business.themeId).name,
        }}
      />
    );
  }

  // ---- Classic section editor (other pages, classic homepages) ---------------
  const pageSections = selectedPage
    ? Array.isArray(selectedPage.sections)
      ? selectedPage.sections
      : []
    : null;
  const pageVersion =
    typeof selectedPage?.version === "number" ? selectedPage.version : undefined;

  // Header and footer in the preview come from the same commerce data as the
  // public store (draft storefront settings).
  const [settings, managedCategories] = await Promise.all([getStorefrontSettings(id), loadPublicCategories(id)]);
  const storefrontView = toStorefrontView(business, products, entitlements.removeBranding, pages, { useDraft: true });

  const { designDraft: _designDraft, design: _design, ...storedSettings } = (business.themeSettings ?? {}) as typeof business.themeSettings & { designDraft?: unknown };
  const initialSettings = {
    ...DEFAULT_THEME_SETTINGS,
    ...storedSettings,
    ...(pageSections ? { sections: pageSections } : {}),
    // Same colours as the store: a page shows the draft design; an old homepage
    // without a page saves straight to the store, so it starts from the live colours.
    ...(() => {
      const { primaryColor, accentColor } = selectedPage ? storefrontView.theme : themeBrandColors(business.themeId, { ...DEFAULT_THEME_SETTINGS, ...(business.themeSettings ?? {}) });
      return { primaryColor, accentColor };
    })(),
  };
  // The AI assistant for this page (not the homepage: that has its own).
  const pageAiConsent = canManage ? await loadAiConsentView(id, membership.role === "owner") : null;

  const base = {
    name: business.name,
    subdomain: business.subdomain,
    category: business.category,
    description: business.description,
    logoUrl: business.logoUrl,
    contactEmail: business.contactEmail,
    phone: business.phone,
    address: business.address,
    currency: business.currency,
  };

  return (
    <VisualEditor
      key={`${id}:${selectedPage ? String(selectedPage._id) : "legacy"}`}
      businessId={id}
      pageId={selectedPage ? String(selectedPage._id) : undefined}
      pageVersion={pageVersion}
      initialThemeId={selectedPage ? storefrontView.themeId : business.themeId}
      design={designState.draft}
      initialSettings={initialSettings}
      base={base}
      products={storefrontView.products}
      pages={serializedPages}
      canManage={canManage}
      removeBranding={entitlements.removeBranding}
      pageAi={
        pageAiConsent
          ? {
              available: pageAiConsent.provider.available,
              consent: pageAiConsent,
              usage: await getAiUsageSummary(id, entitlements.aiRequestsPerMonth),
              planName: entitlements.planName,
              isOwner: membership.role === "owner",
            }
          : undefined
      }
      storefrontDraft={settings.draft}
      commerceExtras={{
        managedCategories,
        pageSlugs: pages.filter((p) => p.status === "published").map((p) => p.slug),
        accountsEnabled,
        reviews: await recentApprovedReviews(id),
      }}
      classicHomepage={hasClassicHomepage}
      themeAccess={themeAccess}
    />
  );
}
