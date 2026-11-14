// SiteForge Next.js configuration. Shape follows `import('next').NextConfig`.
// (Written as a plain comment rather than a `/** @type {...} */` JSDoc cast:
// `esbuild`/`tsx` parse that form as a TypeScript cast expression and reject
// `const x = { ... }`, which would break `npm run test:unit`.)

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
// Delivered through the supported `headers()` mechanism below, so they apply to
// pages, API routes and `_next/*` assets without touching the runtime request
// path in `middleware.ts` (which is a host -> /store rewrite and must stay
// edge-safe and free of mongoose).
//
// `nodeEnv` is a parameter rather than a module-level constant purely so the
// policy can be asserted from `tests/unit/security-headers.test.ts`; the
// default reads the real value Next.js sets when it loads this config
// (`next build` / `next start` -> production, `next dev` -> development).

/**
 * Builds the response headers applied to every request.
 *
 * Known limitation (deliberately explicit instead of misleading): a strict CSP
 * needs a per-request `nonce`, and generating one requires adding nonce
 * minting + forwarding to `middleware.ts`. That is an architectural change we
 * do not make in this phase: the existing middleware is a pure host rewrite,
 * its matcher excludes `_next/*` and `/api`, and per-request nonce propagation
 * would force every route to become dynamic. So:
 *
 *   - `script-src` keeps `'unsafe-inline'` because Next.js App Router injects
 *     its own inline bootstrap/hydration scripts, which only carry a nonce when
 *     one is minted in middleware.
 *   - `style-src` keeps `'unsafe-inline'` because themes render user theme
 *     colors through React inline `style={{ ... }}` attributes
 *     (themes/*.tsx, app/store/product/[slug]/page.tsx, ThemeEditor), and React
 *     never attaches a nonce to a `style` attribute.
 *
 * Everything else is deliberately strict. The app has no external script,
 * stylesheet, font or network connection: `app/layout.tsx` uses no `next/font`,
 * no `<link>`, and no inline `<style>`; all styling comes from the local
 * Tailwind build in `app/globals.css`.
 */
export function buildSecurityHeaders(nodeEnv = String(process.env.NODE_ENV ?? "")) {
  const isProduction = nodeEnv === "production";

  // `next dev` compiles with an eval-based devtool for HMR/source maps and
  // opens an HMR websocket, so those two relaxations are development-only and
  // never reach a production response.
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  const connectSrc = ["'self'"];
  if (!isProduction) {
    scriptSrc.push("'unsafe-eval'");
    connectSrc.push("ws:");
  }

  // `img-src` allows `https:` because product images and business logos are
  // owner-supplied absolute URLs rendered with plain `<img>` tags
  // (themes/*.tsx, `app/store/product/[slug]/page.tsx`, ProductThumb). They are
  // not proxied through `/_next/image`, so there is no allowlist to enforce
  // here beyond the protocol. `http:` is intentionally excluded: storefronts
  // are served over HTTPS and mixed-content image loads are blocked by the
  // browser anyway, so permitting it would only weaken the policy.
  //
  // NOTE: this file is `.mjs`, so it must stay plain JavaScript (no TypeScript
  // annotations) -- `tsx` parses it as TypeScript when a unit test imports it.
  const directives = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "https:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", connectSrc],
    ["frame-src", ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    // Belt and braces with the X-Frame-Options header below.
    ["frame-ancestors", ["'none'"]],
  ];

  if (isProduction) {
    // Only meaningful over HTTPS; would rewrite http://localhost:3000 asset
    // loads in development and break `npm run dev`.
    directives.push(["upgrade-insecure-requests", []]);
  }

  const contentSecurityPolicy = directives
    .map(([directive, values]) =>
      values.length ? `${directive} ${values.join(" ")}` : directive,
    )
    .join("; ");

  // HSTS is production-only: it is only valid when the deployment terminates
  // TLS in front of this app. Local development runs plain HTTP on
  // localhost:3000, where browsers ignore the header but there is no reason to
  // emit it. `preload` is intentionally NOT sent: it is irreversible and
  // requires submitting the domain to the HSTS preload list first.
  const strictTransportSecurity = isProduction
    ? "max-age=63072000; includeSubDomains"
    : "max-age=0";

  return [
    {
      key: "Content-Security-Policy",
      value: contentSecurityPolicy,
    },
    { key: "Strict-Transport-Security", value: strictTransportSecurity },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  ];
}

const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["mongoose"],

  // `app/` holds the routes; the rest of the app now lives under `backend/`
  // (services, models, scripts) and `frontend/` (UI). Point `next lint` at all three so its
  // default dir list (which looked for `components/`, `lib/` at the root) keeps
  // covering the moved code.
  eslint: { dirs: ["app", "backend", "frontend"] },

  async headers() {
    return [
      {
        // Matches pages, API routes and _next/* assets.
        source: "/(.*)",
        headers: buildSecurityHeaders(),
      },
    ];
  },

  images: {
    // ---------------------------------------------------------------------
    // Remote image hosts
    // ---------------------------------------------------------------------
    // Previously this was `[{ protocol: "https", hostname: "**" }]`, which let
    // `next/image` fetch (and therefore proxy, cache and log) an image from
    // ANY host a caller named -- including internal/loopback addresses -- if
    // such a URL ever reached the optimizer.
    //
    // Verified while inspecting current image usage: `next/image` is NOT used
    // anywhere in this repository. Every product image and business logo is
    // rendered with a plain `<img>` tag
    //   - themes/AuroraTheme.tsx, themes/MarketTheme.tsx,
    //     themes/BistroTheme.tsx, themes/StudioTheme.tsx
    //   - app/store/product/[slug]/page.tsx
    //   - components/dashboard/ProductThumb.tsx
    // and there is no `public/` directory with image assets. So
    // `images.remotePatterns` currently grants access to zero legitimate
    // hosts, and the smallest justified allowlist is an empty list.
    //
    // Same-origin/local images remain supported: Next.js only enforces
    // `localPatterns` when `images.localPatterns` is configured, and it is left
    // at its default (undefined) here, so `next/image` can still serve
    // `/public/*` paths if the app adopts it later.
    //
    // Compatibility note: if a future feature optimizes owner-supplied product
    // images through `next/image`, add explicit hostnames here (or proxy the
    // bytes through an upload route) rather than re-introducing `**`. Do not
    // "fix" a 400 "hostname is not configured" from `next/image` by widening
    // this list back to a wildcard.
    remotePatterns: [],
  },
};

export default nextConfig;
