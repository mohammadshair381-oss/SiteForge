import { requireBusinessRole } from "@/lib/auth/guards";
import NotificationCenter from "@/components/dashboard/NotificationCenter";

export const dynamic = "force-dynamic";

export default async function BusinessNotifications({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireBusinessRole(id, ["owner", "manager", "staff"]);
  return <NotificationCenter businessId={id} />;
}
