import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const mobileNavSource = readFileSync(
  resolve(process.cwd(), "frontend/components/dashboard/MobileNav.tsx"),
  "utf8",
);
const dashboardLayoutSource = readFileSync(
  resolve(process.cwd(), "app/dashboard/layout.tsx"),
  "utf8",
);

test("mobile drawer is portaled outside the sticky blurred dashboard header", () => {
  assert.match(mobileNavSource, /createPortal\([\s\S]*document\.body/);
  assert.match(dashboardLayoutSource, /sticky top-0[^"]*backdrop-blur/);
  assert.match(mobileNavSource, /fixed inset-0 z-\[60\]/);
});

test("mobile drawer uses an opaque bounded panel with safe-area spacing", () => {
  assert.match(mobileNavSource, /max-w-\[calc\(100vw-1\.5rem\)\]/);
  assert.match(mobileNavSource, /border-r border-slate-200 bg-white shadow-2xl/);
  assert.match(mobileNavSource, /env\(safe-area-inset-top\)/);
  assert.match(mobileNavSource, /env\(safe-area-inset-right\)/);
  assert.match(mobileNavSource, /env\(safe-area-inset-bottom\)/);
  assert.match(mobileNavSource, /env\(safe-area-inset-left\)/);
});

test("mobile drawer scrolls navigation internally and keeps account actions visible", () => {
  assert.match(mobileNavSource, /min-h-0 flex-1 overflow-y-auto overscroll-contain/);
  assert.match(mobileNavSource, /shrink-0 border-t border-slate-200 pt-3/);
  assert.match(mobileNavSource, /min-h-11/);
  assert.match(mobileNavSource, /aria-label="Close navigation menu"/);
  assert.match(mobileNavSource, /document\.body\.style\.overflow = "hidden"/);
  assert.match(mobileNavSource, /event\.key === "Escape"/);
});
