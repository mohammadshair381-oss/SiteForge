import { requireBusinessRole } from "@/lib/auth/guards";
import OrdersManager from "@/components/dashboard/OrdersManager";

export const dynamic = "force-dynamic";

export default async function BusinessOrders({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ order?: string | string[] }>;
}) {
  const { id } = await params;
  const { membership } = await requireBusinessRole(id, ["owner", "manager"]);

  // Optional deep link to one order (from a customer's order history). Only a
  // well-formed order number is passed on; the API scopes it to this business.
  const { order } = await searchParams;
  const orderNumber =
    typeof order === "string" && /^[0-9a-z]{1,40}$/i.test(order) ? order : null;

  return (
    <OrdersManager
      key={orderNumber ?? "all"}
      businessId={id}
      initialOrderNumber={orderNumber}
      isOwner={membership.role === "owner"}
    />
  );
}
