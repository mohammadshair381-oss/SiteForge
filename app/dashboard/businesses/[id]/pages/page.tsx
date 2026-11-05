import { notFound } from "next/navigation";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { Business } from "@/models/Business";
import { Page } from "@/models/Page";
import PagesManager from "@/components/dashboard/PagesManager";

export const dynamic = "force-dynamic";

export default async function BusinessPages({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { membership } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
  await dbConnect();
  const [pages, business] = await Promise.all([
    Page.find({ business: id }).sort({ isHome: -1, createdAt: 1 }).lean(),
    Business.findById(id).select("name").lean<{ name: string }>(),
  ]);
  const serialized = pages.map((p) => ({
    _id: String(p._id),
    title: p.title,
    slug: p.slug,
    status: p.status,
    isHome: p.isHome,
    version: p.version ?? 0,
    seoTitle: p.seoTitle ?? "",
    seoDescription: p.seoDescription ?? "",
    // Text visitors currently see; legacy pages (no snapshot) fall back to the draft.
    publishedSeoTitle: p.publishedSeoTitle ?? p.seoTitle ?? "",
    publishedSeoDescription: p.publishedSeoDescription ?? p.seoDescription ?? "",
    seoImage: p.seoImage ?? "",
    noindex: Boolean(p.noindex),
    canonicalUrl: p.canonicalUrl ?? "",
    hasDraftChanges:
      JSON.stringify(p.sections ?? null) !== JSON.stringify(p.publishedSections ?? null) ||
      (p.seoTitle ?? "") !== (p.publishedSeoTitle ?? p.seoTitle ?? "") ||
      (p.seoDescription ?? "") !== (p.publishedSeoDescription ?? p.seoDescription ?? "") ||
      (p.seoImage ?? "") !== (p.publishedSeoImage ?? "") ||
      Boolean(p.noindex) !== Boolean(p.publishedNoindex) ||
      (p.canonicalUrl ?? "") !== (p.publishedCanonicalUrl ?? ""),
  }));
  return (
    <PagesManager
      businessId={id}
      businessName={business?.name ?? ""}
      initialPages={serialized}
      canManage={membership.role === "owner" || membership.role === "manager"}
    />
  );
}