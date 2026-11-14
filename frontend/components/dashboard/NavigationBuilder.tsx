"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/Icon";
import { Notice, Pill, cardClass } from "@/components/ui/Surface";
import { useToastHelpers } from "@/components/ui/Toast";
import { isSafeSectionHref } from "@/lib/sections";
import ManagementPageHeader from "./ManagementPageHeader";
import RevisionHistoryDialog from "./editor/RevisionHistoryDialog";
import { useSectionDrag, type DropPosition } from "./editor/SectionControls";

interface PageOption {
  _id: string;
  title: string;
  slug: string;
  status: "draft" | "published";
  isHome: boolean;
}

interface NavItem {
  pageId?: string;
  href?: string;
  label: string;
  order: number;
  showOn?: "desktop" | "mobile";
  children?: NavItem[];
}

type LinkKind = "store" | "category" | "product" | "external";
const LINK_KINDS: Array<{ value: LinkKind; label: string; prefix?: string }> = [
  { value: "category", label: "A category", prefix: "Category: " },
  { value: "product", label: "A product", prefix: "Product: " },
  { value: "store", label: "Another part of your store" },
  { value: "external", label: "Another website" },
];

interface NavConfig {
  header: NavItem[];
  footer: NavItem[];
}

type Area = "header" | "footer";

const input = "min-h-10 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500";
const iconButton = "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 lg:h-8 lg:w-8";

/**
 * Header and footer menus. A link can go to a page, a category, a product, the
 * catalog or another website, and a header link can have a dropdown. Menus stay
 * in a draft until published. A link to an unpublished page is simply not shown.
 */
export default function NavigationBuilder({
  businessId,
  pages,
  initialNavigation,
  initialVersion,
  linkOptions,
  initialHasChanges,
  storeLive,
  canManage,
}: {
  businessId: string;
  pages: PageOption[];
  initialNavigation?: NavConfig;
  /** The version these menus were loaded at: a save names it, so it cannot overwrite a newer one. */
  initialVersion: number;
  /** The store's real destinations (catalog, categories, products). */
  linkOptions: Array<{ label: string; href: string }>;
  initialHasChanges: boolean;
  storeLive: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const { success, error: showError } = useToastHelpers();
  const [area, setArea] = useState<Area>("header");
  const [nav, setNav] = useState<NavConfig>({ header: initialNavigation?.header ?? [], footer: initialNavigation?.footer ?? [] });
  const [saved, setSaved] = useState(JSON.stringify({ header: initialNavigation?.header ?? [], footer: initialNavigation?.footer ?? [] }));
  const [unpublished, setUnpublished] = useState(initialHasChanges);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [customLabel, setCustomLabel] = useState("");
  const [customHref, setCustomHref] = useState("");
  const [linkKind, setLinkKind] = useState<LinkKind>("category");
  const [dropdownLabel, setDropdownLabel] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const version = useRef(initialVersion);
  const dirty = JSON.stringify(nav) !== saved;
  const items = nav[area];
  const pageById = useMemo(() => new Map(pages.map((page) => [page._id, page])), [pages]);
  const used = useMemo(() => {
    const ids = new Set<string>();
    for (const item of items) {
      if (item.pageId) ids.add(item.pageId);
      for (const child of item.children ?? []) if (child.pageId) ids.add(child.pageId);
    }
    return ids;
  }, [items]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const setItems = (next: NavItem[]) => {
    setNav((current) => ({ ...current, [area]: next.map((item, order) => ({ ...item, order, ...(item.children ? { children: item.children.map((child, i) => ({ ...child, order: i })) } : {}) })) }));
    if (!conflict) setMessage(null);
  };

  const addPage = (page: PageOption) => setItems([...items, { pageId: page._id, label: page.isHome ? "Home" : page.title, order: items.length }]);
  const destinations = linkOptions.filter((option) => {
    const kind = LINK_KINDS.find((candidate) => candidate.value === linkKind);
    if (kind?.prefix) return option.label.startsWith(kind.prefix);
    return linkKind === "store" && !LINK_KINDS.some((candidate) => candidate.prefix && option.label.startsWith(candidate.prefix));
  });
  const otherArea: Area = area === "header" ? "footer" : "header";
  /** Puts a copy of a link in the other menu. */
  const copyToOther = (item: NavItem) =>
    setNav((current) => {
      const other = current[otherArea];
      if (item.pageId && other.some((existing) => existing.pageId === item.pageId)) return current;
      return { ...current, [otherArea]: [...other, { ...item, order: other.length }] };
    });
  const addDropdown = () => {
    if (!dropdownLabel.trim()) return;
    setItems([...items, { label: dropdownLabel.trim(), order: items.length, children: [] }]);
    setDropdownLabel("");
  };
  const setShowOn = (index: number, value: string, childIndex?: number) => {
    const apply = (item: NavItem): NavItem => {
      const { showOn: _showOn, ...rest } = item;
      return value === "desktop" || value === "mobile" ? { ...rest, showOn: value } : rest;
    };
    const next = [...items];
    next[index] = childIndex === undefined ? apply(next[index]) : { ...next[index], children: (next[index].children ?? []).map((child, i) => (i === childIndex ? apply(child) : child)) };
    setItems(next);
  };
  /** Dragging: within a level, out of a dropdown, or into one. */
  const moveLink = (fromId: string, toId: string, position: DropPosition) => {
    const parse = (id: string) => id.split(":").slice(1).map(Number);
    const [fromTop, fromChild] = parse(fromId);
    const [toTop, toChild] = parse(toId);
    const next: NavItem[] = items.map((item) => ({ ...item, children: item.children ? [...item.children] : item.children }));
    const moved = fromChild === undefined ? next[fromTop] : (next[fromTop].children ?? [])[fromChild];
    if (!moved) return;
    // A link with its own dropdown stays at the top: menus have one level.
    if (toChild !== undefined && (moved.children ?? []).length > 0) return;
    const marker = {} as NavItem;
    if (fromChild === undefined) next[fromTop] = marker;
    else (next[fromTop].children as NavItem[])[fromChild] = marker;
    if (toChild === undefined) next.splice(position === "before" ? toTop : toTop + 1, 0, moved);
    else (next[toTop].children ??= []).splice(position === "before" ? toChild : toChild + 1, 0, { ...moved, children: undefined });
    setItems(next.filter((item) => item !== marker).map((item) => ({ ...item, ...(item.children ? { children: item.children.filter((child) => child !== marker) } : {}) })));
  };
  const drag = useSectionDrag(moveLink);
  const addCustom = () => {
    if (!customLabel.trim() || !isSafeSectionHref(customHref.trim())) return;
    setItems([...items, { href: customHref.trim(), label: customLabel.trim(), order: items.length }]);
    setCustomLabel("");
    setCustomHref("");
  };
  const customInvalid = customHref.trim() !== "" && !isSafeSectionHref(customHref.trim());

  const move = (index: number, direction: -1 | 1) => {
    const next = [...items];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
  };
  /** Moves a link under the one above it, making a dropdown. */
  const nest = (index: number) => {
    if (index === 0) return;
    const next = [...items];
    const [item] = next.splice(index, 1);
    const parent = next[index - 1];
    next[index - 1] = { ...parent, children: [...(parent.children ?? []), ...[{ ...item, children: undefined }, ...(item.children ?? [])]] };
    setItems(next);
  };
  const unnest = (index: number, childIndex: number) => {
    const next = [...items];
    const parent = next[index];
    const children = [...(parent.children ?? [])];
    const [child] = children.splice(childIndex, 1);
    next[index] = { ...parent, children: children.length > 0 ? children : undefined };
    next.splice(index + 1, 0, child);
    setItems(next);
  };
  const updateLabel = (index: number, label: string, childIndex?: number) => {
    const next = [...items];
    if (childIndex === undefined) next[index] = { ...next[index], label };
    else next[index] = { ...next[index], children: (next[index].children ?? []).map((child, i) => (i === childIndex ? { ...child, label } : child)) };
    setItems(next);
  };
  const remove = (index: number, childIndex?: number) => {
    const next = [...items];
    if (childIndex === undefined) next.splice(index, 1);
    else {
      const children = (next[index].children ?? []).filter((_, i) => i !== childIndex);
      next[index] = { ...next[index], children: children.length > 0 ? children : undefined };
    }
    setItems(next);
  };

  async function saveDraft(): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-expected-version": String(version.current) },
        body: JSON.stringify({ themeSettings: { navigation: nav } }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === "draft_conflict") {
        setConflict(true);
        setMessage({ tone: "danger", text: "These menus were changed in another window or by someone else, so this save was stopped and the newer menus are safe. Reload to see them. Edits you made here since your last save are not kept, so note any you need first." });
        return false;
      }
      if (!res.ok) throw new Error(data.error || "Your menus could not be saved.");
      if (typeof data.navigationVersion === "number") version.current = data.navigationVersion;
      setSaved(JSON.stringify(nav));
      setUnpublished(true);
      setMessage({ tone: "success", text: "Draft saved. Your live menus have not changed." });
      return true;
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Your menus could not be saved." });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!(await confirmDialog({ title: "Publish these menus?", message: storeLive ? "Visitors see them right away." : "They go live when your store is published.", confirmLabel: "Publish menus" }))) return;
    if (dirty && !(await saveDraft())) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/website/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: ["navigation"] }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Your menus could not be published.");
      if (data.failed?.length) throw new Error(data.failed[0].error);
      setUnpublished(false);
      setMessage({ tone: "success", text: "Menus published." });
      success("Menus published", storeLive ? "Visitors now see them." : "They go live with your store.");
      router.refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : "Your menus could not be published.";
      setMessage({ tone: "danger", text });
      showError("Publish failed", text);
    } finally {
      setBusy(false);
    }
  }

  const destination = (item: NavItem): string => {
    if (item.pageId) {
      const page = pageById.get(item.pageId);
      if (!page) return "This page no longer exists, so the link is not shown";
      return `${page.isHome ? "/" : `/${page.slug}`}${page.status === "draft" ? " · draft: shows once published" : ""}`;
    }
    return item.href ? `${item.href}${/^https:/i.test(item.href) ? " · opens in a new tab" : ""}` : (item.children ?? []).length > 0 ? "Opens a dropdown" : "A dropdown: drag links under it. Hidden until it has one.";
  };

  const row = (item: NavItem, index: number, childIndex?: number) => {
    const child = childIndex !== undefined;
    const dragId = child ? `link:${index}:${childIndex}` : `link:${index}`;
    const dropAt = drag.target?.id === dragId ? drag.target.position : null;
    return (
      <div {...(canManage ? drag.row(dragId) : {})} className={`relative flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white p-2 ${child ? "ml-6 sm:ml-10" : ""}`}>
        {dropAt && <span aria-hidden="true" className={`absolute inset-x-0 z-10 h-0.5 rounded-full bg-ember ${dropAt === "before" ? "-top-1" : "-bottom-1"}`} />}
        {canManage && (
          <span {...drag.handle(dragId)} aria-hidden="true" title="Drag to reorder" className="hidden h-7 w-5 shrink-0 cursor-grab items-center justify-center rounded text-slate-400 hover:text-slate-600 active:cursor-grabbing lg:inline-flex">
            <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
              <circle cx="2.5" cy="3" r="1.3" />
              <circle cx="7.5" cy="3" r="1.3" />
              <circle cx="2.5" cy="8" r="1.3" />
              <circle cx="7.5" cy="8" r="1.3" />
              <circle cx="2.5" cy="13" r="1.3" />
              <circle cx="7.5" cy="13" r="1.3" />
            </svg>
          </span>
        )}
        {!child && (
          <div className="flex flex-col">
            <button type="button" className={iconButton} disabled={!canManage || index === 0} onClick={() => move(index, -1)} aria-label={`Move ${item.label} up`}><Icon name="arrow-up" size={15} /></button>
            <button type="button" className={iconButton} disabled={!canManage || index === items.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${item.label} down`}><Icon name="arrow-down" size={15} /></button>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <input value={item.label} maxLength={80} disabled={!canManage} aria-label={`Label for ${item.label || "link"}`} onChange={(e) => updateLabel(index, e.target.value, childIndex)} className={input} />
          <p className="mt-1 truncate px-1 text-xs text-slate-500">{destination(item)}</p>
          {canManage && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-slate-600">
              {area === "header" && (
                <label className="inline-flex items-center gap-1">
                  Show on
                  <select aria-label={`Where ${item.label} shows`} value={item.showOn ?? "all"} onChange={(e) => setShowOn(index, e.target.value, childIndex)} className="min-h-8 rounded border border-slate-300 bg-white px-1 text-xs">
                    <option value="all">All screens</option>
                    <option value="desktop">Larger screens</option>
                    <option value="mobile">Phone menu</option>
                  </select>
                </label>
              )}
              {!child && (
                <button type="button" onClick={() => copyToOther(item)} className="min-h-8 rounded font-medium underline underline-offset-2 hover:text-slate-900">Also add to {otherArea}</button>
              )}
            </div>
          )}
        </div>
        {canManage && area === "header" && !child && index > 0 && (
          <button type="button" className={`${iconButton} !w-auto px-2 text-xs font-medium`} onClick={() => nest(index)}>Under above</button>
        )}
        {canManage && child && (
          <button type="button" className={`${iconButton} !w-auto px-2 text-xs font-medium`} onClick={() => unnest(index, childIndex)}>Move out</button>
        )}
        {canManage && (
          <button type="button" className={`${iconButton} hover:!bg-red-50 hover:!text-red-700`} onClick={() => remove(index, childIndex)} aria-label={`Remove ${item.label}`}><Icon name="x" size={16} /></button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Navigation"
        description="Choose the links in your header and footer. Changes stay in a draft until you publish them."
        actions={
          canManage ? (
            <>
              <Button variant="ghost" onClick={() => setHistoryOpen(true)} disabled={busy}>History</Button>
              <Button variant="secondary" onClick={() => void saveDraft()} disabled={busy || conflict || !dirty}>{busy ? "Saving…" : "Save draft"}</Button>
              <Button onClick={() => void publish()} disabled={busy || conflict || (!dirty && !unpublished)}>Publish</Button>
            </>
          ) : undefined
        }
      />

      <p><Pill tone={dirty || unpublished ? "warning" : "success"} dot>{dirty ? "Unsaved changes" : unpublished ? "Draft not published" : "Matches your live store"}</Pill></p>
      {message && (
        <Notice tone={message.tone} role={message.tone === "danger" ? "alert" : "status"} action={conflict ? <Button variant="secondary" onClick={() => window.location.reload()}>Reload</Button> : undefined}>
          {message.text}
        </Notice>
      )}

      <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5" role="group" aria-label="Which menu">
        {(["header", "footer"] as const).map((tab) => (
          <button key={tab} type="button" aria-pressed={area === tab} onClick={() => setArea(tab)} className={`min-h-10 rounded-md px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${area === tab ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
            {tab === "header" ? "Header" : "Footer"}
          </button>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section aria-labelledby="menu-links" className={`${cardClass} min-w-0 p-4 sm:p-5`}>
          <h2 id="menu-links" className="text-base font-semibold text-slate-900">{area === "header" ? "Header" : "Footer"} links</h2>
          <p className="mt-1 text-sm text-slate-600">
            {area === "header" ? "Your shop and category links are added automatically. These appear with them." : "Shop, policy and account links are added automatically. These appear with them."}
          </p>
          {items.length === 0 ? (
            <p className="mt-4 rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-600">No links yet. Add a page or a link from the list.</p>
          ) : (
            <ul className="mt-4 space-y-2">
              {items.map((item, index) => (
                <li key={`${item.pageId ?? item.href ?? item.label}-${index}`} className="space-y-2">
                  {row(item, index)}
                  {(item.children ?? []).map((child, childIndex) => (
                    <div key={`${child.pageId ?? child.href ?? child.label}-${childIndex}`}>{row(child, index, childIndex)}</div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </section>

        {canManage && (
          <div className="min-w-0 space-y-5">
            <section aria-labelledby="add-page" className={`${cardClass} p-4 sm:p-5`}>
              <h2 id="add-page" className="text-base font-semibold text-slate-900">Add a page</h2>
              {pages.filter((page) => !used.has(page._id)).length === 0 ? (
                <p className="mt-2 text-sm text-slate-600">{pages.length === 0 ? "You have no pages yet. Create one in Pages, or add a link below." : "Every page is already in this menu."}</p>
              ) : (
                <ul className="mt-3 space-y-1">
                  {pages.filter((page) => !used.has(page._id)).map((page) => (
                    <li key={page._id}>
                      <button type="button" onClick={() => addPage(page)} className="flex min-h-10 w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                        <span className="min-w-0 truncate text-slate-800">{page.title}</span>
                        <span className="flex shrink-0 items-center gap-1.5 text-xs text-slate-500">
                          {page.status === "draft" && <Pill>Draft</Pill>}
                          <Icon name="plus" size={15} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="add-link" className={`${cardClass} p-4 sm:p-5`}>
              <h2 id="add-link" className="text-base font-semibold text-slate-900">Add a link</h2>
              <p className="mt-1 text-sm text-slate-600">A category, a product or another website. Pages are in the list above.</p>
              <form onSubmit={(event) => { event.preventDefault(); addCustom(); }} className="mt-3 space-y-3">
                <label className="block text-sm font-medium text-slate-800">
                  Link to
                  <select
                    value={linkKind}
                    onChange={(e) => {
                      setLinkKind(e.target.value as LinkKind);
                      setCustomHref("");
                    }}
                    className={`mt-1 ${input}`}
                  >
                    {LINK_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
                  </select>
                </label>
                {linkKind === "external" ? (
                  <label className="block text-sm font-medium text-slate-800">
                    Website address
                    <input value={customHref} maxLength={300} aria-invalid={customInvalid || undefined} onChange={(e) => setCustomHref(e.target.value)} placeholder="https://" className={`mt-1 ${input}`} />
                  </label>
                ) : destinations.length === 0 ? (
                  <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">Nothing to choose here yet.</p>
                ) : (
                  <label className="block text-sm font-medium text-slate-800">
                    Which one
                    <select
                      value={customHref}
                      onChange={(e) => {
                        const value = e.target.value;
                        setCustomHref(value);
                        // Choosing one also suggests a name.
                        const option = linkOptions.find((o) => o.href === value);
                        if (option && !customLabel) setCustomLabel(option.label.replace(/^(Category|Product|Page): /, ""));
                      }}
                      className={`mt-1 ${input}`}
                    >
                      <option value="">Choose…</option>
                      {destinations.map((option) => <option key={option.href} value={option.href}>{option.label.replace(/^(Category|Product|Page): /, "")}</option>)}
                    </select>
                  </label>
                )}
                {customInvalid && <p className="text-xs text-red-700">Use a link inside your store, such as /products, or a full https:// address.</p>}
                <label className="block text-sm font-medium text-slate-800">
                  Label
                  <input value={customLabel} maxLength={80} onChange={(e) => setCustomLabel(e.target.value)} placeholder="New in" className={`mt-1 ${input}`} />
                </label>
                <Button type="submit" variant="secondary" block disabled={!customLabel.trim() || !customHref.trim() || customInvalid}>
                  <Icon name="plus" size={15} /> Add link
                </Button>
              </form>
            </section>

            {area === "header" && (
              <section aria-labelledby="add-dropdown" className={`${cardClass} p-4 sm:p-5`}>
                <h2 id="add-dropdown" className="text-base font-semibold text-slate-900">Add a dropdown</h2>
                <p className="mt-1 text-sm text-slate-600">A heading that opens a list. Drag links under it, or use &quot;Under above&quot;.</p>
                <form onSubmit={(event) => { event.preventDefault(); addDropdown(); }} className="mt-3 space-y-3">
                  <label className="block text-sm font-medium text-slate-800">
                    Heading
                    <input value={dropdownLabel} maxLength={80} onChange={(e) => setDropdownLabel(e.target.value)} className={`mt-1 ${input}`} />
                  </label>
                  <Button type="submit" variant="secondary" block disabled={!dropdownLabel.trim()}><Icon name="plus" size={15} /> Add dropdown</Button>
                </form>
              </section>
            )}
          </div>
        )}
      </div>

      {historyOpen && (
        <RevisionHistoryDialog businessId={businessId} target="navigation" title="Menus" onClose={() => setHistoryOpen(false)} onRestored={() => window.location.reload()} />
      )}
    </div>
  );
}
