import { requireBusinessRole } from "@/lib/auth/guards";
import CustomerDetail from "@/components/dashboard/CustomerDetail";

export const dynamic = "force-dynamic";

export default async function BusinessCustomer({
  params,
}: {
  params: Promise<{ id: string; customerId: string }>;
}) {
  const { id, customerId } = await params;
  await requireBusinessRole(id, ["owner", "manager"]);

  // The detail API re-scopes the customer id to this business; an id from
  // another business renders "not found".
  return <CustomerDetail businessId={id} customerId={customerId} />;
}
