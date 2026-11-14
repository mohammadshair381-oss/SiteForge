"use client";

import { useEffect, useRef, useState } from "react";
import ManagementPageHeader from "./ManagementPageHeader";
import MediaPicker from "./MediaPicker";
import { apiErrorFrom, fieldErrorId, invalidProps, summaryMessage } from "@/lib/api-errors";
import type { CategoryView } from "@/lib/categories";
import { Button, focusRing } from "@/components/ui/Button";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Card, EmptyState, Notice, Pill } from "@/components/ui/Surface";

const moveButtonClass = `inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`;

interface Draft {
  id?: string;
  name: string;
  slug: string;
  description: string;
  imageUrl: string;
  active: boolean;
}

/**
 * Managed product categories: name, URL slug, description, image, order and
 * visibility. Products are linked by their category text; renaming a
 * category updates its products. Categories are hidden, never deleted.
 */
export default function CategoriesManager({
  businessId,
  initial,
  initialUnmanaged,
}: {
  businessId: string;
  initial: CategoryView[];
  initialUnmanaged: Array<{ name: string; productCount: number }>;
}) {
  const [categories, setCategories] = useState(initial);
  const [unmanaged, setUnmanaged] = useState(initialUnmanaged);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const draftKey = draft ? draft.id ?? "new" : null;

  // The form sits above the list: bring it into view when a row opens it.
  useEffect(() => {
    if (draftKey) formRef.current?.scrollIntoView({ block: "nearest" });
  }, [draftKey]);

  async function request(url: string, method: string, body: unknown) {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const info = apiErrorFrom(data, "Something went wrong.");
      // Only the open form has fields to show them beside.
      if (draft) setFieldErrors(info.fields);
      throw new Error(draft ? summaryMessage(info, ["name", "slug", "description", "imageUrl"]) : info.message);
    }
    return data;
  }

  async function reload() {
    const res = await fetch(`/api/businesses/${businessId}/categories`, { cache: "no-store" });
    if (!res.ok) throw new Error("Could not refresh the list. Please reload the page.");
    const data = await res.json();
    setCategories(data.categories);
    setUnmanaged(data.unmanaged);
  }

  /** One action at a time: buttons wait, and any failure is shown. */
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setFieldErrors({});
    try {
      await action();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof TypeError ? "Could not reach the server. Nothing was changed." : (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    await run(async () => {
      const current = categories.find((c) => c.id === draft.id);
      await request(
        draft.id ? `/api/businesses/${businessId}/categories/${draft.id}` : `/api/businesses/${businessId}/categories`,
        draft.id ? "PUT" : "POST",
        { name: draft.name, slug: draft.slug, description: draft.description, imageUrl: draft.imageUrl, active: draft.active, ...(current ? { sort: current.sort } : {}) },
      );
      setDraft(null);
      setMessage({ ok: true, text: "Category saved." });
      await reload();
    });
  }

  async function move(index: number, direction: -1 | 1) {
    const a = categories[index];
    const b = categories[index + direction];
    if (!a || !b) return;
    await run(async () => {
      // Swap positions (two edits; each is validated server-side).
      await request(`/api/businesses/${businessId}/categories/${a.id}`, "PUT", { ...a, sort: b.sort === a.sort ? b.sort + direction : b.sort });
      await request(`/api/businesses/${businessId}/categories/${b.id}`, "PUT", { ...b, sort: a.sort });
      await reload();
    });
  }

  async function importAll() {
    await run(async () => {
      const data = await request(`/api/businesses/${businessId}/categories`, "POST", { action: "import" });
      setMessage({ ok: true, text: `${data.imported} categories added.` });
      setCategories(data.categories);
      setUnmanaged(data.unmanaged);
    });
  }

  function startNew() {
    setDraft({ name: "", slug: "", description: "", imageUrl: "", active: true });
    setMessage(null);
    setFieldErrors({});
  }

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Categories"
        description="Organise your products. Each active category with products gets its own page in your store and appears in the navigation, in the order shown here."
        actions={
          <Button onClick={startNew}>
            <Icon name="plus" size={16} />
            New category
          </Button>
        }
      />
      {message && (
        <Notice tone={message.ok ? "success" : "danger"} role="status">
          {message.text}
        </Notice>
      )}

      {unmanaged.length > 0 && (
        <Notice
          tone="warning"
          action={
            <Button variant="secondary" onClick={() => void importAll()} disabled={busy}>
              Manage them here
            </Button>
          }
        >
          Your products use {unmanaged.length} {unmanaged.length === 1 ? "category" : "categories"} not managed here yet: {unmanaged.map((u) => `${u.name} (${u.productCount})`).join(", ")}.
        </Notice>
      )}

      {draft && (
        <form ref={formRef} onSubmit={save} className="scroll-mt-44 space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 lg:scroll-mt-32" aria-label={draft.id ? "Edit category" : "New category"}>
          <h2 className="text-lg font-semibold text-slate-900">{draft.id ? "Edit category" : "New category"}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={labelClass}>
              Name
              <input required maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`mt-1.5 ${inputClass}`} {...invalidProps(fieldErrors, "name", "category")} />
              <FieldError id={fieldErrorId("category", "name")} message={fieldErrors.name} />
            </label>
            <label className={labelClass}>
              URL name (optional)
              <input maxLength={64} value={draft.slug} placeholder="from the name" onChange={(e) => setDraft({ ...draft, slug: e.target.value })} className={`mt-1.5 ${inputClass}`} {...invalidProps(fieldErrors, "slug", "category")} />
              <FieldError id={fieldErrorId("category", "slug")} message={fieldErrors.slug} />
            </label>
            <label className={`sm:col-span-2 ${labelClass}`}>
              Description
              <textarea rows={3} maxLength={500} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={`mt-1.5 ${inputClass}`} {...invalidProps(fieldErrors, "description", "category")} />
              <FieldError id={fieldErrorId("category", "description")} message={fieldErrors.description} />
            </label>
          </div>
          <div>
            <p className={labelClass}>Image</p>
            <div className="flex flex-wrap items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {draft.imageUrl && <img src={draft.imageUrl} alt="" className="h-14 w-20 rounded-lg border border-slate-200 object-cover" />}
              <MediaPicker businessId={businessId} selectedUrl={draft.imageUrl} allowClear contextLabel="category image" onSelect={(m) => setDraft((d) => (d ? { ...d, imageUrl: m?.url ?? "" } : d))} />
            </div>
            <FieldError message={fieldErrors.imageUrl} />
          </div>
          <label className="flex min-h-10 items-center gap-2 text-sm font-medium text-slate-800">
            <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} className="h-4 w-4" /> Show in the store
          </label>
          {draft.id && <p className="text-xs text-slate-500">Renaming also renames the category on its products.</p>}
          <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
            <Button type="submit" disabled={busy} aria-busy={busy}>{busy ? "Saving…" : "Save"}</Button>
            <Button variant="secondary" onClick={() => setDraft(null)} disabled={busy}>Cancel</Button>
          </div>
        </form>
      )}

      {categories.length === 0 ? (
        !draft && (
          <EmptyState
            icon={<Icon name="categories" size={20} />}
            title="No categories yet"
            action={<Button onClick={startNew}>Create your first category</Button>}
          >
            Categories group your products, so shoppers can browse them on their own pages in your store.
          </EmptyState>
        )
      ) : (
        <Card as="section" aria-label="Categories">
          <ol className="divide-y divide-slate-100">
            {categories.map((c, index) => (
              <li key={c.id} className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 px-4 py-4 transition-colors hover:bg-slate-50 sm:grid-cols-[1.5rem_3.5rem_minmax(0,1fr)_auto] sm:px-5 sm:py-3">
                <span className="text-sm tabular-nums text-slate-500">{index + 1}.</span>
                {c.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.imageUrl} alt="" loading="lazy" className="hidden h-11 w-14 rounded-lg border border-slate-200 object-cover sm:block" />
                ) : (
                  <span aria-hidden="true" className="hidden h-11 w-14 items-center justify-center rounded-lg bg-slate-100 text-slate-400 sm:flex">
                    <Icon name="categories" size={16} />
                  </span>
                )}
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                    <span className="min-w-0 break-words">{c.name}</span>
                    {!c.active && <Pill>hidden</Pill>}
                  </p>
                  <p className="truncate text-xs text-slate-500">/category/{c.slug} · {c.productCount} {c.productCount === 1 ? "product" : "products"}</p>
                </div>
                <div className="col-span-2 flex flex-wrap items-center gap-2 sm:col-span-1 sm:justify-end">
                  <button type="button" disabled={busy || index === 0} onClick={() => void move(index, -1)} aria-label={`Move ${c.name} up`} className={moveButtonClass}>
                    <Icon name="chevron-down" size={16} className="rotate-180" />
                  </button>
                  <button type="button" disabled={busy || index === categories.length - 1} onClick={() => void move(index, 1)} aria-label={`Move ${c.name} down`} className={moveButtonClass}>
                    <Icon name="chevron-down" size={16} />
                  </button>
                  <Button variant="secondary" onClick={() => { setDraft({ id: c.id, name: c.name, slug: c.slug, description: c.description, imageUrl: c.imageUrl, active: c.active }); setMessage(null); setFieldErrors({}); }}>
                    Edit
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}
