"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ThemeRenderer from "@/components/storefront/ThemeRenderer";
import { useToastHelpers } from "@/components/ui/Toast";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { reorderById, type DropPosition } from "./SectionControls";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Surface";
import { unsavedSummary } from "@/lib/editor-unsaved";
import { THEMES, getThemeMeta } from "@/lib/themes";
import { canSelectTheme, type ThemeAccess } from "@/lib/theme-tiers";
import type { SectionType } from "@/lib/sections";
import type { StorefrontView } from "@/lib/storefront";
import { buildCommerceData, repeatedRailIds, type CommerceExtras } from "@/lib/storefront-home";
import {
  createHomeSection,
  duplicateHomeSection,
  homeSectionName,
  type HomeSection,
  type HomeSectionType,
  type StorefrontConfig,
} from "@/lib/storefront-config";
import { homeSectionFromTemplate, type SectionTemplate } from "@/lib/section-library";
import { findVisiblePlaceholders } from "@/lib/page-presets";
import SectionLibrary from "./SectionLibrary";
import EditorWorkspace, { editorFocus } from "./EditorWorkspace";
import EditorToolbar, { editorSelectClass, type EditorDevice } from "./EditorToolbar";
import HomeSectionNavigator, { type HomeSelection } from "./HomeSectionNavigator";
import PreviewLinksDialog from "../PreviewLinksDialog";
import RevisionHistoryDialog from "./RevisionHistoryDialog";
import PreviewFrame, { previewElement, previewLayoutLabel, type PreviewLayout } from "./PreviewFrame";
import AiAssistantPanel, { type AiPanelStatus, type AiProposalPreview } from "./AiAssistantPanel";
import type { AiConsentView } from "../AiConsentCard";
import {
  AnnouncementSettings,
  FooterSettings,
  HeaderSettings,
  HeroSettings,
  HomeSeoSettings,
  SectionSettings,
  fieldInput,
  fieldLabel,
  type EditorCatalog,
  type LinkOption,
} from "./HomeSectionSettings";

interface Snapshot {
  config: StorefrontConfig;
  themeId: string;
  font: string;
}

function same(a: Snapshot, b: Snapshot): boolean {
  return a.themeId === b.themeId && a.font === b.font && JSON.stringify(a.config) === JSON.stringify(b.config);
}

/** The homepage content that publishing replaces (older custom sections). */
export type ClassicHomepage = { kind: "page"; pageId: string; version: number } | { kind: "legacy" } | null;

/**
 * Website editor for the STORE HOMEPAGE (the commerce homepage of every
 * theme). The preview is rendered by the same components and the same data
 * builder as the public storefront (ThemeRenderer -> CommerceShell ->
 * CommerceHome with `buildCommerceData`), using the DRAFT settings; the only
 * editor differences are selection outlines and disabled links.
 *
 * Saving writes the draft (PUT /storefront, validated on the server);
 * publishing copies it to the public store (POST /storefront/publish, same
 * gates as publishing the store). Publishing also retires an older custom
 * homepage (classic sections) when one exists, so the store shows this page.
 */
export default function HomeEditor({
  businessId,
  businessName,
  view,
  initialConfig,
  initialDraftVersion = 0,
  initialThemeId,
  initialFont,
  extras,
  catalog,
  pages,
  currentPageId,
  classicHomepage,
  storeLive,
  hasUnpublishedChanges = false,
  canManage,
  ai,
  themeAccess,
}: {
  businessId: string;
  businessName: string;
  view: StorefrontView;
  initialConfig: StorefrontConfig;
  /** What a save names, so an old tab cannot overwrite newer edits. */
  initialDraftVersion?: number;
  initialThemeId: string;
  initialFont: string;
  extras: CommerceExtras;
  catalog: EditorCatalog;
  pages: Array<{ _id: string; title: string; status: string; isHome: boolean }>;
  /** The Home page being edited; absent = the homepage shown without a published Home page. */
  currentPageId?: string;
  classicHomepage: ClassicHomepage;
  storeLive: boolean;
  /** The saved draft differs from what visitors see (shown in the toolbar). */
  hasUnpublishedChanges?: boolean;
  canManage: boolean;
  /** AI assistant: provider status (server-decided), this month's usage and context labels. */
  ai: { status: AiPanelStatus; consent: AiConsentView; usage: { used: number; limit: number; remaining: number } | null; typeLabel: string; themeName: string };
  /** Plan-based theme access (server-decided; the server enforces the same rule). */
  themeAccess: ThemeAccess;
}) {
  const router = useRouter();
  const { success, error: showError } = useToastHelpers();
  const linkListId = useId();
  const initial: Snapshot = { config: initialConfig, themeId: initialThemeId, font: initialFont };
  const [snapshot, setSnapshot] = useState<Snapshot>(initial);
  const baseline = useRef<Snapshot>(initial);
  const history = useRef<Snapshot[]>([initial]);
  const historyIndex = useRef(0);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [selected, setSelected] = useState<HomeSelection | null>(null);
  const [device, setDevice] = useState<EditorDevice>("desktop");
  const [layout, setLayout] = useState<PreviewLayout | null>(null);
  const frameDocument = useRef<Document | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [classic, setClassic] = useState<ClassicHomepage>(classicHomepage);
  // For the draft/live note only: whether the saved draft is ahead of the live homepage.
  const [draftAhead, setDraftAhead] = useState(hasUnpublishedChanges);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Re-renders after an autosave moves the saved point (a ref).
  const [, setSavedTick] = useState(0);
  const [autosaveFailed, setAutosaveFailed] = useState(false);
  const draftVersion = useRef(initialDraftVersion);
  const [conflict, setConflict] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const saving = useRef<Promise<boolean> | null>(null);
  const leaving = useRef(false);
  const { config, themeId, font } = snapshot;
  const dirty = !same(snapshot, baseline.current);

  // The latest snapshot, updated synchronously so consecutive changes in one
  // event build on each other (state setters stay pure).
  const current = useRef<Snapshot>(initial);

  /** Applies a change as one undoable step. */
  const commit = useCallback((next: Snapshot) => {
    if (same(current.current, next)) return;
    current.current = next;
    const list = history.current.slice(0, historyIndex.current + 1);
    list.push(next);
    history.current = list.slice(-100);
    historyIndex.current = history.current.length - 1;
    setSnapshot(next);
    setHistoryState({ canUndo: historyIndex.current > 0, canRedo: false });
    setMessage(null);
  }, []);
  const updateConfig = useCallback(
    (mutate: (draft: StorefrontConfig) => void) => {
      const draft = structuredClone(current.current.config);
      mutate(draft);
      commit({ ...current.current, config: draft });
    },
    [commit],
  );

  const jump = useCallback((index: number) => {
    historyIndex.current = index;
    current.current = history.current[index];
    setSnapshot(current.current);
    setHistoryState({ canUndo: index > 0, canRedo: index < history.current.length - 1 });
  }, []);
  const undo = useCallback(() => {
    if (historyIndex.current > 0) jump(historyIndex.current - 1);
  }, [jump]);
  const redo = useCallback(() => {
    if (historyIndex.current < history.current.length - 1) jump(historyIndex.current + 1);
  }, [jump]);

  // ---- Preview: the storefront renderer with the draft --------------------------
  const previewView = useMemo<StorefrontView>(() => {
    // A store on its theme's colours follows the theme chosen here.
    const palette = view.usesThemeColors ? getThemeMeta(themeId as StorefrontView["themeId"]).palette : null;
    return {
      ...view,
      themeId: themeId as StorefrontView["themeId"],
      theme: { ...view.theme, font, ...(palette ? { primaryColor: palette[1], accentColor: palette[2] } : {}) },
    };
  }, [view, themeId, font]);
  const commerce = useMemo(() => buildCommerceData(previewView, config, extras), [previewView, config, extras]);
  const hiddenReasons = useMemo(() => {
    const reasons = new Map(commerce.hiddenSections.map((h) => [h.id, h.reason]));
    for (const id of repeatedRailIds(commerce.sections)) reasons.set(id, "every product here is already shown higher up the page. It appears once you have more products.");
    return reasons;
  }, [commerce]);

  // ---- AI assistant: a suggestion can be previewed on the canvas (read-only) ------
  const [aiOpen, setAiOpen] = useState(false);
  const [proposalPreview, setProposalPreview] = useState<AiProposalPreview | null>(null);
  // The editor remounts with the new draft after a suggestion is applied:
  // keep the assistant open across that (per tab; a convenience only).
  const aiOpenKey = `siteforge:ai-panel:${businessId}`;
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(aiOpenKey) === "1") setAiOpen(true);
    } catch {
      // Storage unavailable: the panel simply starts closed.
    }
  }, [aiOpenKey]);
  const toggleAi = (open: boolean) => {
    setAiOpen(open);
    setProposalPreview(null);
    try {
      window.sessionStorage.setItem(aiOpenKey, open ? "1" : "0");
    } catch {
      // Ignore: nothing depends on it.
    }
  };
  const canvasView = useMemo<StorefrontView>(
    () =>
      proposalPreview
        ? { ...previewView, theme: { ...previewView.theme, primaryColor: proposalPreview.brand.primaryColor, accentColor: proposalPreview.brand.accentColor, font: proposalPreview.brand.font } }
        : previewView,
    [previewView, proposalPreview],
  );
  const canvasCommerce = useMemo(
    () => (proposalPreview ? buildCommerceData(canvasView, proposalPreview.config, extras) : commerce),
    [proposalPreview, canvasView, extras, commerce],
  );

  const select = useCallback((selection: HomeSelection | null) => {
    setSelected(selection);
    if (selection) setSidebarOpen(true);
  }, []);

  /** Click (or Enter/Space) in the preview selects the part under the pointer. */
  const selectFromCanvas = useCallback(
    (event: React.SyntheticEvent<HTMLDivElement>) => {
      // Only the preview frame is inside this wrapper.
      const target = previewElement(event.target);
      if (!target) return;
      if (target.closest("a, button, input, select, textarea, form")) event.preventDefault();
      // A suggestion preview is read-only.
      if (proposalPreview) return;
      const element = target.closest<HTMLElement>("[data-editor-id]");
      if (!element) return;
      const id = element.dataset.editorId ?? "";
      event.preventDefault();
      if (id.startsWith("home:")) select(id.slice(5));
      else if (id === "header:banner") select("announcement");
      else if (id.startsWith("header:")) select("header");
      else if (id.startsWith("footer:")) select("footer");
    },
    [select, proposalPreview],
  );

  // On a phone the editor starts with the phone preview.
  useEffect(() => {
    if (window.matchMedia("(max-width: 639px)").matches) setDevice("mobile");
  }, []);

  // Bring the selected part into view in the preview (no jump when visible).
  useEffect(() => {
    if (selected === null || selected === "seo") return;
    const selector =
      selected === "announcement" ? '[data-editor-id="header:banner"]' : selected === "header" ? "header" : selected === "footer" ? "footer" : `[data-editor-id="home:${selected}"]`;
    frameDocument.current?.querySelector(selector)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  // ---- Section operations ------------------------------------------------------
  const sectionIndex = (id: string) => config.sections.findIndex((s) => s.id === id);
  const moveSection = (id: string, direction: -1 | 1) =>
    updateConfig((draft) => {
      const i = draft.sections.findIndex((s) => s.id === id);
      const j = i + direction;
      if (i < 0 || j < 0 || j >= draft.sections.length) return;
      [draft.sections[i], draft.sections[j]] = [draft.sections[j], draft.sections[i]];
    });
  const reorderSection = (fromId: string, toId: string, position: DropPosition) =>
    updateConfig((draft) => {
      draft.sections = reorderById(draft.sections, fromId, toId, position);
    });
  const addSection = (type: HomeSectionType, blockType?: SectionType) => {
    const created = createHomeSection(type, config.sections, blockType);
    updateConfig((draft) => {
      const at = typeof selected === "string" ? draft.sections.findIndex((s) => s.id === selected) : -1;
      draft.sections.splice(at >= 0 ? at + 1 : draft.sections.length, 0, created);
    });
    select(created.id);
  };
  /** Inserts a ready-made section after the selected one, as one undoable step. */
  const insertTemplate = (template: SectionTemplate) => {
    setLibraryOpen(false);
    const result = homeSectionFromTemplate(template, config.sections);
    if (result.kind === "blocked") return;
    if (result.kind === "hero") {
      // The homepage has one hero: bring it back if hidden, and open it.
      updateConfig((draft) => {
        draft.hero.enabled = true;
      });
      select("hero");
      return;
    }
    updateConfig((draft) => {
      const at = typeof selected === "string" ? draft.sections.findIndex((s) => s.id === selected) : -1;
      draft.sections.splice(at >= 0 ? at + 1 : draft.sections.length, 0, result.section);
    });
    select(result.section.id);
  };
  const duplicateSection = (section: HomeSection) => {
    const copy = duplicateHomeSection(section, config.sections);
    if (!copy) return;
    updateConfig((draft) => {
      draft.sections.splice(draft.sections.findIndex((s) => s.id === section.id) + 1, 0, copy);
    });
    select(copy.id);
  };
  const removeSection = async (section: HomeSection) => {
    const name = homeSectionName(section);
    if (!(await confirmDialog({ title: `Remove ${name}?`, message: `"${name}" comes off your draft homepage. You can undo this.`, confirmLabel: "Remove section", tone: "danger" }))) return;
    updateConfig((draft) => {
      draft.sections = draft.sections.filter((s) => s.id !== section.id);
    });
    select(null);
  };

  // ---- Save / preview / publish --------------------------------------------------
  const persist = useCallback(async (submitted: Snapshot): Promise<void> => {
    const res = await fetch(`/api/businesses/${businessId}/storefront`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-expected-version": String(draftVersion.current) },
      body: JSON.stringify(submitted.config),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.code === "draft_conflict") setConflict(true);
    if (!res.ok) throw new Error(data.error || "Your changes could not be saved.");
    if (typeof data.version === "number") draftVersion.current = data.version;
    if (submitted.themeId !== baseline.current.themeId) {
      // The theme stays in the design draft, so visitors see nothing until it is published.
      const themeRes = await fetch(`/api/businesses/${businessId}/design`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ themeId: submitted.themeId }) });
      const themeData = await themeRes.json().catch(() => ({}));
      if (!themeRes.ok) throw new Error(`Homepage saved, but the theme was not: ${themeData.error || "please try again"}`);
    }
    baseline.current = submitted;
    setDraftAhead(true);
    setAutosaveFailed(false);
  }, [businessId]);

  const saveDraft = useCallback(async (): Promise<boolean> => {
    if (!canManage) return false;
    await saving.current;
    if (same(current.current, baseline.current)) {
      setSavedTick((tick) => tick + 1);
      return true;
    }
    setBusy(true);
    setMessage(null);
    try {
      await persist(current.current);
      setMessage({ kind: "ok", text: "Draft saved. Your live store is unchanged until you publish." });
      return true;
    } catch (error) {
      const text = error instanceof Error ? error.message : "Network error. Your changes were not saved.";
      setMessage({ kind: "error", text });
      showError("Save failed", text);
      return false;
    } finally {
      setBusy(false);
    }
  }, [canManage, persist, showError]);

  // Autosave: a quiet draft save a few seconds after the last change. A half-typed
  // value the server refuses just stays unsaved, and Save explains why.
  useEffect(() => {
    if (!canManage || !dirty || busy || proposalPreview || conflict) return;
    const timer = window.setTimeout(() => {
      if (saving.current) return;
      const run = persist(current.current)
        .then(() => true)
        .catch(() => {
          setAutosaveFailed(true);
          return false;
        })
        .finally(() => {
          saving.current = null;
          setSavedTick((tick) => tick + 1);
        });
      saving.current = run;
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [snapshot, canManage, dirty, busy, proposalPreview, conflict, persist]);

  /** Reloads with what the server now holds (nothing unsaved remains to warn about). */
  const reloadEditor = useCallback(() => {
    leaving.current = true;
    window.location.reload();
  }, []);

  /**
   * The saved draft moved on the server (an applied proposal, a restored version). With nothing unsaved,
   * loads it. Otherwise never drops the owner's work: saving stops and the conflict notice takes over.
   */
  const reloadUnlessUnsaved = useCallback(() => {
    if (same(current.current, baseline.current)) reloadEditor();
    else setConflict(true);
  }, [reloadEditor]);

  const revertToPublished = useCallback(async () => {
    const unsavedNote = same(current.current, baseline.current) ? "" : " Changes you have not saved yet are not in the history, and will be lost.";
    if (!(await confirmDialog({ title: "Go back to the published homepage?", message: `Your draft is replaced by what visitors see now. The current draft stays in the version history.${unsavedNote}`, confirmLabel: "Go back", tone: "danger" }))) return;
    setBusy(true);
    try {
      await saving.current;
      const res = await fetch(`/api/businesses/${businessId}/storefront/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The published homepage could not be restored.");
      reloadEditor();
    } catch (error) {
      const text = error instanceof Error ? error.message : "The published homepage could not be restored.";
      setMessage({ kind: "error", text });
      setBusy(false);
    }
  }, [businessId, reloadEditor]);

  const preview = useCallback(async () => {
    // Open the tab synchronously (popup blockers), then point it at the
    // saved draft once it is saved.
    const tab = window.open("about:blank", "_blank");
    if (dirty && !(await saveDraft())) {
      tab?.close();
      return;
    }
    const url = `/dashboard/businesses/${businessId}/preview${classic ? "?mode=store" : ""}`;
    if (tab) tab.location.href = url;
    else window.location.assign(url);
  }, [businessId, classic, dirty, saveDraft]);

  const publish = useCallback(async () => {
    if (!canManage) return;
    const replaces = classic ? " It also replaces your older custom homepage sections." : "";
    if (!(await confirmDialog({ title: "Publish this homepage?", message: `Visitors will see it ${storeLive ? "right away" : "once your store is published"}.${replaces}`, confirmLabel: "Publish" }))) return;
    if (dirty && !(await saveDraft())) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/storefront/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The homepage could not be published.");
      if (classic?.kind === "page") {
        // Retire the older custom homepage so the store shows this one.
        const clear = await fetch(`/api/businesses/${businessId}/pages/${classic.pageId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sections: [], status: "published", expectedVersion: classic.version }),
        });
        const clearData = await clear.json().catch(() => ({}));
        if (!clear.ok) throw new Error(`Published, but the older homepage sections are still shown: ${clearData.error || "please try again"}`);
        setClassic(null);
      }
      setDraftAhead(false);
      setMessage({ kind: "ok", text: storeLive ? "Published. Your live store shows this homepage now." : "Published. It will show once your store is published." });
      success("Homepage published", storeLive ? "Visitors now see these changes." : "It goes live with your store.");
      router.refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : "Network error. Nothing was published.";
      setMessage({ kind: "error", text });
      showError("Publish failed", text);
    } finally {
      setBusy(false);
    }
  }, [businessId, canManage, classic, dirty, router, saveDraft, showError, storeLive, success]);

  const discard = useCallback(async () => {
    if (!(await confirmDialog({ title: "Discard unsaved changes?", message: "Everything you changed since your last save will be lost. Your saved draft and live store stay as they are.", confirmLabel: "Discard changes", tone: "danger" }))) return;
    history.current = [baseline.current];
    jump(0);
    setSelected(null);
  }, [jump]);

  // Keyboard shortcuts (never while typing in a field).
  useEffect(() => {
    if (!canManage) return;
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (/^(input|textarea|select)$/i.test(t.tagName) || t.isContentEditable);
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || typing(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        void saveDraft();
      } else if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canManage, redo, saveDraft, undo]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty && !leaving.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // What would be lost, for the conflict notice only.
  const unsaved = conflict && dirty ? unsavedSummary(baseline.current, snapshot, (section) => homeSectionName(section)) : null;

  /** Loading the latest draft replaces this window's edits, so it is always the owner's explicit choice. */
  const loadLatestDraft = async () => {
    if (unsaved && !(await confirmDialog({ title: "Load the latest draft?", message: `Changes you have not saved (${unsaved.areas.join(", ")}) will be lost. Copy anything you need first.`, confirmLabel: "Load latest draft", tone: "danger" }))) return;
    reloadEditor();
  };

  const copyUnsaved = async () => {
    try {
      await navigator.clipboard.writeText(unsaved?.text ?? "");
      success("Copied", "Your unsaved text is on your clipboard.");
    } catch {
      showError("That could not be copied", "Open the list of your unsaved text, and copy it from there.");
    }
  };

  // ---- Sidebar content -------------------------------------------------------------
  const selectedSection = typeof selected === "string" ? config.sections.find((s) => s.id === selected) ?? null : null;
  const sidebarTitle =
    selected === null
      ? "Homepage"
      : selected === "hero"
        ? "Hero banner"
        : selected === "announcement"
          ? "Announcement bar"
          : selected === "header"
            ? "Header"
            : selected === "footer"
              ? "Footer"
              : selected === "seo"
                ? "Search and sharing"
                : selectedSection
                  ? homeSectionName(selectedSection)
                  : "Homepage";

  const sidebar = (
    <div className="space-y-4">
      {selected !== null && (
        <button type="button" onClick={() => select(null)} className={`-ml-1 inline-flex min-h-10 items-center gap-1.5 rounded-lg px-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900 lg:min-h-8 ${editorFocus}`}>
          <Icon name="arrow-left" size={14} /> All sections
        </button>
      )}
      {selected === null && (
        <>
          <HomeSectionNavigator
            config={config}
            selected={selected}
            hiddenReasons={hiddenReasons}
            onSelect={select}
            onToggleSection={(id, enabled) => updateConfig((d) => { const s = d.sections.find((x) => x.id === id); if (s) s.enabled = enabled; })}
            onToggleHero={(enabled) => updateConfig((d) => { d.hero.enabled = enabled; })}
            onMove={moveSection}
            onReorder={reorderSection}
            onRemove={(section) => void removeSection(section)}
            onAdd={addSection}
            onBrowseLibrary={() => setLibraryOpen(true)}
          />
          <div className="space-y-3 border-t border-slate-200 pt-4">
            <h3 className="text-sm font-semibold text-slate-900">Store design</h3>
            <div>
              <label htmlFor="editor-theme" className={fieldLabel}>Theme</label>
              <select id="editor-theme" value={themeId} disabled={!canManage} onChange={(e) => commit({ ...current.current, themeId: e.target.value })} className={fieldInput}>
                {THEMES.map((t) => {
                  const locked = !canSelectTheme(themeAccess, t.id);
                  const plan = themeAccess.requiredPlan[t.id];
                  return (
                    <option key={t.id} value={t.id} disabled={locked}>
                      {t.name} — {locked ? `${plan ? plan.name : "Unavailable"} plan` : t.tagline}
                    </option>
                  );
                })}
              </select>
              <p className="mt-1 text-xs text-slate-500">{THEMES.find((t) => t.id === themeId)?.description}</p>
              <p className="mt-1 text-xs text-slate-500">
                {THEMES.filter((t) => canSelectTheme(themeAccess, t.id)).length} of {THEMES.length} themes in your {themeAccess.planName} plan.{" "}
                <a href={`/dashboard/businesses/${businessId}/theme`} className={`rounded font-medium text-slate-800 underline underline-offset-2 ${editorFocus}`}>Compare all themes</a>
              </p>
            </div>
            <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-700">
              A new theme stays in your draft and goes live when you publish it in{" "}
              <a href={`/dashboard/businesses/${businessId}/publish`} className={`rounded font-medium underline underline-offset-2 ${editorFocus}`}>Publish</a>.{" "}
              Colours, fonts and buttons are in{" "}
              <a href={`/dashboard/businesses/${businessId}/design`} className={`rounded font-medium underline underline-offset-2 ${editorFocus}`}>Design</a>.
            </p>
          </div>
        </>
      )}
      {selected === "hero" && (
        <HeroSettings hero={config.hero} catalog={catalog} linkListId={linkListId} onChange={(p) => updateConfig((d) => { Object.assign(d.hero, p); })} />
      )}
      {selected === "announcement" && (
        <AnnouncementSettings announcement={config.announcement} linkListId={linkListId} onChange={(p) => updateConfig((d) => { Object.assign(d.announcement, p); })} />
      )}
      {selected === "footer" && (
        <FooterSettings footer={config.footer} businessId={businessId} linkListId={linkListId} onChange={(p) => updateConfig((d) => { Object.assign(d.footer, p); })} />
      )}
      {selected === "header" && <HeaderSettings header={config.header} businessId={businessId} accountsEnabled={Boolean(extras.accountsEnabled)} onChange={(p) => updateConfig((d) => { Object.assign(d.header, p); })} />}
      {selected === "seo" && (
        <HomeSeoSettings seo={config.seo} businessName={businessName} businessId={businessId} onChange={(p) => updateConfig((d) => { Object.assign(d.seo, p); })} />
      )}
      {selectedSection && (
        <SectionSettings
          key={selectedSection.id}
          section={selectedSection}
          index={sectionIndex(selectedSection.id)}
          count={config.sections.length}
          hiddenReason={hiddenReasons.get(selectedSection.id) ?? null}
          catalog={catalog}
          linkListId={linkListId}
          device={device}
          onChange={(next) => updateConfig((d) => { d.sections = d.sections.map((s) => (s.id === next.id ? next : s)); })}
          onMove={(direction) => moveSection(selectedSection.id, direction)}
          onDuplicate={() => duplicateSection(selectedSection)}
          onRemove={() => void removeSection(selectedSection)}
        />
      )}
      {typeof selected === "string" && !["hero", "announcement", "footer", "header", "seo"].includes(selected) && !selectedSection && (
        <p className="text-sm text-slate-600">This section is no longer on the page. It may have been removed or undone.</p>
      )}
    </div>
  );

  const status = busy ? "Working…" : conflict ? "Newer changes exist" : dirty ? (autosaveFailed ? "Not saved yet" : "Saving shortly…") : "All changes saved";
  const placeholdersLeft = findVisiblePlaceholders(config.sections).length + (config.hero.enabled ? findVisiblePlaceholders([config.hero]).length : 0);
  const hasPublishedHome = pages.some((p) => p.isHome && p.status === "published");

  return (
    <>
      <datalist id={linkListId}>
        {catalog.linkOptions.map((o: LinkOption) => <option key={o.href} value={o.href}>{o.label}</option>)}
      </datalist>
      <EditorWorkspace
        toolbar={
          <EditorToolbar
            title={`${businessName} · Homepage`}
            status={status}
            saveTone={busy ? "busy" : conflict || autosaveFailed ? "error" : dirty ? "unsaved" : "saved"}
            viewing={
              proposalPreview
                ? { label: "AI suggestion", tone: "ember", detail: "A preview only. Your draft has not changed." }
                : !storeLive
                  ? { label: "Draft", detail: "Your store is not published yet, so nobody can see this." }
                  : dirty || draftAhead
                    ? { label: "Draft", tone: "warning", detail: "Visitors still see the last homepage you published." }
                    : { label: "Draft", tone: "success", detail: "Matches what visitors see right now." }
            }
            leading={
              pages.length > 0 ? (
                <select
                  aria-label="Page to edit"
                  value={currentPageId ?? ""}
                  onChange={async (e) => {
                    const next = e.target.value;
                    if (dirty && !(await confirmDialog({ title: "Leave this page?", message: "Your unsaved changes will be lost.", confirmLabel: "Leave page", tone: "danger" }))) return;
                    router.push(`/dashboard/businesses/${businessId}/editor${next ? `?page=${encodeURIComponent(next)}` : ""}`);
                  }}
                  className={editorSelectClass}
                >
                  {!hasPublishedHome && <option value="">Store homepage</option>}
                  {pages.map((p) => (
                    <option key={p._id} value={p._id}>{p.isHome ? "Homepage" : p.title}{p.status === "published" ? "" : " (draft)"}</option>
                  ))}
                </select>
              ) : null
            }
            canUndo={historyState.canUndo}
            canRedo={historyState.canRedo}
            onUndo={undo}
            onRedo={redo}
            device={device}
            onDeviceChange={setDevice}
            onSave={() => void saveDraft()}
            saveDisabled={!canManage || !dirty || conflict}
            onPreview={() => void preview()}
            onPublish={canManage ? () => void publish() : undefined}
            publishLabel="Publish"
            busy={busy}
            assistant={canManage ? { open: aiOpen, onToggle: () => toggleAi(!aiOpen) } : undefined}
            more={[
              { label: sidebarOpen ? "Hide editing panel" : "Show editing panel", onSelect: () => setSidebarOpen((v) => !v) },
              ...(canManage
                ? [
                    { label: "Share a draft preview", onSelect: () => setShareOpen(true) },
                    { label: "Version history", onSelect: () => setHistoryOpen(true) },
                    { label: "Go back to the published version", onSelect: () => void revertToPublished(), disabled: !draftAhead && !dirty },
                    { label: "Everything waiting to publish", onSelect: () => router.push(`/dashboard/businesses/${businessId}/publish`) },
                  ]
                : []),
              { label: "Store-wide settings (policies)", onSelect: () => router.push(`/dashboard/businesses/${businessId}/storefront`) },
              { label: "Discard unsaved changes", onSelect: () => void discard(), disabled: !dirty, danger: true },
            ]}
          />
        }
        notices={
          <>
            {aiOpen && canManage && (
              <AiAssistantPanel
                businessId={businessId}
                status={ai.status}
                consentView={ai.consent}
                usage={ai.usage}
                context={{
                  typeLabel: ai.typeLabel,
                  themeName: ai.themeName,
                  selectedLabel: selectedSection ? homeSectionName(selectedSection) : null,
                  selectedSectionId: selectedSection?.id ?? null,
                }}
                dirty={dirty}
                storeLive={storeLive}
                previewingId={proposalPreview?.id ?? null}
                onPreview={setProposalPreview}
                // The draft and its version moved on the server. Load them, or this editor would
                // show the old draft and its next save would be refused as out of date.
                onApplied={reloadUnlessUnsaved}
                onClose={() => toggleAi(false)}
              />
            )}
            {proposalPreview && (
              <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2 text-sm text-[#7a2a0d]">
                <span className="inline-flex items-center gap-2"><Icon name="ai-builder" size={15} className="text-ember" /> Previewing an AI suggestion. Your draft has not changed.</span>
                <button type="button" onClick={() => setProposalPreview(null)} className={`inline-flex min-h-10 items-center rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 lg:min-h-8 ${editorFocus}`}>
                  Back to my draft
                </button>
              </div>
            )}
            {conflict && (
              <Notice
                tone="danger"
                role="alert"
                title="This draft has newer changes from somewhere else"
                action={
                  <span className="flex flex-wrap gap-2">
                    {unsaved && unsaved.text && <button type="button" onClick={() => void copyUnsaved()} className={`inline-flex min-h-10 items-center rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50 ${editorFocus}`}>Copy my unsaved text</button>}
                    <button type="button" onClick={() => void loadLatestDraft()} className={`inline-flex min-h-10 items-center rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50 ${editorFocus}`}>Load latest draft</button>
                  </span>
                }
              >
                <p>Saving has stopped so neither version overwrites the other. This can happen after another window saves, or after an AI proposal is applied.</p>
                {unsaved ? (
                  <>
                    <p className="mt-1.5 font-medium">Not saved, and only in this window: {unsaved.areas.join(", ")}.</p>
                    <ol className="mt-1.5 list-decimal space-y-0.5 pl-5">
                      <li>Keep this window open, and copy any text you need.</li>
                      <li>
                        <a href={`/dashboard/businesses/${businessId}/editor${classic ? "?mode=store" : ""}`} target="_blank" rel="noopener" className={`rounded font-medium underline underline-offset-2 ${editorFocus}`}>Open the latest draft in a new tab</a>, and make your changes again there.
                      </li>
                      <li>Then load the latest draft here. That replaces what is in this window.</li>
                    </ol>
                    {unsaved.text && (
                      <details className="mt-1.5">
                        <summary className={`cursor-pointer rounded font-medium ${editorFocus}`}>Show my unsaved text</summary>
                        <textarea readOnly rows={6} aria-label="Your unsaved text" value={unsaved.text} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800" />
                      </details>
                    )}
                  </>
                ) : (
                  <p className="mt-1.5">You have nothing unsaved here, so you can load the latest draft and carry on.</p>
                )}
              </Notice>
            )}
            {autosaveFailed && !conflict && (
              <Notice tone="warning" role="status" title="Your latest changes aren't saved yet" action={<button type="button" onClick={() => void saveDraft()} className={`inline-flex min-h-10 items-center rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50 ${editorFocus}`}>Save now</button>}>
                They&apos;re safe in this window. Save now to see what needs fixing.
              </Notice>
            )}
            {placeholdersLeft > 0 && (
              <Notice tone="info" role="status">Replace the {placeholdersLeft === 1 ? "text" : `${placeholdersLeft} texts`} in [[double brackets]] with your own: this homepage can&apos;t be published until you do.</Notice>
            )}
            {classic && (
              <Notice tone="warning">Your store currently shows an older custom homepage. You are editing the store homepage; publishing replaces the older sections.</Notice>
            )}
            {message && (
              <Notice tone={message.kind === "error" ? "danger" : "success"} role={message.kind === "error" ? "alert" : "status"}>
                {message.text}
              </Notice>
            )}
          </>
        }
        canvasLabel={proposalPreview ? "Suggestion preview (not saved)" : "Draft preview"}
        canvasMeta={<span className="hidden sm:inline">{layout ? previewLayoutLabel(layout) : null}</span>}
        canvas={
          <div className="h-full p-3 sm:p-4">
            <div
              className="h-full"
              onClickCapture={selectFromCanvas}
              onSubmitCapture={(e) => e.preventDefault()}
              onKeyDownCapture={(e) => {
                if ((e.key === "Enter" || e.key === " ") && previewElement(e.target)?.matches("[data-editor-id]")) selectFromCanvas(e);
              }}
            >
              <PreviewFrame
                device={device}
                title="Store preview"
                onLayout={(next) => setLayout((prev) => (prev && prev.device === next.device && prev.viewport === next.viewport && prev.scale === next.scale ? prev : next))}
                onDocument={(doc) => {
                  frameDocument.current = doc;
                }}
              >
                <ThemeRenderer
                  view={canvasView}
                  productHrefBase="#"
                  preview
                  editable={canManage && !proposalPreview}
                  commerce={canvasCommerce}
                  selectedElementId={typeof selected === "string" && !["announcement", "header", "footer", "seo"].includes(selected) ? `home:${selected}` : null}
                />
              </PreviewFrame>
            </div>
          </div>
        }
        sidebarTitle={sidebarTitle}
        sidebar={sidebar}
        sidebarOpen={sidebarOpen}
        onSidebarOpenChange={setSidebarOpen}
      />
      {shareOpen && <PreviewLinksDialog businessId={businessId} prepare={saveDraft} onClose={() => setShareOpen(false)} />}
      {libraryOpen && (
        <SectionLibrary
          blockedNote={(template) => {
            const result = homeSectionFromTemplate(template, config.sections);
            return result.kind === "blocked" ? result.reason : null;
          }}
          onInsert={insertTemplate}
          onClose={() => setLibraryOpen(false)}
        />
      )}
      {historyOpen && (
        <RevisionHistoryDialog businessId={businessId} target="home" title="Homepage" onClose={() => setHistoryOpen(false)} onRestored={reloadUnlessUnsaved} />
      )}
    </>
  );
}
