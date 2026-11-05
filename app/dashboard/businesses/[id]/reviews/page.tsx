import { requireBusinessRole } from "@/lib/auth/guards";
import ReviewsManager from "@/components/dashboard/ReviewsManager";

export const dynamic = "force-dynamic";

export default async function BusinessReviews({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireBusinessRole(id, ["owner", "manager"]);
  return <ReviewsManager businessId={id} />;
}
