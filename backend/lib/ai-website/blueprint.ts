import { z } from "zod";
import { designDraftSchema, type DesignDraft } from "@/lib/design-settings";
import { THEME_IDS, type ThemeId } from "@/lib/constants";
import { isSafeSectionHref, sectionsArraySchema, type Section } from "@/lib/sections";
import type { StorefrontConfig } from "@/lib/storefront-config";
import { pageSlugSchema } from "@/lib/validation";

/**
 * The canonical description of a whole website (pure; safe in client components). It is built from
 * the types the rest of the product already uses, so nothing in it is AI-only and the normal editor
 * can edit all of it: page sections are CMS sections, the homepage, header and footer are a storefront
 * config, the design is a design draft. Whatever a provider returned has been converted and validated
 * long before it gets here (./build.ts), so nothing here depends on a provider's format.
 */
export const MAX_WEBSITE_PAGES = 12;

const navLink = {
  /** A page of this website, by address, so a menu can name a page that does not exist yet. */
  pageSlug: pageSlugSchema.optional(),
  /** Any other address in the store, or a full https address. */
  href: z.string().trim().max(300).refine(isSafeSectionHref, "Use a link inside your store, or a full https:// address").optional(),
  label: z.string().trim().min(1).max(80),
  order: z.number().int().min(0).max(1000),
  showOn: z.enum(["desktop", "mobile"]).optional(),
};
const websiteNavItemSchema = z.object({ ...navLink, children: z.array(z.object(navLink)).max(12).optional() });
export type WebsiteNavItem = z.infer<typeof websiteNavItemSchema>;
export const websiteNavigationSchema = z.object({ header: z.array(websiteNavItemSchema).max(30), footer: z.array(websiteNavItemSchema).max(30) });
export type WebsiteNavigation = z.infer<typeof websiteNavigationSchema>;

export const websitePageSchema = z.object({
  /** The page's id; null until it is created. */
  id: z.string().regex(/^[a-f0-9]{24}$/i).nullable(),
  title: z.string().trim().min(1).max(140),
  slug: pageSlugSchema,
  status: z.enum(["draft", "published"]),
  isHome: z.boolean(),
  version: z.number().int().min(0),
  description: z.string().trim().max(300),
  seoTitle: z.string().trim().max(160),
  seoDescription: z.string().trim().max(320),
  seoImage: z.string().trim().max(2048),
  sections: sectionsArraySchema,
  /** Set on pages this proposal wrote, for the page's `generated` marker. */
  aiWritten: z.boolean().optional(),
  /** Policy wording: the owner must confirm a review before it can be published. */
  needsReview: z.boolean().optional(),
});
export type WebsitePage = Omit<z.infer<typeof websitePageSchema>, "sections"> & { sections: Section[] };

/** Everything about a website a proposal can change. */
export interface WebsiteState {
  design: DesignDraft;
  /** The homepage, announcement, header and footer. */
  config: StorefrontConfig;
  navigation: WebsiteNavigation;
  pages: WebsitePage[];
}

export const websiteIdentitySchema = z.object({
  businessName: z.string().trim().min(1).max(140),
  category: z.string().trim().max(80),
  description: z.string().trim().max(2000),
  targetAudience: z.string().trim().max(500),
  purpose: z.string().trim().max(500),
  personality: z.string().trim().max(300),
  language: z.string().trim().max(60),
  themeId: z.enum(THEME_IDS),
});
export type WebsiteIdentity = z.infer<typeof websiteIdentitySchema>;

export const websiteBlueprintSchema = z.object({
  version: z.literal(1),
  identity: websiteIdentitySchema,
  design: designDraftSchema,
  navigation: websiteNavigationSchema,
  pages: z.array(websitePageSchema).max(100),
});
export interface WebsiteBlueprint extends WebsiteState {
  version: 1;
  identity: WebsiteIdentity;
}

/** What a website proposal will do. Only what changes is here, so everything else stays as it is. */
export interface WebsiteChanges {
  config?: StorefrontConfig;
  design?: DesignDraft;
  navigation?: WebsiteNavigation;
  createPages: WebsitePage[];
  updatePages: WebsitePage[];
}

/** What a proposal's items looked like when it was prepared, so it can be refreshed without overwriting newer edits. */
export interface WebsiteBaseline {
  config?: StorefrontConfig;
  design?: DesignDraft;
  navigation?: WebsiteNavigation;
  pages: WebsitePage[];
}

/** The draft versions a proposal was prepared against. */
export interface WebsiteBase {
  storefrontVersion: number;
  designVersion: number;
  navigationVersion: number;
  pageVersions: Array<{ pageId: string; version: number }>;
}

export interface WebsiteProposalData {
  changes: WebsiteChanges;
  base: WebsiteBase;
  /** Absent on proposals from before refreshing existed. */
  baseline?: WebsiteBaseline;
  identity?: WebsiteIdentity;
  conversationId?: string;
  notes: string[];
}

/** What the review and preview screens need. Plain data for the shared renderer. */
export interface WebsitePreview {
  design: DesignDraft;
  config: StorefrontConfig;
  /** Proposed menus, ready to draw. */
  navigation: {
    header: PreviewNavItem[];
    footer: PreviewNavItem[];
  };
  pages: Array<{ id: string; title: string; slug: string; sections: Section[]; proposed: boolean }>;
  /**
   * An older custom homepage visitors see now. A proposal never replaces it: the proposed homepage goes
   * to the draft, and only publishing from the website editor retires this one.
   */
  classicHomepage?: ClassicHomepage | null;
}

export interface ClassicHomepage {
  kind: "page" | "legacy";
  title: string;
  sections: Section[];
}

/** The page id that previews a store's current custom homepage. */
export const CLASSIC_PREVIEW_ID = "classic";

/** How an owner's confirmation of refused wording begins, in the conversation. */
export const CLAIMS_CONFIRMED_PREFIX = "I confirm these are true for my business:";

export interface PreviewNavItem {
  pageId: string;
  label: string;
  slug: string;
  href?: string;
  external?: boolean;
  showOn?: "desktop" | "mobile";
  children?: PreviewNavItem[];
}

export type { ThemeId };
