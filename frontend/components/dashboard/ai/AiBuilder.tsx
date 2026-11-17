"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AI_MODE_LABELS, AI_BUILDER_MODES, asksForWholeWebsite, classifyAiRequest, type AiBuilderMode } from "@/lib/ai-builder/intent";
import { SEO_LIMITS, type SeoTargetKind } from "@/lib/ai-builder/seo";
import type { ThemeRecommendation } from "@/lib/ai-builder/theme-advisor";
import AiConsentCard, { type AiConsentView } from "../AiConsentCard";
import AiProposalReview, { type AiPreviewData, type AiProposalDetail } from "./AiProposalReview";
import AiWebsiteBuilder from "./AiWebsiteBuilder";
import AiSeoResult, { type SeoResult } from "./AiSeoResult";
import AiProductResult, { type ProductResult } from "./AiProductResult";
import AiThemeResult from "./AiThemeResult";
import { AI_STATUS, AiMark, AiNotes, AiPromises, AiUsageMeter } from "./AiShared";
import { Button, buttonClass, focusRing as focus } from "@/components/ui/Button";
import { Notice, Pill, Skeleton } from "@/components/ui/Surface";
import { Icon } from "@/components/ui/Icon";

const input = `min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm ${focus}`;
const fieldLabel = "block text-xs font-medium text-slate-700";

export interface AiBuilderPage {
  id: string;
  title: string;
  slug: string;
  status: "draft" | "published";
  isHome: boolean;
}
export interface AiBuilderProduct {
  id: string;
  name: string;
  description: string;
  hasImage: boolean;
  seoTitle: string;
  seoDescription: string;
  imageAlt: string;
}
export interface AiBuilderCategory {
  id: string;
  name: string;
  slug: string;
  description: string;
  imageUrl: string;
  active: boolean;
  seoTitle: string;
  seoDescription: string;
}

interface HistoryItem {
  id: string;
  source: string;
  target: string;
  request: string;
  summary: string;
  status: string;
  createdAt: string;
}

/** Results that are not stored (nothing to review later): this session only. */
interface SessionItem {
  key: number;
  mode: AiBuilderMode;
  request: string;
  outcome: string;
}

type Result =
  | { kind: "proposal"; detail: AiProposalDetail; notes: string[] }
  | { kind: "message"; text: string; notes: string[] }
  | { kind: "seo"; seo: SeoResult }
  | { kind: "product"; product: ProductResult }
  | { kind: "theme"; summary: string | null; notes: string[]; recommendations: ThemeRecommendation[]; source: "ai" | "catalog" };

const SUGGESTED: Array<{ label: string; mode: AiBuilderMode; text: string }> = [
  { label: "Improve homepage", mode: "homepage", text: "Make my homepage look more premium and professional" },
  { label: "Create About page", mode: "page", text: "Create an About Us page for my business" },
  { label: "Create FAQ page", mode: "page", text: "Create an FAQ page for my store" },
  { label: "Build a section", mode: "section", text: "Add a category showcase section" },
  { label: "Improve SEO", mode: "seo", text: "Write a clear search title and description" },
  { label: "Improve product descriptions", mode: "product", text: "Write a professional description for this product" },
  { label: "Recommend a theme", mode: "theme", text: "Which theme is best for my business?" },
];

const PRODUCT_MODES: Array<{ value: string; label: string }> = [
  { value: "improve", label: "Improve the description" },
  { value: "long", label: "Longer description" },
  { value: "short", label: "Shorter description" },
  { value: "premium", label: "More premium tone" },
  { value: "professional", label: "More professional tone" },
  { value: "highlights", label: "Highlights and features" },
  { value: "seo", label: "SEO title and description" },
  { value: "grammar", label: "Fix grammar and spelling" },
];

/**
 * The AI Builder: the owner describes what they want in ordinary words. The
 * request is classified on the device (shown as "Understood as", and the owner
 * can correct it), then goes to ONE structured task on the server. Homepage,
 * section and page requests come back as change proposals (preview, approve,
 * apply to draft; publishing stays separate). SEO and product text come back
 * as editable suggestions that are saved only when the owner saves them.
 * Theme advice names what the plan allows; applying uses the normal theme
 * change. With AI off or no consent, nothing is sent anywhere.
 *
 * `lockedPage` narrows it to one page inside the section editor.
 */
export default function AiBuilder({
  businessId,
  available,
  consentView,
  usage,
  planName,
  isOwner,
  pages,
  products,
  categories,
  lockedPage = null,
  initialArea,
  dirty = false,
  previewData = null,
  onApplied,
}: {
  businessId: string;
  /** The platform's AI switch and provider are on. */
  available: boolean;
  consentView: AiConsentView;
  usage: { used: number; limit: number; remaining: number } | null;
  planName: string;
  isOwner: boolean;
  pages: AiBuilderPage[];
  products: AiBuilderProduct[];
  categories: AiBuilderCategory[];
  lockedPage?: AiBuilderPage | null;
  /** Which part opens first. */
  initialArea?: "website" | "single";
  /** The editor has unsaved changes: applying is held back. */
  dirty?: boolean;
  /** The store's draft data, for previewing proposals with the real renderer. */
  previewData?: AiPreviewData | null;
  onApplied?: () => void;
}) {
  const textId = useId();
  const hintId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [override, setOverride] = useState<AiBuilderMode | null>(lockedPage ? "page" : null);
  const [pageTarget, setPageTarget] = useState(lockedPage?.id ?? "");
  const [sectionTarget, setSectionTarget] = useState("home");
  const [seoKind, setSeoKind] = useState<SeoTargetKind>("page");
  const [seoTarget, setSeoTarget] = useState("");
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [productMode, setProductMode] = useState("improve");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [lastRequest, setLastRequest] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [session, setSession] = useState<SessionItem[]>([]);
  const [counts, setCounts] = useState(usage);
  const sessionKey = useRef(0);
  const [area, setArea] = useState<"website" | "single">(initialArea ?? (pages.length === 0 ? "website" : "single"));
  /** A request for a whole website typed in "One change", handed to the website builder. */
  const [handoff, setHandoff] = useState<{ text: string; key: number } | null>(null);

  const blockedMessage = consentView.blockedMessage ?? null;
  const ready = available && consentView.consent.granted && !blockedMessage;
  const intent = useMemo(() => classifyAiRequest(text, { pageSelected: Boolean(lockedPage) }), [text, lockedPage]);
  // Decided by keywords, never by the AI: "create a website for my bakery" means every page, not one change.
  const wholeWebsite = !lockedPage && !override && asksForWholeWebsite(text);
  const mode: AiBuilderMode = lockedPage ? "page" : (override ?? (text.trim().length >= 3 ? intent.mode : "homepage"));
  const contentPages = pages.filter((p) => !p.isHome);
  const selectedPage = contentPages.find((p) => p.id === (mode === "section" ? sectionTarget : pageTarget));
  const seoOptions = seoKind === "page" ? pages.map((p) => ({ id: p.id, name: p.isHome ? "Homepage" : p.title })) : seoKind === "product" ? products.map((p) => ({ id: p.id, name: p.name })) : categories.map((c) => ({ id: c.id, name: c.name }));
  const exhausted = counts ? counts.remaining <= 0 : false;
  // A section request about a content page is a page request on the server.
  const serverTask = mode === "seo" ? "seo" : mode === "theme" ? "theme" : mode === "product" ? "product" : mode === "page" || selectedPage ? "page" : "storefront";
  const taskUnavailable = consentView.tasks?.[serverTask] === false;

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/businesses/${businessId}/proposals`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setHistory((data.proposals as HistoryItem[]).filter((p) => p.source === "ai"));
      else setHistory([]);
    } catch {
      setHistory([]);
    }
  }, [businessId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  /** The server's count (only requests that reached the provider are charged). */
  async function refreshUsage() {
    try {
      const res = await fetch(`/api/businesses/${businessId}/ai/consent`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok && data.usage) setCounts(data.usage);
    } catch {
      // Keep the last known count.
    }
  }

  const remember = (request: string, outcome: string) => {
    sessionKey.current += 1;
    setSession((items) => [{ key: sessionKey.current, mode, request, outcome }, ...items].slice(0, 10));
  };

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`/api/businesses/${businessId}/ai/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "The assistant could not make a suggestion.");
    return data;
  };

  async function openProposal(id: string, notes: string[] = []) {
    setError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/proposals/${id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "This suggestion could not be opened.");
      setResult({ kind: "proposal", detail: data.proposal, notes });
    } catch (err) {
      setError(err instanceof Error ? err.message : "This suggestion could not be opened.");
    }
  }

  async function send(requestText: string) {
    const request = requestText.trim();
    if (!lockedPage && !override && asksForWholeWebsite(request)) {
      setError(null);
      setResult(null);
      setText("");
      setHandoff({ text: request, key: Date.now() });
      setArea("website");
      return;
    }
    if (request.length < 3 && mode !== "seo" && mode !== "product") return;
    setBusy(true);
    setError(null);
    setResult(null);
    setLastRequest(request);
    try {
      if (mode === "homepage" || (mode === "section" && !selectedPage)) {
        const data = await post("storefront", { instruction: request });
        if (data.proposal) {
          setResult({ kind: "proposal", detail: data.proposal, notes: data.notes ?? [] });
          await loadHistory();
        } else setResult({ kind: "message", text: data.message || "The assistant had no changes to suggest.", notes: data.notes ?? [] });
      } else if (mode === "page" || mode === "section") {
        const data = await post("page", { instruction: request, ...(selectedPage ? { pageId: selectedPage.id, ...(selectedPage.status === "published" ? { asNewDraft: true } : {}) } : {}) });
        if (data.proposal) {
          setResult({ kind: "proposal", detail: data.proposal, notes: data.notes ?? [] });
          await loadHistory();
        } else setResult({ kind: "message", text: data.message || "The assistant had no changes to suggest.", notes: data.notes ?? [] });
      } else if (mode === "seo") {
        if (!seoTarget) throw new Error("Choose what to write search text for.");
        const data = await post("seo", { kind: seoKind, targetId: seoTarget, instruction: request });
        setResult({ kind: "seo", seo: { kind: seoKind, targetId: seoTarget, targetName: seoOptions.find((o) => o.id === seoTarget)?.name ?? "", current: data.current, suggestion: data.suggestion, summary: data.summary, notes: data.notes ?? [] } });
        remember(request || "Search text", "Suggestion shown");
      } else if (mode === "product") {
        if (!productId) throw new Error("Choose a product.");
        const data = await post("product-copy", { productId, instruction: request, mode: productMode });
        const product = products.find((p) => p.id === productId);
        setResult({ kind: "product", product: { productId, productName: product?.name ?? "", currentDescription: product?.description ?? "", suggestion: data.suggestion, missing: data.missing ?? [] } });
        remember(request || PRODUCT_MODES.find((m) => m.value === productMode)?.label || "Product text", "Suggestion shown");
      } else {
        const data = await post("theme", { instruction: request });
        setResult({ kind: "theme", summary: data.summary, notes: data.notes ?? [], recommendations: data.recommendations, source: "ai" });
        remember(request, "Advice shown");
      }
      void refreshUsage();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error. Nothing was sent.");
      void refreshUsage();
    } finally {
      setBusy(false);
    }
  }

  /** Recommendations without AI: from the business type, nothing is sent. */
  async function catalogThemes() {
    setError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/ai/theme`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Recommendations could not be loaded.");
      setResult({ kind: "theme", summary: null, notes: [], recommendations: data.recommendations, source: "catalog" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recommendations could not be loaded.");
    }
  }

  const editRequest = () => {
    if (lastRequest) setText(lastRequest);
    textRef.current?.focus();
  };

  const needsWords = mode !== "seo" && mode !== "product";
  const canSend = ready && !busy && !exhausted && (!needsWords || text.trim().length >= 3) && (mode !== "seo" || Boolean(seoTarget)) && (mode !== "product" || Boolean(productId));

  /** Why the send button is not available right now, in plain words. */
  const blockedReason = busy
    ? null
    : !available
      ? "AI is switched off on this platform, so requests cannot be sent."
      : blockedMessage
        ? blockedMessage
      : taskUnavailable
        ? "This kind of AI suggestion is not available right now."
      : !consentView.consent.granted
        ? "AI suggestions need to be turned on for this store first."
        : exhausted
          ? "No AI requests left this month."
          : needsWords && text.trim().length < 3
            ? "Write a few words about what you want."
            : mode === "seo" && !seoTarget
              ? "Choose what to write search text for."
              : mode === "product" && !productId
                ? "Choose a product."
                : null;

  const notices = (
    <>
      {available && blockedMessage && (
        <Notice tone="warning" role="status">{blockedMessage}</Notice>
      )}
      {available && !blockedMessage && !consentView.consent.granted && (
        <div className={lockedPage ? "rounded-xl border border-slate-200 p-3" : "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"}>
          <p className="mb-3 text-sm text-slate-700">
            <span className="font-semibold text-slate-900">One step before you can ask.</span> AI suggestions are ready on SiteForge, but they stay off for your store until the store owner has read this and turned them on.
          </p>
          <AiConsentCard businessId={businessId} view={consentView} compact />
        </div>
      )}
      {!available && (
        <div role="note" className={lockedPage ? "rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700" : "rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm sm:p-5"}>
          <div className="flex items-start gap-3">
            <AiMark />
            <div className="min-w-0">
              <p className="font-semibold text-slate-900">AI suggestions are not available on this platform right now.</p>
              <p className="mt-1 leading-6">
                There is nothing you need to do, and nothing is sent to an AI provider until they are back. You can still make every change yourself, and theme recommendations from the catalogue work without AI.
              </p>
              {!lockedPage && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <a href={`/dashboard/businesses/${businessId}/editor`} className={buttonClass({ variant: "secondary" })}>Open the website editor</a>
                  <button type="button" onClick={() => void catalogThemes()} className={buttonClass({ variant: "secondary" })}>See theme recommendations</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {ready && exhausted && (
        <div role="note">
          <Notice tone="warning" title={counts && counts.limit > 0 ? "You have used this month's AI requests." : "Your plan does not include AI requests."}>
            <p className="text-xs leading-5">
              {counts && counts.limit > 0 ? "They renew on the 1st. " : ""}
              {isOwner ? (
                <a href={`/dashboard/businesses/${businessId}/billing`} className={`rounded font-medium underline underline-offset-2 ${focus}`}>Compare plans</a>
              ) : (
                "Ask the store owner about a plan with more requests."
              )}
            </p>
          </Notice>
        </div>
      )}
    </>
  );

  const composer = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) void send(text);
      }}
      className={lockedPage ? "space-y-3" : "space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"}
    >
      <div>
        <label htmlFor={textId} className={lockedPage ? "block text-sm font-semibold text-slate-900" : "block font-heading text-lg font-semibold tracking-tight text-slate-900 sm:text-xl"}>
          {lockedPage ? "What should change on this page?" : "Describe what you want"}
        </label>
        <textarea
          ref={textRef}
          id={textId}
          rows={lockedPage ? 3 : 4}
          maxLength={500}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-describedby={hintId}
          placeholder={lockedPage ? "For example: make this page shorter and add a short FAQ" : "For example: redesign my homepage for a luxury clothing brand"}
          className={`mt-2 ${input} !text-base sm:!text-sm`}
        />
        <p id={hintId} className="mt-1.5 text-xs leading-5 text-slate-500">
          Written by {consentView.provider.name} from your store&apos;s own content, never customer, order or payment data. You review every change before it is used.
        </p>
      </div>

      {!lockedPage && (
        <div>
          <p id={`${textId}-suggested`} className="text-xs font-medium text-slate-500">Suggested actions</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-labelledby={`${textId}-suggested`}>
            {SUGGESTED.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  setText(item.text);
                  setOverride(item.mode);
                  setError(null);
                  if (item.mode === "theme" && !ready) void catalogThemes();
                  textRef.current?.focus();
                }}
                className={`min-h-10 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50 ${focus}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!lockedPage && (
        <div className="rounded-xl bg-slate-50 p-3">
          <p className="text-sm text-slate-700" data-ai-understood="">
            {wholeWebsite ? <>Here is what I understood: <span className="font-semibold text-[#b23a12]">Your whole website, with all its pages</span></> : text.trim().length >= 3 && !override ? <>Here is what I understood: <span className="font-semibold text-[#b23a12]">{intent.label}</span></> : override ? <>Working on: <span className="font-semibold text-[#b23a12]">{AI_MODE_LABELS[override]}</span></> : "Choose what to work on, or just describe it."}
          </p>
          <div role="group" aria-label="What to work on" className="mt-2 flex flex-wrap gap-1">
            {AI_BUILDER_MODES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={!wholeWebsite && mode === value}
                onClick={() => {
                  setOverride(value);
                  if (value === "theme" && !ready) void catalogThemes();
                }}
                className={`min-h-10 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors lg:min-h-8 ${focus} ${!wholeWebsite && mode === value ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-400 hover:text-slate-900"}`}
              >
                {AI_MODE_LABELS[value]}
              </button>
            ))}
          </div>
        </div>
      )}

      {!lockedPage && mode === "page" && (
        <label className={fieldLabel}>
          Page
          <select value={pageTarget} onChange={(e) => setPageTarget(e.target.value)} className={`mt-1 ${input}`}>
            <option value="">Create a new page</option>
            {contentPages.map((p) => (
              <option key={p.id} value={p.id}>
                Change: {p.title}{p.status === "draft" ? " (draft)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {!lockedPage && mode === "section" && (
        <label className={fieldLabel}>
          Where
          <select value={sectionTarget} onChange={(e) => setSectionTarget(e.target.value)} className={`mt-1 ${input}`}>
            <option value="home">Homepage</option>
            {contentPages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}{p.status === "draft" ? " (draft)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {(mode === "page" || mode === "section") && selectedPage?.status === "published" && (
        <p role="note" className="rounded-lg bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-900">
          “{selectedPage.title}” is live, so it stays as it is. The improved version becomes a new draft page you can review, then use to replace the old one.
        </p>
      )}
      {mode === "seo" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={fieldLabel}>
            Write search text for
            <select
              value={seoKind}
              onChange={(e) => {
                setSeoKind(e.target.value as SeoTargetKind);
                setSeoTarget("");
              }}
              className={`mt-1 ${input}`}
            >
              <option value="page">A page</option>
              <option value="product">A product</option>
              <option value="category">A category</option>
            </select>
          </label>
          <label className={fieldLabel}>
            Which one
            <select value={seoTarget} onChange={(e) => setSeoTarget(e.target.value)} className={`mt-1 ${input}`}>
              <option value="">Choose…</option>
              {seoOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs leading-5 text-slate-500 sm:col-span-2">
            Good lengths: title up to {SEO_LIMITS.title} characters, description up to {SEO_LIMITS.description}. Your current text stays until you choose to replace it.
          </p>
        </div>
      )}
      {mode === "product" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={fieldLabel}>
            Product
            <select value={productId} onChange={(e) => setProductId(e.target.value)} className={`mt-1 ${input}`}>
              {products.length === 0 && <option value="">No products yet</option>}
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className={fieldLabel}>
            Write
            <select value={productMode} onChange={(e) => setProductMode(e.target.value)} className={`mt-1 ${input}`}>
              {PRODUCT_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!canSend}>
          <Icon name="ai-builder" size={16} className="text-ember-soft" />
          {busy ? "Thinking…" : "Ask AI"}
        </Button>
        {mode === "theme" && (
          <Button variant="secondary" onClick={() => void catalogThemes()}>
            Recommend without AI
          </Button>
        )}
        {blockedReason && <span className="text-xs text-slate-500">{blockedReason}</span>}
      </div>
    </form>
  );

  const historyList = (
    <div>
      <h3 className="text-sm font-semibold text-slate-900">Request history</h3>
      {history === null ? (
        <div className="mt-2 space-y-1.5">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : history.length === 0 && session.length === 0 ? (
        <p className="mt-2 text-xs leading-5 text-slate-500">No AI requests yet. Your requests and their outcome will be listed here.</p>
      ) : (
        <ul className="mt-2 space-y-1.5" aria-label="AI request history">
          {session.map((item) => (
            <li key={item.key} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
              <span className="block truncate text-sm font-medium text-slate-900">{item.request}</span>
              <span className="mt-1 block text-xs text-slate-500">
                {AI_MODE_LABELS[item.mode]} · {item.outcome} · this visit only
              </span>
            </li>
          ))}
          {history?.map((item) => {
            const label = AI_STATUS[item.status] ?? AI_STATUS.pending;
            const current = result?.kind === "proposal" && result.detail.id === item.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => void openProposal(item.id)}
                  aria-current={current ? "true" : undefined}
                  className={`w-full rounded-xl border bg-white px-3 py-2 text-left transition-colors hover:bg-slate-50 ${focus} ${current ? "border-slate-900" : "border-slate-200 hover:border-slate-300"}`}
                >
                  <span className="block truncate text-sm font-medium text-slate-900">{item.request || item.summary}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                    <Pill tone={label.tone}>{label.text}</Pill>
                    <span>{item.target === "website" ? "Whole website" : item.target === "storefront" ? "Homepage" : "Page"}</span>
                    <span>{new Date(item.createdAt).toLocaleString()}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  const hasOutput = Boolean(error || busy || result);
  const resultArea = (
    <div className={!lockedPage && hasOutput ? "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6" : ""} aria-live="polite">
      {error && (
        <div role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <p>{error}</p>
          {lastRequest !== null && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={editRequest}>Edit request</Button>
              <Button variant="secondary" disabled={!canSend} onClick={() => void send(lastRequest)}>Try again</Button>
            </div>
          )}
        </div>
      )}
      {busy && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-slate-700">The assistant is working on your request…</p>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}
      {!busy && !result && !error && (
        <div className="ui-dots-ink rounded-2xl border border-dashed border-slate-300 px-5 py-8 text-center">
          <p className="mx-auto max-w-md text-sm leading-6 text-slate-600">What the assistant understood and what it proposes changing will appear here. Nothing changes until you approve it.</p>
        </div>
      )}
      {result?.kind === "message" && (
        <div className="space-y-3 text-sm text-slate-800">
          <p>{result.text}</p>
          <AiNotes notes={result.notes} title="Worth knowing:" />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={editRequest}>Edit request</Button>
          </div>
        </div>
      )}
      {result?.kind === "proposal" && (
        <AiProposalReview
          key={result.detail.id}
          businessId={businessId}
          detail={result.detail}
          notes={result.notes}
          dirty={dirty}
          previewData={previewData}
          onChanged={async (id) => {
            await loadHistory();
            await openProposal(id, result.notes);
          }}
          onApplied={onApplied}
          onEditRequest={lastRequest !== null ? editRequest : () => { setText(result.detail.request); textRef.current?.focus(); }}
          onTryAgain={canSend || (ready && !exhausted) ? () => void send(lastRequest ?? result.detail.request) : undefined}
        />
      )}
      {result?.kind === "seo" && <AiSeoResult key={result.seo.targetId} businessId={businessId} result={result.seo} category={categories.find((c) => c.id === result.seo.targetId) ?? null} />}
      {result?.kind === "product" && <AiProductResult key={result.product.productId} businessId={businessId} result={result.product} />}
      {result?.kind === "theme" && <AiThemeResult businessId={businessId} isOwner={isOwner} summary={result.summary} notes={result.notes} recommendations={result.recommendations} source={result.source} />}
    </div>
  );

  const statusBar = (
    <header className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-3 ${lockedPage ? "border-b border-slate-200 px-4 py-3 sm:px-5" : ""}`}>
      <div className="min-w-0 space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {lockedPage && <AiMark size="sm" />}
          <h2 id="ai-builder-title" className={lockedPage ? "text-sm font-semibold text-slate-900" : "sr-only"}>
            {lockedPage ? `AI assistant: ${lockedPage.title}` : "AI Builder"}
          </h2>
          <Pill tone={ready ? "success" : available ? "warning" : "neutral"} dot>
            {ready ? "On" : available ? "Not turned on" : "Off"}
          </Pill>
          <AiPromises />
        </div>
      </div>
      {counts && (
        <AiUsageMeter
          used={counts.used}
          limit={counts.limit}
          remaining={counts.remaining}
          planName={planName}
          className="w-full sm:w-auto sm:max-w-md"
          action={isOwner ? <a href={`/dashboard/businesses/${businessId}/billing`} className={`rounded font-medium text-slate-800 underline underline-offset-2 ${focus}`}>Compare plans</a> : undefined}
        />
      )}
    </header>
  );

  if (lockedPage) {
    return (
      <section aria-labelledby="ai-builder-title" className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {statusBar}
        <div className="grid lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4 border-b border-slate-200 p-4 sm:p-5 lg:border-b-0 lg:border-r">
            {notices}
            {composer}
            {historyList}
          </div>
          <div className="min-w-0 p-4 sm:p-5">{resultArea}</div>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="ai-builder-title" className="space-y-4">
      {statusBar}
      {notices}
      <div role="group" aria-label="What to work on" className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-200 bg-slate-100 p-0.5">
        {([["website", "My whole website"], ["single", "One change"]] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={area === value} onClick={() => setArea(value)} className={`min-h-10 rounded-md px-4 text-sm font-medium transition-colors ${focus} ${area === value ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
            {label}
          </button>
        ))}
      </div>
      {area === "website" ? (
        <AiWebsiteBuilder
          businessId={businessId}
          ready={ready && consentView.tasks?.discovery !== false && consentView.tasks?.website !== false}
          blockedReason={!available ? "AI suggestions are not available right now." : blockedMessage ?? (!consentView.consent.granted ? "AI suggestions need to be turned on for this store first." : exhausted ? "No AI requests left this month." : null)}
          previewData={previewData}
          onUsageChanged={() => void refreshUsage()}
          handoff={handoff}
        />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-4">
            {composer}
            {resultArea}
          </div>
          <aside className="min-w-0 lg:sticky lg:top-28 lg:max-h-[calc(100dvh-8rem)] lg:overflow-y-auto">{historyList}</aside>
        </div>
      )}
    </section>
  );
}
