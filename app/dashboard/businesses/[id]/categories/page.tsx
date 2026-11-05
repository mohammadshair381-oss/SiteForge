import { requireBusinessRole } from "@/lib/auth/guards";
import { listCategories } from "@/lib/categories";
import CategoriesManager from "@/components/dashboard/CategoriesManager";

export const dynamic = "force-dynamic";

export default async function BusinessCategories({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireBusinessRole(id, ["owner", "manager"]);
  const { categories, unmanaged } = await listCategories(id);
  return <CategoriesManager businessId={id} initial={categories} initialUnmanaged={unmanaged} />;
}
