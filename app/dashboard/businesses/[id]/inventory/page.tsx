import { requireBusinessRole } from "@/lib/auth/guards";
import { listInventory } from "@/lib/inventory-overview";
import InventoryManager from "@/components/dashboard/InventoryManager";

export const dynamic = "force-dynamic";

export default async function BusinessInventory({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Stock work is an operational task: owners, managers and staff.
  await requireBusinessRole(id, ["owner", "manager", "staff"]);
  return <InventoryManager businessId={id} initialItems={await listInventory(id)} />;
}
