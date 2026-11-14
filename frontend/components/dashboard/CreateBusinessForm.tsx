"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Surface";
import { buttonClass, focusRing } from "@/components/ui/Button";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { fieldErrorId, invalidProps, readApiError, summaryMessage } from "@/lib/api-errors";

interface CategoryOption {
  key: string;
  name: string;
}

export default function CreateBusinessForm({
  categories,
  rootDomain,
}: {
  categories: CategoryOption[];
  rootDomain?: string;
}) {
  const router = useRouter();
  const nameId = useId();
  const categoryId = useId();
  const subdomainId = useId();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState(categories[0]?.key ?? "retail");
  const [subdomain, setSubdomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const toggle = toggleRef.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    nameRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "Tab" && dialogRef.current) {
        const items = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input, select")];
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      toggle?.focus();
    };
  }, [open]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch("/api/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          category,
          subdomain: subdomain || undefined,
        }),
      });
      if (!res.ok) {
        const info = await readApiError(res, "Unable to create business");
        setFieldErrors(info.fields);
        setError(summaryMessage(info, ["name", "category", "subdomain"]));
        return;
      }
      const data = await res.json();
      // New stores start in the guided setup (it can be left and resumed).
      router.push(`/dashboard/businesses/${data.business._id}/setup`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create business");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button ref={toggleRef} id="create-business-toggle" type="button" onClick={() => setOpen(true)} className={buttonClass({ block: true, className: "sm:w-auto" })}>
        <Icon name="plus" size={16} />
        Create business
      </button>

      {open &&
        createPortal(
          <div className="ui-fade fixed inset-0 z-[70] flex items-end justify-center overflow-y-auto bg-slate-950/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-4">
            <button type="button" tabIndex={-1} aria-hidden="true" className="absolute inset-0 cursor-default" onClick={() => setOpen(false)} />
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="ui-pop relative w-full max-w-lg rounded-t-2xl bg-white p-6 shadow-lg sm:rounded-2xl sm:p-7">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 id={titleId} className="text-xl font-semibold text-slate-900">
                    New business
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">Guided setup takes it from here. Your store stays private until you publish it.</p>
                </div>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 ${focusRing}`}>
                  <Icon name="x" size={18} />
                </button>
              </div>
              <form onSubmit={onSubmit} className="mt-6 space-y-4">
                <div>
                  <label htmlFor={nameId} className={labelClass}>
                    Business name
                  </label>
                  <input ref={nameRef} id={nameId} required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} {...invalidProps(fieldErrors, "name", "new-business")} />
                  <FieldError id={fieldErrorId("new-business", "name")} message={fieldErrors.name} />
                </div>
                <div>
                  <label htmlFor={categoryId} className={labelClass}>
                    Category
                  </label>
                  <select id={categoryId} value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass}>
                    {categories.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-xs text-slate-500">We use this to prepare a starting homepage and pages that suit your business.</p>
                  <FieldError message={fieldErrors.category} />
                </div>
                <div>
                  <label htmlFor={subdomainId} className={labelClass}>
                    Subdomain (optional)
                  </label>
                  <div className="flex items-center gap-2">
                    <input id={subdomainId} value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="my-shop" className={inputClass} {...invalidProps(fieldErrors, "subdomain", "new-business")} />
                    {rootDomain && <span className="shrink-0 text-sm text-slate-500">.{rootDomain}</span>}
                  </div>
                  <p className="mt-1.5 text-xs text-slate-500">Your store&apos;s web address. Letters, numbers and hyphens only. Leave blank to auto-generate.</p>
                  <FieldError id={fieldErrorId("new-business", "subdomain")} message={fieldErrors.subdomain} />
                </div>
                {error && (
                  <Notice tone="danger" role="alert">
                    {error}
                  </Notice>
                )}
                <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
                  <button type="button" onClick={() => setOpen(false)} className={buttonClass({ variant: "secondary" })}>
                    Cancel
                  </button>
                  <button type="submit" disabled={loading} className={buttonClass()}>
                    {loading ? "Creating…" : "Create business"}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
