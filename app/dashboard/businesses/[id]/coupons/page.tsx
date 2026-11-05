import { notFound } from "next/navigation";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { listCoupons } from "@/lib/coupons";
import { Business } from "@/models/Business";
import { Product } from "@/models/Product";
import CouponsManager from "@/components/dashboard/CouponsManager";

export const dynamic = "force-dynamic";

export default async function BusinessCoupons({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireBusinessRole(id, ["owner", "manager"]);
  await dbConnect();
  const business = await Business.findById(id).select("currency").lean();
  if (!business) notFound();
  const products = await Product.find({ business: id, status: { $ne: "archived" } }).select("name category").sort({ name: 1 }).limit(500).lean();
  const categories = [...new Map(products.map((p) => (p.category ?? "").trim()).filter(Boolean).map((name) => [name.toLowerCase(), name] as const)).values()].sort((a, b) => a.localeCompare(b));
  return <CouponsManager businessId={id} currency={(business.currency || "USD").toUpperCase()} products={products.map((p) => ({ id: String(p._id), name: p.name }))} categories={categories} initial={await listCoupons(id)} />;
}
