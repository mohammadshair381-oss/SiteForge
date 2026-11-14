"use client";

import { formatValidationError } from "@/lib/validation-messages";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { businessUpdateSchema } from "@/lib/validation";
import { Button } from "@/components/ui/Button";
import { fieldErrorId, invalidProps, readApiError, summaryMessage } from "@/lib/api-errors";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { Card, Notice } from "@/components/ui/Surface";

interface BusinessFields {
  name: string;
  description: string;
  logoUrl: string;
  contactEmail: string;
  phone: string;
  address: string;
  serviceArea: string;
  currency: string;
}

const FIELD_NAMES = ["name", "description", "logoUrl", "contactEmail", "phone", "address", "serviceArea", "currency"] as const;

/** A titled group of fields: the title sits beside the fields on wide screens. */
function FieldGroup({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="grid gap-4 border-t border-slate-200 py-5 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p>
      </div>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">{children}</div>
    </div>
  );
}

export default function SettingsForm({
  businessId,
  canManage,
  initial,
}: {
  businessId: string;
  canManage: boolean;
  initial: BusinessFields;
}) {
  const router = useRouter();
  const nameId = useId();
  const descriptionId = useId();
  const logoUrlId = useId();
  const contactEmailId = useId();
  const phoneId = useId();
  const currencyId = useId();
  const addressId = useId();
  const serviceAreaId = useId();

  const [fields, setFields] = useState<BusinessFields>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function update<K extends keyof BusinessFields>(key: K, value: BusinessFields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => (current[key] ? { ...current, [key]: "" } : current));
    setDirty(true);
    setError(null);
    setNotice(null);
  }

  // Warn about lost edits on refresh/close. In-app tab navigation is handled by
  // the inline "unsaved changes" hint; intercepting Next.js client navigation
  // is deliberately avoided so the save flow is never blocked.
  useEffect(() => {
    if (!canManage || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [canManage, dirty]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;

    const parsed = businessUpdateSchema.safeParse(fields);
    if (!parsed.success) {
      const problem = formatValidationError(parsed.error);
      setFieldErrors(problem.fields);
      setError(summaryMessage({ ...problem, code: null }, FIELD_NAMES));
      return;
    }

    setSaving(true);
    setError(null);
    setFieldErrors({});
    setNotice(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) {
        const info = await readApiError(res, "Unable to save settings");
        setFieldErrors(info.fields);
        setError(summaryMessage(info, FIELD_NAMES));
        return;
      }
      setNotice("Settings saved.");
      setDirty(false);
      router.refresh();
    } catch {
      setError("Network error. Your settings were not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5 sm:p-6">
      <form onSubmit={save} noValidate>
        <div className="sr-only" role="status" aria-live="polite">
          {notice ?? ""}
        </div>
        <div className="sr-only" role="alert" aria-live="assertive">
          {error ?? ""}
        </div>

        <h2 className="text-lg font-semibold text-slate-900">Business profile</h2>
        <p className="mt-1 text-sm text-slate-600">
          These details appear on your public storefront. Only the business name is required.
        </p>

        {!canManage && (
          <Notice tone="info" className="mt-4">
            Only business owners and managers can edit business settings. You can
            review them but not change them.
          </Notice>
        )}

        {(error || notice) && (
          <Notice tone={error ? "danger" : "success"} className="mt-4">
            {error ?? notice}
          </Notice>
        )}

        <fieldset disabled={!canManage} className="mt-5 min-w-0">
          <legend className="sr-only">Business profile fields</legend>

          <FieldGroup title="Your business" hint="How your store introduces itself.">
            <div className="sm:col-span-2">
              <label htmlFor={nameId} className={labelClass}>
                Business name
              </label>
              <input
                id={nameId}
                required
                maxLength={140}
                value={fields.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder="e.g. Aurora Goods"
                className={inputClass}
                {...invalidProps(fieldErrors, "name", "settings")}
              />
              <FieldError id={fieldErrorId("settings", "name")} message={fieldErrors.name} />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={descriptionId} className={labelClass}>
                Description <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <textarea
                id={descriptionId}
                rows={4}
                maxLength={2000}
                value={fields.description}
                onChange={(e) => update("description", e.target.value)}
                placeholder="A short intro shown in the storefront hero."
                className={inputClass}
                {...invalidProps(fieldErrors, "description", "settings")}
              />
              <FieldError id={fieldErrorId("settings", "description")} message={fieldErrors.description} />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={logoUrlId} className={labelClass}>
                Logo URL <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <input
                id={logoUrlId}
                type="url"
                value={fields.logoUrl}
                onChange={(e) => update("logoUrl", e.target.value)}
                placeholder="https://…"
                className={inputClass}
                {...invalidProps(fieldErrors, "logoUrl", "settings")}
              />
              <FieldError id={fieldErrorId("settings", "logoUrl")} message={fieldErrors.logoUrl} />
            </div>
          </FieldGroup>

          <FieldGroup title="Contact details" hint="How customers can reach you.">
            <div>
              <label htmlFor={contactEmailId} className={labelClass}>
                Contact email <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <input
                id={contactEmailId}
                type="email"
                value={fields.contactEmail}
                onChange={(e) => update("contactEmail", e.target.value)}
                placeholder="hello@example.com"
                className={inputClass}
                {...invalidProps(fieldErrors, "contactEmail", "settings")}
              />
              <FieldError id={fieldErrorId("settings", "contactEmail")} message={fieldErrors.contactEmail} />
            </div>
            <div>
              <label htmlFor={phoneId} className={labelClass}>
                Phone <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <input
                id={phoneId}
                type="tel"
                maxLength={40}
                value={fields.phone}
                onChange={(e) => update("phone", e.target.value)}
                placeholder="+1 (555) 000-0000"
                className={inputClass}
                {...invalidProps(fieldErrors, "phone", "settings")}
              />
              <FieldError id={fieldErrorId("settings", "phone")} message={fieldErrors.phone} />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={addressId} className={labelClass}>
                Address <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <input
                id={addressId}
                maxLength={240}
                value={fields.address}
                onChange={(e) => update("address", e.target.value)}
                placeholder="Street, city, country"
                className={inputClass}
                {...invalidProps(fieldErrors, "address", "settings")}
              />
              <FieldError id={fieldErrorId("settings", "address")} message={fieldErrors.address} />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={serviceAreaId} className={labelClass}>
                Service area <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <input
                id={serviceAreaId}
                maxLength={240}
                value={fields.serviceArea}
                onChange={(e) => update("serviceArea", e.target.value)}
                placeholder="For example: Pune and nearby towns"
                className={inputClass}
                {...invalidProps(fieldErrors, "serviceArea", "settings")}
              />
              <FieldError id={fieldErrorId("settings", "serviceArea")} message={fieldErrors.serviceArea} />
            </div>
          </FieldGroup>

          <FieldGroup title="Money" hint="The currency your prices are shown in.">
            <div>
              <label htmlFor={currencyId} className={labelClass}>
                Currency <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <input
                id={currencyId}
                maxLength={3}
                value={fields.currency}
                onChange={(e) => update("currency", e.target.value.toUpperCase())}
                placeholder="USD"
                className={inputClass}
                {...invalidProps(fieldErrors, "currency", "settings")}
              />
              <FieldError id={fieldErrorId("settings", "currency")} message={fieldErrors.currency} />
              <p className="mt-1.5 text-xs text-slate-500">
                ISO 3-letter code, e.g. USD or EUR.
              </p>
            </div>
          </FieldGroup>
        </fieldset>

        {canManage && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-5">
            {dirty ? (
              <p className="text-sm font-medium text-amber-800">
                <span aria-hidden="true">● </span>
                You have unsaved changes.
              </p>
            ) : (
              <span className="text-sm text-slate-500">All changes saved.</span>
            )}
            <Button type="submit" disabled={saving} className="w-full sm:w-auto">
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
