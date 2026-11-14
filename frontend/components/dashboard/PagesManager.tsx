"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ManagementPageHeader from "./ManagementPageHeader";
import PageSettingsDialog, { type PageSettingsTarget } from "./PageSettingsDialog";
import RecommendedPages from "./RecommendedPages";
import RevisionHistoryDialog from "./editor/RevisionHistoryDialog";
import { useToastHelpers } from "@/components/ui/Toast";
import { Button, buttonClass } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/Icon";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { apiErrorFrom, fieldErrorId, invalidProps, summaryMessage } from "@/lib/api-errors";
import { EmptyState, Pill } from "@/components/ui/Surface";
import { PAGE_TEMPLATES, PAGE_TEMPLATE_INFO, type PageTemplate } from "@/lib/page-templates";
import type { RevisionSummary } from "@/lib/website-revisions";

interface PageItem extends PageSettingsTarget {
  /** A published page whose draft differs from what visitors see. */
  hasDraftChanges?: boolean;
}

const hasUnpublishedChanges = (page: PageItem): boolean => page.status === "published" && Boolean(page.hasDraftChanges);

/** The empty first state of the page list. */
function EmptyPagesState({ onCreate, canCreate }: { onCreate: () => void; canCreate: boolean }) {
  return (
    <EmptyState
      icon={<Icon name="pages" />}
      title="No pages yet"
      className="m-4 sm:m-6"
      action={
        canCreate ? (
          <Button onClick={onCreate}>
            <Icon name="plus" size={16} /> Create your first page
          </Button>
        ) : undefined
      }
    >
      {canCreate ? "Create your first page to start building your website structure." : "Ask a business owner or manager to create the first page."}
    </EmptyState>
  );
}

export default function PagesManager({
  businessId,
  businessName,
  initialPages,
  canManage,
}: {
  businessId: string;
  businessName: string;
  initialPages: PageItem[];
  canManage: boolean;
}) {
  const router = useRouter();
  const { success, error } = useToastHelpers();
  const [pages, setPages] = useState<PageItem[]>(initialPages);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [template, setTemplate] = useState<PageTemplate>("blank");
  const [createFields, setCreateFields] = useState<Record<string, string>>({});
  const [settingsPage, setSettingsPage] = useState<PageItem | null>(null);
  const [historyPage, setHistoryPage] = useState<PageItem | null>(null);
  const [deleted, setDeleted] = useState<RevisionSummary[]>([]);
  const [showDeleted, setShowDeleted] = useState(false);

  useEffect(() => {
    if (!canManage) return;
    fetch(`/api/businesses/${businessId}/revisions?target=page&reason=deleted`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { revisions: [] }))
      .then((data) => setDeleted(data.revisions ?? []))
      .catch(() => setDeleted([]));
  }, [businessId, canManage, pages.length]);

  const postJson = (path: string) =>
    fetch(`/api/businesses/${businessId}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "That did not work. Please try again.");
      return data;
    });

  async function duplicatePage(page: PageItem) {
    setLoading(true);
    try {
      const data = await postJson(`pages/${page._id}/duplicate`);
      setPages((list) => [...list, data.page]);
      success("Page copied", `"${data.page.title}" is a new draft.`);
      router.refresh();
    } catch (err) {
      error("Unable to copy this page", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function setPublished(page: PageItem, publish: boolean) {
    if (!canManage) return;
    if (!publish && !(await confirmDialog({ title: `Unpublish "${page.title}"?`, message: page.isHome ? "Visitors see your store homepage instead. Your draft stays as it is." : "Visitors can no longer open this page. Your draft stays as it is, and you can publish it again.", confirmLabel: "Unpublish", tone: "danger" }))) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/pages/${page._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: publish ? "published" : "draft" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "That did not work. Please try again.");
      setPages((list) => list.map((item) => (item._id === page._id ? { ...item, ...data.page } : item)));
      success(publish ? "Page published" : "Page unpublished", publish ? "Visitors can now open it." : "Visitors can no longer open it.");
      router.refresh();
    } catch (err) {
      error(publish ? "Unable to publish" : "Unable to unpublish", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function revertPage(page: PageItem) {
    if (!(await confirmDialog({ title: `Go back to the published "${page.title}"?`, message: "Your draft edits are replaced by what visitors see now. They stay in the version history.", confirmLabel: "Go back", tone: "danger" }))) return;
    setLoading(true);
    try {
      const data = await postJson(`pages/${page._id}/revert`);
      setPages((list) => list.map((item) => (item._id === page._id ? { ...item, ...data.page } : item)));
      success("Draft replaced", "It now matches your live page.");
      router.refresh();
    } catch (err) {
      error("Unable to go back", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function restoreDeleted(revision: RevisionSummary) {
    setLoading(true);
    try {
      const data = await postJson(`revisions/${revision.id}/restore`);
      setPages((list) => [...list, data.page]);
      setDeleted((list) => list.filter((item) => item.id !== revision.id));
      success("Page restored", `"${data.page.title}" is back as a draft.`);
      router.refresh();
    } catch (err) {
      error("Unable to restore this page", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function createPage() {
    if (!title.trim() || !canManage) return;
    setLoading(true);
    setCreating(true);
    setCreateFields({});
    try {
      const res = await fetch(`/api/businesses/${businessId}/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, slug: slug || undefined, template }),
      });
      const data = await res.json();
      if (!res.ok) {
        const info = apiErrorFrom(data, "Unable to create page");
        // A taken or invalid address is reported by code rather than by field.
        const fields = data.code === "slug_taken" || data.code === "invalid_slug" ? { ...info.fields, slug: info.message } : info.fields;
        setCreateFields(fields);
        throw new Error(summaryMessage({ ...info, fields }, ["title", "slug", "template"]));
      }
      setPages((p) => [...p, data.page]);
      setTitle("");
      setSlug("");
      setTemplate("blank");
      success("Page created", `"${data.page.title}" is ready to edit.`);
      setCreating(false);
      router.push(`/dashboard/businesses/${businessId}/editor?page=${data.page._id}`);
    } catch (err) {
      // The form stays open, so the problem can be fixed and nothing typed is lost.
      error("Unable to create page", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function deletePage(pageId: string) {
    if (!canManage) return;
    const target = pages.find((p) => p._id === pageId);
    if (!(await confirmDialog({ title: target ? `Delete "${target.title}"?` : "Delete this page?", message: "Visitors can no longer reach this page. You can bring it back from Recently deleted.", confirmLabel: "Delete page", tone: "danger" }))) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/pages/${pageId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unable to delete page");
      const deletedPage = pages.find((p) => p._id === pageId);
      setPages((p) => p.filter((pg) => pg._id !== pageId));
      success("Page deleted", deletedPage ? `"${deletedPage.title}" has been removed.` : "The page has been removed.");
      router.refresh();
    } catch (err) {
      error("Unable to delete page", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function setHome(pageId: string) {
    if (!canManage) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/pages/${pageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isHome: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unable to set homepage");
      setPages((p) => p.map((pg) => ({ ...pg, isHome: pg._id === pageId })));
      const homePage = pages.find((p) => p._id === pageId);
      success("Homepage updated", homePage ? `"${homePage.title}" is now the homepage.` : "Homepage has been updated.");
      router.refresh();
    } catch (err) {
      error("Unable to set homepage", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Pages"
        description="Manage the pages on your website. Draft pages are only visible to your team; published pages show the last version you published."
        actions={
          canManage ? (
            <>
              <Link href={`/dashboard/businesses/${businessId}/editor`} className={buttonClass({ variant: "secondary" })}>
                Edit website
              </Link>
              <Button onClick={() => setCreating(true)} disabled={loading}>
                <Icon name="plus" size={16} />
                Create page
              </Button>
            </>
          ) : undefined
        }
      />

      <RecommendedPages businessId={businessId} canManage={canManage} compact={initialPages.length > 1} />

      {/* Create Page Modal */}
      {creating && (
        <div className="ui-fade fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/50 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="create-page-title">
          <div className="ui-pop w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-lg">
            <h2 id="create-page-title" className="text-lg font-semibold text-slate-900">Create page</h2>
            <p className="mt-1 text-sm text-slate-600">Add a new page to your website. It starts as a draft, so nobody sees it until you publish it.</p>
            <form onSubmit={(e) => { e.preventDefault(); createPage(); }} className="mt-4 space-y-4">
              <fieldset>
                <legend className={labelClass}>Start from</legend>
                <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {PAGE_TEMPLATES.map((key) => (
                    <label key={key} title={PAGE_TEMPLATE_INFO[key].description} className={`cursor-pointer rounded-xl border p-2.5 text-sm transition-colors focus-within:ring-2 focus-within:ring-brand-500 ${template === key ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:border-slate-300"}`}>
                      <input
                        type="radio"
                        name="page-template"
                        className="sr-only"
                        checked={template === key}
                        onChange={() => {
                          setTemplate(key);
                          if (!title.trim() && PAGE_TEMPLATE_INFO[key].title) setTitle(PAGE_TEMPLATE_INFO[key].title);
                        }}
                      />
                      <span className="block font-medium text-slate-900">{PAGE_TEMPLATE_INFO[key].label}</span>
                    </label>
                  ))}
                </div>
                <p className="mt-1.5 text-xs leading-5 text-slate-500">{PAGE_TEMPLATE_INFO[template].description}{template !== "blank" && " Anything we don't know is left in [[double brackets]] for you to fill in."}</p>
                <FieldError message={createFields.template} />
              </fieldset>
              <div>
                <label htmlFor="page-title" className={labelClass}>
                  Page title <span className="text-red-600" aria-hidden="true">*</span>
                </label>
                <input
                  id="page-title"
                  name="pageTitle"
                  autoComplete="off"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. About Us…"
                  className={inputClass}
                  {...invalidProps(createFields, "title", "new-page")}
                />
                <FieldError id={fieldErrorId("new-page", "title")} message={createFields.title} />
              </div>
              <div>
                <label htmlFor="page-slug" className={labelClass}>
                  Web address <span className="font-normal text-slate-500">(optional)</span>
                </label>
                <input
                  id="page-slug"
                  name="slug"
                  autoComplete="off"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="e.g. about-us…"
                  className={inputClass}
                  {...invalidProps(createFields, "slug", "new-page")}
                />
                <FieldError id={fieldErrorId("new-page", "slug")} message={createFields.slug} />
                <p className="mt-1.5 text-xs text-slate-500">The end of this page&apos;s link. Made from the title if you leave it empty.</p>
              </div>
              <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
                <Button variant="secondary" onClick={() => { setCreating(false); setTitle(""); setSlug(""); setCreateFields({}); }} disabled={loading}>
                  Cancel
                </Button>
                <Button type="submit" disabled={loading || !title.trim()}>
                  {loading ? "Creating…" : "Create page"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {settingsPage && (
        <PageSettingsDialog
          businessId={businessId}
          businessName={businessName}
          page={settingsPage as PageSettingsTarget}
          onClose={() => setSettingsPage(null)}
          onSaved={(saved) => {
            setPages((list) => list.map((item) => (item._id === saved._id ? { ...item, ...saved } : item)));
            setSettingsPage(null);
            success("Settings saved", saved.status === "published" ? "Search settings go live when you publish this page." : "They apply once the page is published.");
            router.refresh();
          }}
        />
      )}
      {historyPage && (
        <RevisionHistoryDialog
          businessId={businessId}
          target="page"
          targetId={historyPage._id}
          title={historyPage.title}
          onClose={() => setHistoryPage(null)}
          onRestored={() => {
            setHistoryPage(null);
            success("Version restored", "It is now your draft. Publish it when you are ready.");
            router.refresh();
          }}
        />
      )}

      <section aria-labelledby="all-pages-title" className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="all-pages-title" className="text-lg font-semibold text-slate-900">All pages</h2>
            <p className="text-sm text-slate-500">
              {pages.length} {pages.length === 1 ? "page" : "pages"} total
            </p>
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            <span className="font-medium text-slate-800">The Home page is the first thing visitors see</span> when they open your store&apos;s address. There is only one, so it cannot be deleted; choose another page as Home first if you want to remove it.
          </p>
        </div>
        {pages.length === 0 ? (
          <EmptyPagesState onCreate={() => setCreating(true)} canCreate={canManage} />
        ) : (
          <ul className="divide-y divide-slate-100">
            {pages.map((p) => (
              <li key={p._id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-4 transition-colors hover:bg-slate-50/60 sm:px-6">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 truncate font-medium text-slate-900">{p.title}</p>
                    {p.isHome && (
                      <Pill tone="ember">
                        <Icon name="business" size={12} /> Home
                      </Pill>
                    )}
                    <Pill tone={p.status === "published" ? "success" : "neutral"} dot>
                      {p.status === "published" ? "Published" : "Draft"}
                    </Pill>
                    {hasUnpublishedChanges(p) && <Pill tone="warning">Unpublished changes</Pill>}
                  </div>
                  <p className="mt-1 text-sm text-slate-500">
                    <span className="break-all">/{p.slug}</span>
                    <span aria-hidden="true"> · </span>
                    {p.status === "published" ? "Visitors see the last version you published." : "Only your team can see it. Edit it, then publish it from the editor."}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {canManage && (
                    <Link href={`/dashboard/businesses/${businessId}/editor?page=${p._id}`} className={buttonClass({ variant: "secondary" })}>
                      Edit
                    </Link>
                  )}
                  {canManage && (
                    <Button variant="ghost" onClick={() => setSettingsPage(p)} disabled={loading}>
                      Settings
                    </Button>
                  )}
                  {canManage && (
                    <PageActionsMenu
                      disabled={loading}
                      label={p.title}
                      actions={[
                        { label: "Duplicate", onSelect: () => void duplicatePage(p) },
                        { label: "Version history", onSelect: () => setHistoryPage(p) },
                        ...(hasUnpublishedChanges(p) ? [{ label: "Discard draft changes", onSelect: () => void revertPage(p) }] : []),
                        ...(p.status === "published" ? [{ label: "Unpublish", onSelect: () => void setPublished(p, false) }] : [{ label: "Publish", onSelect: () => void setPublished(p, true) }]),
                        ...(!p.isHome ? [{ label: "Make this the home page", onSelect: () => void setHome(p._id) }] : []),
                        ...(!p.isHome ? [{ label: "Delete", danger: true, onSelect: () => void deletePage(p._id) }] : []),
                      ]}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {deleted.length > 0 && (
        <section aria-labelledby="deleted-pages-title" className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <button type="button" aria-expanded={showDeleted} onClick={() => setShowDeleted((value) => !value)} className="flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:px-6">
            <span id="deleted-pages-title" className="text-sm font-semibold text-slate-900">Recently deleted ({deleted.length})</span>
            <Icon name={showDeleted ? "chevron-up" : "chevron-down"} size={16} className="text-slate-500" />
          </button>
          {showDeleted && (
            <ul className="divide-y divide-slate-100 border-t border-slate-200">
              {deleted.map((revision) => (
                <li key={revision.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{revision.label || "Untitled page"}</p>
                    <p className="text-xs text-slate-500">Deleted {new Date(revision.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>
                  </div>
                  <Button variant="secondary" disabled={loading} onClick={() => void restoreDeleted(revision)}>Restore as draft</Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/** A page row's less common actions, so the list stays calm. */
function PageActionsMenu({ actions, label, disabled }: { actions: Array<{ label: string; onSelect: () => void; danger?: boolean }>; label: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="relative">
      <button type="button" aria-expanded={open} disabled={disabled} onClick={() => setOpen((value) => !value)} className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
        <span className="sr-only">More actions for {label}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </button>
      {open && (
        <div className="ui-pop absolute right-0 top-full z-40 mt-1 w-56 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
              className={`block min-h-10 w-full rounded-lg px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${action.danger ? "text-red-700 hover:bg-red-50" : "text-slate-700 hover:bg-slate-50"}`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
