import assert from "node:assert/strict";
import test from "node:test";

import nextConfig, { buildSecurityHeaders } from "../../next.config.mjs";

// Phase 4.10: asserts the *configuration itself* (next.config.mjs), not a live
// server. `headers()` in the config is what `next build` bakes into
// `.next/routes-manifest.json` and what `next start` serves, so testing the
// function that produces it is the appropriate level here.

type ConfigHeader = { key: string; value: string };

function headerMap(nodeEnv: string): Map<string, string> {
  const headers = buildSecurityHeaders(nodeEnv);
  return new Map(headers.map((header: ConfigHeader) => [header.key, header.value]));
}

function directiveValue(csp: string, directive: string): string | undefined {
  const found = csp
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .find((part) => part === directive || part.startsWith(`${directive} `));
  if (!found) return undefined;
  return found.slice(directive.length).trim();
}

test("headers() covers every route with a single security header set", async () => {
  const rules = await nextConfig.headers();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].source, "/(.*)");
  const keys = rules[0].headers.map((h: ConfigHeader) => h.key).sort();
  assert.deepEqual(keys, [
    "Content-Security-Policy",
    "Referrer-Policy",
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
  ]);
});

test("production sends HSTS, nosniff, frame-deny and a strict referrer policy", () => {
  const headers = headerMap("production");
  assert.equal(
    headers.get("Strict-Transport-Security"),
    "max-age=63072000; includeSubDomains",
  );
  // `preload` is intentionally deferred until the domain is submitted.
  assert.doesNotMatch(headers.get("Strict-Transport-Security") ?? "", /preload/);
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.ok(headers.get("Content-Security-Policy"));
});

test("development does not emit a production HSTS max-age", () => {
  const headers = headerMap("development");
  assert.equal(headers.get("Strict-Transport-Security"), "max-age=0");
});

test("production CSP blocks framing, object/base hijacking and foreign form posts", () => {
  const csp = headerMap("production").get("Content-Security-Policy") as string;
  assert.equal(directiveValue(csp, "frame-ancestors"), "'none'");
  assert.equal(directiveValue(csp, "object-src"), "'none'");
  assert.equal(directiveValue(csp, "frame-src"), "'none'");
  assert.equal(directiveValue(csp, "base-uri"), "'self'");
  assert.equal(directiveValue(csp, "form-action"), "'self'");
  assert.equal(directiveValue(csp, "default-src"), "'self'");
  assert.equal(directiveValue(csp, "upgrade-insecure-requests"), "");
});

test("production CSP does not allow unsafe-eval or non-https image sources", () => {
  const csp = headerMap("production").get("Content-Security-Policy") as string;
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(directiveValue(csp, "script-src") ?? "", /unsafe-eval/);
  assert.equal(directiveValue(csp, "img-src"), "'self' data: https:");
  assert.equal(directiveValue(csp, "connect-src"), "'self'");
});

test("script-src and style-src keep the documented unsafe-inline limitation", () => {
  // Documented, not accidental: Next.js injects inline bootstrap scripts and
  // the themes render inline `style` attributes, both of which need a
  // per-request nonce to drop 'unsafe-inline'. See next.config.mjs.
  const csp = headerMap("production").get("Content-Security-Policy") as string;
  assert.equal(directiveValue(csp, "script-src"), "'self' 'unsafe-inline'");
  assert.equal(directiveValue(csp, "style-src"), "'self' 'unsafe-inline'");
});

test("development relaxes only what next dev needs (eval devtool + HMR socket)", () => {
  const csp = headerMap("development").get("Content-Security-Policy") as string;
  assert.equal(
    directiveValue(csp, "script-src"),
    "'self' 'unsafe-inline' 'unsafe-eval'",
  );
  assert.equal(directiveValue(csp, "connect-src"), "'self' ws:");
  // upgrade-insecure-requests must not leak into development: it would rewrite
  // http://localhost:3000 asset loads and break `npm run dev`.
  assert.equal(directiveValue(csp, "upgrade-insecure-requests"), undefined);
  // No other directive is relaxed in development.
  assert.equal(directiveValue(csp, "default-src"), "'self'");
  assert.equal(directiveValue(csp, "object-src"), "'none'");
});

test("every production CSP value is a single line with no stray whitespace", () => {
  const csp = headerMap("production").get("Content-Security-Policy") as string;
  assert.doesNotMatch(csp, /\s{2,}/);
  assert.doesNotMatch(csp, /[\r\n]/);
  assert.doesNotMatch(csp, /undefined|null/);
});

test("images.remotePatterns no longer contains the unrestricted hostname wildcard", () => {
  const patterns = (nextConfig.images ?? { remotePatterns: [] })
    .remotePatterns as Array<{ hostname?: string }>;
  assert.ok(Array.isArray(patterns));
  assert.equal(patterns.length, 0);
  assert.ok(!patterns.some((pattern) => pattern.hostname?.includes("*")));
});
