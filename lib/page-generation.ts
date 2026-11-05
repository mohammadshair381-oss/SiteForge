import mongoose, { type ClientSession } from "mongoose";
import { dbConnect } from "./db";
import { HttpError } from "./api";
import { isCustomerAccountsEnabled } from "./env";
import { readShippingSettings } from "./checkout-pricing";
import { getPageAllowance, withPageCapacity } from "./usage-limits";
import { getStorefrontSettings } from "./storefront-settings";
import { isOnlinePaymentAvailable } from "./payments/order-payments";
import { PAGE_FAMILY_LABELS, isEssentialPage, pagePriority, planDefaultPages, type DefaultPageSpec, type PagePlan, type PagePlanInput } from "./page-presets";
import { Business } from "@/models/Business";
import { Page } from "@/models/Page";
import { Product } from "@/models/Product";

/**
 * Default-page generation (server). Builds the plan from the business's REAL
 * data (lib/page-presets.ts) and creates only what is missing:
 *
 * - Never touches an existing page: a page whose slug or generated key exists
 *   is reported as "exists" (owner content is never overwritten). Running it
 *   again, or concurrently, creates nothing twice (unique slug index).
 * - Every generated page is a DRAFT; nothing is published.
 * - Only as many as the plan has room for, essential ones first. The rest are reported back
 *   as `omitted`, and the owner can prepare them after upgrading. It never exceeds the limit.
 * - A store without any Page renders its homepage in "legacy" mode. Creating
 *   pages switches it to multi-page mode, where `/` needs a published home
 *   page, so a home page that reproduces the CURRENT homepage exactly (the
 *   commerce homepage, or the legacy classic sections) is created first. No
 *   new content becomes public.
 * - Navigation: generated pages are added to the DRAFT header/footer only
 *   where that area is still empty (an owner's navigation is never changed).
 *   Public navigation shows published pages only.
 */

export async function loadPagePlanInput(businessId: string): Promise<PagePlanInput> {
  await dbConnect();
  const business = await Business.findById(businessId).lean();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  const [settings, products, onlinePayments] = await Promise.all([
    getStorefrontSettings(businessId),
    Product.find({ business: businessId, status: "active" }).select("category price compareAtPrice").lean<Array<{ category?: string; price: number; compareAtPrice?: number | null }>>(),
    isOnlinePaymentAvailable(business._id),
  ]);
  const counts = new Map<string, { name: string; count: number }>();
  for (const product of products) {
    const name = (product.category ?? "").trim();
    if (!name) continue;
    const entry = counts.get(name.toLowerCase()) ?? { name, count: 0 };
    entry.count += 1;
    counts.set(name.toLowerCase(), entry);
  }
  const shipping = readShippingSettings((business as { shippingSettings?: unknown }).shippingSettings);
  return {
    business: {
      name: business.name,
      category: business.category,
      description: business.description ?? "",
      contactEmail: business.contactEmail ?? "",
      phone: business.phone ?? "",
      address: business.address ?? "",
      currency: business.currency || "USD",
      codEnabled: (business as { codEnabled?: boolean }).codEnabled === true,
      guestCodEnabled: (business as { guestCodEnabled?: boolean }).guestCodEnabled === true,
    },
    policies: { shipping: settings.draft.policies.shipping ?? "", returns: settings.draft.policies.returns ?? "" },
    shipping: shipping.enabled ? { enabled: true, flatRate: shipping.flatRate, freeOver: shipping.freeOver, deliveryInfo: shipping.deliveryInfo } : null,
    categories: [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    productCount: products.length,
    saleCount: products.filter((p) => typeof p.compareAtPrice === "number" && p.compareAtPrice > p.price).length,
    onlinePayments,
    accountsEnabled: isCustomerAccountsEnabled(),
  };
}

export interface DefaultPagesPreview {
  family: PagePlan["family"];
  familyLabel: string;
  pages: Array<{
    key: string;
    title: string;
    slug: string;
    kind: DefaultPageSpec["kind"];
    description: string;
    needsReview: boolean;
    nav: DefaultPageSpec["nav"];
    reason: string;
    /** "exists": a page with this slug or kind is already there (left untouched). "over_limit": no room on this plan. */
    status: "new" | "exists" | "over_limit";
    essential: boolean;
  }>;
  skipped: PagePlan["skipped"];
  allowance: { limit: number | null; used: number; remaining: number | null };
}

/** Essential first, keeping the plan's own order otherwise. */
const byPriority = <T extends Pick<DefaultPageSpec, "key" | "kind" | "nav">>(specs: readonly T[]): T[] =>
  specs.map((spec, index) => ({ spec, index })).sort((a, b) => pagePriority(a.spec) - pagePriority(b.spec) || a.index - b.index).map(({ spec }) => spec);

async function existingIdentity(businessId: string) {
  const pages = await Page.find({ business: businessId }).select("slug isHome generated.key").lean<Array<{ slug: string; isHome?: boolean; generated?: { key?: string } }>>();
  return {
    count: pages.length,
    slugs: new Set(pages.map((p) => p.slug)),
    keys: new Set(pages.map((p) => p.generated?.key).filter((k): k is string => Boolean(k))),
  };
}

/** What generation would create for this business, and what already exists. */
export async function previewDefaultPages(businessId: string): Promise<DefaultPagesPreview> {
  const [input, existing, allowance] = await Promise.all([loadPagePlanInput(businessId), (async () => { await dbConnect(); return existingIdentity(businessId); })(), getPageAllowance(businessId)]);
  const plan = planDefaultPages(input);
  const missing = plan.pages.filter((spec) => !existing.slugs.has(spec.slug) && !existing.keys.has(spec.key));
  const fits = new Set(byPriority(missing).slice(0, allowance.remaining ?? missing.length).map((spec) => spec.key));
  return {
    family: plan.family,
    familyLabel: PAGE_FAMILY_LABELS[plan.family],
    pages: plan.pages.map((spec) => ({
      key: spec.key,
      title: spec.title,
      slug: spec.slug,
      kind: spec.kind,
      description: spec.description,
      needsReview: spec.needsReview,
      nav: spec.nav,
      reason: spec.reason,
      status: existing.slugs.has(spec.slug) || existing.keys.has(spec.key) ? "exists" : fits.has(spec.key) ? "new" : "over_limit",
      essential: isEssentialPage(spec),
    })),
    skipped: plan.skipped,
    allowance,
  };
}

export interface GenerationResult {
  created: Array<{ id: string; key: string; title: string; slug: string; needsReview: boolean }>;
  existing: Array<{ key: string; title: string; slug: string }>;
  skipped: PagePlan["skipped"];
  /** Not created because the plan has no more room. Nothing about them was saved. */
  omitted: Array<{ key: string; title: string; slug: string; essential: boolean }>;
  /** The plan's limit, when there is one. */
  pageLimit: number | null;
  homeCreated: boolean;
  navigation: { header: number; footer: number };
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;
}

/**
 * Call this before creating a store's first page: it adds a published Home
 * page whose sections are exactly what is live today (none = the commerce
 * homepage), so the homepage does not change and the homepage editor stays
 * reachable once other pages exist. Its slug avoids `reservedSlugs` (the pages
 * about to be created). Returns whether it created one. A store that already
 * has pages is left alone.
 */
export async function ensureHomeMirror(businessId: string, session?: ClientSession, reservedSlugs: readonly string[] = []): Promise<boolean> {
  if ((await Page.countDocuments({ business: businessId }).session(session ?? null)) > 0) return false;
  const business = await Business.findById(businessId).select("themeSettings").session(session ?? null).lean<{ themeSettings?: { sections?: unknown } }>();
  const legacySections = Array.isArray(business?.themeSettings?.sections) ? business!.themeSettings!.sections : [];
  let slug = "home";
  for (let n = 2; reservedSlugs.includes(slug); n += 1) slug = `home-${n}`;
  await Page.create(
    [{ business: businessId, title: "Home", slug, isHome: true, status: "published", sections: legacySections, publishedSections: legacySections, seoTitle: "", seoDescription: "" }],
    { session: session ?? undefined },
  );
  return true;
}

/**
 * Creates the missing default pages (all, or only `keys`) as drafts, up to what
 * the plan has room for. Safe to run repeatedly or concurrently: existing pages
 * are never changed, and each page is checked against the limit as it is created.
 */
export async function generateDefaultPages(businessId: string, options: { keys?: string[] } = {}): Promise<GenerationResult> {
  await dbConnect();
  const input = await loadPagePlanInput(businessId);
  const plan = planDefaultPages(input);
  const wanted = options.keys ? plan.pages.filter((spec) => options.keys!.includes(spec.key)) : plan.pages;
  const existing = await existingIdentity(businessId);
  const result: GenerationResult = { created: [], existing: [], skipped: plan.skipped, omitted: [], pageLimit: null, homeCreated: false, navigation: { header: 0, footer: 0 } };

  const toCreate = wanted.filter((spec) => {
    if (existing.slugs.has(spec.slug) || existing.keys.has(spec.key)) {
      result.existing.push({ key: spec.key, title: spec.title, slug: spec.slug });
      return false;
    }
    return true;
  });
  if (toCreate.length === 0) return result;

  const allowance = await getPageAllowance(businessId);
  result.pageLimit = allowance.limit;
  const omit = (spec: DefaultPageSpec) => result.omitted.push({ key: spec.key, title: spec.title, slug: spec.slug, essential: isEssentialPage(spec) });
  const ordered = byPriority(toCreate);
  const fitting = ordered.slice(0, allowance.remaining ?? ordered.length);
  ordered.slice(fitting.length).forEach(omit);
  // No room at all: nothing about the store changes, not even its homepage record.
  if (fitting.length === 0) return result;

  // Legacy store (no pages yet): first a home page that renders exactly what
  // is live today, so `/` keeps working in multi-page mode.
  if (existing.count === 0) {
    try {
      result.homeCreated = await ensureHomeMirror(businessId);
    } catch (error) {
      // A concurrent run created it: fine.
      if (!isDuplicateKey(error)) throw error;
    }
  }

  const now = new Date();
  for (const [index, spec] of fitting.entries()) {
    try {
      const [page] = await withPageCapacity(businessId, 1, (session) =>
          Page.create(
            [
              {
                business: businessId,
                title: spec.title,
                slug: spec.slug,
                description: spec.description,
                sections: spec.sections,
                isHome: false,
                status: "draft",
                seoTitle: spec.seoTitle.slice(0, 160),
                seoDescription: spec.seoDescription.slice(0, 320),
                generated: { key: spec.key, source: "template", preset: plan.family, needsReview: spec.needsReview, createdAt: now },
              },
            ],
            { session },
          ),
      );
      result.created.push({ id: String(page._id), key: spec.key, title: spec.title, slug: spec.slug, needsReview: spec.needsReview });
    } catch (error) {
      // Another request used the last place meanwhile: the rest are reported, not forced in.
      if (error instanceof HttpError && error.code === "limit_reached") {
        fitting.slice(index).forEach(omit);
        break;
      }
      if (!isDuplicateKey(error)) throw error;
      result.existing.push({ key: spec.key, title: spec.title, slug: spec.slug });
    }
  }
  // Menus list pages in the plan's order, whichever were created first.
  const planOrder = new Map(toCreate.map((spec, index) => [spec.key, index]));
  result.created.sort((a, b) => (planOrder.get(a.key) ?? 0) - (planOrder.get(b.key) ?? 0));

  // Draft navigation, only where the owner has none yet (conditional update,
  // so a navigation saved meanwhile is never overwritten).
  const byArea = (area: "header" | "footer") =>
    result.created
      .filter((page) => toCreate.find((spec) => spec.key === page.key)?.nav === area)
      .slice(0, area === "header" ? 5 : 10)
      .map((page, order) => ({ pageId: page.id, label: page.title, order }));
  for (const area of ["header", "footer"] as const) {
    const items = byArea(area);
    if (items.length === 0) continue;
    const update = await Business.updateOne(
      {
        _id: new mongoose.Types.ObjectId(businessId),
        $or: [{ [`themeSettings.navigation.${area}`]: { $exists: false } }, { [`themeSettings.navigation.${area}`]: { $size: 0 } }],
      },
      // A store with no published copy shows its saved menus, so these are marked as
      // drafts: they go live with the store or from Publish, like any other menu.
      { $set: { [`themeSettings.navigation.${area}`]: items, "themeSettings.navigationDraftOnly": true }, $inc: { navigationDraftVersion: 1 } },
    );
    if (update.modifiedCount === 1) result.navigation[area] = items.length;
  }
  return result;
}
