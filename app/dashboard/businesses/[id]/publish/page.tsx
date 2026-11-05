import { requireBusinessRole } from "@/lib/auth/guards";
import { websiteStatus } from "@/lib/website-publish";
import PublishCenter from "@/components/dashboard/PublishCenter";

export const dynamic = "force-dynamic";

export default async function BusinessPublish({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireBusinessRole(id, ["owner", "manager"]);
  const status = await websiteStatus(id);
  // The key resets the ticks once the list changes after publishing.
  return <PublishCenter key={status.items.map((item) => item.key).join()} businessId={id} storeLive={status.storeLive} initialItems={status.items} draftPages={status.draftPages} />;
}
