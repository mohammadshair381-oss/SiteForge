import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  BUSINESS_NAV_GROUPS,
  businessNavHref,
  businessSectionLabel,
  visibleBusinessTabs,
  type BusinessMembershipRole,
} from "../../frontend/components/dashboard/BusinessTabs";

test("business tabs: owner sees every workspace section", () => {
  const labels = visibleBusinessTabs("owner").map((tab) => tab.label);
  assert.deepEqual(labels, [
    "Overview",
    "Notifications",
    "Store setup",
    "Website editor",
    "Pages",
    "Storefront",
    "Themes",
    "Design",
    "Navigation",
    "Publish",
    "Change proposals",
    "AI Builder",
    "Products",
    "Inventory",
    "Categories",
    "Insights",
    "Orders",
    "Customers",
    "Abandoned carts",
    "Coupons",
    "Reviews",
    "Media",
    "Business settings",
    "Shipping",
    "Subscription",
  ]);
  assert.equal(visibleBusinessTabs("owner").find((tab) => tab.segment === "editor")?.group, "Website");
  assert.equal(visibleBusinessTabs("owner").find((tab) => tab.segment === "design")?.group, "Website");
  assert.equal(visibleBusinessTabs("owner").find((tab) => tab.segment === "navigation")?.group, "Website");
  assert.equal(visibleBusinessTabs("owner").find((tab) => tab.segment === "")?.group, "Workspace");
});

test("business tabs: manager sees content sections but not billing", () => {
  const labels = visibleBusinessTabs("manager").map((tab) => tab.label);
  assert.deepEqual(labels, [
    "Overview",
    "Notifications",
    "Store setup",
    "Website editor",
    "Pages",
    "Storefront",
    "Themes",
    "Design",
    "Navigation",
    "Publish",
    "Change proposals",
    "AI Builder",
    "Products",
    "Inventory",
    "Categories",
    "Insights",
    "Orders",
    "Customers",
    "Abandoned carts",
    "Coupons",
    "Reviews",
    "Media",
    "Business settings",
    "Shipping",
  ]);
});

test("business tabs: staff sees only operational sections", () => {
  const labels = visibleBusinessTabs("staff").map((tab) => tab.label);
  assert.deepEqual(labels, ["Overview", "Notifications", "Pages", "Products", "Inventory", "Media"]);
});

test("business tabs: unknown roles cannot be passed and staff cannot reach settings", () => {
  const role: BusinessMembershipRole = "staff";
  assert.equal(visibleBusinessTabs(role).some((tab) => tab.segment === "settings"), false);
  assert.equal(visibleBusinessTabs(role).some((tab) => tab.segment === "billing"), false);
});

test("business navigation groups appear in a stable order", () => {
  assert.deepEqual(BUSINESS_NAV_GROUPS, ["Workspace", "Website", "Business", "Manage"]);
  for (const tab of visibleBusinessTabs("owner")) {
    assert.ok(BUSINESS_NAV_GROUPS.includes(tab.group), `${tab.label} has a known group`);
  }
});

test("every business navigation item maps to an implemented route", () => {
  for (const tab of visibleBusinessTabs("owner")) {
    const dir = join(
      process.cwd(),
      "app",
      "dashboard",
      "businesses",
      "[id]",
      ...(tab.segment ? [tab.segment] : []),
    );
    assert.equal(
      existsSync(join(dir, "page.tsx")),
      true,
      `${tab.label} (${tab.segment || "/"}) has a page`,
    );
  }
});
