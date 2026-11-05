import { notFound } from "next/navigation";
import { requireBusinessRole } from "@/lib/auth/guards";
import { loadStorefrontPreviewData } from "@/lib/storefront-preview-data";
import NavigationBuilder from "@/components/dashboard/NavigationBuilder";

export const dynamic = "force-dynamic";

export default async function BusinessNavigation({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { membership } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
  const data = await loadStorefrontPreviewData(id);
  if (!data) notFound();

  const serializedPages = [...data.pages]
    .sort((a, b) => Number(b.isHome) - Number(a.isHome))
    .map((p) => ({
      _id: String(p._id),
      title: p.title,
      slug: p.slug,
      status: p.status as "draft" | "published",
      isHome: p.isHome,
    }));

  const settings = data.business.themeSettings;
  const navigation = settings?.navigation;

  return (
    <NavigationBuilder
      businessId={id}
      pages={serializedPages}
      initialNavigation={navigation ? JSON.parse(JSON.stringify(navigation)) : undefined}
      initialVersion={data.business.navigationDraftVersion ?? 0}
      linkOptions={data.linkOptions.filter((option) => !option.label.startsWith("Page: "))}
      initialHasChanges={Boolean(navigation) && JSON.stringify(navigation) !== JSON.stringify(settings?.publishedNavigation)}
      storeLive={data.business.status === "published"}
      canManage={membership.role === "owner" || membership.role === "manager"}
    />
  );
}
