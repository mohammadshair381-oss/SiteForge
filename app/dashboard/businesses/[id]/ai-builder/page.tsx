import Link from "next/link";
import { notFound } from "next/navigation";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { getEntitlements } from "@/lib/billing";
import { loadAiConsentView } from "@/lib/ai-builder/consent";
import { getAiUsageSummary } from "@/lib/ai-builder/usage";
import { loadStorefrontPreviewData } from "@/lib/storefront-preview-data";
import { Business } from "@/models/Business";
import { Page } from "@/models/Page";
import { Product, type ProductDoc } from "@/models/Product";
import { ProductCategory, type ProductCategoryDoc } from "@/models/ProductCategory";
import AiBuilder from "@/components/dashboard/ai/AiBuilder";
import ManagementPageHeader from "@/components/dashboard/ManagementPageHeader";
import { focusRing } from "@/components/ui/Button";
import { cardClass } from "@/components/ui/Surface";

export const dynamic = "force-dynamic";

/**
 * The AI Builder: natural-language changes to the homepage, sections, pages,
 * SEO, product text and theme choice, all through the existing proposal,
 * consent, allowance and entitlement systems. Owners and managers.
 */
export default async function AiBuilderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ area?: string | string[] }> }) {
  const { id } = await params;
  const { area } = await searchParams;
  const { membership } = await requireBusinessRole(id, ["owner", "manager"]);
  await dbConnect();
  const [business, pages, products, categories, entitlements, previewData] = await Promise.all([
    Business.findById(id).select("name").lean(),
    Page.find({ business: id }).select("_id title slug status isHome").sort({ isHome: -1, createdAt: 1 }).lean(),
    Product.find({ business: id, status: { $ne: "archived" } }).select("_id name description imageUrl images seoTitle seoDescription imageAlt").sort({ name: 1 }).limit(200).lean<ProductDoc[]>(),
    ProductCategory.find({ business: id }).sort({ sort: 1, name: 1 }).lean<ProductCategoryDoc[]>(),
    getEntitlements(id),
    loadStorefrontPreviewData(id),
  ]);
  if (!business || !previewData) notFound();
  const isOwner = membership.role === "owner";
  const consent = await loadAiConsentView(id, isOwner);
  const usage = await getAiUsageSummary(id, entitlements.aiRequestsPerMonth);

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="AI Builder"
        description="Describe what you want in your own words. The AI proposes the change, you preview and approve it, it goes to your draft, and publishing stays your decision."
      />
      <AiBuilder
        businessId={id}
        available={consent.provider.available}
        initialArea={area === "website" ? "website" : undefined}
        consentView={consent}
        usage={{ used: usage.used, limit: usage.limit, remaining: usage.remaining }}
        planName={entitlements.planName}
        isOwner={isOwner}
        previewData={{ view: previewData.view, config: previewData.settings.draft, extras: previewData.extras }}
        pages={pages.map((p) => ({ id: String(p._id), title: p.title, slug: p.slug, status: p.status === "published" ? "published" : "draft", isHome: Boolean(p.isHome) }))}
        products={products.map((p) => ({
          id: String(p._id),
          name: p.name,
          description: p.description ?? "",
          hasImage: Boolean(p.imageUrl || p.images?.[0]),
          seoTitle: p.seoTitle ?? "",
          seoDescription: p.seoDescription ?? "",
          imageAlt: p.imageAlt ?? "",
        }))}
        categories={categories.map((c) => ({
          id: String(c._id),
          name: c.name,
          slug: c.slug,
          description: c.description ?? "",
          imageUrl: c.imageUrl ?? "",
          active: c.active,
          seoTitle: c.seoTitle ?? "",
          seoDescription: c.seoDescription ?? "",
        }))}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Link href={`/dashboard/businesses/${id}/ai-builder/planner`} className={`${cardClass} ui-lift block p-4 transition-colors hover:border-slate-300 ${focusRing}`}>
          <span className="block text-sm font-semibold text-slate-900">Prefer to lay out pages by hand?</span>
          <span className="mt-0.5 block text-sm text-slate-600">The website planner adds new draft pages from your own brief, with no AI.</span>
        </Link>
        <Link href={`/dashboard/businesses/${id}/proposals`} className={`${cardClass} ui-lift block p-4 transition-colors hover:border-slate-300 ${focusRing}`}>
          <span className="block text-sm font-semibold text-slate-900">Change proposals</span>
          <span className="mt-0.5 block text-sm text-slate-600">Review every suggestion and what happened to it, all in one queue.</span>
        </Link>
      </div>
    </div>
  );
}
