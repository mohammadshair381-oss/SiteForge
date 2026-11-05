import { notFound } from "next/navigation";
import { requireBusinessRole } from "@/lib/auth/guards";
import { getThemeAccess } from "@/lib/billing";
import { getDesignState } from "@/lib/design-service";
import { loadStorefrontPreviewData } from "@/lib/storefront-preview-data";
import DesignStudio from "@/components/dashboard/DesignStudio";

export const dynamic = "force-dynamic";

export default async function BusinessDesign({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { membership } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
  const [data, design, themeAccess] = await Promise.all([loadStorefrontPreviewData(id), getDesignState(id), getThemeAccess(id)]);
  if (!data) notFound();
  return (
    <DesignStudio
      businessId={id}
      view={data.view}
      config={data.settings.draft}
      extras={data.extras}
      initialDraft={design.draft}
      initialVersion={design.version}
      initialHasChanges={design.hasUnpublishedChanges}
      themeAccess={themeAccess}
      storeLive={data.business.status === "published"}
      canManage={membership.role === "owner" || membership.role === "manager"}
    />
  );
}
