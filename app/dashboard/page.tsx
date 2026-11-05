import Link from "next/link";
import { headers } from "next/headers";
import { storeLinkRoot } from "@/lib/host";
import { dbConnect } from "@/lib/db";
import { requireUser, getMembershipsForUser } from "@/lib/auth/guards";
import { getThemeMeta } from "@/lib/themes";
import { Category } from "@/models/Category";
import { BUSINESS_CATEGORIES, type ThemeId } from "@/lib/constants";
import CreateBusinessForm from "@/components/dashboard/CreateBusinessForm";
import DashboardEmptyState from "@/components/dashboard/DashboardEmptyState";
import ThemeThumbnail from "@/components/dashboard/ThemeThumbnail";
import { Pill, cardClass, type Tone } from "@/components/ui/Surface";
import { Icon } from "@/components/ui/Icon";
import { focusRing } from "@/components/ui/Button";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: Tone }> = {
  published: { label: "Live", tone: "success" },
  draft: { label: "Draft", tone: "neutral" },
  suspended: { label: "Suspended", tone: "danger" },
};

const ROLE_LABELS: Record<string, string> = { owner: "Owner", manager: "Manager", staff: "Staff" };

function categoryName(key: string): string {
  return BUSINESS_CATEGORIES.find((c) => c.key === key)?.name ?? key;
}

export default async function DashboardPage() {
  const user = await requireUser();
  const memberships = await getMembershipsForUser(user._id.toString());
  await dbConnect();
  // The code list is the source of truth (it is what the API validates);
  // stored categories may rename or deactivate a type, and types added in
  // code appear without a database change.
  const allStored = await Category.find({}).select("key name active").lean();
  const stored = new Map(allStored.map((c) => [c.key, c]));
  const categories = BUSINESS_CATEGORIES.filter((c) => stored.get(c.key)?.active !== false).map((c) => ({
    key: c.key,
    name: stored.get(c.key)?.name || c.name,
  }));

  const rootDomain = storeLinkRoot((await headers()).get("host"));

  const businesses = memberships
    .map((membership) => {
      const business = membership.business as unknown as {
        _id: string;
        name: string;
        status: string;
        category: string;
        subdomain: string;
        themeId: ThemeId;
      } | null;
      if (!business) return null;
      return {
        id: String(business._id),
        name: business.name,
        status: business.status,
        category: business.category,
        subdomain: business.subdomain,
        themeId: business.themeId,
        role: membership.role,
      };
    })
    .filter((b) => b !== null);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">Welcome, {user.name.split(" ")[0]}</h1>
          <p className="mt-1.5 text-slate-600">{businesses.length === 0 ? "Let's get your first store started." : "Choose a business to keep working on it."}</p>
        </div>
        <CreateBusinessForm categories={categories} rootDomain={rootDomain} />
      </div>

      {businesses.length === 0 ? (
        <DashboardEmptyState />
      ) : (
        <section aria-labelledby="your-businesses">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="your-businesses" className="text-lg font-semibold text-slate-900">
              Your businesses
            </h2>
            <span className="text-sm text-slate-500">
              {businesses.length} {businesses.length === 1 ? "business" : "businesses"}
            </span>
          </div>

          <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {businesses.map((business) => {
              const status = STATUS[business.status] ?? STATUS.draft;
              const storefrontUrl = business.status === "published" && business.subdomain ? `http://${business.subdomain}.${rootDomain}` : null;
              return (
                <li key={business.id} className={`${cardClass} ui-lift group relative flex flex-col overflow-hidden hover:shadow-md`}>
                  <div className="border-b border-slate-200 bg-slate-100 p-4 pb-0">
                    <div className="overflow-hidden rounded-t-lg shadow-sm">
                      <ThemeThumbnail themeId={business.themeId} className="!aspect-[16/8] !rounded-none" />
                    </div>
                  </div>
                  <div className="flex flex-1 flex-col p-5">
                    <div className="flex items-start justify-between gap-3">
                      <Link href={`/dashboard/businesses/${business.id}`} className={`min-w-0 rounded font-heading text-lg font-semibold text-slate-900 after:absolute after:inset-0 after:content-[''] ${focusRing}`}>
                        <span className="line-clamp-2">{business.name}</span>
                      </Link>
                      <Pill tone={status.tone} dot className="shrink-0">
                        {status.label}
                      </Pill>
                    </div>
                    <p className="mt-1 text-sm text-slate-500">
                      {categoryName(business.category)} · {getThemeMeta(business.themeId).name} theme · {ROLE_LABELS[business.role] ?? business.role}
                    </p>
                    <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3 text-sm">
                      <span className="inline-flex items-center gap-1 font-medium text-slate-900">
                        Open
                        <Icon name="arrow-right" size={15} className="transition-transform group-hover:translate-x-0.5" />
                      </span>
                      {storefrontUrl && (
                        <a href={storefrontUrl} target="_blank" rel="noreferrer" className={`relative z-10 inline-flex items-center gap-1 rounded text-xs font-medium text-slate-600 hover:text-slate-900 ${focusRing}`}>
                          View store <Icon name="external" size={13} />
                          <span className="sr-only">(opens in a new tab)</span>
                        </a>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
