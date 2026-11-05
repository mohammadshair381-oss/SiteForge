import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import ThemeRenderer from "@/components/storefront/ThemeRenderer";
import { selectEditorPage } from "@/lib/editor-mode";
import { PREVIEW_COOKIE } from "@/lib/preview-link-options";
import { resolvePreviewLink } from "@/lib/preview-links";
import { getVisibleSections } from "@/lib/sections";
import type { StorefrontView } from "@/lib/storefront";
import { buildCommerceData } from "@/lib/storefront-home";
import { loadStorefrontPreviewData } from "@/lib/storefront-preview-data";

export const dynamic = "force-dynamic";

// The middleware also sends X-Robots-Tag and Referrer-Policy on these addresses.
export const metadata: Metadata = {
  title: "Draft preview",
  robots: { index: false, follow: false, nocache: true, noarchive: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
};

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** Only the settings the renderer reads reach the browser, nothing else that is stored. */
function browserView(view: StorefrontView): StorefrontView {
  const { primaryColor, accentColor, font, heroHeadline, heroSubheadline, about, showProducts, designTokens, design } = view.theme as StorefrontView["theme"] & { designTokens?: unknown; design?: unknown };
  const theme = { primaryColor, accentColor, font, heroHeadline, heroSubheadline, about, showProducts, ...(designTokens ? { designTokens } : {}), ...(design ? { design } : {}) };
  return { ...view, theme: theme as StorefrontView["theme"] };
}

/**
 * A store's saved drafts, for someone without an account. Rendered by the same
 * renderer as the store, on the platform address only: store addresses rewrite to
 * /store, so this route cannot be reached through them. Links, cart and checkout
 * are disabled. An invalid, expired or revoked token is a plain 404, whichever it is.
 */
export default async function SharedDraftPreview({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  // Set from the link by app/preview/page.tsx, for `/preview` pages only and readable
  // by no script, so it is never in an address or in this page's data.
  const token = (await cookies()).get(PREVIEW_COOKIE)?.value;
  // `next dev` adds debug data to every page, which can include whole stored
  // records, so outside production a link only works on this machine.
  if (process.env.NODE_ENV !== "production" && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test((await headers()).get("host") ?? "")) notFound();
  const access = await resolvePreviewLink(token);
  if (!access) notFound();
  const data = await loadStorefrontPreviewData(access.businessId, { liveFrame: access.scope === "page" });
  if (!data) notFound();

  const { page: requested } = await searchParams;
  const wantedId = access.scope === "page" ? access.pageId : requested;
  const liveHome = selectEditorPage(data.pages);
  const page = wantedId ? data.pages.find((item) => String(item._id) === wantedId) : liveHome;
  if (wantedId && !page) notFound();

  const view = browserView(data.view);
  const sections = getVisibleSections(page ? page.sections : data.view.theme.sections);
  // A link to one page shows that page in the published header and footer: the
  // draft homepage is not part of what it shares.
  const commerce = buildCommerceData(view, access.scope === "page" ? data.settings.published : data.settings.draft, data.extras);
  const pageView = sections.length > 0 ? { ...view, theme: { ...view.theme, sections } } : view;
  const others = access.scope === "site" ? data.pages.filter((item) => item._id !== liveHome?._id && Array.isArray(item.sections) && item.sections.length > 0) : [];

  return (
    <>
      <div role="note" className="sticky top-0 z-50 bg-slate-900 px-4 py-2 text-sm text-white">
        <p className="text-center font-medium">Draft preview of {view.name}. This is not the live website, and links and the cart are turned off. Link ends {dateFormat.format(access.expiresAt)} UTC.</p>
        {others.length > 0 && (
          <nav aria-label="Preview pages" className="mt-1.5 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
            <a href="/preview/view" aria-current={!requested ? "page" : undefined} className="underline underline-offset-2">Homepage</a>
            {others.map((item) => (
              <a key={String(item._id)} href={`/preview/view?page=${String(item._id)}`} aria-current={requested === String(item._id) ? "page" : undefined} className="underline underline-offset-2">{item.title}</a>
            ))}
          </nav>
        )}
      </div>
      <ThemeRenderer view={pageView} productHrefBase="#" preview commerce={commerce} sections={sections.length > 0 ? sections : undefined} />
    </>
  );
}
