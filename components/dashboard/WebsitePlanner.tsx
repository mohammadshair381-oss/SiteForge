"use client";

import { formatValidationError } from "@/lib/validation-messages";
import { useEffect, useMemo, useState } from "react";
import {
  createDefaultSection,
  sectionSchema,
  SECTION_TYPES,
  SECTION_TYPE_LABELS,
  type SectionType,
} from "@/lib/sections";
import { THEME_IDS, type ThemeId } from "@/lib/constants";
import {
  MAX_WEBSITE_PLAN_PAGES,
  websitePlanSchema,
  type WebsitePlan,
} from "@/lib/ai-planning/plan";
import { Button, focusRing as focus } from "@/components/ui/Button";
import { Eyebrow, Notice, Pill } from "@/components/ui/Surface";
import { AiMark, AiPromises } from "./ai/AiShared";
import ManagementPageHeader from "./ManagementPageHeader";

interface BusinessDefaults {
  name: string;
  description: string;
  category: string;
  themeId: ThemeId;
  audience: string;
  designPreferences: WebsitePlan["designPreferences"];
}

interface ExistingPage {
  id: string;
  title: string;
  slug: string;
  status: "draft" | "published";
  version: number;
  isHome: boolean;
}

interface ProductOption {
  id: string;
  name: string;
}

interface PageBrief {
  title: string;
  slug: string;
  purpose: string;
  requiredContent: string;
}

const field = `mt-1 block min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 placeholder:text-slate-400 ${focus}`;
const panel = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6";
const quietLink = `rounded font-medium underline underline-offset-2 ${focus}`;
const textAction = `inline-flex min-h-10 items-center rounded-lg px-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-40 lg:min-h-8 ${focus}`;

function makeSlug(title: string, index: number) {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || (index === 0 ? "home" : `page-${index + 1}`);
}

function initialPageBrief(index: number): PageBrief {
  return {
    title: index === 0 ? "Home" : `Page ${index + 1}`,
    slug: index === 0 ? "home" : `page-${index + 1}`,
    purpose: "",
    requiredContent: "",
  };
}

export default function WebsitePlanner({
  businessId,
  business,
  existingPages,
  products,
  aiAvailable,
  aiNeedsConsent = false,
  aiUnavailableMessage = null,
}: {
  businessId: string;
  business: BusinessDefaults;
  existingPages: ExistingPage[];
  products: ProductOption[];
  /** Whether AI requests can be made: provider on and configured, and the owner consented (server-decided). */
  aiAvailable: boolean;
  /** The provider is on but this store's owner has not turned on AI suggestions. */
  aiNeedsConsent?: boolean;
  /** Why AI planning cannot be used now, in plain words (server-decided). */
  aiUnavailableMessage?: string | null;
}) {
  const [businessSummary, setBusinessSummary] = useState(business.description);
  const [targetAudience, setTargetAudience] = useState(business.audience);
  const [requestedPageCount, setRequestedPageCount] = useState(1);
  const [pageBriefs, setPageBriefs] = useState<PageBrief[]>([initialPageBrief(0)]);
  const [preferredTheme, setPreferredTheme] = useState<ThemeId>(business.themeId);
  const [designNotes, setDesignNotes] = useState(business.designPreferences.notes);
  const [primaryColor, setPrimaryColor] = useState(
    business.designPreferences.primaryColor ?? "#4f46e5",
  );
  const [accentColor, setAccentColor] = useState(
    business.designPreferences.accentColor ?? "#0ea5e9",
  );
  const [specialRequirements, setSpecialRequirements] = useState("");
  const [productIds, setProductIds] = useState<string[]>([]);
  const [plan, setPlan] = useState<WebsitePlan | null>(null);
  // Every plan reaches drafts through a reviewed change proposal (AGENTS.md).
  const [planSource, setPlanSource] = useState<"manual" | "ai">("manual");
  const [settingsText, setSettingsText] = useState<Record<string, string>>({});
  const [validationMessage, setValidationMessage] = useState("");
  const [isValidating, setIsValidating] = useState(false);
  const [isHandingOver, setIsHandingOver] = useState(false);
  const [isSavingProposal, setIsSavingProposal] = useState(false);
  const [savedProposalId, setSavedProposalId] = useState<string | null>(null);

  function markBriefChanged() {
    setPlan(null);
    setValidationMessage("");
  }

  const pageCountOptions = useMemo(
    () => Array.from({ length: MAX_WEBSITE_PLAN_PAGES }, (_, index) => index + 1),
    [],
  );

  useEffect(() => {
    if (!plan) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [plan]);

  function changePageCount(count: number) {
    setRequestedPageCount(count);
    setPageBriefs((current) =>
      Array.from({ length: count }, (_, index) => current[index] ?? initialPageBrief(index)),
    );
    setPlan(null);
    setValidationMessage("");
  }

  function updateBrief(index: number, key: keyof PageBrief, value: string) {
    setPageBriefs((current) =>
      current.map((page, pageIndex) => {
        if (pageIndex !== index) return page;
        const updated = { ...page, [key]: value };
        if (key === "title") updated.slug = makeSlug(value, index);
        return updated;
      }),
    );
    setPlan(null);
    setValidationMessage("");
  }

  /**
   * Hands this brief to the AI Builder, the one place whole websites are generated. It only records what
   * the owner wrote: nothing is sent to a provider until they ask there, so it works with AI off too.
   */
  async function continueInAiBuilder() {
    if (!businessSummary.trim()) {
      setValidationMessage("Describe your business first, so the AI Builder has something to start from.");
      return;
    }
    setIsHandingOver(true);
    setValidationMessage("");
    try {
      const pagesText = pageBriefs.map((brief) => `${brief.title}: ${brief.purpose}${brief.requiredContent ? ` (${brief.requiredContent})` : ""}`).join("\n");
      const response = await fetch(`/api/businesses/${businessId}/ai/website`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: {
            offerings: businessSummary.trim().slice(0, 800),
            audience: targetAudience.trim().slice(0, 500),
            pages: pageBriefs.map((brief) => brief.title.trim().slice(0, 80)).filter(Boolean).slice(0, 20),
            design: designNotes.trim().slice(0, 500),
            special: specialRequirements.trim().slice(0, 800),
          },
          message: `Here is the plan for my website.\n${businessSummary.trim()}\nFor: ${targetAudience.trim()}\nPages:\n${pagesText}\n${specialRequirements.trim()}`.slice(0, 2000),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Your plan could not be handed over.");
      window.location.href = `/dashboard/businesses/${businessId}/ai-builder?area=website`;
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Your plan could not be handed over.");
      setIsHandingOver(false);
    }
  }

  function prepareManualDraft() {
    const unansweredQuestions = [
      !businessSummary.trim() ? "What does the business offer and what should the site communicate?" : "",
      !targetAudience.trim() ? "Who is the primary target audience?" : "",
      ...pageBriefs.flatMap((page) => [
        !page.purpose.trim() ? `What is the purpose of the "${page.title}" page?` : "",
        !page.requiredContent.trim() ? `What required content belongs on the "${page.title}" page?` : "",
      ]),
    ].filter(Boolean);
    const result = websitePlanSchema.safeParse({
      businessSummary: businessSummary.trim() || "Business overview to be added by the owner.",
      targetAudience: targetAudience.trim() || "Target audience to be confirmed by the owner.",
      recommendedTheme: preferredTheme,
      requestedPageCount,
      designPreferences: {
        notes: designNotes,
        primaryColor,
        accentColor,
      },
      specialRequirements,
      productIds,
      pages: pageBriefs.map((brief, index) => ({
        title: brief.title,
        slug: brief.slug,
        purpose: brief.purpose.trim() || "Purpose to be confirmed by the owner.",
        proposedContent: brief.requiredContent,
        isHome: index === 0,
        sections: [
          createDefaultSection(index === 0 ? "hero" : "about", 0),
        ],
      })),
      navigation: pageBriefs.map((page) => ({
        pageSlug: page.slug,
        label: page.title,
      })),
      assumptions: [],
      unansweredQuestions,
      summary: "Owner-created manual draft. Missing details are flagged for the owner; no AI-generated content is included.",
    });
    if (!result.success) {
      setValidationMessage(formatValidationError(result.error).message);
      setPlan(null);
      return;
    }
    setPlan(result.data);
    setPlanSource("manual");
    setSettingsText({});
    setValidationMessage("Manual draft prepared. Review and edit the pages and sections below.");
  }

  function updatePlanPage(index: number, changes: Partial<WebsitePlan["pages"][number]>) {
    setPlan((current) =>
      current
        ? {
            ...current,
            pages: current.pages.map((page, pageIndex) =>
              pageIndex === index ? { ...page, ...changes } : page,
            ),
            navigation: current.navigation.map((item) => {
              const page = current.pages[index];
              return page && item.pageSlug === page.slug
                ? { ...item, pageSlug: changes.slug ?? item.pageSlug, label: changes.title ?? item.label }
                : item;
            }),
          }
        : current,
    );
    setValidationMessage("");
  }

  function removePlanPage(index: number) {
    setPlan((current) => {
      if (!current || current.pages.length <= 1) return current;
      const pages = current.pages.filter((_, pageIndex) => pageIndex !== index);
      const removedSlug = current.pages[index]?.slug;
      const homeExists = pages.some((page) => page.isHome);
      if (!homeExists && pages[0]) pages[0] = { ...pages[0], isHome: true };
      return {
        ...current,
        requestedPageCount: pages.length,
        pages: pages.map((page, order) => ({
          ...page,
          sections: page.sections.map((section, sectionOrder) => ({ ...section, order: sectionOrder })),
        })),
        navigation: current.navigation.filter((item) => item.pageSlug !== removedSlug),
      };
    });
    setValidationMessage("");
  }

  function addPlanPage() {
    setPlan((current) => {
      if (!current || current.pages.length >= MAX_WEBSITE_PLAN_PAGES) return current;
      const index = current.pages.length;
      const brief = initialPageBrief(index);
      return {
        ...current,
        requestedPageCount: index + 1,
        pages: [
          ...current.pages,
          {
            ...brief,
            purpose: "",
            proposedContent: "",
            isHome: false,
            sections: [createDefaultSection("about", 0)],
          },
        ],
        navigation: [...current.navigation, { pageSlug: brief.slug, label: brief.title }],
      };
    });
    setValidationMessage("");
  }

  function addSection(pageIndex: number, type: SectionType) {
    setPlan((current) => {
      if (!current) return current;
      const page = current.pages[pageIndex];
      if (!page || page.sections.length >= 50) return current;
      return {
        ...current,
        pages: current.pages.map((item, index) =>
          index === pageIndex
            ? { ...item, sections: [...item.sections, createDefaultSection(type, item.sections.length)] }
            : item,
        ),
      };
    });
    setValidationMessage("");
  }

  function removeSection(pageIndex: number, sectionId: string) {
    setPlan((current) =>
      current
        ? {
            ...current,
            pages: current.pages.map((page, index) =>
              index === pageIndex
                ? {
                    ...page,
                    sections: page.sections
                      .filter((section) => section.id !== sectionId)
                      .map((section, order) => ({ ...section, order })),
                  }
                : page,
            ),
          }
        : current,
    );
    setValidationMessage("");
  }

  function moveSection(pageIndex: number, sectionId: string, direction: -1 | 1) {
    setPlan((current) => {
      if (!current) return current;
      const page = current.pages[pageIndex];
      if (!page) return current;
      const from = page.sections.findIndex((section) => section.id === sectionId);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= page.sections.length) return current;
      const sections = [...page.sections];
      [sections[from], sections[to]] = [sections[to], sections[from]];
      return {
        ...current,
        pages: current.pages.map((item, index) =>
          index === pageIndex
            ? { ...item, sections: sections.map((section, order) => ({ ...section, order })) }
            : item,
        ),
      };
    });
    setValidationMessage("");
  }

  function updateSectionSettings(pageIndex: number, sectionId: string, text: string) {
    setSettingsText((current) => ({ ...current, [sectionId]: text }));
    try {
      const settings: unknown = JSON.parse(text);
      const section = plan?.pages[pageIndex]?.sections.find((item) => item.id === sectionId);
      if (!section) return;
      const updatedSection = sectionSchema.parse({ ...section, settings });
      setPlan((current) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page, index) =>
                index === pageIndex
                  ? {
                      ...page,
                      sections: page.sections.map((section) =>
                        section.id === sectionId ? updatedSection : section,
                      ),
                    }
                  : page,
              ),
            }
          : current,
      );
      setValidationMessage("");
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Invalid section settings.");
    }
  }

  async function validatePlan() {
    if (!plan) return;
    let validatedPlan: WebsitePlan;
    try {
      const candidate = {
        ...plan,
        pages: plan.pages.map((page) => ({
          ...page,
          sections: page.sections.map((section) => {
            const text = settingsText[section.id];
            if (text === undefined) return section;
            const settings: unknown = JSON.parse(text);
            return sectionSchema.parse({ ...section, settings });
          }),
        })),
      };
      validatedPlan = websitePlanSchema.parse(candidate);
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Invalid section settings.");
      return;
    }
    setIsValidating(true);
    setValidationMessage("Validating the current plan…");
    try {
      const response = await fetch(`/api/businesses/${businessId}/planning/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validatedPlan),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to validate plan.");
      setPlan(validatedPlan);
      setValidationMessage(
        "Plan validated. Review it, then save it as a change proposal to approve and apply.",
      );
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : "Unable to validate plan.");
    } finally {
      setIsValidating(false);
    }
  }

  /**
   * Saves the validated plan as a change proposal (new draft pages only) for
   * review on the Change proposals page. Nothing is applied or published.
   */
  async function savePlanAsProposal() {
    if (!plan || !validationMessage.startsWith("Plan validated") || isSavingProposal) return;
    setIsSavingProposal(true);
    setSavedProposalId(null);
    try {
      const response = await fetch(`/api/businesses/${businessId}/proposals/from-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Unable to save the proposal.");
      setSavedProposalId(String(body.proposal?.id ?? ""));
      const aiPages = Number(body.provenance?.aiPages ?? 0);
      setValidationMessage(`Plan validated and saved as a change proposal. Review and apply it from Change proposals.${aiPages > 0 ? ` ${aiPages} ${aiPages === 1 ? "page is" : "pages are"} marked as AI-written.` : ""}`);
    } catch (error) {
      setValidationMessage(`Plan validated. ${error instanceof Error ? error.message : "Unable to save the proposal."}`);
    } finally {
      setIsSavingProposal(false);
    }
  }

  function rejectPlan() {
    setPlan(null);
    setValidationMessage("Draft discarded. No website content was changed.");
  }

  return (
    <>
    <a
      href="#planner-main"
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:font-semibold focus:text-slate-900"
    >
      Skip to planning form
    </a>
    <div id="planner-main" className="space-y-6">
      <ManagementPageHeader
        title="Website planner"
        description={`Plan ${business.name}'s website before anything changes. Validation does not change your site; applying is a separate action that adds new draft pages only.`}
      />

      <section
        aria-labelledby="provider-status"
        className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <AiMark />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="provider-status" className="text-sm font-semibold text-slate-900">
              Plan by hand here, or let the AI Builder write it
            </h2>
            <Pill tone={aiAvailable ? "success" : aiNeedsConsent ? "warning" : "neutral"} dot>{aiAvailable ? "AI is on" : aiNeedsConsent ? "AI not turned on" : "AI is off"}</Pill>
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            {aiAvailable
              ? "This planner lays out new draft pages by hand, with no AI. To have a whole website written, with its homepage, design and menus, take your brief to the AI Builder."
              : aiNeedsConsent
                ? "This planner lays out new draft pages by hand, with no AI. The store owner can turn on AI suggestions in Business settings, and the AI Builder can then write a whole website from your brief."
                : `This planner lays out new draft pages by hand, with no AI. ${aiUnavailableMessage ?? "AI suggestions are not available right now."}`}
          </p>
          <AiPromises className="mt-2" />
        </div>
      </section>

      <section className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className={`min-w-0 space-y-5 ${panel}`}>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Your brief</h2>
            <p className="mt-1 text-sm text-slate-600">
              Share what visitors should understand and what each page needs to do.
            </p>
          </div>
          <label className="block text-sm font-medium text-slate-800">
            Business and website requirements
            <textarea
              className={field}
              rows={4}
              maxLength={2000}
              value={businessSummary}
              onChange={(event) => {
                setBusinessSummary(event.target.value);
                markBriefChanged();
              }}
              placeholder="Describe your business, what makes it distinct, and what visitors should be able to do."
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-800">
              Target audience
              <textarea
                className={field}
                rows={3}
                maxLength={500}
                value={targetAudience}
                onChange={(event) => {
                  setTargetAudience(event.target.value);
                  markBriefChanged();
                }}
                placeholder="Who is this website for?"
              />
            </label>
            <label className="block text-sm font-medium text-slate-800">
              Number of pages
              <select
                className={field}
                value={requestedPageCount}
                onChange={(event) => changePageCount(Number(event.target.value))}
              >
                {pageCountOptions.map((count) => (
                  <option key={count} value={count}>
                    {count} {count === 1 ? "page" : "pages"}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-slate-500">
                Plan contract maximum: {MAX_WEBSITE_PLAN_PAGES}. This is not a subscription limit.
              </span>
            </label>
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Page purpose and required content</h3>
            {pageBriefs.map((page, index) => (
              <fieldset key={index} className="grid min-w-0 gap-3 rounded-xl border border-slate-200 p-4 sm:grid-cols-2">
                <legend className="px-1 text-sm font-medium text-slate-800">
                  {index === 0 ? "Homepage" : `Page ${index + 1}`}
                </legend>
                <label className="block text-xs font-medium text-slate-600">
                  Page title
                  <input
                    className={field}
                    value={page.title}
                    maxLength={140}
                    onChange={(event) => updateBrief(index, "title", event.target.value)}
                  />
                </label>
                <label className="block text-xs font-medium text-slate-600">
                  Web address
                  <input
                    className={field}
                    value={page.slug}
                    maxLength={80}
                    onChange={(event) => updateBrief(index, "slug", event.target.value)}
                  />
                </label>
                <label className="block text-xs font-medium text-slate-600 sm:col-span-2">
                  Purpose
                  <textarea
                    className={field}
                    rows={2}
                    maxLength={600}
                    value={page.purpose}
                    onChange={(event) => updateBrief(index, "purpose", event.target.value)}
                    placeholder="What should this page help visitors understand or do?"
                  />
                </label>
                <label className="block text-xs font-medium text-slate-600 sm:col-span-2">
                  Required content
                  <textarea
                    className={field}
                    rows={2}
                    maxLength={4000}
                    value={page.requiredContent}
                    onChange={(event) => updateBrief(index, "requiredContent", event.target.value)}
                    placeholder="List content, sections, or details that must appear."
                  />
                </label>
              </fieldset>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-800">
              Preferred theme
              <select
                className={field}
                value={preferredTheme}
                onChange={(event) => {
                  setPreferredTheme(event.target.value as ThemeId);
                  markBriefChanged();
                }}
              >
                {THEME_IDS.map((theme) => (
                  <option key={theme} value={theme}>
                    {theme[0].toUpperCase() + theme.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-slate-800">
              Design preferences
              <input
                className={field}
                maxLength={1000}
                value={designNotes}
                onChange={(event) => {
                  setDesignNotes(event.target.value);
                  markBriefChanged();
                }}
                placeholder="Mood, layout, typography, or inspiration"
              />
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-800">
              Primary color
              <input
                className={`mt-1 block h-10 w-full cursor-pointer rounded-lg border border-slate-300 bg-white p-1 ${focus}`}
                type="color"
                value={primaryColor}
                onChange={(event) => {
                  setPrimaryColor(event.target.value);
                  markBriefChanged();
                }}
              />
            </label>
            <label className="block text-sm font-medium text-slate-800">
              Accent color
              <input
                className={`mt-1 block h-10 w-full cursor-pointer rounded-lg border border-slate-300 bg-white p-1 ${focus}`}
                type="color"
                value={accentColor}
                onChange={(event) => {
                  setAccentColor(event.target.value);
                  markBriefChanged();
                }}
              />
            </label>
          </div>
          {products.length > 0 && (
            <fieldset>
              <legend className="text-sm font-medium text-slate-800">Products to consider</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {products.map((product) => (
                  <label
                    key={product.id}
                    className="inline-flex min-h-10 items-center gap-2 rounded-full border border-slate-200 px-3 py-1.5 text-sm text-slate-800"
                  >
                    <input
                      name={`product-${product.id}`}
                      type="checkbox"
                      className={focus}
                      checked={productIds.includes(product.id)}
                      onChange={(event) =>
                        {
                          setProductIds((current) =>
                            event.target.checked
                              ? [...current, product.id]
                              : current.filter((id) => id !== product.id),
                          );
                          markBriefChanged();
                        }
                      }
                    />
                    {product.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <label className="block text-sm font-medium text-slate-800">
            Special requirements
            <textarea
              className={field}
              rows={3}
              maxLength={2000}
              value={specialRequirements}
              onChange={(event) => {
                setSpecialRequirements(event.target.value);
                markBriefChanged();
              }}
              placeholder="Accessibility, language, compliance, or other constraints"
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <Button onClick={prepareManualDraft}>
              Prepare manual review draft
            </Button>
            <Button
              variant="secondary"
              onClick={() => void continueInAiBuilder()}
              disabled={isHandingOver}
            >
              {isHandingOver ? "Taking your brief across…" : "Continue in the AI Builder"}
            </Button>
          </div>
        </div>

        <aside className="h-fit min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5">
          <p className="text-sm font-semibold text-slate-900">Planning rules</p>
          <ul className="mt-3 space-y-2.5 text-sm leading-6 text-slate-700">
            <li>All {THEME_IDS.length} SiteForge themes can be chosen in a plan.</li>
            <li>Page and section settings are checked before anything is saved.</li>
            <li>Only active products from this business can be referenced.</li>
            <li>Existing content and published snapshots remain untouched.</li>
            <li>Applying adds new draft pages only; nothing is published.</li>
            <li>Plans change draft pages only through a change proposal you review and approve.</li>
          </ul>
        </aside>
      </section>

      {validationMessage && (
        <p role="status" aria-live="polite" className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800">
          {validationMessage}
        </p>
      )}

      {plan && (
        <section aria-labelledby="plan-review" className={`space-y-5 ${panel}`}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <Eyebrow>Review draft</Eyebrow>
              <h2 id="plan-review" className="mt-1 text-lg font-semibold text-slate-900">Proposed website outline</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {planSource === "ai"
                  ? "Generated by an AI provider from your brief. Review every page and section before saving it as a proposal."
                  : "Manually prepared from your brief. No generated content or website changes are implied."}
              </p>
            </div>
            <Pill>
              {plan.recommendedTheme} · {plan.pages.length} {plan.pages.length === 1 ? "page" : "pages"}
            </Pill>
          </div>
          <label className="block text-sm font-medium text-slate-800">
            Plan summary
            <textarea
              className={field}
              rows={2}
              maxLength={2000}
              value={plan.summary}
              onChange={(event) => {
                setPlan({ ...plan, summary: event.target.value });
                setValidationMessage("");
              }}
            />
          </label>
          <div className="space-y-4">
            {plan.unansweredQuestions.length > 0 && (
              <Notice tone="warning" title="Details to clarify">
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {plan.unansweredQuestions.map((question) => <li key={question}>{question}</li>)}
                </ul>
              </Notice>
            )}
            {plan.pages.map((page, pageIndex) => (
              <article key={`${page.slug}-${pageIndex}`} className="rounded-xl border border-slate-200 p-4 sm:p-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm font-medium text-slate-800">
                    Page title
                    <input className={field} value={page.title} onChange={(event) => updatePlanPage(pageIndex, { title: event.target.value })} />
                  </label>
                  <label className="block text-sm font-medium text-slate-800">
                    Web address
                    <input className={field} value={page.slug} onChange={(event) => updatePlanPage(pageIndex, { slug: event.target.value })} />
                  </label>
                  <label className="block text-sm font-medium text-slate-800 sm:col-span-2">
                    Purpose
                    <textarea className={field} rows={2} value={page.purpose} onChange={(event) => updatePlanPage(pageIndex, { purpose: event.target.value })} />
                  </label>
                  <label className="block text-sm font-medium text-slate-800 sm:col-span-2">
                    Proposed content
                    <textarea className={field} rows={3} value={page.proposedContent} onChange={(event) => updatePlanPage(pageIndex, { proposedContent: event.target.value })} />
                  </label>
                  <label className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-slate-800">
                    <input
                      type="checkbox"
                      checked={page.isHome}
                      onChange={(event) => {
                        if (!event.target.checked) return;
                        setPlan((current) =>
                          current
                            ? {
                                ...current,
                                pages: current.pages.map((item, index) => ({ ...item, isHome: index === pageIndex })),
                              }
                            : current,
                        );
                        setValidationMessage("");
                      }}
                    />
                    Homepage
                  </label>
                </div>
                <div className="mt-4 space-y-3">
                  <h3 className="text-sm font-semibold text-slate-900">Sections</h3>
                  {page.sections.map((section) => (
                    <div key={section.id} className="rounded-xl bg-slate-50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-slate-900">
                          {section.order + 1}. {SECTION_TYPE_LABELS[section.type]} {section.visible ? "" : "(hidden)"}
                        </p>
                        <div className="flex flex-wrap items-center gap-1">
                          <button
                            type="button"
                            onClick={() => moveSection(pageIndex, section.id, -1)}
                            disabled={section.order === 0}
                            aria-label={`Move ${SECTION_TYPE_LABELS[section.type]} section up`}
                            className={textAction}
                          >
                            Move up
                          </button>
                          <button
                            type="button"
                            onClick={() => moveSection(pageIndex, section.id, 1)}
                            disabled={section.order === page.sections.length - 1}
                            aria-label={`Move ${SECTION_TYPE_LABELS[section.type]} section down`}
                            className={textAction}
                          >
                            Move down
                          </button>
                          <label className="inline-flex min-h-10 items-center gap-1.5 px-2 text-xs font-medium text-slate-700 lg:min-h-8">
                            <input
                              type="checkbox"
                              checked={section.visible}
                              onChange={(event) =>
                                {
                                  setPlan((current) =>
                                    current
                                      ? {
                                          ...current,
                                          pages: current.pages.map((item, index) =>
                                            index === pageIndex
                                              ? {
                                                  ...item,
                                                  sections: item.sections.map((value) =>
                                                    value.id === section.id
                                                      ? { ...value, visible: event.target.checked }
                                                      : value,
                                                  ),
                                                }
                                              : item,
                                          ),
                                        }
                                      : current,
                                  );
                                  setValidationMessage("");
                                }
                              }
                            />
                            Visible
                          </label>
                          <button type="button" onClick={() => removeSection(pageIndex, section.id)} className={`${textAction} !text-red-700 hover:!bg-red-50`}>
                            Remove section
                          </button>
                        </div>
                      </div>
                      <details className="mt-1">
                        <summary className={`min-h-10 cursor-pointer rounded py-1 text-xs font-medium text-slate-600 ${focus}`}>Advanced settings</summary>
                        <label className="mt-1 block text-xs font-medium text-slate-600">
                          Section settings (JSON)
                          <textarea
                            className={`${field} font-mono !text-xs`}
                            rows={3}
                            spellCheck={false}
                            value={settingsText[section.id] ?? JSON.stringify(section.settings, null, 2)}
                            onChange={(event) => updateSectionSettings(pageIndex, section.id, event.target.value)}
                          />
                        </label>
                      </details>
                    </div>
                  ))}
                  <label className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-800">
                    Add section
                    <select
                      className={`min-h-10 min-w-0 max-w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal ${focus}`}
                      value=""
                      onChange={(event) => {
                        if (event.target.value) addSection(pageIndex, event.target.value as SectionType);
                      }}
                    >
                      <option value="">Choose section type</option>
                      {SECTION_TYPES.map((type) => (
                        <option key={type} value={type}>{SECTION_TYPE_LABELS[type]}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {plan.pages.length > 1 && (
                  <button type="button" onClick={() => removePlanPage(pageIndex)} className={`${textAction} mt-3 !text-sm !text-red-700 hover:!bg-red-50`}>
                    Reject this page
                  </button>
                )}
              </article>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 rounded-xl bg-slate-50 p-3">
            <Button variant="secondary" onClick={addPlanPage} disabled={plan.pages.length >= MAX_WEBSITE_PLAN_PAGES}>
              Add page
            </Button>
            <Button variant="secondary" onClick={validatePlan} disabled={isValidating}>
              {isValidating ? "Validating…" : "Validate review draft"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void savePlanAsProposal()}
              disabled={!validationMessage.startsWith("Plan validated") || isSavingProposal}
            >
              {isSavingProposal ? "Saving proposal…" : "Save as proposal for review"}
            </Button>
            <Button variant="ghost" className="!text-red-700 hover:!bg-red-50 sm:ml-auto" onClick={rejectPlan}>
              Reject draft
            </Button>
          </div>
          {savedProposalId && (
            <Notice tone="success" role="status">
              Saved as a change proposal.{" "}
              <a className={quietLink} href={`/dashboard/businesses/${businessId}/proposals?proposal=${savedProposalId}`}>
                Review it in Change proposals
              </a>
            </Notice>
          )}
          <p className="text-xs leading-5 text-slate-500">
            Existing pages: {existingPages.length}. A plan adds new draft pages and leaves these as they are.
            Selected products: {plan.productIds.length}. Validation only reviews the plan; applying is a separate draft-only action.
          </p>
        </section>
      )}
    </div>
    </>
  );
}
