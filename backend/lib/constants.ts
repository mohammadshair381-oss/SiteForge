export const PLATFORM_ROLES = ["user", "super_admin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const MEMBERSHIP_ROLES = ["owner", "staff", "manager"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * Role groups for future authorization phases. They are intentionally descriptive
 * and are not applied to any route yet; route role arrays remain unchanged in
 * the role-foundation phase.
 */
export const BUSINESS_ADMIN_ROLES = ["owner"] as const;
export const CONTENT_MANAGEMENT_ROLES = ["owner", "manager"] as const;
export const PRODUCT_OPERATION_ROLES = ["owner", "manager", "staff"] as const;

export const MEMBERSHIP_STATUSES = ["active", "invited", "disabled"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** `deleted`: removed by its owner (soft; lib/business-deletion.ts). Never served, never reopened. */
export const BUSINESS_STATUSES = ["draft", "published", "suspended", "deleted"] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

export const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = [
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "canceled",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const PAYMENT_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  "refunded",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const AUTH_TOKEN_TYPES = ["password_reset", "email_verification"] as const;
export type ActionTokenType = (typeof AUTH_TOKEN_TYPES)[number];

/**
 * A pending sign-in from a new device (lib/auth/login-challenge.ts). Stored in the same
 * `AuthToken` collection but deliberately NOT an action token: the generic helpers in
 * lib/auth/action-tokens.ts refuse it, so it can only be completed with its emailed code.
 */
export const LOGIN_CODE_TOKEN_TYPE = "login_code" as const;
export const AUTH_TOKEN_RECORD_TYPES = [...AUTH_TOKEN_TYPES, LOGIN_CODE_TOKEN_TYPE] as const;
export type AuthTokenRecordType = (typeof AUTH_TOKEN_RECORD_TYPES)[number];

// Append only: stored `Business.themeId` values must stay valid.
export const THEME_IDS = ["aurora", "market", "bistro", "studio", "launch", "atelier", "volt", "harvest", "forma"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const BUSINESS_CATEGORIES = [
  { key: "retail", name: "Retail & Ecommerce" },
  // Store types with their own starting homepage (lib/storefront-presets.ts).
  { key: "clothing", name: "Clothing & Fashion" },
  { key: "shoes", name: "Shoes & Footwear" },
  { key: "electronics", name: "Electronics" },
  { key: "grocery", name: "Grocery" },
  { key: "furniture", name: "Furniture & Home" },
  { key: "cosmetics", name: "Cosmetics & Personal Care" },
  { key: "hardware", name: "Hardware & Tools" },
  { key: "food", name: "Food & Beverage" },
  { key: "services", name: "Professional Services" },
  { key: "beauty", name: "Beauty & Wellness" },
  { key: "realestate", name: "Real Estate" },
  { key: "fitness", name: "Fitness & Sports" },
  { key: "education", name: "Education & Training" },
  { key: "technology", name: "Technology & SaaS" },
  { key: "creative", name: "Creative & Events" },
  { key: "other", name: "Other" },
] as const;

export type BusinessCategoryKey = (typeof BUSINESS_CATEGORIES)[number]["key"];
