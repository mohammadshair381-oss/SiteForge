import { z } from "zod";
import { PAGE_TEMPLATES } from "./page-templates";
import {
  BUSINESS_CATEGORIES,
  MEMBERSHIP_ROLES,
  THEME_IDS,
} from "./constants";
import { isValidSubdomain } from "./slug";
import { validateDomain } from "./domain";
import { isSafeSectionHref, sectionsArraySchema } from "./sections";

const categoryKeys = BUSINESS_CATEGORIES.map((c) => c.key) as [string, ...string[]];

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("A valid email is required");

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(200);

export const registerSchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(120),
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: passwordSchema,
});

/**
 * Body for POST /api/auth/email/verify. The raw action token is opaque and
 * URL-safe (see lib/auth/action-tokens.ts); length limits just bound the input
 * before it reaches the token helper.
 */
export const verifyEmailSchema = z.object({
  token: z
    .string()
    .trim()
    .min(1, "This confirmation link is incomplete")
    .max(512, "This confirmation link is not valid"),
  password: z.string().min(1, "Enter your password").max(200, "Enter your password"),
});

/**
 * Body for POST /api/auth/password/forgot. Same email normalisation as the rest
 * of the auth surface; the handler intentionally returns an identical response
 * regardless of whether the address exists.
 */
export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

/**
 * Body for POST /api/auth/password/reset. The token is opaque and URL-safe; the
 * password reuses the shared policy so reset, registration and password change
 * stay identical.
 */
/**
 * Storefront customer accounts (business-scoped; see docs/customer-accounts.md).
 * `emailSchema` normalises with JS `trim()` + `toLowerCase()`, exactly like the
 * `lowercase`/`trim` setters on `models/Customer.ts#email`, so lookups, inserts
 * and the unique `{ business, email }` index all use the same value. Passwords
 * reuse the platform policy (`passwordSchema`).
 */
export const customerRegisterSchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(120),
  email: emailSchema.pipe(z.string().max(254, "Email is too long")),
  password: passwordSchema,
});

export const customerLoginSchema = z.object({
  email: emailSchema.pipe(z.string().max(254)),
  password: z.string().min(1, "Password is required").max(200),
});

export const customerEmailOnlySchema = z.object({
  email: emailSchema.pipe(z.string().max(254)),
});

const customerTokenSchema = z
  .string()
  .trim()
  .min(1, "Token is required")
  .max(512, "Token is too long");

export const customerVerifyEmailSchema = z.object({
  token: customerTokenSchema,
  password: z.string().min(1, "Password is required").max(200),
});

export const customerResetPasswordSchema = z.object({
  token: customerTokenSchema,
  password: passwordSchema,
});

/** A signed-in customer's own details. The email is not editable here. */
export const customerProfileSchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(120),
  phone: z
    .string()
    .trim()
    .max(32, "Phone number is too long")
    .regex(/^(?:\+?[0-9][0-9 ().-]*)?$/, "Enter a valid phone number"),
});

export const customerChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Password is required").max(200),
  newPassword: passwordSchema,
});

/** Shared normaliser for code paths that do not go through `emailSchema`. */
export function normalizeAccountEmail(value: string): string {
  return value.trim().toLowerCase();
}

export const resetPasswordSchema = z.object({
  token: z
    .string()
    .trim()
    .min(1, "This reset link is incomplete")
    .max(512, "This reset link is not valid"),
  password: passwordSchema,
});

export const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #4f46e5");

// Menu items: one of the store's pages, or any safe address (lib/navigation.ts).
const navigationLinkFields = {
  pageId: z.string().trim().max(64).optional(),
  href: z
    .string()
    .trim()
    .max(300)
    .refine((value) => value === "" || isSafeSectionHref(value), "Use a link inside your store, or a full https:// address")
    .optional(),
  label: z.string().trim().min(1).max(80),
  order: z.number().int().min(0).max(1000),
  /** Only on larger screens, or only in the phone menu. Absent = everywhere. */
  showOn: z.enum(["desktop", "mobile"]).optional(),
};
const navigationItemSchema = z.object({
  ...navigationLinkFields,
  children: z.array(z.object(navigationLinkFields)).max(12).optional(),
});

const noDuplicatePages = (items: Array<{ pageId?: string }>, area: string, ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (!item.pageId) return;
    if (seen.has(item.pageId)) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate page reference in ${area} navigation: ${item.pageId}`,
        path: [area, index, "pageId"],
      });
    }
    seen.add(item.pageId);
  });
};

const navigationConfigSchema = z.object({
  header: z.array(navigationItemSchema).max(20).prefault([]),
  footer: z.array(navigationItemSchema).max(20).prefault([]),
}).superRefine((nav, ctx) => {
  noDuplicatePages(nav.header ?? [], "header", ctx);
  noDuplicatePages(nav.footer ?? [], "footer", ctx);
});

// Extended design tokens for Phase 2A
const designTokensSchema = z
  .object({
    spacing: z
      .object({
        xs: z.string().optional(),
        sm: z.string().optional(),
        md: z.string().optional(),
        lg: z.string().optional(),
        xl: z.string().optional(),
      })
      .optional(),
    radius: z
      .object({
        sm: z.string().optional(),
        md: z.string().optional(),
        lg: z.string().optional(),
        xl: z.string().optional(),
      })
      .optional(),
    shadows: z
      .object({
        sm: z.string().optional(),
        md: z.string().optional(),
        lg: z.string().optional(),
      })
      .optional(),
    button: z
      .object({
        radius: z.string().optional(),
        paddingX: z.string().optional(),
        paddingY: z.string().optional(),
      })
      .optional(),
    contentWidth: z.string().optional(),
    fontScale: z.string().optional(),
  })
  .optional();

/** Live copies change only by publishing, so a request naming one is refused, never ignored. */
// Optional: in Zod 4 a plain z.undefined() also refuses a request that leaves the key out.
const publishedOnly = z.undefined({ error: "Published content changes only by publishing." }).optional();

export const themeSettingsSchema = z.object({
  primaryColor: hexColor.optional(),
  accentColor: hexColor.optional(),
  font: z.enum(["sans", "serif", "mono"]).optional(),
  heroHeadline: z.string().trim().max(160).optional(),
  heroSubheadline: z.string().trim().max(240).optional(),
  about: z.string().trim().max(4000).optional(),
  showProducts: z.boolean().optional(),
  sections: sectionsArraySchema.optional(),
  designTokens: designTokensSchema,
  navigation: navigationConfigSchema.optional(),
  publishedNavigation: publishedOnly,
  publishedDesignTokens: publishedOnly,
  publishedStorefront: publishedOnly,
  design: publishedOnly,
});

export const subdomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isValidSubdomain, "That subdomain is not allowed");

export const businessCreateSchema = z.object({
  name: z.string().trim().min(2, "Business name is too short").max(140),
  category: z.enum(categoryKeys),
  subdomain: subdomainSchema.optional(),
  description: z.string().trim().max(2000).optional(),
  themeId: z.enum(THEME_IDS).optional(),
});

/**
 * Protocol allowlist for owner-supplied image/logo URLs.
 *
 * `z.string().url()` is NOT a security boundary: it only checks that the value
 * parses as a URL, so it happily accepts `javascript:alert(1)`,
 * `data:text/html;base64,...`, `vbscript:…` and `ftp://…` (zod 3 uses
 * `new URL()` semantics here). Those values are inert inside an `<img src>`,
 * but they are stored and re-rendered, so any future `<a href>`, CSS
 * `background-image: url()` or `<iframe src>` would turn stored data into
 * script execution.
 *
 * Only `https:` is accepted. Plain `http:` is rejected on purpose:
 *   - storefronts are served over HTTPS, and a browser blocks an `http:`
 *     image on an `https:` page as mixed content before CSS/cSP even matter;
 *   - there is no documented product requirement for hosting product images
 *     on a plain-http origin. Local development does not need one: the dev
 *     server is reached at `http://localhost:3000`, but image URLs are
 *     absolute, so any real image host (or a self-hosted https one) works.
 *
 * Add new schemes here only with a concrete, documented requirement.
 */
export const imageUrlSchema = z
  .string()
  .trim()
  .url("A valid URL is required")
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Only https:// URLs are allowed" },
  );

/**
 * Optional image/logo URL. Keeps the existing contract of these fields exactly:
 * absent, an explicit `""` (the "cleared" value the models default to), or a
 * valid https URL. Anything else is rejected.
 */
export const optionalImageUrlSchema = imageUrlSchema
  .or(z.literal(""))
  .optional();

export const businessUpdateSchema = z.object({
  name: z.string().trim().min(2).max(140).optional(),
  category: z.enum(categoryKeys).optional(),
  description: z.string().trim().max(2000).optional(),
  logoUrl: optionalImageUrlSchema,
  contactEmail: emailSchema.or(z.literal("")).optional(),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(240).optional(),
  serviceArea: z.string().trim().max(240).optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  themeId: z.enum(THEME_IDS).optional(),
  themeSettings: themeSettingsSchema.optional(),
  /** Storefront cash on delivery. Owner-only (enforced by the route). */
  codEnabled: z.boolean().optional(),
  guestCodEnabled: z.boolean().optional(),
  managersCanInvite: z.boolean().optional(),
});

/** "" or null clears the original price; numbers and numeric strings set it. */
const compareAtPriceSchema = z.preprocess(
  (value) => (value === "" ? null : typeof value === "string" ? Number(value) : value),
  z.number().min(0).max(1_000_000).nullable(),
);

const productFieldsSchema = z.object({
  name: z.string().trim().min(1, "Product name is required").max(160),
  description: z.string().trim().max(4000).optional(),
  price: z.coerce.number().min(0).max(1_000_000),
  compareAtPrice: compareAtPriceSchema.optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  imageUrl: optionalImageUrlSchema,
  images: z.array(imageUrlSchema).max(10).optional(),
  sku: z.string().trim().max(80).optional(),
  category: z.string().trim().max(80).optional(),
  /** Search-engine title/description and main image alt text ("" = derived). */
  seoTitle: z.string().trim().max(160).refine((v) => !/[<>]/.test(v), "Use plain text").optional(),
  seoDescription: z.string().trim().max(320).refine((v) => !/[<>]/.test(v), "Use plain text").optional(),
  imageAlt: z.string().trim().max(160).refine((v) => !/[<>]/.test(v), "Use plain text").optional(),
  stock: z.coerce.number().int().min(0).prefault(0),
  /** Low-stock warning level (empty = platform default). */
  lowStockThreshold: z.preprocess(
    (value) => (value === "" ? null : typeof value === "string" ? Number(value) : value),
    z.number().int().min(0).max(100_000).nullable(),
  ).optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
});

/** A sale price must be lower than the original price it is compared with. */
export function isValidCompareAtPrice(price: number, compareAtPrice: number | null | undefined): boolean {
  return compareAtPrice === null || compareAtPrice === undefined || compareAtPrice > price;
}

export const productCreateSchema = productFieldsSchema.refine(
  (value) => isValidCompareAtPrice(value.price, value.compareAtPrice),
  { message: "The original price must be higher than the price", path: ["compareAtPrice"] },
);

export const productUpdateSchema = productFieldsSchema.partial().extend({
  // No default: `.partial()` keeps a default, which would set stock to 0 on every edit.
  stock: z.coerce.number().int().min(0).optional(),
  /**
   * Optional optimistic guard for stock edits: the stock value the editor
   * displayed. When present, the stock change applies only if stock still equals
   * it (orders reserve stock by decrementing it), otherwise 409.
   */
  expectedStock: z.coerce.number().int().min(0).optional(),
});

export const customerCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(140),
  email: emailSchema,
  phone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const membershipInviteSchema = z.object({
  email: emailSchema,
  role: z.enum(MEMBERSHIP_ROLES),
});

/**
 * Body for PATCH /api/businesses/[id]/media/[mediaId]. Only descriptive
 * metadata can be edited; storage keys, MIME type and size are server-owned.
 */
export const mediaUpdateSchema = z.object({
  altText: z.string().trim().max(240, "Alt text is too long"),
});

export const membershipRoleUpdateSchema = z.object({
  role: z.enum(MEMBERSHIP_ROLES),
});

export const checkoutSchema = z.object({
  planKey: z.string().trim().toLowerCase().min(1),
});

export const publishSchema = z.object({
  publish: z.boolean(),
});

/**
 * Reserved storefront slugs that must never be claimed as custom pages,
 * because they collide with existing routes or platform paths.
 */
export const RESERVED_PAGE_SLUGS = new Set([
  "product",
  "products",
  "api",
  "admin",
  "dashboard",
  "store",
  "login",
  "register",
  "forgot-password",
  "reset-password",
  "verify-email",
  "terms",
  "privacy",
  // Storefront shopping routes (app/store/cart, app/store/order/[orderId]).
  "cart",
  // Storefront customer account routes (app/store/account/*).
  "account",
  "checkout",
  "order",
  "orders",
]);

export function normalizePageSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export const pageSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""))
  .pipe(
    z
      .string()
      .min(1, "Slug is required")
      .max(80)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "Invalid slug")
      .refine((v) => !RESERVED_PAGE_SLUGS.has(v), "This slug is reserved"),
  );

/** An image for sharing: https, or a platform local-media address (same rule as the homepage). */
const seoImageSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (value === "") return true;
    if (value.startsWith("/")) return /^\/api\/businesses\/[a-f0-9]{24}\/local-media\?key=[A-Za-z0-9+/=%]+$/i.test(value);
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Use an image from your media library");

export const pageCreateSchema = z.object({
  title: z.string().trim().min(1).max(140),
  /** A starting layout (lib/page-templates.ts); ignored when `sections` is given. */
  template: z.enum(PAGE_TEMPLATES).optional(),
  slug: pageSlugSchema.optional(),
  sections: sectionsArraySchema.optional(),
  isHome: z.boolean().optional(),
  seoTitle: z.string().trim().max(160).optional(),
  seoDescription: z.string().trim().max(320).optional(),
  description: z.string().trim().max(300).optional(),
});

export const pageUpdateSchema = z.object({
  title: z.string().trim().min(1).max(140).optional(),
  slug: pageSlugSchema.optional(),
  sections: sectionsArraySchema.optional(),
  status: z.enum(["draft", "published"]).optional(),
  isHome: z.boolean().optional(),
  seoTitle: z.string().trim().max(160).optional(),
  seoDescription: z.string().trim().max(320).optional(),
  description: z.string().trim().max(300).optional(),
  seoImage: seoImageSchema.optional(),
  noindex: z.boolean().optional(),
  canonicalUrl: z
    .string()
    .trim()
    .max(500)
    .refine((value) => {
      if (value === "") return true;
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    }, "Use a full address starting with https://, or leave this empty")
    .optional(),
  expectedVersion: z.number().int().min(0).optional(),
  /** The owner confirms they reviewed a generated policy/legal template (needed to publish it). */
  confirmReviewed: z.literal(true).optional(),
});

/**
 * Schema for a custom domain value submitted to the domain assignment and
 * verification APIs. Uses the shared `validateDomain` helper so validation
 * logic lives in one place.
 */
export const customDomainSchema = z
  .string()
  .trim()
  .refine(
    (value) => {
      try {
        validateDomain(value);
        return true;
      } catch {
        return false;
      }
    },
    {
      message:
        "Invalid custom domain. Use a bare hostname (e.g. example.com) without scheme, path, or query.",
    },
  );
