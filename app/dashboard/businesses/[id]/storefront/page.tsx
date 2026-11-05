import { notFound } from "next/navigation";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { Business } from "@/models/Business";
import { Product } from "@/models/Product";
import { Page } from "@/models/Page";
import { getStorefrontSettings } from "@/lib/storefront-settings";
import { categoryHref } from "@/lib/storefront-home";
import StorefrontSettings from "@/components/dashboard/StorefrontSettings";

export const dynamic = "force-dynamic";

export default async function BusinessStorefront({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Same audience as the editor and theme settings: owners and managers.
  await requireBusinessRole(id, ["owner", "manager"]);
  await dbConnect();

  const [business, products, pages, settings] = await Promise.all([
    Business.findById(id).select("name status").lean<{ name: string; status: string }>(),
    Product.find({ business: id, status: "active" }).select("name slug category imageUrl").sort({ createdAt: -1 }).lean(),
    Page.find({ business: id, status: "published" }).select("title slug").lean(),
    getStorefrontSettings(id),
  ]);
  if (!business) notFound();

  const categories = [...new Map(
    products
      .map((p) => (p.category ?? "").trim())
      .filter(Boolean)
      .map((name) => [name.toLowerCase(), name] as const),
  ).values()].sort((a, b) => a.localeCompare(b));

  // Suggestions for link fields: only destinations that exist right now.
  const linkOptions = [
    { label: "All products", href: "/products" },
    ...categories.map((name) => ({ label: `Category: ${name}`, href: categoryHref(name) })),
    ...products.slice(0, 50).map((p) => ({ label: `Product: ${p.name}`, href: `/product/${p.slug}` })),
    ...pages.map((p) => ({ label: `Page: ${p.title}`, href: `/${p.slug}` })),
    { label: "Shipping & returns", href: "/policies" },
    { label: "Cart", href: "/cart" },
  ];

  return (
    <StorefrontSettings
      businessId={id}
      storeLive={business.status === "published"}
      initialDraft={settings.draft}
      hasPublished={settings.published !== null}
      initialHasUnpublishedChanges={settings.hasUnpublishedChanges}
      linkOptions={linkOptions}
    />
  );
}
