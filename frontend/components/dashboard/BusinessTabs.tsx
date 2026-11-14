/**
 * Navigation model for an individual business workspace.
 *
 * The same model powers the desktop sidebar, the mobile drawer, and the
 * breadcrumb label. Keeping it in one place means role visibility can never
 * drift between the three surfaces.
 */

export type BusinessMembershipRole = "owner" | "manager" | "staff";

export type BusinessNavGroup = "Workspace" | "Website" | "Business" | "Manage";

export interface BusinessNavItem {
  segment: string;
  label: string;
  group: BusinessNavGroup;
  roles: readonly BusinessMembershipRole[];
}

export const BUSINESS_NAV_GROUPS: readonly BusinessNavGroup[] = [
  "Workspace",
  "Website",
  "Business",
  "Manage",
];

const TABS: readonly BusinessNavItem[] = [
  {
    segment: "",
    label: "Overview",
    group: "Workspace",
    roles: ["owner", "manager", "staff"],
  },
  {
    // Everyone sees this page; lib/notifications.ts filters what each role gets.
    segment: "notifications",
    label: "Notifications",
    group: "Workspace",
    roles: ["owner", "manager", "staff"],
  },
  {
    // Guided setup wizard: the same audience as the website editor.
    segment: "setup",
    label: "Store setup",
    group: "Workspace",
    roles: ["owner", "manager"],
  },
  {
    segment: "editor",
    label: "Website editor",
    group: "Website",
    roles: ["owner", "manager"],
  },
  {
    segment: "pages",
    label: "Pages",
    group: "Website",
    roles: ["owner", "manager", "staff"],
  },
  {
    // Storefront homepage: hero, sections, featured products, footer.
    segment: "storefront",
    label: "Storefront",
    group: "Website",
    roles: ["owner", "manager"],
  },
  {
    segment: "theme",
    label: "Themes",
    group: "Website",
    roles: ["owner", "manager"],
  },
  {
    segment: "design",
    label: "Design",
    group: "Website",
    roles: ["owner", "manager"],
  },
  {
    segment: "navigation",
    label: "Navigation",
    group: "Website",
    roles: ["owner", "manager"],
  },
  {
    segment: "publish",
    label: "Publish",
    group: "Website",
    roles: ["owner", "manager"],
  },
  {
    // Reviewable website changes (applied to drafts only); planner audience.
    segment: "proposals",
    label: "Change proposals",
    group: "Website",
    roles: ["owner", "manager"],
  },
  {
    segment: "ai-builder",
    label: "AI Builder",
    group: "Website",
    roles: ["owner", "manager"],
  },
  {
    segment: "products",
    label: "Products",
    group: "Business",
    roles: ["owner", "manager", "staff"],
  },
  {
    // Stock levels, adjustments and history: an operational task (staff too).
    segment: "inventory",
    label: "Inventory",
    group: "Business",
    roles: ["owner", "manager", "staff"],
  },
  {
    // Store structure (names, images, order): owners and managers.
    segment: "categories",
    label: "Categories",
    group: "Business",
    roles: ["owner", "manager"],
  },
  {
    // Aggregated sales and customer data: same audience as orders.
    segment: "insights",
    label: "Insights",
    group: "Business",
    roles: ["owner", "manager"],
  },
  {
    // Customer PII and payment state: owners and managers only.
    segment: "orders",
    label: "Orders",
    group: "Business",
    roles: ["owner", "manager"],
  },
  {
    // Derived from orders, so the same audience: owners and managers only.
    segment: "customers",
    label: "Customers",
    group: "Business",
    roles: ["owner", "manager"],
  },
  {
    // What shoppers left behind: same audience as orders.
    segment: "carts",
    label: "Abandoned carts",
    group: "Business",
    roles: ["owner", "manager"],
  },
  {
    // Discount codes change what shoppers pay: same audience as orders.
    segment: "coupons",
    label: "Coupons",
    group: "Business",
    roles: ["owner", "manager"],
  },
  {
    // Moderating public reviews: owners and managers.
    segment: "reviews",
    label: "Reviews",
    group: "Business",
    roles: ["owner", "manager"],
  },
  {
    segment: "media",
    label: "Media",
    group: "Business",
    roles: ["owner", "manager", "staff"],
  },
  {
    segment: "settings",
    label: "Business settings",
    group: "Manage",
    roles: ["owner", "manager"],
  },
  {
    // Shipping charges and delivery information shown at checkout.
    segment: "shipping",
    label: "Shipping",
    group: "Manage",
    roles: ["owner", "manager"],
  },
  {
    segment: "billing",
    label: "Subscription",
    group: "Manage",
    roles: ["owner"],
  },
];

/**
 * How the groups read in the navigation (null = no heading), and the order
 * people reach for things within them: building starts with the AI Builder and
 * the editor; selling starts with what needs daily attention.
 */
export const BUSINESS_NAV_GROUP_LABELS: Record<BusinessNavGroup, string | null> = {
  Workspace: null,
  Website: "Build",
  Business: "Sell",
  Manage: "Settings",
};

const NAV_ORDER = ["", "notifications", "setup", "ai-builder", "editor", "pages", "theme", "design", "navigation", "storefront", "proposals", "publish", "orders", "products", "inventory", "categories", "customers", "carts", "coupons", "reviews", "insights", "media", "settings", "shipping", "billing"];

/** One group's sections for this role, in navigation order. Visibility comes only from `visibleBusinessTabs`. */
export function orderedBusinessTabs(role: BusinessMembershipRole, group: BusinessNavGroup): BusinessNavItem[] {
  return visibleBusinessTabs(role)
    .filter((tab) => tab.group === group)
    .sort((a, b) => NAV_ORDER.indexOf(a.segment) - NAV_ORDER.indexOf(b.segment));
}

export function visibleBusinessTabs(role: BusinessMembershipRole): BusinessNavItem[] {
  return TABS.filter((tab) => tab.roles.includes(role));
}

export function businessNavHref(businessId: string, segment: string): string {
  const base = `/dashboard/businesses/${businessId}`;
  return segment ? `${base}/${segment}` : base;
}

/** The section label for a URL pathname segment, or null for an unknown page. */
export function businessSectionLabel(segment: string): string | null {
  if (!segment) return "Overview";
  return TABS.find((tab) => tab.segment === segment)?.label ?? null;
}
