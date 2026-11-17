"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { Notice, Pill } from "@/components/ui/Surface";
import { apiErrorFrom, fieldErrorId, invalidProps, summaryMessage } from "@/lib/api-errors";

export interface AiKeyProvider {
  id: string;
  displayName: string;
  envName: string;
  source: "admin" | "environment" | "unreadable" | "none";
  last4: string | null;
  updatedAt: string | null;
}

/** Keep in sync with ADMIN_REASON_MIN in lib/admin-audit.ts (the server enforces it). */
const REASON_MIN = 5;

const STATUS: Record<AiKeyProvider["source"], { tone: "success" | "neutral" | "warning" | "danger"; text: (p: AiKeyProvider) => string }> = {
  admin: { tone: "success", text: (p) => `Key saved here, ending …${p.last4 ?? ""}` },
  environment: { tone: "neutral", text: (p) => `Using the server setting ${p.envName}` },
  unreadable: { tone: "danger", text: () => "Saved key cannot be read: enter it again" },
  none: { tone: "warning", text: () => "No API key" },
};

/**
 * API keys for the AI providers (app/api/admin/ai-credentials). A key is written once and never
 * shown again: only its last four characters. Each change needs the admin's password and a reason,
 * and is recorded in the audit log. A key never turns AI on by itself.
 */
export default function AiKeyManager({ initial }: { initial: AiKeyProvider[] }) {
  const router = useRouter();
  const formId = useId();
  const [providers, setProviders] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);

  function open(id: string | null) {
    setEditing(id);
    setApiKey("");
    setPassword("");
    setReason("");
    setError(null);
    setFields({});
  }

  async function send(method: "PUT" | "DELETE", provider: AiKeyProvider) {
    if (reason.trim().length < REASON_MIN || !password) {
      setFields({ ...(reason.trim().length < REASON_MIN ? { reason: `Give a reason of at least ${REASON_MIN} characters.` } : {}), ...(!password ? { currentPassword: "Enter your password." } : {}) });
      setError("Check the highlighted fields. Nothing was changed.");
      return;
    }
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const res = await fetch("/api/admin/ai-credentials", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: provider.id, ...(method === "PUT" ? { apiKey } : {}), currentPassword: password, reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const info = apiErrorFrom(data, "The key could not be saved.");
        setFields(info.fields);
        setError(`${summaryMessage(info, ["apiKey", "currentPassword", "reason"])} Nothing was changed.`);
        return;
      }
      setProviders((current) => current.map((item) => (item.id === provider.id ? { ...item, ...data.provider } : item)));
      setSaved(method === "PUT" ? `${provider.displayName} key saved. It is used from the next request.` : `${provider.displayName} key removed.`);
      open(null);
      router.refresh();
    } catch {
      setError("The server could not be reached. Nothing was changed.");
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  const prefix = (id: string) => `${formId}-${id}`;

  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-slate-500">
        Paste each provider&apos;s API key here. It is stored encrypted and never shown again, only its last four characters. A key saved here is used instead of the server setting. Adding a key does not turn AI on: choose which provider to use in the routing below.
      </p>
      {saved && <Notice tone="success" role="status">{saved}</Notice>}
      <ul className="space-y-3">
        {providers.map((provider) => {
          const status = STATUS[provider.source];
          const isOpen = editing === provider.id;
          return (
            <li key={provider.id} className="rounded-xl border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-900">{provider.displayName}</span>
                <Pill tone={status.tone} dot>{status.text(provider)}</Pill>
              </div>
              {provider.updatedAt && provider.source !== "environment" && <p className="mt-1 text-xs text-slate-500">Changed {new Date(provider.updatedAt).toLocaleString()}</p>}
              {!isOpen ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => { setSaved(null); open(provider.id); }}>{provider.source === "admin" || provider.source === "unreadable" ? "Replace key" : "Add key"}</Button>
                </div>
              ) : (
                <form
                  className="mt-3 space-y-3"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send("PUT", provider);
                  }}
                >
                  <div>
                    <label htmlFor={`${prefix(provider.id)}-key`} className={labelClass}>{provider.displayName} API key</label>
                    <input id={`${prefix(provider.id)}-key`} type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} className={inputClass} {...invalidProps(fields, "apiKey", prefix(provider.id))} />
                    <FieldError id={fieldErrorId(prefix(provider.id), "apiKey")} message={fields.apiKey} />
                  </div>
                  <div>
                    <label htmlFor={`${prefix(provider.id)}-password`} className={labelClass}>Your SiteForge password</label>
                    <input id={`${prefix(provider.id)}-password`} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className={inputClass} {...invalidProps(fields, "currentPassword", prefix(provider.id))} />
                    <FieldError id={fieldErrorId(prefix(provider.id), "currentPassword")} message={fields.currentPassword} />
                  </div>
                  <div>
                    <label htmlFor={`${prefix(provider.id)}-reason`} className={labelClass}>Reason (recorded in the audit log)</label>
                    <input id={`${prefix(provider.id)}-reason`} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="For example: new key from the provider's console" className={inputClass} {...invalidProps(fields, "reason", prefix(provider.id))} />
                    <FieldError id={fieldErrorId(prefix(provider.id), "reason")} message={fields.reason} />
                  </div>
                  {error && <Notice tone="danger" role="alert">{error}</Notice>}
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={busy || apiKey.trim().length === 0}>{busy ? "Saving…" : "Save key"}</Button>
                    {provider.source === "admin" || provider.source === "unreadable" ? (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={async () => {
                          const confirmed = await confirmDialog({
                            title: `Remove the ${provider.displayName} key?`,
                            message: `Requests to ${provider.displayName} stop within about 30 seconds, unless the server setting ${provider.envName} has a key.`,
                            confirmLabel: "Remove key",
                            tone: "danger",
                          });
                          if (confirmed) void send("DELETE", provider);
                        }}
                      >
                        Remove key
                      </Button>
                    ) : null}
                    <Button variant="ghost" disabled={busy} onClick={() => open(null)}>Cancel</Button>
                  </div>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
