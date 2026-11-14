"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";
import { apiErrorFrom, fieldErrorId, invalidProps, summaryMessage } from "@/lib/api-errors";
import type { PlatformSettingsView } from "@/lib/platform-settings";

const FIELDS = ["supportEmail", "maintenanceMessage", "reason"];
/** Keep in sync with ADMIN_REASON_MIN in lib/admin-audit.ts (the server enforces it). */
const REASON_MIN = 5;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(form: PlatformSettingsView, reason: string): Record<string, string> {
  const problems: Record<string, string> = {};
  const email = form.supportEmail.trim();
  if (email && !EMAIL.test(email)) problems.supportEmail = "Enter a valid email address, or leave this empty.";
  if (/[<>]/.test(form.maintenanceMessage)) problems.maintenanceMessage = "Use plain text, without < or >.";
  if (reason.trim().length < REASON_MIN) problems.reason = `Give a reason of at least ${REASON_MIN} characters.`;
  return problems;
}

const same = (a: PlatformSettingsView, b: PlatformSettingsView) =>
  a.supportEmail.trim().toLowerCase() === b.supportEmail.trim().toLowerCase() && a.maintenanceEnabled === b.maintenanceEnabled && a.maintenanceMessage.trim() === b.maintenanceMessage.trim() && a.registrationOpen === b.registrationOpen;

/**
 * The settings a Super Admin can change here. Each save needs a reason, and is audited.
 * `unavailable` means the saved values could not be read, so saving is off: what is shown may
 * be defaults, and they must not replace what is stored.
 */
export default function PlatformSettingsForm({ initial, revision: initialRevision, unavailable = false }: { initial: PlatformSettingsView; revision: number; unavailable?: boolean }) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [revision, setRevision] = useState(initialRevision);
  const [outdated, setOutdated] = useState(false);
  const [form, setForm] = useState(initial);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const dirty = !same(form, saved);

  function update(patch: Partial<PlatformSettingsView>) {
    setForm((current) => ({ ...current, ...patch }));
    setSavedAt(null);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const problems = validate(form, reason);
    setFields(problems);
    setSavedAt(null);
    if (Object.keys(problems).length > 0) {
      setError("Check the highlighted fields. Nothing was saved.");
      return;
    }
    setError(null);
    if (form.maintenanceEnabled && !saved.maintenanceEnabled) {
      const confirmed = await confirmDialog({ title: "Turn on maintenance mode?", message: "New accounts, new stores and publishing are paused for everyone straight away. Storefronts, checkout and payments keep working.", confirmLabel: "Turn on", tone: "danger" });
      if (!confirmed) return;
    }
    if (!form.registrationOpen && saved.registrationOpen) {
      const confirmed = await confirmDialog({ title: "Stop accepting new accounts?", message: "The registration page will say that accounts are not being accepted. Existing accounts are not affected.", confirmLabel: "Stop accepting", tone: "danger" });
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, reason, expectedRevision: revision }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const info = apiErrorFrom(data, "The settings could not be saved.");
        setFields(info.fields);
        setOutdated(info.code === "settings_changed");
        setError(info.code === "settings_changed" ? info.message : `${summaryMessage(info, FIELDS)} Nothing was changed.`);
        return;
      }
      const next = (data as { settings?: PlatformSettingsView }).settings ?? form;
      const nextRevision = (data as { revision?: number }).revision;
      if (typeof nextRevision === "number") setRevision(nextRevision);
      setOutdated(false);
      setSaved(next);
      setForm(next);
      setSavedAt(new Date().toLocaleTimeString(undefined, { timeStyle: "short" }));
      setReason("");
      router.refresh();
    } catch {
      setError("The server could not be reached. Nothing was changed.");
    } finally {
      setSaving(false);
    }
  }

  const checkbox = (key: "maintenanceEnabled" | "registrationOpen", label: string, hint: string) => (
    <label className="flex items-start gap-2.5 text-sm text-slate-800">
      <input type="checkbox" checked={form[key]} disabled={unavailable} onChange={(e) => update({ [key]: e.target.checked })} className="mt-0.5 h-4 w-4" />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs leading-5 text-slate-500">{hint}</span>
      </span>
    </label>
  );

  return (
    <form onSubmit={save} noValidate className="space-y-4">
      <div>
        <label htmlFor="platform-support" className={labelClass}>Support email</label>
        <input id="platform-support" type="email" value={form.supportEmail} disabled={unavailable} onChange={(e) => update({ supportEmail: e.target.value })} className={inputClass} {...invalidProps(fields, "supportEmail", "platform")} />
        <FieldError id={fieldErrorId("platform", "supportEmail")} message={fields.supportEmail} />
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Shown on the sign-in and registration pages, error pages and dashboard help. Anyone can see it, but shoppers on a store never do. Left empty, people are told to contact their platform administrator.
        </p>
      </div>
      {checkbox("registrationOpen", "Accept new accounts", "Off: the registration page says that accounts are not being accepted, and the server refuses them. Existing accounts are not affected.")}
      {checkbox("maintenanceEnabled", "Maintenance mode", "Pauses new accounts, new stores and publishing, and shows a notice in every dashboard. Storefronts, checkout, payments and signing in keep working.")}
      {form.maintenanceEnabled && (
        <Notice tone="warning" role="status">
          {saved.maintenanceEnabled ? "Maintenance mode is on for everyone now." : "Saving this turns on maintenance mode for everyone."} Owners cannot create stores or publish until it is off.
        </Notice>
      )}
      <div>
        <label htmlFor="platform-message" className={labelClass}>Maintenance message (optional)</label>
        <textarea id="platform-message" rows={2} maxLength={300} value={form.maintenanceMessage} disabled={unavailable} onChange={(e) => update({ maintenanceMessage: e.target.value })} className={inputClass} {...invalidProps(fields, "maintenanceMessage", "platform")} />
        <FieldError id={fieldErrorId("platform", "maintenanceMessage")} message={fields.maintenanceMessage} />
        <p className="mt-1 text-xs text-slate-500">Plain text, shown publicly during maintenance. {form.maintenanceMessage.length}/300</p>
      </div>
      <div>
        <label htmlFor="platform-reason" className={labelClass}>Reason for this change (recorded in the audit log)</label>
        <input id="platform-reason" maxLength={500} value={reason} disabled={unavailable} onChange={(e) => setReason(e.target.value)} className={inputClass} {...invalidProps(fields, "reason", "platform")} />
        <FieldError id={fieldErrorId("platform", "reason")} message={fields.reason} />
      </div>
      {error && (
        <Notice tone="danger" role="alert" action={outdated ? <Button variant="secondary" onClick={() => window.location.reload()}>Load the latest settings</Button> : undefined}>
          {error}
        </Notice>
      )}
      {savedAt && <Notice tone="success" role="status">Settings saved at {savedAt}. They can take up to 30 seconds to apply everywhere.</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving || unavailable || outdated || !dirty}>{saving ? "Saving…" : "Save settings"}</Button>
        {dirty && !saving && <span className="text-xs text-slate-500">You have unsaved changes.</span>}
      </div>
    </form>
  );
}
