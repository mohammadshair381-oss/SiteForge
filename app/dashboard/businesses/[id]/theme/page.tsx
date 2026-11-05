import { notFound } from "next/navigation";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { getThemeAccess } from "@/lib/billing";
import { getDesignState } from "@/lib/design-service";
import { getVisibleSections } from "@/lib/sections";
import { Page } from "@/models/Page";
import ThemeMarketplace from "@/components/dashboard/ThemeMarketplace";
import { loadStorefrontPreviewData } from "@/lib/storefront-preview-data";

export const dynamic = "force-dynamic";

export default async function BusinessTheme({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { membership } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
  await dbConnect();

  const [pages, access, previewData, design] = await Promise.all([
    Page.find({ business: id }).sort({ isHome: -1, createdAt: 1 }).lean(),
    getThemeAccess(id),
    loadStorefrontPreviewData(id),
    getDesignState(id),
  ]);
  if (!previewData) notFound();
  const canManage = membership.role === "owner" || membership.role === "manager";
  // Content pages (About, Contact, policies…) previewed with their DRAFT sections.
  const contentPages = pages
    .filter((page) => !page.isHome)
    .map((page) => ({
      id: String(page._id),
      title: page.title,
      status: page.status,
      sections: getVisibleSections(page.sections),
    }));

  return (
    <div className="space-y-6">
      <ThemeMarketplace
        businessId={id}
        access={access}
        initialDraftThemeId={design.draft.themeId}
        storeLive={previewData.business.status === "published"}
        view={previewData.view}
        config={previewData.settings.draft}
        extras={previewData.extras}
        pages={contentPages}
        canManage={canManage}
        isOwner={membership.role === "owner"}
      />
    </div>
  );
}
