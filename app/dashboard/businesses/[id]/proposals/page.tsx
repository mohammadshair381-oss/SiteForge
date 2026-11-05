import { requireBusinessRole } from "@/lib/auth/guards";
import ProposalsManager from "@/components/dashboard/ProposalsManager";
import { aiReadiness } from "@/lib/ai-builder/consent";

export const dynamic = "force-dynamic";

export default async function BusinessProposals({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ proposal?: string | string[] }>;
}) {
  const { id } = await params;
  // Same audience as the website planner: owners and managers.
  await requireBusinessRole(id, ["owner", "manager"]);
  const { proposal } = await searchParams;
  const initial = typeof proposal === "string" && /^[a-f0-9]{24}$/i.test(proposal) ? proposal : null;
  return <ProposalsManager businessId={id} initialProposalId={initial} aiAvailable={(await aiReadiness(id)).ready} />;
}
