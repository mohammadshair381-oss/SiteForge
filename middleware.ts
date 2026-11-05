import { NextResponse, type NextRequest } from "next/server";
import { isAllowedApiOrigin, isRootHost } from "@/lib/host";
import { legacyPreviewTokenOf, PREVIEW_COOKIE, PREVIEW_COOKIE_MAX_AGE } from "@/lib/preview-link-options";

/**
 * Paths served on every host by root-level metadata routes: the host-aware
 * robots.txt / sitemap.xml, and the SiteForge icon (app/icon.svg; the
 * /favicon.ico fallback is excluded by the matcher below).
 */
export function isHostAwareMetadataPath(pathname: string): boolean {
  return pathname === "/robots.txt" || pathname === "/sitemap.xml" || pathname === "/icon.svg";
}

/** Pages opened from an emailed one-time link. */
export function isTokenLinkPath(pathname: string): boolean {
  return (
    pathname === "/verify-email" ||
    pathname === "/reset-password" ||
    pathname === "/invitations/accept" ||
    pathname === "/account/verify-email" ||
    pathname === "/account/reset-password"
  );
}

function protectTokenPage(response: NextResponse): NextResponse {
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

/** Draft preview links: on the platform address only (a store address rewrites to /store). */
export function isDraftPreviewPath(pathname: string): boolean {
  return pathname === "/preview" || pathname.startsWith("/preview/");
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get("host");

  // API routes are the same on every host; only cross-site writes stop here.
  if (pathname.startsWith("/api/")) {
    const reads = request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
    if (!reads && !isAllowedApiOrigin(request.headers.get("origin"), host, process.env.NODE_ENV === "production")) {
      return NextResponse.json({ error: "Request origin verification failed", code: "csrf_failed" }, { status: 403 });
    }
    return NextResponse.next();
  }

  // Root domain (or localhost): serve the platform itself.
  if (isRootHost(host)) {
    // A link from before tokens moved out of addresses: keep it working, without
    // the token in the address or in the page's data.
    const legacyPreviewToken = legacyPreviewTokenOf(pathname);
    if (legacyPreviewToken) {
      const url = request.nextUrl.clone();
      url.pathname = "/preview/view";
      const redirect = protectTokenPage(NextResponse.redirect(url));
      redirect.cookies.set({
        name: PREVIEW_COOKIE,
        value: legacyPreviewToken,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/preview",
        maxAge: PREVIEW_COOKIE_MAX_AGE,
      });
      return redirect;
    }
    const response = NextResponse.next();
    // Search engines must not keep these pages, and their addresses are secrets, so
    // they must not reach other sites as referrers.
    return isDraftPreviewPath(pathname) || isTokenLinkPath(pathname) ? protectTokenPage(response) : response;
  }

  // Host-aware metadata routes (app/robots.ts, app/sitemap.ts) live at the app
  // root and resolve the tenant from the Host header themselves, so they must
  // not be rewritten under /store (where they would 404).
  if (isHostAwareMetadataPath(pathname)) {
    return NextResponse.next();
  }

  // Storefront host: tenant subdomain or (future) verified custom domain.
  // Rewrite to /store while the page reads the Host header to resolve the
  // correct business. The visible URL is preserved.
  const url = request.nextUrl.clone();
  url.pathname = `/store${pathname === "/" ? "" : pathname}`;
  const rewrite = NextResponse.rewrite(url);
  return isTokenLinkPath(pathname) ? protectTokenPage(rewrite) : rewrite;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
