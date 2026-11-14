"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { inputClass, labelClass } from "@/components/ui/Field";
import { Card, Notice, Pill, Skeleton } from "@/components/ui/Surface";

interface AccountView {
  featureEnabled: boolean;
  encryptionConfigured: boolean;
  liveAllowed: boolean;
  account: { provider: "razorpay"; mode: "test" | "live"; keyId: string; connectedAt: string; rotatedAt: string | null } | null;
}

const quietDangerClass =
  "inline-flex min-h-10 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Connect the business's OWN Razorpay account (owner only). Secrets are
 * write-only: they are sent once, encrypted on the server and never shown
 * again. The server enforces the owner role, the platform feature flag and
 * test/live separation.
 */
export default function OnlinePaymentAccount({ businessId, webhookUrl }: { businessId: string; webhookUrl: string }) {
  const formId = useId();
  const [view, setView] = useState<AccountView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<"test" | "live">("test");
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/businesses/${businessId}/payment-account`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not load the payment account.");
      setView(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the payment account.");
    }
  }, [businessId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(method: "PUT" | "DELETE", event?: React.FormEvent) {
    event?.preventDefault();
    if (saving) return;
    if (
      method === "DELETE" &&
      !(await confirmDialog({
        title: "Disconnect Razorpay?",
        message: "Shoppers will no longer be able to pay online.",
        confirmLabel: "Disconnect",
        cancelLabel: "Stay connected",
        tone: "danger",
      }))
    ) {
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/payment-account`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "PUT" ? JSON.stringify({ mode, keyId, keySecret, webhookSecret }) : "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ kind: "error", text: typeof data.error === "string" ? data.error : "Could not save." });
        return;
      }
      setView(data);
      setKeySecret("");
      setWebhookSecret("");
      setMessage({ kind: "ok", text: method === "PUT" ? "Razorpay account saved." : "Razorpay account disconnected." });
    } catch {
      setMessage({ kind: "error", text: "Network error. Please try again." });
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <Notice tone="danger" role="alert">
        {loadError}
      </Notice>
    );
  }
  if (!view) {
    return (
      <Card className="p-5 sm:p-6">
        <p role="status" className="sr-only">Loading online payments…</p>
        <div aria-hidden="true" className="space-y-2">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </Card>
    );
  }

  const disabledReason = !view.featureEnabled
    ? "Online payments are not enabled on this platform yet."
    : !view.encryptionConfigured
      ? "Secure credential storage is not configured on this platform yet."
      : null;

  return (
    <Card as="section" aria-labelledby={`${formId}-title`} className="p-5 sm:p-6">
      <h2 id={`${formId}-title`} className="text-lg font-semibold text-slate-900">Online payments (Razorpay)</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        Connect your own Razorpay account. Shoppers pay on Razorpay&apos;s secure page and the money goes directly to your
        account. Orders are marked paid only after SiteForge verifies the payment with Razorpay. Orders must be priced in INR.
      </p>

      {view.account ? (
        <div className="mt-4 rounded-xl border border-slate-200 p-4 text-sm">
          <p className="flex flex-wrap items-center gap-2 text-slate-700">
            <span>
              Connected: <strong className="break-all font-semibold text-slate-900">{view.account.keyId}</strong>
            </span>
            <Pill tone={view.account.mode === "live" ? "success" : "warning"} dot>
              {view.account.mode === "live" ? "Live mode" : "Test mode — no real money"}
            </Pill>
          </p>
          {view.account.mode === "live" && !view.liveAllowed && (
            <Notice tone="warning" className="mt-3">
              Live payments are switched off on this platform, so online payment is hidden from shoppers.
            </Notice>
          )}
        </div>
      ) : (
        <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">No Razorpay account connected.</p>
      )}

      {disabledReason ? (
        <Notice tone="warning" className="mt-4">
          {disabledReason}
        </Notice>
      ) : (
        <form onSubmit={(e) => void submit("PUT", e)} className="mt-5 grid gap-4 border-t border-slate-200 pt-5 sm:grid-cols-2">
          <fieldset className="sm:col-span-2">
            <legend className={labelClass}>Mode</legend>
            <div className="flex flex-wrap gap-x-5 text-sm text-slate-800">
              <label className="flex min-h-10 items-center gap-2">
                <input type="radio" name="mode" value="test" checked={mode === "test"} onChange={() => setMode("test")} /> Test
              </label>
              <label className="flex min-h-10 items-center gap-2">
                <input type="radio" name="mode" value="live" checked={mode === "live"} disabled={!view.liveAllowed} onChange={() => setMode("live")} /> Live
                {!view.liveAllowed && <span className="text-xs text-slate-500">(not enabled)</span>}
              </label>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {mode === "live" ? "Live keys take real payments from shoppers." : "Test keys never take real money."}
            </p>
          </fieldset>
          <label className={labelClass}>
            Key id
            <input className={`mt-1.5 ${inputClass}`} value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder={`rzp_${mode}_…`} autoComplete="off" required />
          </label>
          <label className={labelClass}>
            Key secret
            <input className={`mt-1.5 ${inputClass}`} type="password" value={keySecret} onChange={(e) => setKeySecret(e.target.value)} autoComplete="new-password" required />
          </label>
          <label className={`sm:col-span-2 ${labelClass}`}>
            Webhook secret
            <input className={`mt-1.5 ${inputClass}`} type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} autoComplete="new-password" required />
            <span className="mt-2 block rounded-lg bg-slate-50 px-3 py-2 text-xs font-normal leading-5 text-slate-600">
              In Razorpay, add a webhook for <code className="break-all font-medium text-slate-900">{webhookUrl}</code> with the events{" "}
              <code className="font-medium text-slate-900">payment_link.paid</code>, <code className="font-medium text-slate-900">payment_link.expired</code>, <code className="font-medium text-slate-900">payment_link.cancelled</code>, <code className="font-medium text-slate-900">payment.failed</code>, <code className="font-medium text-slate-900">refund.created</code>, <code className="font-medium text-slate-900">refund.processed</code> and <code className="font-medium text-slate-900">refund.failed</code>, and use the same secret here.
            </span>
          </label>
          <p className="text-xs text-slate-500 sm:col-span-2">Secrets are sent once, stored encrypted and never shown again.</p>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : view.account ? "Replace credentials" : "Connect Razorpay"}
            </Button>
            {view.account && (
              <button type="button" disabled={saving} onClick={() => void submit("DELETE")} className={quietDangerClass}>
                Disconnect
              </button>
            )}
          </div>
        </form>
      )}
      <div aria-live="polite">
        {message && (
          <Notice tone={message.kind === "ok" ? "success" : "danger"} className="mt-3">
            {message.text}
          </Notice>
        )}
      </div>
    </Card>
  );
}
