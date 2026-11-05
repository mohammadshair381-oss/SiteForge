import { requireBusinessRole } from "@/lib/auth/guards";
import MediaLibrary from "@/components/dashboard/MediaLibrary";

export const dynamic = "force-dynamic";

export default async function BusinessMedia({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireBusinessRole(id, ["owner", "manager", "staff"]);

  return <MediaLibrary businessId={id} />;
}
