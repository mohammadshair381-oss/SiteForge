import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { getEntitlements } from "@/lib/billing";
import { Business } from "@/models/Business";
import { Product } from "@/models/Product";
import ProductsManager from "@/components/dashboard/ProductsManager";
import { aiReadiness, aiStateOf } from "@/lib/ai-builder/consent";
import { ProductCategory } from "@/models/ProductCategory";

export const dynamic = "force-dynamic";

export default async function BusinessProducts({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { membership } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
  await dbConnect();

  const [business, products, entitlements] = await Promise.all([
    Business.findById(id).select("currency").lean(),
    Product.find({ business: id, status: { $ne: "archived" } })
      .sort({ createdAt: -1 })
      .lean(),
    getEntitlements(id),
  ]);

  const categoryOptions = (await ProductCategory.find({ business: id, active: true }).sort({ sort: 1, name: 1 }).select("name").lean()).map((c) => c.name);
  const serialized = products.map((product) => ({
    _id: String(product._id),
    name: product.name,
    description: product.description,
    price: product.price,
    compareAtPrice: typeof product.compareAtPrice === "number" ? product.compareAtPrice : null,
    currency: product.currency,
    imageUrl: product.imageUrl,
    images: product.images ?? [],
    category: product.category,
    seoTitle: product.seoTitle ?? "",
    seoDescription: product.seoDescription ?? "",
    imageAlt: product.imageAlt ?? "",
    status: product.status,
    stock: product.stock ?? 0,
    variantCount: (product.options ?? []).length > 0 ? (product.variants ?? []).filter((v) => !v.archived).length : 0,
    lowStockThreshold: typeof product.lowStockThreshold === "number" ? product.lowStockThreshold : null,
    sample: product.sample ?? "",
  }));

  return (
    <ProductsManager
      businessId={id}
      initialProducts={serialized}
      currency={business?.currency ?? "USD"}
      canArchive={membership.role === "owner" || membership.role === "manager"}
      canViewBilling={membership.role === "owner"}
      categoryOptions={categoryOptions}
      entitlements={{
        planName: entitlements.planName,
        productLimit: entitlements.productLimit,
        active: entitlements.active,
      }}
      aiState={aiStateOf(await aiReadiness(id, "product"))}
    />
  );
}
