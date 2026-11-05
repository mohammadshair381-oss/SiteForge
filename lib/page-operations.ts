import { RESERVED_PAGE_SLUGS, normalizePageSlug } from "@/lib/validation";
import { Page } from "@/models/Page";

/** A free address for a new page: `about`, then `about-2`, `about-3`… (server-only). */
export async function uniquePageSlug(businessId: string, wanted: string): Promise<string> {
  const base = normalizePageSlug(wanted).slice(0, 72) || "page";
  const start = RESERVED_PAGE_SLUGS.has(base) ? `${base}-page` : base;
  const taken = new Set(
    (await Page.find({ business: businessId, slug: new RegExp(`^${start}(-\\d+)?$`) }).select("slug").lean()).map((page) => page.slug),
  );
  if (!taken.has(start)) return start;
  for (let n = 2; ; n += 1) {
    const candidate = `${start}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
