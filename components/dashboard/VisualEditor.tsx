"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import PageSettingsDialog from "./PageSettingsDialog";
import PreviewLinksDialog from "./PreviewLinksDialog";
import ContentSectionFields from "./editor/ContentSectionFields";
import RevisionHistoryDialog from "./editor/RevisionHistoryDialog";
import ResponsiveControls from "./editor/ResponsiveControls";
import SectionLibrary from "./editor/SectionLibrary";
import { sectionFromTemplate, type SectionTemplate } from "@/lib/section-library";
import { THEMES, getThemeMeta } from "@/lib/themes";
import { pickStoreDesign, type DesignDraft } from "@/lib/design-settings";
import { resolveEditorNavigation } from "@/lib/editor-preview";
import { canSelectTheme, type ThemeAccess } from "@/lib/theme-tiers";
import { findPlaceholders, findVisiblePlaceholders } from "@/lib/page-presets";
import {
  EditorSaveError,
  savePageBackedEditorChanges,
  type EditorSaveResponse,
} from "@/lib/editor-save";
import {
  DEFAULT_THEME_SETTINGS,
  type StorefrontProduct,
  type StorefrontView,
} from "@/lib/storefront";
import type { ThemeSettings } from "@/models/Business";
import {
  editorElementStyleSchema,
  type EditorElementStyle,
  type Section,
  type SectionType,
} from "@/lib/sections";
import {
  SECTION_TYPES,
  SECTION_TYPE_LABELS,
  SECTION_TYPE_DESCRIPTIONS,
  createDefaultSection,
  generateSectionId,
  reorderSections,
  sectionDisplayName,
} from "@/lib/sections";
import ThemeRenderer from "@/components/storefront/ThemeRenderer";
import { buildCommerceData, type CommerceExtras } from "@/lib/storefront-home";
import type { StorefrontConfig } from "@/lib/storefront-config";
import EditorWorkspace from "./editor/EditorWorkspace";
import EditorToolbar, { editorSelectClass } from "./editor/EditorToolbar";
import PreviewFrame, { previewElement, previewLayoutLabel, type PreviewLayout } from "./editor/PreviewFrame";
import MediaPicker from "./MediaPicker";
import ProductThumb from "./ProductThumb";
import AiBuilder from "./ai/AiBuilder";
import type { AiConsentView } from "./AiConsentCard";
import { useToastHelpers } from "@/components/ui/Toast";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { AddSectionMenu, SectionNameField, SectionPanelActions, SectionRow, reorderById, useSectionDrag, type DropPosition } from "./editor/SectionControls";
import { Icon } from "@/components/ui/Icon";
import { Notice, Pill } from "@/components/ui/Surface";

const inputClass =
  "min-h-10 w-full rounded-lg border px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1";
const controlFocus =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1";
const toolbarButtonClass = `inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-9 ${controlFocus}`;
const toolbarSelectClass = `min-h-10 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-700 transition-colors lg:min-h-9 ${controlFocus} disabled:cursor-not-allowed disabled:opacity-60`;
const itemCard = "space-y-2 rounded-xl border border-slate-200 p-3";
const removeItem = `inline-flex min-h-10 items-center text-xs font-medium text-red-700 hover:underline lg:min-h-7 ${controlFocus}`;
const addItem = `inline-flex min-h-10 items-center text-xs font-semibold text-slate-900 hover:underline disabled:opacity-50 lg:min-h-7 ${controlFocus}`;
const propLabel = "mb-1 block text-xs font-medium text-slate-700";

type Device = "desktop" | "tablet" | "mobile";
type EditorSnapshot = {
  themeId: string;
  settings: ThemeSettings;
  sections: Section[];
};

type SelectedElement = {
  id: string;
  sectionId: string;
  label: string;
  contentPath?: string;
};

const AUTOSAVE_DELAY_MS = 5000;
/** Before trying a failed save again, when the server does not say how long to wait. */
const SAVE_RETRY_MS = 30_000;

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function writePath(value: unknown, path: string, nextValue: unknown): unknown {
  const keys = path.split(".");
  if (
    keys.length === 0 ||
    keys.some((key) => !/^(?:[A-Za-z][A-Za-z0-9]*|\d+)$/.test(key))
  ) {
    return value;
  }

  function update(current: unknown, depth: number): unknown {
    const key = keys[depth];
    const index = /^\d+$/.test(key) ? Number(key) : null;
    if (index !== null) {
      const copy = Array.isArray(current) ? [...current] : [];
      copy[index] =
        depth === keys.length - 1
          ? nextValue
          : update(copy[index], depth + 1);
      return copy;
    }

    const copy: Record<string, unknown> =
      current && typeof current === "object" && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {};
    copy[key] =
      depth === keys.length - 1
        ? nextValue
        : update(copy[key], depth + 1);
    return copy;
  }

  return update(value, 0);
}

function sameSnapshot(left: EditorSnapshot, right: EditorSnapshot): boolean {
  return (
    left.themeId === right.themeId &&
    JSON.stringify(left.settings) === JSON.stringify(right.settings) &&
    JSON.stringify(left.sections) === JSON.stringify(right.sections)
  );
}

function getElementLinkPath(section: Section, key: string): string | undefined {
  if ((section.type === "hero" || section.type === "imageText") && key === "cta") return "ctaHref";
  if (section.type === "cta" && key === "button") return "buttonHref";
  if ((section.type === "contact" && key === "cta") ||
    (section.type === "newsletter" && key === "button")) return "ctaHref";
  const pricingCta = section.type === "pricing" && key.match(/^plans\.(\d+)\.cta$/);
  return pricingCta ? `plans.${pricingCta[1]}.ctaHref` : undefined;
}

/**
 * The page's own sections. A page without sections stays empty (the editor
 * offers "Add section"); it is NEVER filled with generated placeholder
 * sections, which used to replace the store homepage with an unfinished
 * layout ("Information coming soon", an empty footer section, …).
 */
function resolveInitialSections(initial: ThemeSettings): Section[] {
  return Array.isArray(initial.sections) ? (initial.sections as Section[]) : [];
}

interface BaseBusiness {
  name: string;
  subdomain: string;
  category: string;
  description: string;
  logoUrl: string;
  contactEmail: string;
  phone: string;
  address: string;
  currency: string;
}

/** The server's messages about particular sections, so each can be opened to fix it. */
function sectionProblemsFrom(error: unknown, sections: ReadonlyArray<{ id: string; type: string }>): SectionProblem[] {
  if (!(error instanceof EditorSaveError) || !error.fields) return [];
  return Object.entries(error.fields).map(([key, message]) => {
    const match = key.match(/^sections\.(\d+)/);
    const position = match ? Number(match[1]) : -1;
    const section = sections[position];
    return section
      ? { key, sectionId: section.id, label: `Section ${position + 1}: ${(SECTION_TYPE_LABELS as Record<string, string>)[section.type] ?? section.type}`, message }
      : { key, sectionId: null, label: "This page", message };
  });
}

interface SectionProblem {
  key: string;
  sectionId: string | null;
  label: string;
  message: string;
}

export default function VisualEditor({
  businessId,
  pageId,
  pageVersion,
  initialThemeId,
  design,
  initialSettings,
  base,
  products,
  pages,
  canManage,
  pageAi,
  removeBranding,
  storefrontDraft,
  commerceExtras,
  classicHomepage = false,
  themeAccess,
}: {
  businessId: string;
  pageId?: string;
  pageVersion?: number;
  initialThemeId: string;
  /** The draft design: choosing a theme here changes the draft only. */
  design: DesignDraft;
  initialSettings: ThemeSettings;
  base: BaseBusiness;
  products: StorefrontProduct[];
  pages?: Array<{ _id: string; title: string; slug: string; status: string; isHome?: boolean; generated?: boolean; generatedByAi?: boolean; needsReview?: boolean; seoTitle?: string; seoDescription?: string; seoImage?: string; noindex?: boolean; canonicalUrl?: string }>;
  canManage: boolean;
  /** The AI assistant for this page (owners and managers). */
  pageAi?: { available: boolean; consent: AiConsentView; usage: { used: number; limit: number; remaining: number } | null; planName: string; isOwner: boolean };
  removeBranding: boolean;
  /** Draft storefront settings: header/footer of the preview (same as the store). */
  storefrontDraft?: StorefrontConfig;
  commerceExtras?: CommerceExtras;
  /** This is a homepage that still uses classic custom sections. */
  classicHomepage?: boolean;
  /** Plan-based theme access (server-decided; the server enforces the same rule). */
  themeAccess: ThemeAccess;
}) {
  const router = useRouter();
  const { success, error: showError } = useToastHelpers();
  const initialSections = resolveInitialSections(initialSettings);
  const [themeId, setThemeId] = useState(initialThemeId);
  const [settings, setSettings] = useState<ThemeSettings>({ ...initialSettings, sections: initialSections });
  const [sections, setSections] = useState<Section[]>(initialSections);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedSection = sections.find((s) => s.id === selectedId) ?? null;
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [previewLayout, setPreviewLayout] = useState<PreviewLayout | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [aiOpen, setAiOpen] = useState(false);
  // On a phone the editor starts with the phone preview.
  useEffect(() => {
    if (window.matchMedia("(max-width: 639px)").matches) setDevice("mobile");
  }, []);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sectionProblems, setSectionProblems] = useState<SectionProblem[]>([]);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // When a save that failed for a passing reason (too many saves, no connection) is tried again.
  const [retrySaveAt, setRetrySaveAt] = useState<number | null>(null);
  // Moves on with every finished save, so edits made while one was running get a save of their own.
  const [savedCount, setSavedCount] = useState(0);
  const [currentVersion, setCurrentVersion] = useState<number | undefined>(pageVersion);
  const saveVersion = useRef(0);
  const saveInFlightRef = useRef(false);
  const leavingRef = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const initialSnapshot: EditorSnapshot = { themeId, settings, sections };
  const baselineSnapshot = useRef<EditorSnapshot>(initialSnapshot);
  const historyRef = useRef<EditorSnapshot[]>([initialSnapshot]);
  const historyIndexRef = useRef(0);
  const applyingHistoryRef = useRef(false);
  const [historyStatus, setHistoryStatus] = useState({ canUndo: false, canRedo: false });

  const elementOffsetMap = useMemo(() => {
    const map: Record<string, { x: number; y: number }> = {};
    for (const section of sections) {
      const styles = section.style?.elementStyles ?? {};
      for (const [key, responsive] of Object.entries(styles)) {
        const dev = (responsive as Record<string, { offsetX?: number; offsetY?: number }> | undefined)?.[device];
        if (dev && (dev.offsetX !== undefined || dev.offsetY !== undefined)) {
          map[`${section.id}:${key}`] = { x: dev.offsetX ?? 0, y: dev.offsetY ?? 0 };
        }
      }
    }
    return map;
  }, [sections, device]);
  const isDirty = !sameSnapshot(
    { themeId, settings, sections },
    baselineSnapshot.current,
  );
  const selectedElementKey =
    selectedSection && selectedElement?.sectionId === selectedSection.id &&
    selectedElement.id.startsWith(`${selectedSection.id}:`)
      ? selectedElement.id.slice(selectedSection.id.length + 1)
      : null;
  const selectedElementStyle = selectedElementKey
    ? selectedSection?.style?.elementStyles?.[selectedElementKey]?.[device] ?? {}
    : {};
  const selectedLinkPath =
    selectedSection && selectedElementKey
      ? getElementLinkPath(selectedSection, selectedElementKey)
      : undefined;
  const selectedContentValue =
    selectedSection && selectedElement?.contentPath
      ? readPath(selectedSection.settings, selectedElement.contentPath)
      : undefined;

  useEffect(() => {
    if (applyingHistoryRef.current) {
      applyingHistoryRef.current = false;
      return;
    }
    const snapshot = { themeId, settings, sections };
    const history = historyRef.current;
    const current = history[historyIndexRef.current];
    if (current && sameSnapshot(current, snapshot)) return;
    const nextHistory = history.slice(0, historyIndexRef.current + 1);
    nextHistory.push(snapshot);
    historyRef.current = nextHistory;
    historyIndexRef.current = nextHistory.length - 1;
    setHistoryStatus({ canUndo: nextHistory.length > 1, canRedo: false });
  }, [themeId, settings, sections]);

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current -= 1;
    const snapshot = historyRef.current[historyIndexRef.current];
    applyingHistoryRef.current = true;
    setThemeId(snapshot.themeId);
    setSettings(snapshot.settings);
    setSections(snapshot.sections);
    setHistoryStatus({
      canUndo: historyIndexRef.current > 0,
      canRedo: true,
    });
  }, []);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current += 1;
    const snapshot = historyRef.current[historyIndexRef.current];
    applyingHistoryRef.current = true;
    setThemeId(snapshot.themeId);
    setSettings(snapshot.settings);
    setSections(snapshot.sections);
    setHistoryStatus({
      canUndo: historyIndexRef.current > 0,
      canRedo: historyIndexRef.current < historyRef.current.length - 1,
    });
  }, []);

  const discardChanges = useCallback(async () => {
    if (!(await confirmDialog({ title: "Discard unsaved edits?", message: "Everything you changed on this page since your last save will be lost.", confirmLabel: "Discard edits", tone: "danger" }))) return;
    const snapshot = baselineSnapshot.current;
    applyingHistoryRef.current = true;
    historyRef.current = [snapshot];
    historyIndexRef.current = 0;
    setThemeId(snapshot.themeId);
    setSettings(snapshot.settings);
    setSections(snapshot.sections);
    setSelectedElement(null);
    setSelectedId(null);
    setHistoryStatus({ canUndo: false, canRedo: false });
    setSaveStatus("idle");
    setRetrySaveAt(null);
    setError(null);
  }, []);

  const selectCanvasElement = useCallback((event: React.SyntheticEvent<HTMLDivElement>) => {
    if (!canManage) return;
    // Only the preview frame is inside the wrapper this handler is attached to.
    const target = previewElement(event.target);
    if (!target) return;
    if (target.closest("a, button")) event.preventDefault();
    const element = target.closest<HTMLElement>("[data-editor-id]");
    if (!element) return;
    const id = element.dataset.editorId;
    if (!id) return;
    const sectionId = element.dataset.editorSectionId ?? id.split(":")[0];
    event.preventDefault();
    const label = element.dataset.editorLabel ?? "Element";
    const contentPath = element.dataset.editorContentPath;
    setSelectedId(sectionId);
    setSelectedElement({ id, sectionId, label, contentPath });
  }, [canManage]);

  const selectCanvasElementByKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!canManage || (event.key !== "Enter" && event.key !== " ")) return;
      if (!previewElement(event.target)?.matches("[data-editor-id]")) return;
      event.preventDefault();
      selectCanvasElement(event);
    },
    [canManage, selectCanvasElement],
  );

  // Resolve navigation from pages for preview
  const resolvedNavigation = useMemo(
    () => resolveEditorNavigation(settings.navigation ?? initialSettings.navigation, pages ?? []),
    [settings, initialSettings, pages],
  );

  const previewView: StorefrontView = useMemo(
    () => ({
      id: businessId,
      name: base.name,
      subdomain: base.subdomain,
      category: base.category,
      about: base.description || settings.about || "",
      logoUrl: base.logoUrl,
      contactEmail: base.contactEmail,
      phone: base.phone,
      address: base.address,
      currency: base.currency,
      removeBranding,
      themeId: themeId as StorefrontView["themeId"],
      theme: {
        ...DEFAULT_THEME_SETTINGS,
        ...settings,
        // Same design as the draft store: a store on its theme's colours follows the theme chosen here.
        ...(pageId && design.useThemeColors ? { primaryColor: getThemeMeta(themeId as StorefrontView["themeId"]).palette[1], accentColor: getThemeMeta(themeId as StorefrontView["themeId"]).palette[2] } : {}),
        ...(pageId ? { design: pickStoreDesign(design) } : {}),
      },
      products,
      navigation: resolvedNavigation,
      reviews: commerceExtras?.reviews,
    }),
    [businessId, base, settings, themeId, products, removeBranding, resolvedNavigation, pageId, design, commerceExtras],
  );

  const syncSectionsToSettings = useCallback(
    (nextSections: Section[]) => {
      const hero = nextSections.find((s) => s.type === "hero");
      const productsSec = nextSections.find((s) => s.type === "products");
      const aboutSec = nextSections.find((s) => s.type === "about");
      const next: Partial<ThemeSettings> = {};
      if (hero) {
        const h = hero.settings as { headline?: string; subheadline?: string };
        if (h.headline !== undefined) next.heroHeadline = h.headline;
        if (h.subheadline !== undefined) next.heroSubheadline = h.subheadline;
      }
      if (productsSec) {
        next.showProducts = productsSec.visible;
      } else {
        next.showProducts = false;
      }
      if (aboutSec) {
        const a = aboutSec.settings as { body?: string };
        if (a.body !== undefined) next.about = a.body;
      }
      setSettings((cur) => ({ ...cur, ...next, sections: nextSections }));
      setSections(nextSections);
    },
    [],
  );

  function addSection(type: SectionType) {
    if (!canManage || sections.length >= 50) return;
    const next = reorderSections([...sections, createDefaultSection(type, sections.length)]);
    syncSectionsToSettings(next);
    const added = next[next.length - 1];
    if (added) {
      setSelectedId(added.id);
      setSelectedElement({ id: added.id, sectionId: added.id, label: "Section" });
    }
  }

  /** Inserts a ready-made section after the selected one, as one undoable step. */
  function insertTemplate(template: SectionTemplate) {
    setLibraryOpen(false);
    if (!canManage || sections.length >= 50) return;
    const selectedAt = sections.findIndex((s) => s.id === selectedId);
    const at = selectedAt >= 0 ? selectedAt + 1 : sections.length;
    const inserted = sectionFromTemplate(template, at);
    syncSectionsToSettings(reorderSections([...sections.slice(0, at), inserted, ...sections.slice(at)]));
    setSelectedId(inserted.id);
    setSelectedElement({ id: inserted.id, sectionId: inserted.id, label: "Section" });
  }

  /** The owner's name for a section, shown only in the editor. */
  function renameSection(id: string, name: string) {
    syncSectionsToSettings(sections.map((s) => {
      if (s.id !== id) return s;
      const { name: _name, ...rest } = s;
      return (name ? { ...rest, name } : rest) as Section;
    }));
  }

  /** Copies a section (content and style) right after the original, with a new id. */
  function duplicateSection(id: string) {
    if (!canManage || sections.length >= 50) return;
    const index = sections.findIndex((s) => s.id === id);
    if (index < 0) return;
    const original = sections[index];
    const copy = { ...structuredClone(original), id: generateSectionId(original.type) } as Section;
    const next = reorderSections([...sections.slice(0, index + 1), copy, ...sections.slice(index + 1)]);
    syncSectionsToSettings(next);
    setSelectedId(copy.id);
    setSelectedElement({ id: copy.id, sectionId: copy.id, label: "Section" });
  }

  function removeSection(id: string) {
    const next = reorderSections(sections.filter((s) => s.id !== id));
    syncSectionsToSettings(next);
    if (selectedId === id) setSelectedId(null);
  }

  /** Same confirmation as the homepage editor; the removal can be undone. */
  async function confirmRemoveSection(id: string) {
    const section = sections.find((s) => s.id === id);
    if (!section) return;
    const name = sectionDisplayName(section);
    const confirmed = await confirmDialog({ title: `Remove ${name}?`, message: `"${name}" comes off this draft page. You can undo this.`, confirmLabel: "Remove section", tone: "danger" });
    if (confirmed) removeSection(id);
  }

  function reorderSection(fromId: string, toId: string, position: DropPosition) {
    syncSectionsToSettings(reorderSections(reorderById(sections, fromId, toId, position)));
  }

  function toggleVisibility(id: string) {
    const next = sections.map((s) =>
      s.id === id ? ({ ...s, visible: !s.visible } as Section) : s,
    );
    syncSectionsToSettings(next);
  }

  const updateSectionSettings = useCallback((id: string, patch: Record<string, unknown>) => {
    const next = sections.map((s) =>
      s.id === id ? ({ ...s, settings: { ...(s.settings as Record<string, unknown>), ...patch } } as Section) : s,
    );
    syncSectionsToSettings(next);
  }, [sections, syncSectionsToSettings]);

  /** Which screen sizes show a section (hidden sizes stay in the draft and on the page). */
  const updateSectionHideOn = useCallback((id: string, value: string) => {
    const next = sections.map((s) => {
      if (s.id !== id) return s;
      const { hideOn: _hideOn, ...rest } = s;
      return (value === "mobile" || value === "desktop" ? { ...rest, hideOn: value } : rest) as Section;
    });
    syncSectionsToSettings(next);
  }, [sections, syncSectionsToSettings]);

  const updateSectionStyle = useCallback((id: string, patch: Record<string, unknown>) => {
    const next = sections.map((s) =>
      s.id === id ? ({ ...s, style: { ...(s.style ?? {}), ...patch } } as Section) : s,
    );
    syncSectionsToSettings(next);
  }, [sections, syncSectionsToSettings]);

  const updateSelectedContent = useCallback(
    (path: string, value: string) => {
      if (!selectedSection) return;
      const nextSettings = writePath(selectedSection.settings, path, value);
      updateSectionSettings(
        selectedSection.id,
        nextSettings as Record<string, unknown>,
      );
    },
    [selectedSection, updateSectionSettings],
  );

  const updateSelectedElementStyle = useCallback(
    (property: keyof EditorElementStyle, value: string | number | undefined) => {
      if (!selectedSection || !selectedElementKey) return;
      const styleMap = selectedSection.style?.elementStyles ?? {};
      const current = styleMap[selectedElementKey] ?? {};
      const currentDevice: Record<string, string | number> = {
        ...(current[device] ?? {}),
      };
      if (value === undefined) delete currentDevice[property];
      else currentDevice[property] = value;
      const parsed = editorElementStyleSchema.safeParse(currentDevice);
      if (!parsed.success) return;

      const nextResponsive = { ...current };
      if (Object.keys(parsed.data).length > 0) nextResponsive[device] = parsed.data;
      else delete nextResponsive[device];
      const nextStyleMap = { ...styleMap };
      if (Object.keys(nextResponsive).length > 0) nextStyleMap[selectedElementKey] = nextResponsive;
      else delete nextStyleMap[selectedElementKey];
      updateSectionStyle(selectedSection.id, { elementStyles: nextStyleMap });
    },
    [device, selectedElementKey, selectedSection, updateSectionStyle],
  );

  const resetSelectedElementStyle = useCallback(() => {
    if (!selectedSection || !selectedElementKey) return;
    const nextStyleMap = { ...(selectedSection.style?.elementStyles ?? {}) };
    delete nextStyleMap[selectedElementKey];
    updateSectionStyle(selectedSection.id, { elementStyles: nextStyleMap });
  }, [selectedElementKey, selectedSection, updateSectionStyle]);


  const moveUp = useCallback((id: string) => {
    const idx = sections.findIndex((s) => s.id === id);
    if (idx <= 0) return;
    const next = [...sections];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    syncSectionsToSettings(reorderSections(next));
  }, [sections, syncSectionsToSettings]);

  const moveDown = useCallback((id: string) => {
    const idx = sections.findIndex((s) => s.id === id);
    if (idx < 0 || idx >= sections.length - 1) return;
    const next = [...sections];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    syncSectionsToSettings(reorderSections(next));
  }, [sections, syncSectionsToSettings]);

  /** A theme chosen in this editor stays in the design draft until it is published. */
  const saveThemeDraft = useCallback(async (nextThemeId: string, previousThemeId: string, response: EditorSaveResponse) => {
    if (nextThemeId === previousThemeId) return;
    const res = await fetch(`/api/businesses/${businessId}/design`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ themeId: nextThemeId }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new EditorSaveError(typeof data.error === "string" ? data.error : "Unable to save the theme", "theme", res.status, true, response);
  }, [businessId]);

  const save = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    // Every saved page has a record; only someone who cannot edit sees one without it.
    if (!pageId || saveInFlightRef.current || loading || !canManage) return;
    saveInFlightRef.current = true;
    const version = ++saveVersion.current;
    const submittedSnapshot = { themeId, settings, sections };
    const savedSnapshot = baselineSnapshot.current;
    if (!silent) setLoading(true);
    setSaveStatus("saving");
    setError(null);
    setSectionProblems([]);
    if (!silent) setNotice(null);
    try {
      const data = await savePageBackedEditorChanges({
        businessId,
        pageId,
        pagePayload: { sections, expectedVersion: currentVersion },
        themeId,
        savedThemeId: themeId,
        font: settings.font,
        savedFont: settings.font,
      });
      await saveThemeDraft(themeId, savedSnapshot.themeId, data);
      if (version !== saveVersion.current) return;
      if (data.page && typeof data.page.version === "number") {
        setCurrentVersion(data.page.version);
      }
      baselineSnapshot.current = submittedSnapshot;
      setSaveStatus("saved");
      setRetrySaveAt(null);
      setSavedCount((count) => count + 1);
      if (silent) return;
      setNotice("Draft saved. Your published page is unchanged until you publish it.");
      success("Draft saved", "Your published page is unchanged.");
      router.refresh();
    } catch (err) {
      if (version !== saveVersion.current) return;
      if (err instanceof EditorSaveError && err.pageSaved) {
        if (typeof err.response?.page?.version === "number") {
          setCurrentVersion(err.response.page.version);
        }
        baselineSnapshot.current = {
          ...submittedSnapshot,
          themeId: savedSnapshot.themeId,
          settings: { ...submittedSnapshot.settings, font: savedSnapshot.settings.font },
        };
      }
      setSaveStatus("error");
      // Nothing is lost in any of these: the edits stay here, and leaving the page still warns.
      const rateLimited = err instanceof EditorSaveError && err.status === 429;
      const passing = rateLimited || !(err instanceof EditorSaveError) || err.status === undefined || err.status >= 500;
      const waitMs = (err instanceof EditorSaveError ? err.retryAfterMs : undefined) ?? SAVE_RETRY_MS;
      setRetrySaveAt(passing ? Date.now() + waitMs : null);
      if (rateLimited) {
        const minutes = Math.max(1, Math.ceil(waitMs / 60000));
        const waiting = `Too many saves in a short time. Your edits are safe in this window and are saved again automatically in about ${minutes} minute${minutes === 1 ? "" : "s"}. Keep this window open until then.`;
        setError(waiting);
        showError("Not saved yet", waiting);
        return;
      }
      // A value the server refuses during autosave (half-typed, say) stays unsaved
      // without interrupting; a conflict with another edit always shows.
      if (silent && !(err instanceof EditorSaveError && err.status === 409)) return;
      const message =
        err instanceof EditorSaveError && err.pageSaved
          ? `Page content saved, but the theme or design settings were not saved. ${err.message}`
          : err instanceof EditorSaveError && err.status === 409
            ? "This page was modified elsewhere. Reload to get the latest version (unsaved edits may be lost)."
            : err instanceof Error
              ? err.message
              : "Unable to save";
      setError(message);
      setSectionProblems(sectionProblemsFrom(err, submittedSnapshot.sections));
      showError(
        err instanceof EditorSaveError && err.pageSaved
          ? "Partial save"
          : err instanceof EditorSaveError && err.status === 409
            ? "Save conflict"
            : "Save failed",
        message,
      );
    } finally {
      saveInFlightRef.current = false;
      if (!silent) setLoading(false);
    }
  }, [loading, canManage, pageId, businessId, currentVersion, router, success, showError, themeId, settings, sections, saveThemeDraft]);

  // Autosave: a quiet draft save a few seconds after the last change. A save that failed for a
  // passing reason is tried again when it may succeed, so the latest edits are never left waiting
  // for another change, and editing meanwhile does not bring that time forward.
  useEffect(() => {
    if (!pageId || !canManage || !isDirty || loading) return;
    const delay = retrySaveAt === null ? AUTOSAVE_DELAY_MS : Math.max(AUTOSAVE_DELAY_MS, retrySaveAt - Date.now());
    const timer = window.setTimeout(() => void save({ silent: true }), delay);
    return () => window.clearTimeout(timer);
  }, [pageId, canManage, isDirty, loading, sections, settings, themeId, save, retrySaveAt, savedCount]);

  /** Reloads with what the server now holds (nothing unsaved remains to warn about). */
  const reloadEditor = useCallback(() => {
    leavingRef.current = true;
    window.location.reload();
  }, []);

  const flushDraft = useCallback(async () => {
    if (isDirty) await save({ silent: true });
  }, [isDirty, save]);

  const duplicateThisPage = useCallback(async () => {
    if (!pageId) return;
    setLoading(true);
    try {
      await flushDraft();
      const res = await fetch(`/api/businesses/${businessId}/pages/${pageId}/duplicate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "This page could not be copied.");
      leavingRef.current = true;
      success("Page copied", `"${data.page.title}" is a new draft.`);
      router.push(`/dashboard/businesses/${businessId}/editor?page=${data.page._id}`);
    } catch (err) {
      showError("Copy failed", err instanceof Error ? err.message : "This page could not be copied.");
    } finally {
      setLoading(false);
    }
  }, [pageId, businessId, flushDraft, router, success, showError]);

  const revertThisPage = useCallback(async () => {
    if (!pageId) return;
    if (!(await confirmDialog({ title: "Go back to the published version?", message: "Your draft is replaced by what visitors see now. The current draft stays in the version history.", confirmLabel: "Go back", tone: "danger" }))) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/pages/${pageId}/revert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The published version could not be restored.");
      reloadEditor();
    } catch (err) {
      showError("Could not go back", err instanceof Error ? err.message : "The published version could not be restored.");
      setLoading(false);
    }
  }, [pageId, businessId, reloadEditor, showError]);

  const publishPage = useCallback(async () => {
    if (!pageId || saveInFlightRef.current || loading || !canManage) return;
    // Pages prepared from a policy/legal template need the owner's explicit
    // review (the server refuses them otherwise, and refuses any page that
    // still contains [[placeholders]]).
    const reviewNeeded = Boolean(pages?.find((page) => page._id === pageId)?.needsReview);
    if (reviewNeeded) {
      if (!(await confirmDialog({ title: "Have you reviewed this page?", message: "This page was prepared from a policy or legal template. It is not legal advice: publish it only after you have checked every statement against how your business really works. Have you reviewed it, and do you want to publish it now?", confirmLabel: "Reviewed, publish now" }))) return;
    } else if (!(await confirmDialog({ title: "Publish this page?", message: "Visitors will see the current preview.", confirmLabel: "Publish" }))) return;
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    const version = ++saveVersion.current;
    const submittedSnapshot = { themeId, settings, sections };
    const savedSnapshot = baselineSnapshot.current;
    setLoading(true);
    setSaveStatus("saving");
    setError(null);
    setSectionProblems([]);
    setNotice(null);
    try {
      const data = await savePageBackedEditorChanges({
        businessId,
        pageId,
        pagePayload: {
          sections,
          status: "published",
          expectedVersion: currentVersion,
          ...(reviewNeeded ? { confirmReviewed: true } : {}),
        },
        themeId,
        savedThemeId: themeId,
        font: settings.font,
        savedFont: settings.font,
      });
      await saveThemeDraft(themeId, savedSnapshot.themeId, data);
      if (version !== saveVersion.current) return;
      if (typeof data.page?.version === "number") {
        setCurrentVersion(data.page.version);
      }
      baselineSnapshot.current = submittedSnapshot;
      setSaveStatus("saved");
      setNotice("Page published.");
      success("Page published", "Visitors can now see these changes.");
      router.refresh();
    } catch (err) {
      if (version !== saveVersion.current) return;
      if (err instanceof EditorSaveError && err.pageSaved) {
        if (typeof err.response?.page?.version === "number") {
          setCurrentVersion(err.response.page.version);
        }
        baselineSnapshot.current = {
          ...submittedSnapshot,
          themeId: savedSnapshot.themeId,
          settings: { ...submittedSnapshot.settings, font: savedSnapshot.settings.font },
        };
      }
      setSaveStatus("error");
      const message =
        err instanceof EditorSaveError && err.pageSaved
          ? `Page published, but the theme or design settings were not saved. ${err.message}`
          : err instanceof EditorSaveError && err.status === 409 && (!err.code || err.code === "version_conflict")
            ? "This page was modified elsewhere. Reload to get the latest version."
            : err instanceof Error
              ? err.message
              : "Unable to publish this page";
      setError(message);
      setSectionProblems(sectionProblemsFrom(err, submittedSnapshot.sections));
      showError(
        err instanceof EditorSaveError && err.pageSaved
          ? "Partial publish"
          : err instanceof EditorSaveError && err.status === 409 && (!err.code || err.code === "version_conflict")
            ? "Publish conflict"
            : err instanceof EditorSaveError && err.code === "placeholders_remaining"
              ? "Replace the placeholders first"
              : "Publish failed",
        message,
      );
    } finally {
      saveInFlightRef.current = false;
      setLoading(false);
    }
  }, [
    pageId,
    loading,
    canManage,
    themeId,
    settings,
    sections,
    businessId,
    currentVersion,
    showError,
    success,
    router,
    pages,
    saveThemeDraft,
  ]);

  // Warn before navigation while local edits have not been saved as a draft.
  useEffect(() => {
    if (!canManage) return;
    const handler = (e: BeforeUnloadEvent) => {
      if ((isDirty || saveStatus === "saving") && !leavingRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [canManage, isDirty, saveStatus]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!canManage) return;

    function isTypingTarget(target: EventTarget | null): boolean {
      if (!target || !(target instanceof HTMLElement)) return false;
      const tag = target.tagName.toLowerCase();
      return (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        tag === "option" ||
        target.isContentEditable ||
        target.getAttribute("role") === "textbox"
      );
    }

    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        save();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === "Escape") {
        if (isTypingTarget(e.target)) return;
        if (selectedId) {
          e.preventDefault();
          setSelectedId(null);
          setSelectedElement(null);
          return;
        }
        if (panelOpen) {
          e.preventDefault();
          setPanelOpen(false);
          return;
        }
        return;
      }
      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        selectedId
      ) {
        if (isTypingTarget(e.target)) return;
        const idx = sections.findIndex((s) => s.id === selectedId);
        if (idx < 0) return;
        e.preventDefault();
        if (e.key === "ArrowUp" && idx > 0) {
          moveUp(selectedId);
        } else if (e.key === "ArrowDown" && idx < sections.length - 1) {
          moveDown(selectedId);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canManage, selectedId, sections, save, moveUp, moveDown, undo, redo, panelOpen]);

  const shortcutHints = [
    { keys: "Ctrl+S", action: "Save" },
    { keys: "Esc", action: "Deselect" },
    { keys: "↑↓", action: "Reorder" },
  ];


  // Header/footer of the preview come from the same commerce data builder as
  // the public store (draft storefront settings), so the preview matches it.
  const previewCommerce = useMemo(
    () => buildCommerceData(previewView, storefrontDraft, commerceExtras ?? {}),
    [previewView, storefrontDraft, commerceExtras],
  );

  const currentPage = pages?.find((page) => page._id === pageId);
  const statusText =
    saveStatus === "saving"
      ? "Saving draft…"
      : isDirty
        ? saveStatus === "error" ? "Not saved yet" : "Saving shortly…"
        : saveStatus === "error"
          ? "Save failed"
          : "All changes saved";

  const sectionDrag = useSectionDrag(reorderSection);

  /** Sidebar content when no section is selected: layer list and design. */
  const sectionsOverview = (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Sections on this page</h3>
        <p className="mt-0.5 text-xs leading-5 text-slate-500">Select a section to edit it, or click it in the preview.</p>
      </div>
      {sections.length === 0 ? (
        <p className="ui-dots-ink rounded-lg border border-dashed border-slate-300 px-3 py-5 text-center text-sm text-slate-600">This page has no sections yet. Browse the ready-made sections below to start.</p>
      ) : (
        <ol className="space-y-1.5" aria-label="Page sections">
          {sections.map((section, index) => (
            <SectionRow
              key={section.id}
              id={section.id}
              name={sectionDisplayName(section)}
              detail={`${SECTION_TYPE_LABELS[section.type]} · ${section.visible ? "Shown" : "Hidden"}`}
              muted={!section.visible}
              isFirst={index === 0}
              isLast={index === sections.length - 1}
              visible={section.visible}
              disabled={!canManage}
              drag={sectionDrag}
              onSelect={() => {
                setSelectedId(section.id);
                setSelectedElement({ id: section.id, sectionId: section.id, label: "Section" });
              }}
              onMove={(direction) => (direction < 0 ? moveUp(section.id) : moveDown(section.id))}
              onToggle={() => toggleVisibility(section.id)}
              onRemove={() => void confirmRemoveSection(section.id)}
            />
          ))}
        </ol>
      )}
      <AddSectionMenu
        options={SECTION_TYPES.map((type) => ({ key: type, label: SECTION_TYPE_LABELS[type], description: SECTION_TYPE_DESCRIPTIONS[type] }))}
        disabled={!canManage || sections.length >= 50}
        disabledNote={canManage ? "A page can have up to 50 sections." : undefined}
        onAdd={(key) => addSection(key as SectionType)}
      >
        <button type="button" disabled={!canManage || sections.length >= 50} onClick={() => setLibraryOpen(true)} className={`mt-1.5 flex min-h-10 w-full items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:opacity-50 ${controlFocus}`}>
          Browse ready-made sections
        </button>
      </AddSectionMenu>
      <div className="space-y-3 border-t border-slate-200 pt-4">
        <h3 className="text-sm font-semibold text-slate-900">Store design</h3>
        <label className="block text-xs font-medium text-slate-700">
          Theme
          <select value={themeId} onChange={(e) => setThemeId(e.target.value)} disabled={!canManage} className={`mt-1 block w-full ${toolbarSelectClass}`}>
            {THEMES.map((t) => {
              const locked = !canSelectTheme(themeAccess, t.id);
              const plan = themeAccess.requiredPlan[t.id];
              return (
                <option key={t.id} value={t.id} disabled={locked}>
                  {t.name}{locked ? ` (${plan ? plan.name : "unavailable"} plan)` : ""}
                </option>
              );
            })}
          </select>
        </label>
        <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-700">
          A new theme stays in your draft and goes live when you publish it in{" "}
          <a href={`/dashboard/businesses/${businessId}/publish`} className={`rounded font-medium underline underline-offset-2 ${controlFocus}`}>Publish</a>.{" "}
          Colours, fonts and buttons are in{" "}
          <a href={`/dashboard/businesses/${businessId}/design`} className={`rounded font-medium underline underline-offset-2 ${controlFocus}`}>Design</a>.
        </p>
      </div>
      <div className="hidden flex-wrap gap-2 text-xs text-slate-500 lg:flex">
        {shortcutHints.map((hint) => (
          <span key={hint.action} className="flex items-center gap-1">
            <kbd className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium">{hint.keys}</kbd>
            <span>{hint.action}</span>
          </span>
        ))}
      </div>
    </div>
  );

  return (
    <>
    <EditorWorkspace
      toolbar={
        <EditorToolbar
          title={`${base.name} · ${currentPage ? (currentPage.isHome ? "Homepage" : currentPage.title) : "Homepage"}`}
          status={statusText}
          saveTone={saveStatus === "saving" ? "busy" : isDirty ? "unsaved" : saveStatus === "error" ? "error" : "saved"}
          viewing={
            !currentPage
              ? { label: "Homepage", detail: "You can view this homepage. An owner or manager can edit it." }
              : currentPage.status === "published"
                ? { label: "Draft", tone: "warning", detail: "This page is live. Visitors see the last version until you publish updates." }
                : { label: "Draft", detail: "This page is not published, so visitors cannot see it." }
          }
          leading={
            pages && pages.length > 0 ? (
              <select
                value={pageId ?? ""}
                onChange={async (event) => {
                  const next = event.target.value;
                  if (isDirty && !(await confirmDialog({ title: "Switch pages?", message: "Your unsaved edits on this page will be lost.", confirmLabel: "Discard and switch", tone: "danger" }))) return;
                  router.push(`/dashboard/businesses/${businessId}/editor${next ? `?page=${encodeURIComponent(next)}` : ""}`);
                }}
                disabled={!canManage}
                className={editorSelectClass}
                aria-label="Website page"
              >
                {!pages.some((page) => page.isHome && page.status === "published") && <option value="">Store homepage</option>}
                {pages.map((page) => (
                  <option key={page._id} value={page._id}>
                    {page.isHome ? "Homepage" : page.title}{page.status === "published" ? "" : " (draft)"}
                  </option>
                ))}
              </select>
            ) : null
          }
          canUndo={historyStatus.canUndo}
          canRedo={historyStatus.canRedo}
          onUndo={undo}
          onRedo={redo}
          device={device}
          onDeviceChange={setDevice}
          onSave={() => void save()}
          saveDisabled={!canManage}
          busy={loading}
          onPreview={() => window.open(`/dashboard/businesses/${businessId}/preview${pageId ? `?page=${encodeURIComponent(pageId)}` : ""}`, "_blank", "noopener")}
          onPublish={pageId && canManage ? () => void publishPage() : undefined}
          publishLabel={currentPage?.status === "published" ? "Publish updates" : "Publish page"}
          assistant={pageAi && currentPage && !currentPage.isHome ? { open: aiOpen, onToggle: () => setAiOpen((open) => !open) } : undefined}
          more={[
            { label: panelOpen ? "Hide editing panel" : "Show editing panel", onSelect: () => setPanelOpen((open) => !open) },
            ...(saveStatus === "error" ? [{ label: "Reload latest version", onSelect: () => router.refresh() }] : []),
            ...(pageId && canManage && currentPage
              ? [
                  { label: "Page settings", onSelect: () => void flushDraft().then(() => setSettingsOpen(true)) },
                  { label: "Share a draft preview", onSelect: () => setShareOpen(true) },
                  { label: "Version history", onSelect: () => setHistoryOpen(true) },
                  ...(currentPage.status === "published" ? [{ label: "Go back to the published version", onSelect: () => void revertThisPage() }] : []),
                  { label: "Duplicate this page", onSelect: () => void duplicateThisPage(), disabled: loading },
                  { label: "Everything waiting to publish", onSelect: () => router.push(`/dashboard/businesses/${businessId}/publish`) },
                ]
              : []),
            { label: "Discard unsaved changes", onSelect: () => void discardChanges(), disabled: !isDirty || loading, danger: true },
          ]}
        />
      }
      notices={
        <>
          {aiOpen && pageAi && currentPage && !currentPage.isHome && (
            <AiBuilder
              businessId={businessId}
              available={pageAi.available}
              consentView={pageAi.consent}
              usage={pageAi.usage}
              planName={pageAi.planName}
              isOwner={pageAi.isOwner}
              pages={(pages ?? []).map((p) => ({ id: p._id, title: p.title, slug: p.slug, status: p.status === "published" ? "published" : "draft", isHome: Boolean(p.isHome) }))}
              products={[]}
              categories={[]}
              lockedPage={{ id: currentPage._id, title: currentPage.title, slug: currentPage.slug, status: currentPage.status === "published" ? "published" : "draft", isHome: false }}
              dirty={isDirty}
              previewData={storefrontDraft ? { view: previewView, config: storefrontDraft, extras: commerceExtras ?? {} } : null}
              // A draft page changed on the server: load it. A published page got a new draft page instead.
              onApplied={currentPage.status === "published" ? undefined : () => window.location.reload()}
            />
          )}
          {saveStatus === "error" && isDirty && !error && (
            <Notice tone="warning" role="status" title="Your latest changes aren't saved yet" action={<button type="button" onClick={() => void save()} className={toolbarButtonClass}>Save now</button>}>
              {retrySaveAt !== null ? "They're safe in this window, and saving is tried again shortly. Keep this window open until they are saved." : "They're safe in this window. Save now to see what needs fixing."}
            </Notice>
          )}
          {!currentPage?.generated && findVisiblePlaceholders(sections).length > 0 && (
            <Notice tone="info" role="status">Replace the {findVisiblePlaceholders(sections).length === 1 ? "text" : `${findVisiblePlaceholders(sections).length} texts`} in [[double brackets]] with your own: this page can&apos;t be published until you do.</Notice>
          )}
          {currentPage?.generated && (() => {
            const left = findPlaceholders(sections).length;
            return (
              <Notice role="status" tone={left > 0 || currentPage.needsReview ? "warning" : "success"} title={`${currentPage.generatedByAi ? "Written by the AI assistant from your store details." : "Prepared for you from your store details."} Nothing is published until you publish it.`}>
                {left > 0
                  ? `Replace the ${left === 1 ? "text in [[double brackets]]" : `${left} texts in [[double brackets]]`} with your own details: the page cannot be published while any remain.`
                  : "Every placeholder has been replaced."}
                {currentPage.needsReview && " This is a policy template, not legal advice: you will be asked to confirm your review when you publish."}
              </Notice>
            );
          })()}
          {classicHomepage && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span>This homepage uses older custom sections instead of the store homepage (categories, products, best sellers…).</span>
              <a href={`/dashboard/businesses/${businessId}/editor?mode=store`} className={`inline-flex min-h-10 items-center rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-brand-700 ${controlFocus}`}>
                Switch to the store homepage
              </a>
            </div>
          )}
          <span className="sr-only" aria-live="polite">
            {selectedElement ? `Selected ${selectedElement.label}` : "No element selected"}
          </span>
          {notice && (
            <div aria-live="polite"><Notice tone="success">{notice}</Notice></div>
          )}
          {error && (
            <Notice tone="danger" role="alert">{error}</Notice>
          )}
          {sectionProblems.length > 0 && (
            <ul className="space-y-1 text-sm text-red-700">
              {sectionProblems.map((problem) => (
                <li key={problem.key}>
                  {problem.sectionId ? (
                    <button type="button" onClick={() => setSelectedId(problem.sectionId)} className="font-medium underline underline-offset-2">{problem.label}</button>
                  ) : (
                    <span className="font-medium">{problem.label}</span>
                  )}
                  : {problem.message}
                </li>
              ))}
            </ul>
          )}
        </>
      }
      canvasLabel={currentPage ? "Draft preview" : "Preview"}
      canvasMeta={<span className="hidden sm:inline">{previewLayout ? previewLayoutLabel(previewLayout) : null}</span>}
      canvas={
        <div className="h-full p-3 sm:p-4">
          <div
            className="h-full"
            onClickCapture={(event) => {
              selectCanvasElement(event);
              if (event.defaultPrevented && canManage) setPanelOpen(true);
            }}
            onKeyDownCapture={selectCanvasElementByKeyboard}
            onSubmitCapture={(event) => event.preventDefault()}
          >
            <PreviewFrame
              device={device}
              title="Page preview"
              onLayout={(next) => setPreviewLayout((prev) => (prev && prev.device === next.device && prev.viewport === next.viewport && prev.scale === next.scale ? prev : next))}
            >
              <ThemeRenderer
                view={previewView}
                productHrefBase="#"
                preview
                commerce={previewCommerce}
                editable={canManage}
                selectedElementId={selectedElement?.id}
                onSelectElement={setSelectedId}
                sections={sections}
                draggableSections={canManage}
                onReorderSections={reorderSection}
                onCommitElementOffset={(id, x, y) => {
                  const sectionId = id.split(":")[0];
                  const elementKey = id.slice(sectionId.length + 1);
                  const section = sections.find((s) => s.id === sectionId);
                  if (!section || !elementKey) return;
                  const styleMap = section.style?.elementStyles ?? {};
                  const current = styleMap[elementKey] ?? {};
                  const currentDevice: Record<string, string | number> = {
                    ...(current[device] ?? {}),
                  };
                  currentDevice.offsetX = x;
                  currentDevice.offsetY = y;
                  const parsed = editorElementStyleSchema.safeParse(currentDevice);
                  if (!parsed.success) return;
                  const nextResponsive = { ...current };
                  if (Object.keys(parsed.data).length > 0) nextResponsive[device] = parsed.data;
                  else delete nextResponsive[device];
                  const nextStyleMap = { ...styleMap };
                  if (Object.keys(nextResponsive).length > 0) nextStyleMap[elementKey] = nextResponsive;
                  else delete nextStyleMap[elementKey];
                  updateSectionStyle(section.id, { elementStyles: nextStyleMap });
                }}
                elementOffsetMap={elementOffsetMap}
              />
            </PreviewFrame>
          </div>
        </div>
      }
      sidebarTitle={selectedSection ? sectionDisplayName(selectedSection) : "Page sections"}
      sidebar={
        <>
          {selectedSection ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(null);
                    setSelectedElement(null);
                  }}
                  className={`-ml-1 inline-flex min-h-10 items-center gap-1.5 rounded-lg px-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900 lg:min-h-8 ${controlFocus}`}
                >
                  <Icon name="arrow-left" size={14} /> All sections
                </button>
                {!selectedSection.visible && <Pill tone="warning">Hidden</Pill>}
              </div>
              <h2 className="sr-only">
                {SECTION_TYPE_LABELS[selectedSection.type]} section settings
              </h2>
              <SectionPanelActions
                isFirst={sections.findIndex((s) => s.id === selectedSection.id) <= 0}
                isLast={sections.findIndex((s) => s.id === selectedSection.id) >= sections.length - 1}
                visible={selectedSection.visible}
                disabled={!canManage}
                duplicateDisabled={sections.length >= 50}
                onMove={(direction) => (direction < 0 ? moveUp(selectedSection.id) : moveDown(selectedSection.id))}
                onToggle={() => toggleVisibility(selectedSection.id)}
                onDuplicate={() => duplicateSection(selectedSection.id)}
                onRemove={() => void confirmRemoveSection(selectedSection.id)}
              />
              <SectionNameField value={selectedSection.name} placeholder={SECTION_TYPE_LABELS[selectedSection.type]} disabled={!canManage} onChange={(name) => renameSection(selectedSection.id, name)} />
              <ResponsiveControls device={device} disabled={!canManage} value={selectedSection.style?.responsive} onChange={(responsive) => updateSectionStyle(selectedSection.id, { responsive })} />

              {selectedElement?.sectionId === selectedSection.id && selectedElement.id !== selectedSection.id && (
                <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-800">
                      {pageId ? pages?.find((page) => page._id === pageId)?.title ?? "Page" : "Home"}
                      {" → "}{SECTION_TYPE_LABELS[selectedSection.type]} section
                      {" → "}{selectedElement.label}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Changes apply only to this element at the selected screen size.
                    </p>
                  </div>
                  {selectedElement.contentPath && (
                    <label className="block text-xs font-medium text-slate-700">
                      <span className="mb-1 block">Content</span>
                      {/(?:body|answer|description|quote)$/.test(selectedElement.contentPath) ? (
                        <textarea
                          className={inputClass}
                          rows={3}
                          value={typeof selectedContentValue === "string" ? selectedContentValue : ""}
                          onChange={(event) =>
                            updateSelectedContent(selectedElement.contentPath!, event.target.value)
                          }
                        />
                      ) : (
                        <input
                          className={inputClass}
                          value={typeof selectedContentValue === "string" ? selectedContentValue : ""}
                          onChange={(event) =>
                            updateSelectedContent(selectedElement.contentPath!, event.target.value)
                          }
                        />
                      )}
                    </label>
                  )}
                  {selectedLinkPath && (
                    <label className="block text-xs font-medium text-slate-700">
                      Link destination
                      <input
                        type="url"
                        autoComplete="off"
                        className={inputClass}
                        value={
                          typeof readPath(selectedSection.settings, selectedLinkPath) === "string"
                            ? (readPath(selectedSection.settings, selectedLinkPath) as string)
                            : ""
                        }
                        onChange={(event) =>
                          updateSelectedContent(selectedLinkPath, event.target.value)
                        }
                        placeholder="https://example.com or /contact"
                      />
                    </label>
                  )}
                  <ElementStyleControls
                    style={selectedElementStyle as EditorElementStyle}
                    onChange={updateSelectedElementStyle}
                    onReset={resetSelectedElementStyle}
                  />
                </div>
              )}

              <SectionContentFields
                section={selectedSection}
                businessId={businessId}
                categories={[...new Map(products.map((p) => (p.category ?? "").trim()).filter(Boolean).map((n) => [n.toLowerCase(), n] as const)).values()].sort((a, b) => a.localeCompare(b))}
                onChange={(p) => updateSectionSettings(selectedSection.id, p)}
              />

              <div className="border-t border-slate-200 pt-4">
                <h3 className="text-sm font-semibold text-slate-900">Style</h3>
                <div className="mt-3 space-y-3">
                  <div>
                    <label className={propLabel}>Background color</label>
                    <input
                      type="color"
                      value={(selectedSection.style?.backgroundColor as string) || "#ffffff"}
                      onChange={(e) =>
                        updateSectionStyle(selectedSection.id, { backgroundColor: e.target.value })
                      }
                      className={`h-10 w-full cursor-pointer rounded-lg border border-slate-300 bg-white p-1 ${controlFocus}`}
                    />
                  </div>
                  <div>
                    <label className={propLabel}>Text color</label>
                    <input
                      type="color"
                      value={(selectedSection.style?.textColor as string) || "#000000"}
                      onChange={(e) =>
                        updateSectionStyle(selectedSection.id, { textColor: e.target.value })
                      }
                      className={`h-10 w-full cursor-pointer rounded-lg border border-slate-300 bg-white p-1 ${controlFocus}`}
                    />
                  </div>
                  <div>
                    <label className={propLabel}>Padding</label>
                    <select
                      value={selectedSection.style?.padding ?? "md"}
                      onChange={(e) =>
                        updateSectionStyle(selectedSection.id, { padding: e.target.value })
                      }
                      className={inputClass}
                    >
                      {[["none", "None"], ["sm", "Small"], ["md", "Medium"], ["lg", "Large"], ["xl", "Extra large"]].map(([value, name]) => (
                        <option key={value} value={value}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-200 pt-3">
                <label className={propLabel}>
                  Show on
                  <select value={selectedSection.hideOn ?? "all"} onChange={(e) => updateSectionHideOn(selectedSection.id, e.target.value)} className={inputClass}>
                    <option value="all">All screen sizes</option>
                    <option value="mobile">Larger screens only</option>
                    <option value="desktop">Phones only</option>
                  </select>
                </label>
                <label className="flex min-h-10 items-center gap-2 text-xs font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={selectedSection.visible}
                    onChange={() => toggleVisibility(selectedSection.id)}
                    className="h-4 w-4 rounded"
                  />
                  Visible on site
                </label>
              </div>
            </div>
          ) : (
            sectionsOverview
          )}
        </>
      }
      sidebarOpen={panelOpen}
      onSidebarOpenChange={setPanelOpen}
    />
    {settingsOpen && pageId && currentPage && (
      <PageSettingsDialog
        businessId={businessId}
        businessName={base.name}
        sections={sections}
        page={{
          _id: currentPage._id,
          title: currentPage.title,
          slug: currentPage.slug,
          status: currentPage.status === "published" ? "published" : "draft",
          isHome: Boolean(currentPage.isHome),
          version: currentVersion ?? 0,
          seoTitle: currentPage.seoTitle,
          seoDescription: currentPage.seoDescription,
          seoImage: currentPage.seoImage,
          noindex: currentPage.noindex,
          canonicalUrl: currentPage.canonicalUrl,
        }}
        onClose={() => setSettingsOpen(false)}
        onSaved={(page) => {
          setCurrentVersion(page.version);
          setSettingsOpen(false);
          success("Settings saved", page.status === "published" ? "Search settings go live when you publish this page." : "They apply once the page is published.");
          router.refresh();
        }}
      />
    )}
    {libraryOpen && <SectionLibrary onInsert={insertTemplate} onClose={() => setLibraryOpen(false)} />}
    {shareOpen && pageId && currentPage && (
      <PreviewLinksDialog businessId={businessId} page={{ id: pageId, title: currentPage.title }} prepare={flushDraft} onClose={() => setShareOpen(false)} />
    )}
    {historyOpen && pageId && currentPage && (
      <RevisionHistoryDialog businessId={businessId} target="page" targetId={pageId} title={currentPage.title} onClose={() => setHistoryOpen(false)} onRestored={reloadEditor} />
    )}
    </>
  );
}

function ElementStyleControls({
  style,
  onChange,
  onReset,
}: {
  style: EditorElementStyle;
  onChange: (property: keyof EditorElementStyle, value: string | number | undefined) => void;
  onReset: () => void;
}) {
  const [unitOverrides, setUnitOverrides] = useState<
    Partial<Record<keyof EditorElementStyle, "px" | "rem" | "%">>
  >({});

  function colorControl(
    label: string,
    property: "color" | "backgroundColor" | "borderColor",
    fallback: string,
  ) {
    return (
      <label className="block text-xs">
        <span className="mb-1 block font-medium">{label}</span>
        <span className="flex items-center gap-2">
          <input
            type="color"
            value={(style[property] as string | undefined) ?? fallback}
            onChange={(event) => onChange(property, event.target.value)}
            className={`h-9 w-11 cursor-pointer rounded-lg border border-slate-300 bg-white p-0.5 ${controlFocus}`}
            aria-label={label}
          />
          <span className="text-slate-500">{style[property] ?? fallback}</span>
          {style[property] !== undefined && (
            <button type="button" onClick={() => onChange(property, undefined)} className={`ml-auto rounded font-medium text-slate-800 underline underline-offset-2 ${controlFocus}`}>
              Reset
            </button>
          )}
        </span>
      </label>
    );
  }

  function lengthControl(
    label: string,
    property: keyof EditorElementStyle,
    max: number,
  ) {
    const units = ["px", "rem", "%"] as const;
    const value = style[property];
    const current = typeof value === "string" ? value : "";
    const unit =
      unitOverrides[property] ??
      units.find((candidate) => current.endsWith(candidate)) ??
      "px";
    const numeric = current ? Number.parseFloat(current) : "";
    return (
      <label className="block text-xs">
        <span className="mb-1 block font-medium">{label}</span>
        <span className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            max={max}
            step="any"
            value={numeric}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              if (event.target.value === "") onChange(property, undefined);
              else if (Number.isFinite(parsed) && parsed >= 0 && parsed <= max) {
                onChange(property, `${parsed}${unit}`);
              }
            }}
            className={`min-h-10 min-w-0 flex-1 rounded-lg border px-2 py-1.5 ${controlFocus}`}
            aria-label={label}
          />
          <select
            value={unit}
            onChange={(event) => {
              const selectedUnit = event.target.value as "px" | "rem" | "%";
              setUnitOverrides((previous) => ({ ...previous, [property]: selectedUnit }));
              if (numeric !== "") onChange(property, `${numeric}${selectedUnit}`);
            }}
            className={`min-h-10 rounded-lg border px-1.5 py-1.5 ${controlFocus}`}
            aria-label={`${label} unit`}
          >
            {units.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          {value !== undefined && (
            <button type="button" onClick={() => onChange(property, undefined)} className={`rounded font-medium text-slate-800 underline underline-offset-2 ${controlFocus}`}>
              Reset
            </button>
          )}
        </span>
      </label>
    );
  }

  return (
    <div className="space-y-3 border-t border-slate-200 pt-3">
      <div>
        <h3 className="text-xs font-semibold text-slate-800">Element style</h3>
        <p className="text-xs text-slate-500">Dimensions use px, rem, or %.</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {colorControl("Text color", "color", "#111827")}
        {colorControl("Background", "backgroundColor", "#ffffff")}
        {colorControl("Border color", "borderColor", "#cbd5e1")}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {lengthControl("Font size", "fontSize", 160)}
        {lengthControl("Width", "width", 9999)}
        {lengthControl("Max width", "maxWidth", 9999)}
        {lengthControl("Padding", "padding", 999)}
        {lengthControl("Margin", "margin", 999)}
        {lengthControl("Border width", "borderWidth", 32)}
        {lengthControl("Corner radius", "borderRadius", 500)}
        {lengthControl("Letter spacing", "letterSpacing", 80)}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">
          <span className="mb-1 block font-medium">Font weight</span>
          <select
            value={style.fontWeight ?? ""}
            onChange={(event) => onChange("fontWeight", event.target.value || undefined)}
            className={`min-h-10 w-full rounded-lg border px-2 py-1.5 ${controlFocus}`}
          >
            <option value="">Theme default</option>
            {["400", "500", "600", "700", "800"].map((weight) => <option key={weight} value={weight}>{weight}</option>)}
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium">Text alignment</span>
          <select
            value={style.textAlign ?? ""}
            onChange={(event) => onChange("textAlign", event.target.value || undefined)}
            className={`min-h-10 w-full rounded-lg border px-2 py-1.5 ${controlFocus}`}
          >
            <option value="">Theme default</option>
            {["left", "center", "right", "justify"].map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium">Line height</span>
          <input
            type="number"
            min="0.8"
            max="3"
            step="0.1"
            value={style.lineHeight ?? ""}
            onChange={(event) => onChange("lineHeight", event.target.value ? Number(event.target.value) : undefined)}
            className={`min-h-10 w-full rounded-lg border px-2 py-1.5 ${controlFocus}`}
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium">Opacity</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={style.opacity ?? 1}
            onChange={(event) => onChange("opacity", Number(event.target.value))}
            className="w-full"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium">Shadow</span>
          <select
            value={style.boxShadow ?? "none"}
            onChange={(event) => onChange("boxShadow", event.target.value === "none" ? undefined : event.target.value)}
            className={`min-h-10 w-full rounded-lg border px-2 py-1.5 ${controlFocus}`}
          >
            {["none", "sm", "md", "lg"].map((shadow) => <option key={shadow} value={shadow}>{shadow}</option>)}
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium">Image fit</span>
          <select
            value={style.objectFit ?? ""}
            onChange={(event) => onChange("objectFit", event.target.value || undefined)}
            className={`min-h-10 w-full rounded-lg border px-2 py-1.5 ${controlFocus}`}
          >
            <option value="">Theme default</option>
            {["cover", "contain", "fill"].map((fit) => <option key={fit} value={fit}>{fit}</option>)}
          </select>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">
          <span className="mb-1 block font-medium">Offset X</span>
          <input
            type="number"
            min="-2000"
            max="2000"
            step="1"
            value={style.offsetX ?? ""}
            onChange={(event) => onChange("offsetX", event.target.value ? Number(event.target.value) : undefined)}
            className={`min-h-10 w-full rounded-lg border px-2 py-1.5 ${controlFocus}`}
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block font-medium">Offset Y</span>
          <input
            type="number"
            min="-2000"
            max="2000"
            step="1"
            value={style.offsetY ?? ""}
            onChange={(event) => onChange("offsetY", event.target.value ? Number(event.target.value) : undefined)}
            className={`min-h-10 w-full rounded-lg border px-2 py-1.5 ${controlFocus}`}
          />
        </label>
      </div>
      <button
        type="button"
        onClick={onReset}
        className={`min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition-colors hover:border-slate-400 hover:bg-slate-50 lg:min-h-8 ${controlFocus}`}
      >
        Reset element style
      </button>
    </div>
  );
}

/** A section's content fields, shared by the page editor and the homepage's content blocks. */
export function SectionContentFields({
  section,
  businessId,
  categories,
  onChange,
}: {
  section: Section;
  businessId: string;
  categories: string[];
  onChange: (patch: Record<string, unknown>) => void;
}) {
  return (
    <>
    {section.type === "hero" && (
      <HeroProps
        businessId={businessId}
        settings={section.settings as Record<string, string>}
        onChange={onChange}
      />
    )}
    {section.type === "products" && (
      <ProductsProps
        settings={section.settings as Record<string, string>}
        onChange={onChange}
        categories={categories}
      />
    )}
    {section.type === "about" && (
      <AboutProps
        businessId={businessId}
        settings={section.settings as Record<string, string>}
        onChange={onChange}
      />
    )}
    {section.type === "features" && (
      <FeaturesProps
        settings={section.settings as { title?: string; items?: { title: string; description: string }[] }}
        onChange={onChange}
      />
    )}
    {section.type === "cta" && (
      <CtaProps
        settings={section.settings as Record<string, string>}
        onChange={onChange}
      />
    )}
    {section.type === "footer" && (
      <FooterProps
        settings={section.settings as Record<string, string>}
        onChange={onChange}
      />
    )}
    {section.type === "faq" && (
      <FaqProps
        settings={section.settings as { title?: string; items?: { question: string; answer: string }[] }}
        onChange={onChange}
      />
    )}
    {section.type === "testimonials" && (
      <TestimonialsProps
        businessId={businessId}
        settings={section.settings as { title?: string; items?: { quote: string; name: string; role?: string; imageUrl?: string; imageAlt?: string }[] }}
        onChange={onChange}
      />
    )}
    {section.type === "gallery" && (
      <GalleryProps
        businessId={businessId}
        settings={section.settings as { title?: string; images?: { url?: string; alt?: string; caption?: string }[]; columns?: string }}
        onChange={onChange}
      />
    )}
    {section.type === "pricing" && (
      <PricingProps
        settings={section.settings as { title?: string; plans?: { title: string; price: string; period?: string; features?: string[]; ctaText?: string; ctaHref?: string; highlighted?: boolean }[] }}
        onChange={onChange}
      />
    )}
    {section.type === "contact" && (
      <ContactProps
        settings={section.settings as { title?: string; description?: string; email?: string; phone?: string; address?: string; ctaText?: string; ctaHref?: string }}
        onChange={onChange}
      />
    )}
    {section.type === "newsletter" && (
      <NewsletterProps
        settings={section.settings as { headline?: string; description?: string; buttonText?: string; placeholder?: string; ctaHref?: string }}
        onChange={onChange}
      />
    )}
    {section.type === "stats" && (
      <StatsProps
        settings={section.settings as { title?: string; items?: { value: string; label: string }[] }}
        onChange={onChange}
      />
    )}
      <ContentSectionFields section={section} businessId={businessId} onChange={onChange} />
    </>
  );
}

// --- Property sub-components ---

function SectionImageField({
  businessId,
  contextLabel,
  settings,
  onChange,
}: {
  businessId: string;
  contextLabel: string;
  settings: Record<string, string>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  const imageUrl = settings.imageUrl ?? "";

  return (
    <div>
      <span className={propLabel}>Image</span>
      <div className="flex items-start gap-3">
        {imageUrl ? (
          <ProductThumb
            imageUrl={imageUrl}
            name={settings.imageAlt || "Section image"}
            sizeClassName="h-16 w-24"
          />
        ) : (
          <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-xs text-slate-500 ring-1 ring-slate-200">
            No image
          </div>
        )}
        <div className="min-w-0 flex-1">
          <MediaPicker
            businessId={businessId}
            selectedUrl={imageUrl}
            onSelect={(selection) =>
              onChange(
                selection
                  ? { imageUrl: selection.url, imageAlt: selection.altText }
                  : { imageUrl: "", imageAlt: "" },
              )
            }
            allowClear
            contextLabel={contextLabel}
          />
          <p className="mt-2 text-xs leading-5 text-slate-500">
            {settings.imageAlt
              ? `Alt text: ${settings.imageAlt}`
              : imageUrl
                ? "No alt text yet. Add it in Media, then reselect this image to copy it."
                : "Optional. Choose an uploaded image."}
          </p>
        </div>
      </div>
    </div>
  );
}

function HeroProps({
  businessId,
  settings,
  onChange,
}: {
  businessId: string;
  settings: Record<string, string>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <SectionImageField
        businessId={businessId}
        contextLabel="hero image"
        settings={settings}
        onChange={onChange}
      />
      <div>
        <label className={propLabel}>Headline</label>
        <input
          className={inputClass}
          value={settings.headline ?? ""}
          onChange={(e) => onChange({ headline: e.target.value })}
        />
      </div>
      <div>
        <label className={propLabel}>Subheadline</label>
        <textarea
          className={inputClass}
          rows={3}
          value={settings.subheadline ?? ""}
          onChange={(e) => onChange({ subheadline: e.target.value })}
        />
      </div>
      <div>
        <label className={propLabel}>CTA button text</label>
        <input
          className={inputClass}
          value={settings.ctaText ?? ""}
          onChange={(e) => onChange({ ctaText: e.target.value })}
        />
      </div>
      <div>
        <label className={propLabel}>CTA link</label>
        <input
          className={inputClass}
          value={settings.ctaHref ?? ""}
          onChange={(e) => onChange({ ctaHref: e.target.value })}
          placeholder="https://example.com or /contact…"
        />
      </div>
    </div>
  );
}

function ProductsProps({
  settings,
  onChange,
  categories,
}: {
  settings: Record<string, string>;
  onChange: (p: Record<string, unknown>) => void;
  /** The store's real product categories. */
  categories: string[];
}) {
  const limit = (settings as Record<string, unknown>).limit;
  return (
    <div className="space-y-3">
      <div>
        <label className={propLabel} htmlFor="products-category">Category</label>
        <select id="products-category" className={inputClass} value={settings.category ?? ""} onChange={(e) => onChange({ category: e.target.value || undefined })}>
          <option value="">All products</option>
          {categories.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
          {settings.category && !categories.some((c) => c.toLowerCase() === settings.category.toLowerCase()) && <option value={settings.category}>{settings.category} (no products now)</option>}
        </select>
      </div>
      <div>
        <label className={propLabel} htmlFor="products-collection">Show</label>
        <select id="products-collection" className={inputClass} value={settings.collection ?? "all"} onChange={(e) => onChange({ collection: e.target.value })}>
          <option value="all">All matching products</option>
          <option value="new">Newest first</option>
          <option value="sale">Only reduced prices</option>
        </select>
      </div>
      <div>
        <label className={propLabel} htmlFor="products-limit">Number of products (blank = all)</label>
        <input
          id="products-limit"
          type="number"
          min={1}
          max={48}
          className={inputClass}
          value={typeof limit === "number" ? String(limit) : ""}
          onChange={(e) => {
            const value = Number(e.target.value);
            onChange({ limit: e.target.value === "" || !Number.isInteger(value) ? undefined : Math.min(48, Math.max(1, value)) });
          }}
        />
      </div>
      <div>
        <label className={propLabel}>Section title</label>
        <input
          className={inputClass}
          value={settings.title ?? ""}
          onChange={(e) => onChange({ title: e.target.value })}
        />
      </div>
      <div>
        <label className={propLabel}>Columns</label>
        <select
          className={inputClass}
          value={settings.columns ?? "3"}
          onChange={(e) => onChange({ columns: e.target.value })}
        >
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="4">4</option>
        </select>
      </div>
    </div>
  );
}

function AboutProps({
  businessId,
  settings,
  onChange,
}: {
  businessId: string;
  settings: Record<string, string>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <label className={propLabel}>Title</label>
        <input
          className={inputClass}
          value={settings.title ?? ""}
          onChange={(e) => onChange({ title: e.target.value })}
        />
      </div>
      <div>
        <label className={propLabel}>Body</label>
        <textarea
          className={inputClass}
          rows={6}
          value={settings.body ?? ""}
          onChange={(e) => onChange({ body: e.target.value })}
        />
      </div>
      <SectionImageField
        businessId={businessId}
        contextLabel="about section image"
        settings={settings}
        onChange={onChange}
      />
    </div>
  );
}

function FeaturesProps({
  settings,
  onChange,
}: {
  settings: { title?: string; items?: { title: string; description: string }[] };
  onChange: (p: Record<string, unknown>) => void;
}) {
  const items = settings.items ?? [];
  return (
    <div className="space-y-3">
      <div>
        <label className={propLabel}>Title</label>
        <input
          className={inputClass}
          value={settings.title ?? ""}
          onChange={(e) => onChange({ title: e.target.value })}
        />
      </div>
      <div>
        <label className={propLabel}>Items</label>
        <div className="space-y-2">
          {items.map((item, idx) => (
            <div key={idx} className={itemCard}>
              <input
                className={inputClass}
                placeholder="Title"
                value={item.title}
                onChange={(e) => {
                  const next = [...items];
                  next[idx] = { ...item, title: e.target.value };
                  onChange({ items: next });
                }}
              />
              <textarea
                className={`${inputClass} mt-1`}
                placeholder="Description"
                rows={2}
                value={item.description}
                onChange={(e) => {
                  const next = [...items];
                  next[idx] = { ...item, description: e.target.value };
                  onChange({ items: next });
                }}
              />
              <button
                type="button"
                onClick={() => {
                  const next = items.filter((_, i) => i !== idx);
                  onChange({ items: next });
                }}
                className={removeItem}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onChange({ items: [...items, { title: "", description: "" }] })}
            className={addItem}
          >
            + Add item
          </button>
        </div>
      </div>
    </div>
  );
}

function CtaProps({
  settings,
  onChange,
}: {
  settings: Record<string, string>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <label className={propLabel}>Headline</label>
        <input
          className={inputClass}
          value={settings.headline ?? ""}
          onChange={(e) => onChange({ headline: e.target.value })}
        />
      </div>
      <div>
        <label className={propLabel}>Button text</label>
        <input
          className={inputClass}
          value={settings.buttonText ?? ""}
          onChange={(e) => onChange({ buttonText: e.target.value })}
        />
      </div>
      <div>
        <label className={propLabel}>Button link</label>
        <input
          className={inputClass}
          value={settings.buttonHref ?? ""}
          onChange={(e) => onChange({ buttonHref: e.target.value })}
          placeholder="https://example.com or /contact…"
        />
      </div>
    </div>
  );
}

function FooterProps({
  settings,
  onChange,
}: {
  settings: Record<string, string>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <label className={propLabel}>Footer text</label>
        <textarea
          className={inputClass}
          rows={3}
          value={settings.text ?? ""}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      </div>
    </div>
  );
}

// --- Phase 2B: Advanced section property editors ---

function FaqProps({
  settings,
  onChange,
}: {
  settings: { title?: string; items?: { question: string; answer: string }[] };
  onChange: (p: Record<string, unknown>) => void;
}) {
  const items = settings.items ?? [];
  return (
    <div className="space-y-3">
      <div>
        <label className={propLabel}>Title</label>
        <input className={inputClass} value={settings.title ?? ""} onChange={(e) => onChange({ title: e.target.value })} />
      </div>
      <div>
        <label className={propLabel}>Questions</label>
        <div className="space-y-2">
          {items.map((item, idx) => (
            <div key={idx} className={itemCard}>
              <label className="block text-xs font-medium text-slate-700">
                Question {idx + 1}
                <input className={inputClass} value={item.question} onChange={(e) => { const next = [...items]; next[idx] = { ...item, question: e.target.value }; onChange({ items: next }); }} />
              </label>
              <label className="block text-xs font-medium text-slate-700">
                Answer {idx + 1}
                <textarea className={inputClass} rows={2} value={item.answer} onChange={(e) => { const next = [...items]; next[idx] = { ...item, answer: e.target.value }; onChange({ items: next }); }} />
              </label>
              <button type="button" onClick={() => onChange({ items: items.filter((_, i) => i !== idx) })} className={removeItem}>Remove</button>
            </div>
          ))}
          <button type="button" disabled={items.length >= 20} onClick={() => onChange({ items: [...items, { question: "", answer: "" }] })} className={addItem}>+ Add question</button>
        </div>
      </div>
    </div>
  );
}

function TestimonialsProps({
  businessId,
  settings,
  onChange,
}: {
  businessId: string;
  settings: { title?: string; items?: { quote: string; name: string; role?: string; imageUrl?: string; imageAlt?: string }[] };
  onChange: (p: Record<string, unknown>) => void;
}) {
  const items = settings.items ?? [];
  return (
    <div className="space-y-3">
      <div>
        <label className={propLabel}>Title</label>
        <input className={inputClass} value={settings.title ?? ""} onChange={(e) => onChange({ title: e.target.value })} />
      </div>
      <div>
        <label className={propLabel}>Testimonials</label>
        <div className="space-y-2">
          {items.map((item, idx) => (
            <div key={idx} className={itemCard}>
              <label className="block text-xs font-medium text-slate-700">
                Quote {idx + 1}
                <textarea className={inputClass} rows={2} value={item.quote} onChange={(e) => { const next = [...items]; next[idx] = { ...item, quote: e.target.value }; onChange({ items: next }); }} />
              </label>
              <label className="block text-xs font-medium text-slate-700">
                Name {idx + 1}
                <input className={inputClass} value={item.name} onChange={(e) => { const next = [...items]; next[idx] = { ...item, name: e.target.value }; onChange({ items: next }); }} />
              </label>
              <label className="block text-xs font-medium text-slate-700">
                Role or attribution (optional)
                <input className={inputClass} value={item.role ?? ""} onChange={(e) => { const next = [...items]; next[idx] = { ...item, role: e.target.value }; onChange({ items: next }); }} />
              </label>
              <SectionImageField businessId={businessId} contextLabel="testimonial image" settings={{ imageUrl: item.imageUrl ?? "", imageAlt: item.imageAlt ?? "" }} onChange={(p) => { const next = [...items]; next[idx] = { ...item, imageUrl: (p.imageUrl as string) ?? "", imageAlt: (p.imageAlt as string) ?? "" }; onChange({ items: next }); }} />
              <button type="button" onClick={() => onChange({ items: items.filter((_, i) => i !== idx) })} className={removeItem}>Remove</button>
            </div>
          ))}
          <button type="button" disabled={items.length >= 12} onClick={() => onChange({ items: [...items, { quote: "", name: "", role: "" }] })} className={addItem}>+ Add testimonial</button>
        </div>
      </div>
    </div>
  );
}

function GalleryProps({
  businessId,
  settings,
  onChange,
}: {
  businessId: string;
  settings: { title?: string; images?: { url?: string; alt?: string; caption?: string }[]; columns?: string };
  onChange: (p: Record<string, unknown>) => void;
}) {
  const images = settings.images ?? [];
  return (
    <div className="space-y-3">
      <div>
        <label className={propLabel}>Title</label>
        <input className={inputClass} value={settings.title ?? ""} onChange={(e) => onChange({ title: e.target.value })} />
      </div>
      <div>
        <label className={propLabel}>Columns</label>
        <select className={inputClass} value={settings.columns ?? "3"} onChange={(e) => onChange({ columns: e.target.value })}>
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="4">4</option>
        </select>
      </div>
      <div>
        <label className={propLabel}>Images</label>
        <div className="space-y-2">
          {images.map((img, idx) => (
            <div key={idx} className={itemCard}>
              <SectionImageField businessId={businessId} contextLabel="gallery image" settings={{ imageUrl: img.url ?? "", imageAlt: img.alt ?? "" }} onChange={(p) => { const next = [...images]; next[idx] = { ...img, url: (p.imageUrl as string) ?? "", alt: (p.imageAlt as string) ?? "" }; onChange({ images: next }); }} />
              <label className="block text-xs font-medium text-slate-700">
                Alt text
                <input className={inputClass} value={img.alt ?? ""} onChange={(e) => { const next = [...images]; next[idx] = { ...img, alt: e.target.value }; onChange({ images: next }); }} />
              </label>
              <label className="block text-xs font-medium text-slate-700">
                Caption (optional)
                <input className={inputClass} value={img.caption ?? ""} onChange={(e) => { const next = [...images]; next[idx] = { ...img, caption: e.target.value }; onChange({ images: next }); }} />
              </label>
              <button type="button" onClick={() => onChange({ images: images.filter((_, i) => i !== idx) })} className={removeItem}>Remove</button>
            </div>
          ))}
          <button type="button" disabled={images.length >= 24} onClick={() => onChange({ images: [...images, { url: "", alt: "", caption: "" }] })} className={addItem}>+ Add image</button>
        </div>
      </div>
    </div>
  );
}

function PricingProps({
  settings,
  onChange,
}: {
  settings: { title?: string; plans?: { title: string; price: string; period?: string; features?: string[]; ctaText?: string; ctaHref?: string; highlighted?: boolean }[] };
  onChange: (p: Record<string, unknown>) => void;
}) {
  const plans = settings.plans ?? [];
  return (
    <div className="space-y-3">
      <div>
        <label className={propLabel}>Title</label>
        <input className={inputClass} value={settings.title ?? ""} onChange={(e) => onChange({ title: e.target.value })} />
      </div>
      <div>
        <label className={propLabel}>Plans</label>
        <div className="space-y-2">
          {plans.map((plan, idx) => (
            <div key={idx} className={itemCard}>
              <label className="block text-xs font-medium text-slate-700">
                Plan title
                <input className={inputClass} value={plan.title} onChange={(e) => { const next = [...plans]; next[idx] = { ...plan, title: e.target.value }; onChange({ plans: next }); }} />
              </label>
              <label className="block text-xs font-medium text-slate-700">
                Price
                <input className={inputClass} value={plan.price} onChange={(e) => { const next = [...plans]; next[idx] = { ...plan, price: e.target.value }; onChange({ plans: next }); }} />
              </label>
              <label className="block text-xs font-medium text-slate-700">
                Billing period (optional)
                <input className={inputClass} value={plan.period ?? ""} onChange={(e) => { const next = [...plans]; next[idx] = { ...plan, period: e.target.value }; onChange({ plans: next }); }} />
              </label>
              <label className="block text-xs font-medium text-slate-700">
                Features (up to 12, one per line)
                <textarea className={inputClass} rows={3} value={(plan.features ?? []).join("\n")} onChange={(e) => { const next = [...plans]; next[idx] = { ...plan, features: e.target.value.split("\n").filter(Boolean).slice(0, 12) }; onChange({ plans: next }); }} />
              </label>
              <label className="block text-xs font-medium text-slate-700">
                CTA text (optional)
                <input className={inputClass} value={plan.ctaText ?? ""} onChange={(e) => { const next = [...plans]; next[idx] = { ...plan, ctaText: e.target.value }; onChange({ plans: next }); }} />
              </label>
              <label className="block text-xs font-medium text-slate-700">
                CTA link (optional)
                <input className={inputClass} value={plan.ctaHref ?? ""} onChange={(e) => { const next = [...plans]; next[idx] = { ...plan, ctaHref: e.target.value }; onChange({ plans: next }); }} placeholder="https://example.com or /contact…" />
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={plan.highlighted ?? false} onChange={(e) => { const next = [...plans]; next[idx] = { ...plan, highlighted: e.target.checked }; onChange({ plans: next }); }} className="h-4 w-4 rounded" />
                Highlighted
              </label>
              <button type="button" onClick={() => onChange({ plans: plans.filter((_, i) => i !== idx) })} className={removeItem}>Remove</button>
            </div>
          ))}
          <button type="button" disabled={plans.length >= 6} onClick={() => onChange({ plans: [...plans, { title: "", price: "", features: [] }] })} className={addItem}>+ Add plan</button>
        </div>
      </div>
    </div>
  );
}

function ContactProps({
  settings,
  onChange,
}: {
  settings: { title?: string; description?: string; email?: string; phone?: string; address?: string; ctaText?: string; ctaHref?: string };
  onChange: (p: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <label className={propLabel}>Title</label>
        <input className={inputClass} value={settings.title ?? ""} onChange={(e) => onChange({ title: e.target.value })} />
      </div>
      <div>
        <label className={propLabel}>Description</label>
        <textarea className={inputClass} rows={2} value={settings.description ?? ""} onChange={(e) => onChange({ description: e.target.value })} />
      </div>
      <div>
        <label className={propLabel}>Email</label>
        <input type="email" autoComplete="off" className={inputClass} value={settings.email ?? ""} onChange={(e) => onChange({ email: e.target.value })} />
      </div>
      <div>
        <label className={propLabel}>Phone</label>
        <input type="tel" autoComplete="off" className={inputClass} value={settings.phone ?? ""} onChange={(e) => onChange({ phone: e.target.value })} />
      </div>
      <div>
        <label className={propLabel}>Address</label>
        <input className={inputClass} value={settings.address ?? ""} onChange={(e) => onChange({ address: e.target.value })} />
      </div>
      <div>
        <label className={propLabel}>CTA text</label>
        <input className={inputClass} value={settings.ctaText ?? ""} onChange={(e) => onChange({ ctaText: e.target.value })} />
      </div>
      <div>
        <label className={propLabel}>CTA link</label>
        <input className={inputClass} value={settings.ctaHref ?? ""} onChange={(e) => onChange({ ctaHref: e.target.value })} placeholder="https://example.com or /contact…" />
      </div>
    </div>
  );
}

function NewsletterProps({
  settings,
  onChange,
}: {
  settings: { headline?: string; description?: string; buttonText?: string; placeholder?: string; ctaHref?: string };
  onChange: (p: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <label className={propLabel}>Headline</label>
        <input className={inputClass} value={settings.headline ?? ""} onChange={(e) => onChange({ headline: e.target.value })} />
      </div>
      <div>
        <label className={propLabel}>Description</label>
        <textarea className={inputClass} rows={2} value={settings.description ?? ""} onChange={(e) => onChange({ description: e.target.value })} />
      </div>
      <div>
        <label className={propLabel}>Button text</label>
        <input className={inputClass} value={settings.buttonText ?? ""} onChange={(e) => onChange({ buttonText: e.target.value })} />
      </div>
      <div>
        <label className={propLabel}>CTA link</label>
        <input
          className={inputClass}
          value={settings.ctaHref ?? ""}
          onChange={(e) => onChange({ ctaHref: e.target.value })}
          placeholder="https://example.com or /subscribe…"
        />
        <p className="mt-1 text-xs text-slate-500">
          Link to an existing signup page; this section does not collect or submit email addresses.
        </p>
      </div>
    </div>
  );
}

function StatsProps({
  settings,
  onChange,
}: {
  settings: { title?: string; items?: { value: string; label: string }[] };
  onChange: (p: Record<string, unknown>) => void;
}) {
  const items = settings.items ?? [];
  return (
    <div className="space-y-3">
      <div>
        <label className={propLabel}>Title</label>
        <input className={inputClass} value={settings.title ?? ""} onChange={(e) => onChange({ title: e.target.value })} />
      </div>
      <div>
        <label className={propLabel}>Stats</label>
        <div className="space-y-2">
          {items.map((item, idx) => (
            <div key={idx} className="flex gap-2">
              <input aria-label={`Highlight ${idx + 1} value`} className={inputClass} value={item.value} onChange={(e) => { const next = [...items]; next[idx] = { ...item, value: e.target.value }; onChange({ items: next }); }} />
              <input aria-label={`Highlight ${idx + 1} label`} className={inputClass} value={item.label} onChange={(e) => { const next = [...items]; next[idx] = { ...item, label: e.target.value }; onChange({ items: next }); }} />
              <button type="button" aria-label={`Remove highlight ${idx + 1}`} onClick={() => onChange({ items: items.filter((_, i) => i !== idx) })} className={`${removeItem} shrink-0 px-1`}>✕</button>
            </div>
          ))}
          <button type="button" disabled={items.length >= 8} onClick={() => onChange({ items: [...items, { value: "", label: "" }] })} className={addItem}>+ Add stat</button>
        </div>
      </div>
    </div>
  );
}