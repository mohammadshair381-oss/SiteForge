import { notFound } from "next/navigation";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { isValidObjectId } from "@/lib/ids";
import { Product } from "@/models/Product";
import VariantEditor from "@/components/dashboard/VariantEditor";

export const dynamic = "force-dynamic";

export default async function ProductVariantsPage({ params }: { params: Promise<{ id: string; productId: string }> }) {
  const { id, productId } = await params;
  // Same audience as product editing: owners, managers and staff.
  await requireBusinessRole(id, ["owner", "manager", "staff"]);
  if (!isValidObjectId(productId)) notFound();
  await dbConnect();
  const product = await Product.findOne({ _id: productId, business: id, status: { $ne: "archived" } }).lean();
  if (!product) notFound();

  return (
    <VariantEditor
      businessId={id}
      product={{
        id: String(product._id),
        name: product.name,
        price: product.price,
        currency: product.currency,
        lowStockThreshold: typeof product.lowStockThreshold === "number" ? product.lowStockThreshold : null,
        options: (product.options ?? []).map((o) => ({ name: o.name, values: [...o.values] })),
        variants: (product.variants ?? []).map((v) => ({
          id: String(v._id),
          options: v.options.map((o) => ({ name: o.name, value: o.value })),
          sku: v.sku ?? "",
          price: v.price ?? null,
          compareAtPrice: v.compareAtPrice ?? null,
          stock: v.stock,
          archived: Boolean(v.archived),
          imageUrl: v.imageUrl ?? "",
        })),
      }}
    />
  );
}
