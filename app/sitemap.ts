import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { getSitemapForHost } from "@/lib/seo";

// Host-dependent: each tenant storefront lists only its own public URLs.
// Reading headers() already opts out of caching; this makes it explicit.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const headerList = await headers();
  return getSitemapForHost(headerList.get("host"));
}
