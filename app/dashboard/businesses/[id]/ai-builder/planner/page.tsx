import { notFound } from "next/navigation";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { Business } from "@/models/Business";
import { Page } from "@/models/Page";
import { Product } from "@/models/Product";
import WebsitePlanner from "@/components/dashboard/WebsitePlanner";
import { aiReadiness } from "@/lib/ai-builder/consent";

export const dynamic = "force-dynamic";

export default async function WebsitePlannerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireBusinessRole(id, ["owner", "manager"]);
  await dbConnect();
  const [business, pages, products] = await Promise.all([
    Business.findById(id).select("name description category themeId themeSettings").lean(),
    Page.find({ business: id })
      .select("_id title slug status version isHome")
      .sort({ createdAt: 1 })
      .lean(),
    Product.find({ business: id, status: "active" }).select("_id name").sort({ name: 1 }).lean(),
  ]);
  if (!business) notFound();
  const readiness = await aiReadiness(id, "website");

  return (
    <WebsitePlanner
      businessId={id}
      aiAvailable={readiness.ready}
      aiNeedsConsent={readiness.reason === "consent_required" || readiness.reason === "consent_outdated"}
      aiUnavailableMessage={readiness.message}
      business={{
        name: business.name,
        description: business.description ?? "",
        category: business.category,
        themeId: business.themeId,
        audience: "",
        designPreferences: {
          notes: "",
          primaryColor: business.themeSettings?.primaryColor,
          accentColor: business.themeSettings?.accentColor,
        },
      }}
      existingPages={pages.map((page) => ({
        id: String(page._id),
        title: page.title,
        slug: page.slug,
        status: page.status,
        version: page.version,
        isHome: page.isHome,
      }))}
      products={products.map((product) => ({
        id: String(product._id),
        name: product.name,
      }))}
    />
  );
}
