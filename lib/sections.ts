/**
 * Section model for the visual website builder (Phase WB-2).
 *
 * A "section" is a typed, ordered, validated block of content that composes a
 * page. Multi-page sites store sections on Page; legacy homepage content may
 * still use the optional `Business.themeSettings.sections` array.
 *
 * Validation rules:
 * - Section types are an allowlist (no arbitrary types).
 * - Each section's `settings` are validated against a type-specific schema.
 * - Section ids must be unique within a page and match a safe slug pattern.
 * - Unknown fields are stripped (zod default).
 * - Payloads are size-bounded.
 */

import { z } from "zod";
import { responsiveSettingsSchema } from "./section-responsive";

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #4f46e5");

export const SECTION_TYPES = [
  "hero",
  "products",
  "about",
  "features",
  "cta",
  "footer",
  "faq",
  "testimonials",
  "gallery",
  "pricing",
  "contact",
  "newsletter",
  "stats",
  "richText",
  "imageText",
  "video",
  "logos",
  "team",
  "steps",
  "spacer",
  "reviews",
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export const SECTION_TYPE_LABELS: Record<SectionType, string> = {
  hero: "Hero",
  products: "Products",
  about: "About",
  features: "Features",
  cta: "Call to action",
  footer: "Footer",
  faq: "FAQ",
  testimonials: "Testimonials",
  gallery: "Gallery",
  pricing: "Pricing",
  contact: "Contact",
  newsletter: "Newsletter",
  stats: "Stats",
  richText: "Text",
  imageText: "Image and text",
  video: "Video",
  logos: "Logos",
  team: "Team",
  steps: "Steps",
  spacer: "Space or line",
  reviews: "Customer reviews",
};

export const SECTION_TYPE_DESCRIPTIONS: Record<SectionType, string> = {
  hero: "Headline, subheadline, optional image and call-to-action banner.",
  products: "Product grid from your catalog.",
  about: "About your business text block with an optional image.",
  features: "Feature highlights with title and description.",
  cta: "Conversion-focused call-to-action block.",
  footer: "Contact and footer information.",
  faq: "Frequently asked questions with expandable answers.",
  testimonials: "Customer quotes with names and optional roles.",
  gallery: "Image collection with accessible alt text.",
  pricing: "Pricing cards with features and optional CTAs.",
  contact: "Business contact details and actions.",
  newsletter: "Newsletter signup presentation with CTA.",
  stats: "Numeric highlights and labels.",
  richText: "Headings, paragraphs, bullet lists, bold text and links.",
  imageText: "A picture beside your text, on either side, with an optional button.",
  video: "A poster with a play button that opens your YouTube or Vimeo video.",
  logos: "Partner, client or press logos in a row.",
  team: "The people behind your business, with photos and roles.",
  steps: "A numbered process: how it works, in order.",
  spacer: "Extra room between sections, with an optional line.",
  reviews: "Reviews you have approved from real orders. Hidden until there are some.",
};

// ---------------------------------------------------------------------------
// Per-type settings schemas
// ---------------------------------------------------------------------------

/**
 * Optional section image. Kept URL-based for backward compatibility with
 * existing section data; the API additionally verifies that platform media
 * URLs belong to the current business.
 */
/** A local development media address: the same rule as the homepage's images. Ownership is checked by the API. */
export const LOCAL_MEDIA_PATH = /^\/api\/businesses\/[a-f0-9]{24}\/local-media\?key=[A-Za-z0-9+/=%]+$/i;

const sectionImageUrl = z
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
  )
  .or(z.literal(""))
  .or(z.string().regex(LOCAL_MEDIA_PATH))
  .optional();

const sectionImageAlt = z.string().trim().max(240).optional();

export function isSafeSectionHref(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f\\]/.test(value)
  ) {
    return false;
  }

  if (value.startsWith("//")) return false;

  try {
    const base = new URL("https://siteforge.invalid/");
    const url = new URL(value, base);
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
    if (!hasScheme) return url.origin === base.origin;
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

const sectionHref = z
  .string()
  .trim()
  .max(200)
  .refine((value) => value === "" || isSafeSectionHref(value), {
    message: "Use an https URL, a site path, or a page anchor",
  })
  .optional();

export const heroSettingsSchema = z.object({
  headline: z.string().trim().max(160).optional(),
  subheadline: z.string().trim().max(240).optional(),
  ctaText: z.string().trim().max(60).optional(),
  ctaHref: sectionHref,
  imageUrl: sectionImageUrl,
  imageAlt: sectionImageAlt,
});

export const productsSettingsSchema = z.object({
  title: z.string().trim().max(80).optional(),
  columns: z.enum(["2", "3", "4"]).optional(),
  /** Only products in this product category (case-insensitive); empty = all. */
  category: z.string().trim().max(80).optional(),
  /** all (default), new (newest first) or sale (real compare-at prices only). */
  collection: z.enum(["all", "new", "sale"]).optional(),
  /** At most this many products (default: all). */
  limit: z.number().int().min(1).max(48).optional(),
});

export const aboutSettingsSchema = z.object({
  title: z.string().trim().max(80).optional(),
  body: z.string().trim().max(4000).optional(),
  imageUrl: sectionImageUrl,
  imageAlt: sectionImageAlt,
});

export const featuresSettingsSchema = z.object({
  title: z.string().trim().max(80).optional(),
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(80),
        description: z.string().trim().max(240),
      }),
    )
    .max(12)
    .optional(),
});

export const ctaSettingsSchema = z.object({
  headline: z.string().trim().max(160).optional(),
  buttonText: z.string().trim().max(60).optional(),
  buttonHref: sectionHref,
});

export const footerSettingsSchema = z.object({
  text: z.string().trim().max(240).optional(),
});

// ---------------------------------------------------------------------------
// Phase 2B: Advanced section settings schemas
// ---------------------------------------------------------------------------

export const faqSettingsSchema = z.object({
  title: z.string().trim().max(80).optional(),
  items: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(200),
        answer: z.string().trim().min(1).max(2000),
      }),
    )
    .max(20)
    .optional(),
});

export const testimonialsSettingsSchema = z.object({
  title: z.string().trim().max(80).optional(),
  items: z
    .array(
      z.object({
        quote: z.string().trim().min(1).max(1000),
        name: z.string().trim().min(1).max(120),
        role: z.string().trim().max(120).optional(),
        imageUrl: sectionImageUrl,
        imageAlt: sectionImageAlt,
      }),
    )
    .max(12)
    .optional(),
});

export const gallerySettingsSchema = z.object({
  title: z.string().trim().max(80).optional(),
  images: z
    .array(
      z.object({
        url: sectionImageUrl,
        alt: z.string().trim().max(240).optional(),
        caption: z.string().trim().max(240).optional(),
      }).superRefine((image, ctx) => {
        if (image.url && !image.alt) {
          ctx.addIssue({
            code: "custom",
            message: "Add alt text for each gallery image",
            path: ["alt"],
          });
        }
      }),
    )
    .max(24)
    .optional(),
  columns: z.enum(["2", "3", "4"]).optional(),
});

export const pricingSettingsSchema = z.object({
  title: z.string().trim().max(80).optional(),
  plans: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(80),
        price: z.string().trim().max(40),
        period: z.string().trim().max(40).optional(),
        features: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
        ctaText: z.string().trim().max(60).optional(),
        ctaHref: sectionHref,
        highlighted: z.boolean().optional(),
      }),
    )
    .max(6)
    .optional(),
});

export const contactSettingsSchema = z.object({
  title: z.string().trim().max(80).optional(),
  description: z.string().trim().max(500).optional(),
  email: z.string().trim().email().max(200).or(z.literal("")).optional(),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(240).optional(),
  ctaText: z.string().trim().max(60).optional(),
  ctaHref: sectionHref,
});

export const newsletterSettingsSchema = z.object({
  headline: z.string().trim().max(160).optional(),
  description: z.string().trim().max(500).optional(),
  buttonText: z.string().trim().max(60).optional(),
  placeholder: z.string().trim().max(80).optional(),
  ctaHref: sectionHref,
});

export const statsSettingsSchema = z.object({
  title: z.string().trim().max(80).optional(),
  items: z
    .array(
      z.object({
        value: z.string().trim().min(1).max(40),
        label: z.string().trim().min(1).max(80),
      }),
    )
    .max(8)
    .optional(),
});

const editorLength = z
  .string()
  .regex(/^(?:0|(?:\d{1,4}(?:\.\d{1,2})?)(?:px|rem|em|%|vw|vh))$/, "Use a supported CSS size such as px, rem, or %");

export const editorElementStyleSchema = z
  .object({
    color: hexColor.optional(),
    backgroundColor: hexColor.optional(),
    fontSize: editorLength.optional(),
    fontWeight: z.enum(["400", "500", "600", "700", "800"]).optional(),
    textAlign: z.enum(["left", "center", "right", "justify"]).optional(),
    lineHeight: z.number().min(0.8).max(3).optional(),
    letterSpacing: editorLength.optional(),
    width: editorLength.optional(),
    maxWidth: editorLength.optional(),
    margin: editorLength.optional(),
    padding: editorLength.optional(),
    borderColor: hexColor.optional(),
    borderWidth: editorLength.optional(),
    borderRadius: editorLength.optional(),
    boxShadow: z.enum(["none", "sm", "md", "lg"]).optional(),
    opacity: z.number().min(0).max(1).optional(),
    objectFit: z.enum(["cover", "contain", "fill"]).optional(),
  offsetX: z.number().min(-2000).max(2000).optional(),
  offsetY: z.number().min(-2000).max(2000).optional(),
  })
  .strict();
export type EditorElementStyle = z.infer<typeof editorElementStyleSchema>;

const sectionStyleSchema = z.object({
  backgroundColor: hexColor.optional(),
  textColor: hexColor.optional(),
  padding: z.enum(["none", "sm", "md", "lg", "xl"]).optional(),
  /** Spacing, alignment, columns, width and visibility per screen size (lib/section-responsive.ts). */
  responsive: responsiveSettingsSchema.optional(),
  elementStyles: z
    .record(
      z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,127}$/i),
      z
        .object({
          desktop: editorElementStyleSchema.optional(),
          tablet: editorElementStyleSchema.optional(),
          mobile: editorElementStyleSchema.optional(),
        })
        .strict(),
    )
    .optional(),
});

// ---------------------------------------------------------------------------
// Section schema (discriminated union by type)
// ---------------------------------------------------------------------------

// ---- Content sections ---------------------------------------------------------

export const richTextSettingsSchema = z.object({
  title: z.string().trim().max(160).optional(),
  body: z.string().trim().max(8000).optional(),
});

export const imageTextSettingsSchema = z.object({
  title: z.string().trim().max(160).optional(),
  body: z.string().trim().max(4000).optional(),
  imageUrl: sectionImageUrl,
  imageAlt: sectionImageAlt,
  imageSide: z.enum(["left", "right"]).optional(),
  ctaText: z.string().trim().max(60).optional(),
  ctaHref: sectionHref.optional(),
});

/** The address to open and the poster for a supported video link, or null. */
export function parseVideoUrl(value: unknown): { watchUrl: string; poster: string | null; provider: "YouTube" | "Vimeo" } | null {
  if (typeof value !== "string" || !value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\.|^m\./, "");
  const youtube =
    host === "youtu.be"
      ? url.pathname.slice(1)
      : host === "youtube.com" || host === "youtube-nocookie.com"
        ? url.pathname === "/watch"
          ? url.searchParams.get("v") ?? ""
          : (/^\/(?:embed|shorts|live)\/([^/]+)/.exec(url.pathname)?.[1] ?? "")
        : "";
  if (/^[A-Za-z0-9_-]{6,20}$/.test(youtube)) {
    return { watchUrl: `https://www.youtube.com/watch?v=${youtube}`, poster: `https://i.ytimg.com/vi/${youtube}/hqdefault.jpg`, provider: "YouTube" };
  }
  const vimeo = host === "vimeo.com" ? (/^\/(\d{5,12})(?:\/|$)/.exec(url.pathname)?.[1] ?? "") : "";
  if (vimeo) return { watchUrl: `https://vimeo.com/${vimeo}`, poster: null, provider: "Vimeo" };
  return null;
}

export const videoSettingsSchema = z.object({
  title: z.string().trim().max(160).optional(),
  url: z
    .string()
    .trim()
    .max(300)
    .refine((value) => value === "" || parseVideoUrl(value) !== null, "Paste a YouTube or Vimeo link")
    .optional(),
  /** A picture to show instead of the video's own (Vimeo has no automatic one). */
  imageUrl: sectionImageUrl,
  imageAlt: sectionImageAlt,
  caption: z.string().trim().max(240).optional(),
});

export const logosSettingsSchema = z.object({
  title: z.string().trim().max(160).optional(),
  items: z
    .array(z.object({ imageUrl: sectionImageUrl, alt: z.string().trim().max(160).optional(), href: sectionHref.optional() }))
    .max(24)
    .prefault([]),
});

export const teamSettingsSchema = z.object({
  title: z.string().trim().max(160).optional(),
  items: z
    .array(
      z.object({
        name: z.string().trim().max(120),
        role: z.string().trim().max(120).optional(),
        bio: z.string().trim().max(600).optional(),
        imageUrl: sectionImageUrl,
        imageAlt: sectionImageAlt,
      }),
    )
    .max(24)
    .prefault([]),
});

export const stepsSettingsSchema = z.object({
  title: z.string().trim().max(160).optional(),
  items: z.array(z.object({ title: z.string().trim().max(160), description: z.string().trim().max(600).optional() })).max(12).prefault([]),
});

export const spacerSettingsSchema = z.object({
  size: z.enum(["small", "medium", "large"]).optional(),
  line: z.boolean().optional(),
});

/** Only ever approved reviews from real orders (`recentApprovedReviews`): nothing here holds review text. */
export const reviewsSettingsSchema = z.object({
  title: z.string().trim().max(160).optional(),
  limit: z.number().int().min(1).max(12).optional(),
});

const baseSectionFields = {
  id: z
    .string()
    .trim()
    .min(1, "Section id is required")
    .max(64, "Section id is too long")
    .regex(/^[a-z0-9][a-z0-9-]*$/i, "Section id must be alphanumeric with hyphens"),
  order: z.number().int().min(0).max(10_000),
  /** The owner's name for this section in the editor. Never shown to visitors. */
  name: z.string().trim().max(60).optional(),
  visible: z.boolean().prefault(true),
  /** Hide this section on one kind of screen; absent shows it everywhere. */
  hideOn: z.enum(["mobile", "desktop"]).optional(),
  style: sectionStyleSchema.optional(),
};

export const sectionSchema = z.discriminatedUnion("type", [
  z.object({ ...baseSectionFields, type: z.literal("hero"), settings: heroSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("products"), settings: productsSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("about"), settings: aboutSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("features"), settings: featuresSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("cta"), settings: ctaSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("footer"), settings: footerSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("faq"), settings: faqSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("testimonials"), settings: testimonialsSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("gallery"), settings: gallerySettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("pricing"), settings: pricingSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("contact"), settings: contactSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("newsletter"), settings: newsletterSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("stats"), settings: statsSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("richText"), settings: richTextSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("imageText"), settings: imageTextSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("video"), settings: videoSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("logos"), settings: logosSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("team"), settings: teamSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("steps"), settings: stepsSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("spacer"), settings: spacerSettingsSchema.prefault({}) }),
  z.object({ ...baseSectionFields, type: z.literal("reviews"), settings: reviewsSettingsSchema.prefault({}) }),
]);

export type Section = z.infer<typeof sectionSchema>;

export function getVisibleSections(value: unknown): Section[] {
  if (!Array.isArray(value)) return [];

  return value
    .flatMap((candidate): Section[] => {
      const parsed = sectionSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    })
    .filter((section) => section.visible)
    .sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------------------
// Sections array schema with duplicate-id check
// ---------------------------------------------------------------------------

/**
 * The sections a PUBLIC visitor may see for a published Page document.
 *
 * Publication state is decided by the snapshot FIELD, not by whether it has
 * content. The only code path that publishes a page (`PATCH
 * /api/businesses/[id]/pages/[pageId]` with `status: "published"`) writes
 * `publishedSections` in the same atomic update, and Mongoose stores `[]` on
 * every page it creates. So:
 *
 * - field ABSENT (`undefined` on a `.lean()` read): a legacy record written
 *   before snapshots existed, when `sections` WAS the live content. Its stored
 *   sections are rendered, preserving legacy behaviour.
 * - field PRESENT (any value): the snapshot is authoritative. An empty array
 *   means "published with no sections" and renders the theme default; it never
 *   falls back to `sections`, which may hold newer, unpublished draft edits.
 *   A malformed (non-array) snapshot fails closed to "no sections".
 */
export function resolvePublishedPageSections(page: {
  sections?: unknown;
  publishedSections?: unknown;
}): unknown[] {
  if (page.publishedSections === undefined) {
    return Array.isArray(page.sections) ? page.sections : [];
  }
  return Array.isArray(page.publishedSections) ? page.publishedSections : [];
}

export const sectionsArraySchema = z
  .array(sectionSchema)
  .max(50, "Too many sections (max 50)")
  .superRefine((sections, ctx) => {
    const ids = new Set<string>();
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      if (ids.has(s.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate section id: ${s.id}`,
          path: [i, "id"],
        });
      }
      ids.add(s.id);
    }
    // Re-normalize order to be contiguous 0..n-1 is NOT done here; callers
    // may reorder. We only reject obviously invalid order values (already
    // bounded by per-section schema).
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sectionCounter = 0;

export function generateSectionId(type: SectionType): string {
  sectionCounter += 1;
  return `${type}-${Date.now().toString(36)}-${sectionCounter}`;
}

export function createDefaultSection(type: SectionType, order: number): Section {
  const base = {
    id: generateSectionId(type),
    type,
    order,
    visible: true,
    settings: {},
  };
  switch (type) {
    case "hero":
      return { ...base, type: "hero", settings: { headline: "Welcome", subheadline: "Quality you can trust." } };
    case "products":
      return { ...base, type: "products", settings: { title: "Featured products", columns: "3" } };
    case "about":
      return { ...base, type: "about", settings: { title: "About us", body: "" } };
    case "features":
      return { ...base, type: "features", settings: { title: "Features", items: [] } };
    case "cta":
      return { ...base, type: "cta", settings: { headline: "Get started today", buttonText: "Contact us" } };
    case "footer":
      return { ...base, type: "footer", settings: { text: "" } };
    case "faq":
      return { ...base, type: "faq", settings: { title: "Frequently asked questions", items: [] } };
    case "testimonials":
      return { ...base, type: "testimonials", settings: { title: "Testimonials", items: [] } };
    case "gallery":
      return { ...base, type: "gallery", settings: { title: "Gallery", images: [], columns: "3" } };
    case "pricing":
      return { ...base, type: "pricing", settings: { title: "Pricing", plans: [] } };
    case "contact":
      return { ...base, type: "contact", settings: { title: "Contact us", description: "", email: "", phone: "", address: "" } };
    case "newsletter":
      return { ...base, type: "newsletter", settings: { headline: "Stay updated", description: "", buttonText: "Learn more", placeholder: "", ctaHref: "" } };
    case "stats":
      return { ...base, type: "stats", settings: { title: "Highlights", items: [] } };
    case "richText":
      return { ...base, type: "richText", settings: { title: "A heading", body: "" } };
    case "imageText":
      return { ...base, type: "imageText", settings: { title: "A heading", body: "", imageSide: "right" } };
    case "video":
      return { ...base, type: "video", settings: { title: "Watch", url: "" } };
    case "logos":
      return { ...base, type: "logos", settings: { title: "", items: [] } };
    case "team":
      return { ...base, type: "team", settings: { title: "Meet the team", items: [] } };
    case "steps":
      return { ...base, type: "steps", settings: { title: "How it works", items: [] } };
    case "spacer":
      return { ...base, type: "spacer", settings: { size: "medium", line: false } };
    case "reviews":
      return { ...base, type: "reviews", settings: { title: "Customer reviews", limit: 6 } };
  }
}

export function reorderSections(sections: Section[]): Section[] {
  return sections.map((s, i) => ({ ...s, order: i }));
}

/** What a section is called in the editor: the owner's name, its own heading, or its type. */
export function sectionDisplayName(section: Section): string {
  if (section.name) return section.name;
  const settings = section.settings as { title?: unknown; headline?: unknown };
  const own = typeof settings.title === "string" && settings.title ? settings.title : typeof settings.headline === "string" ? settings.headline : "";
  return own && !/\[\[/.test(own) ? own : SECTION_TYPE_LABELS[section.type];
}

export function getSectionTypeLabel(type: SectionType): string {
  return SECTION_TYPE_LABELS[type];
}