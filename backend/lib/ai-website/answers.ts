import { z } from "zod";
import { THEME_IDS } from "@/lib/constants";
import { BODY_WEIGHTS, BUTTON_SHAPES, BUTTON_STYLES, CONTENT_WIDTHS, DESIGN_FONTS, HEADING_SIZES, HEADING_WEIGHTS, LINK_STYLES, RADII, SECTION_SPACINGS, TEXT_SIZES } from "@/lib/design-settings";
import { responsiveRuleSchema, RESPONSIVE_DEVICES } from "@/lib/section-responsive";
import { aiPageEditSchema, aiSectionUpdateSet } from "@/lib/ai-builder/page-builder";
import { storefrontChangeSchema } from "@/lib/ai-builder/storefront-changes";
import { sectionTemplate } from "@/lib/section-library";
import { FOOTER_LAYOUTS, HEADER_LAYOUTS } from "@/lib/storefront-config";
import { PLACEHOLDER_PATTERN } from "@/lib/page-presets";

/**
 * What a provider may answer in the website workflow (pure). Every object is strict, so an answer can
 * express only what these schemas name. No answer sets an image address, a product, an order or a
 * contact detail: images are references to this store's own media, which the server turns into
 * addresses, and contact details come from the business settings on the server.
 */
const noHtml = (value: string) => !/<\/?[a-z][^>]*>/i.test(value);
const text = (max: number) => z.string().trim().max(max).refine(noHtml, "HTML is not supported");
const required = (max: number) => text(max).pipe(z.string().min(1));
/** Checked against the store's real links when it is used. */
const link = z.string().trim().max(200).refine((v) => v === "" || /^\/(?!\/)[A-Za-z0-9\-._~/?=&%+#]*$/.test(v), "Use a store link");
const imageRef = z.string().regex(/^m\d{1,3}$/, "Use a reference from MEDIA");
const productRef = z.string().regex(/^p\d{1,3}$/, "Use a reference from PRODUCTS");
/** No suitable picture exists: what the owner should upload. The section works without one. */
const imageRequest = text(120);
const notes = z.array(text(200)).max(5).prefault([]);

/** Everything the section library offers. Sections needing facts only the owner has come as templates, with [[placeholders]]. */
export const aiWebsiteSectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hero"), headline: required(160), subheadline: text(240).optional(), ctaText: text(60).optional(), ctaHref: link.optional(), imageRef: imageRef.optional(), imageAlt: text(160).optional(), imageRequest: imageRequest.optional() }).strict(),
  z.object({ type: z.literal("about"), title: text(80).optional(), body: required(4000), imageRef: imageRef.optional(), imageAlt: text(160).optional(), imageRequest: imageRequest.optional() }).strict(),
  z.object({ type: z.literal("features"), title: text(80).optional(), items: z.array(z.object({ title: required(80), description: text(240) }).strict()).min(1).max(8) }).strict(),
  z.object({ type: z.literal("faq"), title: text(80).optional(), items: z.array(z.object({ question: required(200), answer: required(2000) }).strict()).min(1).max(12) }).strict(),
  z.object({ type: z.literal("cta"), headline: required(160), buttonText: text(60).optional(), buttonHref: link.optional() }).strict(),
  z.object({ type: z.literal("contact"), title: text(80).optional(), description: text(500).optional() }).strict(),
  z.object({ type: z.literal("products"), title: text(80).optional(), category: text(80).optional(), collection: z.enum(["all", "new", "sale"]).optional(), limit: z.number().int().min(1).max(48).optional() }).strict(),
  z.object({ type: z.literal("richText"), title: text(160).optional(), body: required(8000) }).strict(),
  z.object({ type: z.literal("imageText"), title: text(160).optional(), body: required(4000), imageRef: imageRef.optional(), imageAlt: text(160).optional(), imageRequest: imageRequest.optional(), imageSide: z.enum(["left", "right"]).optional(), ctaText: text(60).optional(), ctaHref: link.optional() }).strict(),
  z.object({ type: z.literal("steps"), title: text(160).optional(), items: z.array(z.object({ title: required(160), description: text(600).optional() }).strict()).min(1).max(12) }).strict(),
  z.object({ type: z.literal("newsletter"), headline: required(160), description: text(500).optional(), buttonText: text(60).optional() }).strict(),
  z.object({ type: z.literal("spacer"), size: z.enum(["small", "medium", "large"]).optional(), line: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("reviews"), title: text(160).optional(), limit: z.number().int().min(1).max(12).optional() }).strict(),
  z.object({ type: z.literal("gallery"), title: text(80).optional(), images: z.array(z.object({ imageRef, alt: required(240), caption: text(240).optional() }).strict()).min(1).max(24), columns: z.enum(["2", "3", "4"]).optional() }).strict(),
  z.object({ type: z.literal("template"), template: z.string().regex(/^[a-z-]{1,40}$/) }).strict(),
]);
export type AiWebsiteSection = z.infer<typeof aiWebsiteSectionSchema>;

const designChoices = z
  .object({
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    useThemeColors: z.boolean(),
    displayFont: z.enum(DESIGN_FONTS),
    bodyFont: z.enum(DESIGN_FONTS),
    headingWeight: z.enum(HEADING_WEIGHTS),
    bodyWeight: z.enum(BODY_WEIGHTS),
    headingSize: z.enum(HEADING_SIZES),
    textSize: z.enum(TEXT_SIZES),
    buttonShape: z.enum(BUTTON_SHAPES),
    buttonStyle: z.enum(BUTTON_STYLES),
    radius: z.enum(RADII),
    contentWidth: z.enum(CONTENT_WIDTHS),
    sectionSpacing: z.enum(SECTION_SPACINGS),
    linkStyle: z.enum(LINK_STYLES),
    backgroundColor: z.string().regex(/^(#[0-9a-fA-F]{6})?$/),
    textColor: z.string().regex(/^(#[0-9a-fA-F]{6})?$/),
  })
  .partial()
  .strict();
export type AiDesignChoices = z.infer<typeof designChoices>;

const headerChoices = z
  .object({ layout: z.enum(HEADER_LAYOUTS), logoDisplay: z.enum(["auto", "logo", "name", "both"]), logoSize: z.enum(["small", "medium", "large"]), navAlign: z.enum(["theme", "left", "center", "right"]), sticky: z.enum(["theme", "on", "off"]) })
  .partial()
  .strict();

const footerChoices = z
  .object({
    layout: z.enum(FOOTER_LAYOUTS),
    about: text(400),
    copyright: text(160),
    showContact: z.boolean(),
    showSocial: z.boolean(),
    showShopLinks: z.boolean(),
    showMenuLinks: z.boolean(),
    columns: z.array(z.object({ title: text(40), links: z.array(z.object({ label: required(60), href: link }).strict()).max(8) }).strict()).max(4),
  })
  .partial()
  .strict();

const announcementChoices = z.object({ enabled: z.boolean(), text: text(140), href: link, tone: z.enum(["theme", "brand"]) }).partial().strict();

const NATIVE_HOME = ["categories", "featured", "bestSellers", "newArrivals", "sale", "benefits", "story"] as const;

const homeSectionAnswer = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(NATIVE_HOME), title: text(80).optional(), subtitle: text(160).optional(), limit: z.number().int().min(2).max(24).optional(), text: text(2000).optional(), products: z.array(productRef).max(24).optional() }).strict(),
  z.object({ kind: z.literal("block"), section: aiWebsiteSectionSchema }).strict(),
]);
export type AiHomeSection = z.infer<typeof homeSectionAnswer>;

const homeAnswer = z
  .object({
    hero: z
      .object({
        enabled: z.boolean(),
        eyebrow: text(60),
        headline: text(120),
        description: text(300),
        align: z.enum(["left", "center"]),
        primaryCta: z.object({ label: text(40), href: link }).strict(),
        secondaryCta: z.object({ label: text(40), href: link }).strict(),
        imageRef,
        imageAlt: text(160),
        imageRequest,
      })
      .partial()
      .strict()
      .prefault({}),
    announcement: announcementChoices.optional(),
    sections: z.array(homeSectionAnswer).max(14),
    seoTitle: text(160).optional(),
    seoDescription: text(320).optional(),
  })
  .strict();
export type AiHomeAnswer = z.infer<typeof homeAnswer>;

/** One turn of the discovery conversation. */
export const aiDiscoverySchema = z
  .object({
    reply: required(1200),
    brief: z
      .object({
        businessType: text(200),
        offerings: text(800),
        audience: text(500),
        objectives: text(800),
        pages: z.array(text(80)).max(20),
        brand: text(500),
        design: text(500),
        contactNotes: text(300),
        special: text(800),
        language: text(60),
      })
      .partial()
      .strict()
      .prefault({}),
    readyToGenerate: z.boolean().prefault(false),
    questions: z.array(text(200)).max(3).prefault([]),
  })
  .strict();
export type AiDiscovery = z.infer<typeof aiDiscoverySchema>;
export type WebsiteBrief = AiDiscovery["brief"];

/** The first step of generating: the whole website's structure, design and homepage. */
export const aiWebsitePlanSchema = z
  .object({
    summary: required(280),
    identity: z.object({ description: text(2000), targetAudience: text(500), purpose: text(500), personality: text(300), language: text(60) }).partial().strict().prefault({}),
    themeId: z.enum(THEME_IDS),
    design: designChoices.prefault({}),
    header: headerChoices.prefault({}),
    footer: footerChoices.prefault({}),
    home: homeAnswer,
    pages: z
      .array(
        z
          .object({
            title: required(140),
            /** Only when this rewrites a page in EXISTING_PAGES. */
            existingPath: z.string().trim().max(90).optional(),
            purpose: required(600),
            nav: z.enum(["header", "footer", "both", "none"]).prefault("header"),
          })
          .strict(),
      )
      .max(40),
    notes,
  })
  .strict();
export type AiWebsitePlan = z.infer<typeof aiWebsitePlanSchema>;

/** The content of one page. */
export const aiWebsitePageSchema = z
  .object({
    description: text(300).prefault(""),
    seoTitle: text(70).prefault(""),
    seoDescription: text(170).prefault(""),
    sections: z.array(aiWebsiteSectionSchema).min(1).max(12),
    notes,
  })
  .strict();
export type AiWebsitePageContent = z.infer<typeof aiWebsitePageSchema>;

const pagePath = z.string().trim().min(1).max(90);
const menuItem = z.object({ label: required(80), target: z.string().trim().max(200), showOn: z.enum(["desktop", "mobile"]).optional() }).strict();

/** One requested change. A revision holds only what was asked for. */
const revisionChange = z.discriminatedUnion("op", [
  // The homepage editor's own change format, without colours and fonts, which `design` covers.
  z.object({ op: z.literal("home"), change: storefrontChangeSchema }).strict(),
  z.object({ op: z.literal("home_add_block"), index: z.number().int().min(0).max(30), section: aiWebsiteSectionSchema }).strict(),
  // The text of a content section on the homepage. Its id, pictures and screen size settings stay.
  z.object({ op: z.literal("home_block_update"), sectionId: z.string().trim().min(1).max(64), set: aiSectionUpdateSet }).strict(),
  // Real products only, by reference. With no sectionId, a new product collection at `index`.
  z.object({ op: z.literal("home_featured"), sectionId: z.string().trim().min(1).max(64).optional(), index: z.number().int().min(0).max(30).optional(), title: text(80).optional(), products: z.array(productRef).min(1).max(24) }).strict(),
  z.object({ op: z.literal("page_edit"), path: pagePath, changes: aiPageEditSchema.shape.changes }).strict(),
  z.object({ op: z.literal("page_add_section"), path: pagePath, index: z.number().int().min(0).max(49), section: aiWebsiteSectionSchema }).strict(),
  z
    .object({
      op: z.literal("page_create"),
      title: required(140),
      purpose: required(600),
      nav: z.enum(["header", "footer", "both", "none"]).prefault("header"),
      description: text(300).prefault(""),
      seoTitle: text(70).prefault(""),
      seoDescription: text(170).prefault(""),
      sections: z.array(aiWebsiteSectionSchema).min(1).max(12),
    })
    .strict(),
  z.object({ op: z.literal("page_seo"), path: pagePath, seoTitle: text(70).optional(), seoDescription: text(170).optional(), description: text(300).optional() }).strict(),
  z.object({ op: z.literal("seo_home"), seoTitle: text(160).optional(), seoDescription: text(320).optional() }).strict(),
  z.object({ op: z.literal("design"), themeId: z.enum(THEME_IDS).optional(), set: designChoices.prefault({}) }).strict(),
  z.object({ op: z.literal("header"), set: headerChoices }).strict(),
  z.object({ op: z.literal("footer"), set: footerChoices }).strict(),
  z.object({ op: z.literal("announcement"), set: announcementChoices }).strict(),
  z.object({ op: z.literal("menu"), area: z.enum(["header", "footer"]), items: z.array(menuItem).max(20) }).strict(),
  z.object({ op: z.literal("responsive"), path: pagePath, sectionId: z.string().trim().min(1).max(64), device: z.enum(RESPONSIVE_DEVICES), rule: responsiveRuleSchema }).strict(),
]);
export type AiRevisionChange = z.infer<typeof revisionChange>;

export const aiWebsiteRevisionSchema = z
  .object({
    summary: required(280),
    changes: z.array(revisionChange).max(20),
    notes,
  })
  .strict();
export type AiWebsiteRevision = z.infer<typeof aiWebsiteRevisionSchema>;

export interface UnsupportedChoices {
  templates: string[];
  categories: string[];
}

/**
 * What an answer's sections choose that does not exist: section templates checked against the section
 * library, and product categories against this store's real ones, matched as lib/ai-builder/page-builder.ts
 * matches them. Run on every answer before it is kept, so a stored step can always be built later.
 */
export function findUnsupportedChoices(answer: unknown, categories: readonly string[]): UnsupportedChoices {
  const known = new Set(categories.map((category) => category.trim().toLowerCase()));
  const found: UnsupportedChoices = { templates: [], categories: [] };
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const item = value as { type?: unknown; template?: unknown; category?: unknown };
      if (item.type === "template" && typeof item.template === "string" && !sectionTemplate(item.template)) found.templates.push(item.template);
      if (item.type === "products" && typeof item.category === "string" && item.category.trim() && !known.has(item.category.trim().toLowerCase())) found.categories.push(item.category.trim());
      Object.values(value).forEach(visit);
    }
  };
  visit(answer);
  return { templates: [...new Set(found.templates)], categories: [...new Set(found.categories)] };
}

/** Keys whose text reaches visitors. Everything else in an answer is structure or a choice from a list. */
const VISIBLE_KEYS = new Set(["title", "subtitle", "headline", "subheadline", "description", "body", "text", "eyebrow", "about", "copyright", "label", "ctaText", "buttonText", "answer", "name", "caption", "alt", "imageAlt", "seoTitle", "seoDescription"]);

/**
 * Every text an answer would put on the store, placeholders removed (the claims check). A question
 * states nothing, and the headings of sections filled only from real orders and approved reviews claim
 * nothing of their own.
 */
export function answerVisibleTexts(answer: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown, key: string) => {
    if (typeof value === "string") {
      if (VISIBLE_KEYS.has(key)) out.push(value.replace(PLACEHOLDER_PATTERN, " "));
    } else if (Array.isArray(value)) value.forEach((item) => visit(item, key));
    else if (value && typeof value === "object") {
      const item = value as { type?: unknown; kind?: unknown };
      if (item.type === "reviews" || item.kind === "bestSellers") return;
      Object.entries(value).forEach(([name, child]) => visit(child, name));
    }
  };
  visit(answer, "");
  return out.filter((text) => text.trim().length > 0);
}
