import { PLACEHOLDER_PATTERN } from "./page-presets";
import { hiddenOnEveryScreen, type ResponsiveSettings } from "./section-responsive";

/**
 * Search and sharing defaults worked out from a page's own sections (pure; safe in client
 * components). Used to suggest text in the editor, and as the fallback for published pages
 * with nothing set, only ever from the published copy. Text still to be written is skipped.
 */
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

interface LooseSection {
  type?: string;
  visible?: boolean;
  settings?: Record<string, unknown>;
  style?: { responsive?: ResponsiveSettings };
}

const usable = (value: unknown): string => {
  if (typeof value !== "string") return "";
  PLACEHOLDER_PATTERN.lastIndex = 0;
  if (PLACEHOLDER_PATTERN.test(value)) return "";
  // Headings, bullets and links in formatted text read as plain words.
  return value.replace(/^#+\s*/gm, "").replace(/^-\s+/gm, "").replace(/\*\*/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
};

const shorten = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);

/** What a visitor can see: not hidden, and not hidden on every screen size. */
const visible = (sections: unknown): LooseSection[] =>
  Array.isArray(sections) ? (sections as LooseSection[]).filter((section) => section && section.visible !== false && !hiddenOnEveryScreen(section.style?.responsive)) : [];

export function pageDescriptionFrom(sections: unknown): string {
  for (const section of visible(sections)) {
    const s = section.settings ?? {};
    const text = usable(s.body) || usable(s.subheadline) || usable(s.description);
    if (text.length >= 30) return shorten(text, DESCRIPTION_MAX);
  }
  return "";
}

/** The first picture on the page, for sharing. */
export function pageImageFrom(sections: unknown): string {
  for (const section of visible(sections)) {
    const url = section.settings?.imageUrl;
    if (typeof url === "string" && url) return url;
  }
  return "";
}

export function suggestPageSeo(input: { title: string; isHome?: boolean; businessName: string; sections: unknown }): { seoTitle: string; seoDescription: string; seoImage: string } {
  const pageTitle = input.title.trim();
  return {
    seoTitle: shorten(input.isHome || !pageTitle ? input.businessName : `${pageTitle} | ${input.businessName}`, TITLE_MAX),
    seoDescription: pageDescriptionFrom(input.sections),
    seoImage: pageImageFrom(input.sections),
  };
}

/** Questions and answers in the page's visible FAQ sections, for structured data. */
export function pageFaqFrom(sections: unknown): Array<{ question: string; answer: string }> {
  const out: Array<{ question: string; answer: string }> = [];
  for (const section of visible(sections)) {
    if (section.type !== "faq" || !Array.isArray(section.settings?.items)) continue;
    for (const item of section.settings.items as Array<{ question?: unknown; answer?: unknown } | null>) {
      const question = usable(item?.question);
      const answer = usable(item?.answer);
      if (question && answer) out.push({ question, answer });
    }
  }
  return out;
}
