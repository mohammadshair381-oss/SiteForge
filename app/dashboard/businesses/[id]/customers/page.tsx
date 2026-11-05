import { requireBusinessRole } from "@/lib/auth/guards";
import CustomersManager from "@/components/dashboard/CustomersManager";

export const dynamic = "force-dynamic";

export default async function BusinessCustomers({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Customer data is derived from orders: same audience as order management.
  await requireBusinessRole(id, ["owner", "manager"]);

  return <CustomersManager businessId={id} />;
}
