"use client";

import { useId, useState } from "react";
import MediaPicker from "@/components/dashboard/MediaPicker";
import { Notice } from "@/components/ui/Surface";
import { SetupFooter, setupInput, setupLabel, useSetup } from "./SetupWizard";

export interface BusinessDetails {
  name: string;
  category: string;
  description: string;
  address: string;
  serviceArea: string;
  contactEmail: string;
  phone: string;
  logoUrl: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Step 1: who the business is and how customers reach it (PATCH /api/businesses/[id]). */
export default function BusinessStep({
  initial,
  businessTypes,
  presetLabel,
}: {
  initial: BusinessDetails;
  businessTypes: Array<{ key: string; name: string }>;
  /** Name of the homepage layout the current type uses. */
  presetLabel: string;
}) {
  const { businessId } = useSetup();
  const ids = { name: useId(), type: useId(), description: useId(), address: useId(), serviceArea: useId(), email: useId(), phone: useId(), hint: useId() };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const set = (patch: Partial<BusinessDetails>) => setForm((f) => ({ ...f, ...patch }));

  const problems = {
    name: form.name.trim().length < 2 ? "Enter your business name (at least 2 characters)." : null,
    email: form.contactEmail.trim() && !EMAIL.test(form.contactEmail.trim()) ? "Enter a valid email address, or leave it empty." : null,
  };
  const valid = !problems.name && !problems.email;

  async function save(): Promise<boolean> {
    setTouched(true);
    if (!valid) return false;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          category: form.category,
          description: form.description.trim(),
          address: form.address.trim(),
          serviceArea: form.serviceArea.trim(),
          contactEmail: form.contactEmail.trim(),
          phone: form.phone.trim(),
          logoUrl: form.logoUrl,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Your details could not be saved.");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error. Your details were not saved.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (message: string | null, id: string) =>
    touched && message ? (
      <p id={id} className="mt-1 text-xs text-red-700">
        {message}
      </p>
    ) : null;

  return (
    <div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <label htmlFor={ids.name} className={setupLabel}>
            Business name
          </label>
          <input
            id={ids.name}
            value={form.name}
            maxLength={140}
            required
            aria-invalid={touched && Boolean(problems.name)}
            aria-describedby={touched && problems.name ? `${ids.name}-error` : undefined}
            onChange={(e) => set({ name: e.target.value })}
            className={setupInput}
          />
          {fieldError(problems.name, `${ids.name}-error`)}
        </div>
        <div>
          <label htmlFor={ids.type} className={setupLabel}>
            Type of business
          </label>
          <select id={ids.type} value={form.category} onChange={(e) => set({ category: e.target.value })} aria-describedby={ids.hint} className={setupInput}>
            {businessTypes.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
          <p id={ids.hint} className="mt-1.5 text-xs leading-5 text-slate-500">
            Suggests a homepage layout and brand style ({presetLabel} now). Your homepage only changes if you choose a new layout in the Homepage and pages step.
          </p>
        </div>
        <div className="lg:col-span-2">
          <label htmlFor={ids.description} className={setupLabel}>
            Description
          </label>
          <textarea
            id={ids.description}
            rows={3}
            maxLength={2000}
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="What you sell and what makes your store special, in a sentence or two."
            className={setupInput}
          />
          <p className="mt-1.5 text-xs text-slate-500">Shown on your homepage and in search results. {form.description.length}/2000</p>
        </div>
        <div>
          <label htmlFor={ids.email} className={setupLabel}>
            Contact email
          </label>
          <input
            id={ids.email}
            type="email"
            value={form.contactEmail}
            aria-invalid={touched && Boolean(problems.email)}
            aria-describedby={touched && problems.email ? `${ids.email}-error` : undefined}
            onChange={(e) => set({ contactEmail: e.target.value })}
            className={setupInput}
          />
          {fieldError(problems.email, `${ids.email}-error`)}
        </div>
        <div>
          <label htmlFor={ids.phone} className={setupLabel}>
            Phone
          </label>
          <input id={ids.phone} type="tel" maxLength={40} value={form.phone} onChange={(e) => set({ phone: e.target.value })} className={setupInput} />
        </div>
        <div>
          <label htmlFor={ids.address} className={setupLabel}>
            Store address <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <input
            id={ids.address}
            maxLength={240}
            value={form.address}
            onChange={(e) => set({ address: e.target.value })}
            placeholder="Street, city, country"
            className={setupInput}
          />
        </div>
        <div>
          <label htmlFor={ids.serviceArea} className={setupLabel}>
            Service area <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <input
            id={ids.serviceArea}
            maxLength={240}
            value={form.serviceArea}
            onChange={(e) => set({ serviceArea: e.target.value })}
            placeholder="For example: Pune and nearby towns"
            className={setupInput}
          />
          <p className="mt-1.5 text-xs text-slate-500">Shown in your store footer. It does not limit orders: set delivery rules under Store settings.</p>
        </div>
        <div className="lg:col-span-2">
          <p className={setupLabel}>Logo <span className="font-normal text-slate-500">(optional)</span></p>
          <div className="flex flex-wrap items-center gap-3">
            {form.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={form.logoUrl} alt="Current logo" className="h-14 w-14 rounded-xl border border-slate-200 object-contain" />
            ) : (
              <span className="flex h-14 w-14 items-center justify-center rounded-xl border border-dashed border-slate-300 text-lg font-semibold text-slate-400" aria-hidden="true">
                {form.name.trim().charAt(0).toUpperCase() || "?"}
              </span>
            )}
            <MediaPicker businessId={businessId} selectedUrl={form.logoUrl} allowClear contextLabel="logo" onSelect={(m) => set({ logoUrl: m?.url ?? "" })} />
          </div>
        </div>
      </div>
      {error && (
        <Notice tone="danger" role="alert" className="mt-4">
          {error}
        </Notice>
      )}
      <SetupFooter onContinue={save} saving={saving} />
    </div>
  );
}
