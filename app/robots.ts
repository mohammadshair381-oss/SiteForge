import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { getRobotsForHost } from "@/lib/seo";

// Host-dependent: the platform and every tenant storefront get their own policy.
// Reading headers() already opts out of caching; this makes it explicit.
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const headerList = await headers();
  return getRobotsForHost(headerList.get("host"));
}
