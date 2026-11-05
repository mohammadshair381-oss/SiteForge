import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { isDraftPreviewPath, middleware } from "@/middleware";

const request = (url: string, host: string) => new NextRequest(url, { headers: { host } });

test("a preview address on the platform is not indexed and sends no referrer", () => {
  const response = middleware(request("http://localhost:3000/preview/abc", "localhost:3000"));
  assert.match(response.headers.get("X-Robots-Tag") ?? "", /noindex/);
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
  assert.equal(response.headers.get("x-middleware-rewrite"), null);
});

test("other platform pages keep their normal headers", () => {
  const response = middleware(request("http://localhost:3000/pricing", "localhost:3000"));
  assert.equal(response.headers.get("X-Robots-Tag"), null);
  assert.equal(response.headers.get("Referrer-Policy"), null);
});

test("a store address never reaches the preview route", () => {
  const response = middleware(request("http://shop.localhost:3000/preview/abc", "shop.localhost:3000"));
  assert.match(response.headers.get("x-middleware-rewrite") ?? "", /\/store\/preview\/abc$/);
});

test("only the preview path counts", () => {
  assert.equal(isDraftPreviewPath("/preview/abc"), true);
  assert.equal(isDraftPreviewPath("/previews"), false);
  assert.equal(isDraftPreviewPath("/dashboard/businesses/1/preview"), false);
});
