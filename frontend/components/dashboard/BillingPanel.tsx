"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { describeBillingState } from "@/lib/billing-status";
import { formatPrice } from "@/lib/format";
import { INACTIVE_PLAN_EFFECTS, formatUsageValue, isAtLimit, isOverLimit, planChangeImpact, type PlanLimitValues, type UsageLine } from "@/lib/plan-limits";
import ManagementPageHeader from "./ManagementPageHeader";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/Icon";
import { Card, EmptyState, Notice, Pill, type Tone } from "@/components/ui/Surface";
import SupportContact from "@/components/ui/SupportContact";

interface PlanOption {
  key: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  interval: string;
  features: {
    productLimit: number;
    staffLimit: number;
    customDomain: boolean;
    removeBranding: boolean;
    aiRequestsPerMonth: number;
    /** null = no limit. */
    pageLimit: number | null;
    storageMb: number | null;
    monthlyOrderLimit: number | null;
  };
  /** Names of the storefront themes this plan includes. */
  themes: string[];
}

interface PaymentRow {
  _id: string;
  amount: number;
  currency: string;
  status: string;
  description: string;
  createdAt: string;
  paidAt: string | null;
  refundedAmount: number;
}

/** A refund or dispute on a subscription payment, as Razorpay reports it. */
interface AdjustmentRow {
  id: string;
  kind: "refund" | "dispute";
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
}

const shortDate = (value: string) => new Date(value).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });

interface SubscriptionSummary {
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

const SUBSCRIPTION_TONES: Record<string, Tone> = {
  active: "success",
  trialing: "success",
  expired: "danger",
  past_due: "warning",
  canceled: "danger",
  incomplete: "neutral",
};

const PAYMENT_TONES: Record<string, Tone> = {
  succeeded: "success",
  pending: "warning",
  failed: "danger",
  refunded: "neutral",
};

function titleCaseStatus(status: string): string {
  const normalized = status.replace(/[_-]+/g, " ").trim();
  if (!normalized) return "Unknown";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-0.5 text-base font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function UsageRow({ line }: { line: UsageLine }) {
  const { label, used, limit, unit, hint, atLimit } = line;
  // Themes are what a plan includes, not something that runs out.
  const isCapacity = line.key !== "themes";
  const percent = limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const over = isCapacity && isOverLimit(line);
  const full = isCapacity && isAtLimit(line) && (limit ?? 0) > 0;
  const value = limit === null ? `${formatUsageValue(used, unit)}, no limit` : limit === 0 && used === 0 ? "Not on this plan" : `${formatUsageValue(used, unit)} of ${formatUsageValue(limit, unit)}`;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-medium text-slate-800">{label}</span>
        <span className={`font-semibold tabular-nums ${over || full ? "text-amber-800" : "text-slate-900"}`}>{value}</span>
      </div>
      <div aria-hidden="true" className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${over || full ? "bg-amber-500" : "bg-slate-900"}`} style={{ width: `${percent}%` }} />
      </div>
      {over || full ? <p className="mt-1 text-xs text-amber-800">{over ? "Over this plan's limit. " : "Limit reached. "}{atLimit}</p> : hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

const monthlyPrice = (plan: PlanOption) => (plan.interval === "year" ? plan.price / 12 : plan.price);

/** Whether moving to `plan` is a step up or down. Different currencies cannot be compared. */
function planChangeVerb(plan: PlanOption, current: PlanOption | null): string {
  if (!current) return "Choose";
  if (plan.currency !== current.currency) return "Switch to";
  const difference = monthlyPrice(plan) - monthlyPrice(current);
  return difference > 0 ? "Upgrade to" : difference < 0 ? "Downgrade to" : "Switch to";
}

const planLimitValues = (plan: PlanOption): PlanLimitValues => ({ ...plan.features });

function FeatureRow({ included, children }: { included: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span
        className={`mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full ${
          included ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-400"
        }`}
      >
        {included ? (
          <Icon name="check" size={11} />
        ) : (
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3" aria-hidden="true">
            <path d="M5 9a1 1 0 1 0 0 2h10a1 1 0 1 0 0-2H5Z" />
          </svg>
        )}
      </span>
      <span className={included ? "text-slate-800" : "text-slate-500"}>{children}</span>
    </li>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 motion-safe:animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
  );
}

/** Invoices live at Razorpay and are read when asked for. */
function InvoiceList({ businessId }: { businessId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const [invoices, setInvoices] = useState<Array<{ id: string; number: string | null; status: string; amount: number; currency: string; billingEnd: string | null; url: string | null }> | null>(null);
  async function load() {
    setState("loading");
    try {
      const res = await fetch(`/api/businesses/${businessId}/subscription/invoices`);
      const data = (await res.json().catch(() => null)) as { invoices?: NonNullable<typeof invoices>; unavailable?: boolean } | null;
      if (!res.ok || !data?.invoices || data.unavailable) {
        setState("failed");
        return;
      }
      setInvoices(data.invoices);
      setState("idle");
    } catch {
      setState("failed");
    }
  }
  if (!invoices) {
    return (
      <div className="mt-2">
        <Button variant="ghost" disabled={state === "loading"} onClick={() => void load()}>
          {state === "loading" ? "Loading…" : "Show invoices"}
        </Button>
        {state === "failed" && <p role="alert" className="mt-1 text-sm text-red-700">Invoices are not available right now, because Razorpay could not be reached. Your payment history below is not affected. Please try again shortly.</p>}
      </div>
    );
  }
  return invoices.length === 0 ? (
    <p className="mt-2 text-sm text-slate-600">No invoices yet.</p>
  ) : (
    <>
    <p className="mt-3 text-xs leading-5 text-slate-500">
      These are Razorpay&apos;s billing records for your subscription. They are not GST tax invoices, and SiteForge does not add GST details or tax calculations to them.
    </p>
    <ul className="mt-2 space-y-1 text-sm">
      {invoices.map((invoice) => (
        <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
          <span>
            {invoice.number ? `${invoice.number} · ` : ""}{invoice.currency} {invoice.amount.toFixed(2)} · {invoice.status}
            {invoice.billingEnd ? ` · to ${new Date(invoice.billingEnd).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" })}` : ""}
          </span>
          {invoice.url && (
            <a href={invoice.url} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">
              View<span className="sr-only"> invoice (opens in a new tab)</span>
            </a>
          )}
        </li>
      ))}
    </ul>
    </>
  );
}

export default function BillingPanel({
  businessId,
  entitlements,
  usage,
  totalThemes,
  plans,
  payments,
  adjustments = [],
  subscription,
  canManage,
  provider,
  manualPaidPlansAllowed = true,
  onlineBilling = null,
}: {
  businessId: string;
  entitlements: {
    planKey: string | null;
    planName: string;
    status: string;
    active: boolean;
    expired: boolean;
    productLimit: number;
    staffLimit: number;
    customDomain: boolean;
    removeBranding: boolean;
    aiRequestsPerMonth: number;
    /** Names of the themes the business may switch to now. */
    themes: string[];
  };
  /** Measured the same way the server enforces limits (lib/usage-limits.ts). */
  usage: UsageLine[];
  totalThemes: number;
  plans: PlanOption[];
  payments: PaymentRow[];
  adjustments?: AdjustmentRow[];
  subscription: SubscriptionSummary | null;
  canManage: boolean;
  provider: string;
  /** Razorpay subscription billing, when it is configured. */
  onlineBilling?: {
    mode: "test" | "live";
    onProvider: boolean;
    checkoutPending: boolean;
    graceUntil: string | null;
    providerStatus: string | null;
    pendingPlanName: string | null;
    /** When Razorpay says a scheduled plan change takes effect. */
    scheduledChangeAt: string | null;
    /** The last time this store was compared with Razorpay. */
    lastReconciledAt: string | null;
    /** False until the database is prepared for billing; paid plans stay off until then. */
    ready: boolean;
  } | null;
  /** Mirrors `isManualBillingAllowed()`: whether the server will activate paid plans manually. */
  manualPaidPlansAllowed?: boolean;
}) {
  const router = useRouter();
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const submitting = submittingKey !== null;
  const currentPlan = plans.find((plan) => plan.key === entitlements.planKey) ?? null;

  // Mirror the server's checkout rules so buttons never promise something the
  // API will refuse (501 for a non-manual provider, 402 for paid plans when
  // manual billing is disabled in production).
  const planSelectable = (price: number) =>
    onlineBilling ? onlineBilling.ready && !subscription?.cancelAtPeriodEnd : provider === "manual" && (price === 0 || manualPaidPlansAllowed);

  // An expired paid subscription keeps its stored "active"/"trialing" status but
  // no longer grants access, so surface it distinctly instead of as Active.
  const displayStatus = entitlements.expired ? "expired" : entitlements.status;

  // Paid through Razorpay, its statuses say more. A period that ran out with no word from
  // Razorpay still shows as expired above, never as active.
  const described =
    onlineBilling?.onProvider && subscription
      ? describeBillingState({
          status: subscription.status,
          providerStatus: onlineBilling.providerStatus,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          graceUntil: onlineBilling.graceUntil,
          currentPeriodEnd: subscription.currentPeriodEnd,
        })
      : null;
  const billingState = described && !(entitlements.expired && (described.key === "active" || described.key === "ending")) ? described : null;
  const showsRecovery = billingState !== null && !["active", "ending", "none"].includes(billingState.key);
  const needsPayment = billingState?.key === "past_due" || billingState?.key === "halted";
  const changeDate = onlineBilling?.scheduledChangeAt ?? subscription?.currentPeriodEnd ?? null;

  const intervalLabel = currentPlan
    ? currentPlan.interval === "year"
      ? "Yearly"
      : "Monthly"
    : "Unavailable";

  let renewalText: string | null = null;
  // Free plans never expire, so their stored period end is not meaningful.
  if (subscription?.currentPeriodEnd && currentPlan?.price !== 0) {
    const end = new Date(subscription.currentPeriodEnd).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });
    renewalText = entitlements.expired
      ? `Subscription expired on ${end}.`
      : subscription.cancelAtPeriodEnd
        ? `Scheduled to cancel on ${end}.`
        : `Current billing period ends ${end}.`;
  }

  async function choose(planKey: string) {
    if (inFlightRef.current) return;
    const next = plans.find((plan) => plan.key === planKey);
    // Anything already over the new plan's limits is said before the move, not after.
    const impact = next ? planChangeImpact(usage, planLimitValues(next)) : [];
    const impactText = impact.length > 0
      ? ` You are over ${next?.name}'s limits for ${impact.map((item) => `${item.label.toLowerCase()} (${item.used}, allowed ${item.allowed})`).join(", ")}. Nothing is deleted and everything stays editable, but you can't add more of these until you are within the limit.${next?.features.customDomain ? "" : " A custom domain stops serving your store until you upgrade again."}`
      : "";
    // Moving between plans on Razorpay happens with the next billing cycle. Saying so
    // first matters, because nothing about it is immediate and nothing is pro-rated.
    if (onlineBilling?.onProvider && subscription && !entitlements.expired) {
      const end = changeDate ? shortDate(changeDate) : "the end of this billing period";
      const confirmed = await confirmDialog(
        next?.price === 0
          ? { title: `Move to ${next.name} on ${end}?`, message: `Your paid plan stays active until ${end}, and this ends your Razorpay subscription then. Nothing more is charged. A cancellation cannot be undone, but you can choose a paid plan again after it has ended.${impactText}`, confirmLabel: "Schedule the move", tone: "danger" }
          : { title: `Change to ${next?.name ?? "this plan"} on ${end}?`, message: `You stay on ${entitlements.planName} until ${end}. The new plan and its price start with the next billing cycle. No part-period refund or extra charge is worked out. Razorpay can refuse a change for some payment methods, such as bank mandates; if it does, nothing changes and you can cancel at the period end and choose the new plan afterwards.${impactText}`, confirmLabel: "Schedule the change" },
      );
      if (!confirmed) return;
    } else if (impact.length > 0) {
      const confirmed = await confirmDialog({ title: `Move to ${next?.name ?? "this plan"}?`, message: impactText.trim(), confirmLabel: "Move to this plan" });
      if (!confirmed) return;
    }
    inFlightRef.current = true;
    setSubmittingKey(planKey);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/subscription`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planKey }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        entitlements?: { planName?: string };
        warnings?: string[];
        checkoutUrl?: string;
        scheduledPlan?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Unable to update plan");
      // Razorpay's own page takes the payment. The plan changes when Razorpay reports it.
      if (data.checkoutUrl) {
        window.location.assign(data.checkoutUrl);
        return;
      }
      if (data.scheduledPlan) {
        setNotice(changeDate ? `Your plan will change on ${shortDate(changeDate)}, when the current billing period ends.` : "Your plan will change when the current billing period ends.");
        router.refresh();
        return;
      }
      const name = data.entitlements?.planName ?? "the selected plan";
      setNotice([`Subscription updated to ${name}.`, ...(data.warnings ?? [])].join(" "));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update plan");
    } finally {
      inFlightRef.current = false;
      setSubmittingKey(null);
    }
  }

  /** Asks Razorpay for the latest state, in case a notification has not arrived. */
  async function billingAction(action: "refresh" | "abandon_checkout" | "payment_link" | "cancel_plan_change") {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSubmittingKey(action);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/subscription`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; url?: string | null };
      if (!res.ok) throw new Error(data.error ?? "Razorpay could not be reached. Please try again shortly.");
      if (action === "payment_link") {
        if (data.url) {
          window.location.assign(data.url);
          return;
        }
        setNotice("There is no invoice to pay online right now. Razorpay also emails you a link to update your payment method.");
        return;
      }
      setNotice(action === "refresh" ? "Your subscription now matches what Razorpay reports." : action === "cancel_plan_change" ? "The plan change was withdrawn. You stay on your current plan." : "That payment was cancelled. Your current plan has not changed.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Razorpay could not be reached. Please try again shortly.");
    } finally {
      inFlightRef.current = false;
      setSubmittingKey(null);
    }
  }

  /** Ends the plan with its paid period, or undoes that. Nothing is charged or refunded. */
  async function changeCancellation(action: "cancel" | "resume") {
    if (inFlightRef.current) return;
    if (action === "cancel" && !(await confirmDialog({ title: "Cancel at the end of this period?", message: `Your plan stays active until the current period ends. After that your store goes offline until you choose a plan again. Your products, pages and orders are kept.${onlineBilling?.onProvider ? " A cancellation cannot be undone." : ""}`, confirmLabel: "Cancel at period end", tone: "danger" }))) return;
    inFlightRef.current = true;
    setSubmittingKey(action);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/subscription`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Unable to update your subscription");
      setNotice(action === "cancel" ? "Your plan will end when the current period ends." : "Your plan will continue.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update your subscription");
    } finally {
      inFlightRef.current = false;
      setSubmittingKey(null);
    }
  }

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Subscription"
        description="Review this business’s current plan, included limits, and recorded payment history. Only the business owner can change the plan."
      />
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Current subscription</h2>
            <p className="mt-1 text-sm text-slate-600">
              The plan and billing status for this business.
            </p>
          </div>
          <Pill tone={billingState?.tone ?? SUBSCRIPTION_TONES[displayStatus] ?? "neutral"} dot>
            {billingState?.label ?? titleCaseStatus(displayStatus)}
          </Pill>
        </div>

        {entitlements.planKey ? (
          <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label="Current plan" value={entitlements.planName} />
            <Stat
              label="Price"
              value={
                currentPlan
                  ? currentPlan.price === 0
                    ? "Free"
                    : `${formatPrice(currentPlan.price, currentPlan.currency)}/${currentPlan.interval}`
                  : "Unavailable"
              }
            />
            <Stat label="Billing interval" value={intervalLabel} />
          </div>
        ) : (
          <Notice tone="warning" className="mt-4">
            No subscription yet. Choose a plan below to activate this business.
          </Notice>
        )}

        {renewalText && <p className="mt-3 text-sm text-slate-600">{renewalText}</p>}
        {!entitlements.active && (
          <div className="mt-4 grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-2">
            <div>
              <h3 className="font-semibold text-slate-900">Paused without an active plan</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700">
                {INACTIVE_PLAN_EFFECTS.stops.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
            <div>
              <h3 className="font-semibold text-slate-900">Not affected</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700">
                {INACTIVE_PLAN_EFFECTS.keeps.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          </div>
        )}
        {billingState && showsRecovery && (
          <Notice tone={billingState.tone === "danger" ? "danger" : billingState.tone === "warning" ? "warning" : "info"} className="mt-4" title={billingState.label}>
            {billingState.summary}
            {billingState.recovery.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {billingState.recovery.map((step) => <li key={step}>{step}</li>)}
              </ul>
            )}
            <SupportContact label="Billing support:" className="mt-2" />
            {canManage && needsPayment && (
              <div className="mt-3">
                <Button variant="secondary" disabled={submittingKey !== null} onClick={() => void billingAction("payment_link")}>
                  {submittingKey === "payment_link" ? "Opening…" : "Open the oldest unpaid invoice at Razorpay"}
                </Button>
              </div>
            )}
          </Notice>
        )}
        {onlineBilling?.pendingPlanName && !subscription?.cancelAtPeriodEnd && (
          <p className="mt-3 text-sm text-slate-600">
            Moves to {onlineBilling.pendingPlanName} {changeDate ? `on ${shortDate(changeDate)}` : "when this billing period ends"}. Until then, nothing changes. The new price starts with that billing cycle, and no part-period refund or extra charge is worked out.
          </p>
        )}
        {onlineBilling?.pendingPlanName && subscription?.cancelAtPeriodEnd && (
          <p className="mt-3 text-sm text-slate-600">Moves to {onlineBilling.pendingPlanName} when this billing period ends.</p>
        )}
        {onlineBilling && !onlineBilling.ready && (
          <Notice tone="warning" className="mt-4">
            Paid plans can&apos;t be bought yet, because online billing has not been switched on. Your current plan is not affected.
          </Notice>
        )}
        {canManage && onlineBilling?.checkoutPending && (
          <Notice tone="info" className="mt-4" title="A payment is in progress">
            Your plan changes once Razorpay confirms the payment. That usually takes a moment.
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" disabled={submittingKey !== null} onClick={() => void billingAction("refresh")}>
                {submittingKey === "refresh" ? "Checking…" : "Check now"}
              </Button>
              <Button variant="ghost" disabled={submittingKey !== null} onClick={() => void billingAction("abandon_checkout")}>
                Cancel this payment
              </Button>
            </div>
          </Notice>
        )}
        {canManage && onlineBilling?.onProvider && subscription && (
          <div className="mt-3 flex flex-wrap gap-2">
            {!subscription.cancelAtPeriodEnd && !onlineBilling.pendingPlanName && (
              <Button variant="secondary" disabled={submittingKey !== null} onClick={() => void changeCancellation("cancel")}>
                {submittingKey === "cancel" ? "Saving…" : "Cancel at period end"}
              </Button>
            )}
            {!subscription.cancelAtPeriodEnd && onlineBilling.pendingPlanName && (
              <Button variant="secondary" disabled={submittingKey !== null} onClick={() => void billingAction("cancel_plan_change")}>
                {submittingKey === "cancel_plan_change" ? "Saving…" : "Keep my current plan"}
              </Button>
            )}
            <Button variant="ghost" disabled={submittingKey !== null} onClick={() => void billingAction("refresh")}>
              {submittingKey === "refresh" ? "Checking…" : "Refresh status"}
            </Button>
          </div>
        )}
        {onlineBilling?.onProvider && onlineBilling.lastReconciledAt && (
          <p className="mt-2 text-xs text-slate-500">Last compared with Razorpay on {shortDate(onlineBilling.lastReconciledAt)}.</p>
        )}
        {onlineBilling?.onProvider && subscription?.cancelAtPeriodEnd && (
          <p className="mt-3 text-sm text-slate-600">A cancellation cannot be undone. You can choose a plan again once this one has ended.</p>
        )}
        {canManage && provider === "manual" && subscription && currentPlan && currentPlan.price > 0 && entitlements.active && (
          <div className="mt-3">
            <Button variant="secondary" disabled={submittingKey !== null} onClick={() => void changeCancellation(subscription.cancelAtPeriodEnd ? "resume" : "cancel")}>
              {submittingKey === "cancel" || submittingKey === "resume" ? "Saving…" : subscription.cancelAtPeriodEnd ? "Keep my plan" : "Cancel at period end"}
            </Button>
          </div>
        )}
        {entitlements.planKey && !renewalText && (
          <p className="mt-3 text-sm text-slate-500">
            {currentPlan?.price === 0
              ? "The free plan does not expire."
              : "Billing period dates are not available for this subscription."}
          </p>
        )}

        <div className="mt-5 border-t border-slate-200 pt-5">
          <h3 className="text-sm font-semibold text-slate-900">Usage on this plan</h3>
          <p className="mt-0.5 text-xs text-slate-500">Going over a limit, for example after moving to a smaller plan, never deletes anything. It only stops new things being added.</p>
          <div className="mt-3 grid gap-x-8 gap-y-4 md:grid-cols-2 xl:grid-cols-4">
            {usage.map((line) => <UsageRow key={line.key} line={line} />)}
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4 border-t border-slate-200 pt-5 sm:grid-cols-4">
          <Stat label="Custom domain" value={entitlements.customDomain ? "Included" : "Not included"} />
          <Stat label="Remove branding" value={entitlements.removeBranding ? "Included" : "Not included"} />
          <Stat label="AI suggestions a month" value={entitlements.aiRequestsPerMonth} />
          <Stat label="Themes" value={`${entitlements.themes.length} of ${totalThemes}`} />
        </div>

        {provider === "manual" && manualPaidPlansAllowed && (
          <Notice tone="info" className="mt-5">
            Payments are in sandbox/manual mode. Selecting a plan activates it immediately on the
            server and no real payment is taken. Live billing will use webhook-verified events.
          </Notice>
        )}
        {provider === "manual" && !manualPaidPlansAllowed && (
          <Notice tone="warning" className="mt-5">
            Online payments are not set up yet, so paid plans can&apos;t be purchased right now.
            Free plans remain available.
          </Notice>
        )}
        {onlineBilling?.mode === "test" && (
          <Notice tone="info" className="mt-5">
            Razorpay test mode: no real money is taken.
          </Notice>
        )}
        {provider !== "manual" && !onlineBilling && (
          <Notice tone="warning" className="mt-5">
            Online checkout is not available yet, so plans can&apos;t be changed from this page.
          </Notice>
        )}
        {!canManage && (
          <Notice tone="info" className="mt-5">
            Only the business owner can change the subscription plan.
          </Notice>
        )}
      </Card>

      <section aria-labelledby="billing-plans">
        <h2 id="billing-plans" className="text-lg font-semibold text-slate-900">Plans</h2>
        <p className="mt-1 text-sm text-slate-600">Compare plans and what each includes. Moving to a smaller plan never deletes your products, pages or orders.</p>

        {(error || notice) && (
          <div className="mt-4 space-y-2">
            {error && (
              <Notice tone="danger" role="alert">
                {error}
              </Notice>
            )}
            {notice && (
              <Notice tone="success" role="status">
                {notice}
              </Notice>
            )}
          </div>
        )}

        {plans.length === 0 ? (
          <EmptyState icon={<Icon name="billing" size={20} />} title="No plans are available right now." className="mt-4">
            Please check back later.
            <SupportContact className="mt-1" />
          </EmptyState>
        ) : (
          <>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {plans.map((plan) => {
                const isCurrent = entitlements.planKey === plan.key;
                const isSubmitting = submittingKey === plan.key;
                const buttonLabel = isCurrent
                  ? "Current plan"
                  : isSubmitting
                    ? "Processing…"
                    : `${planChangeVerb(plan, currentPlan)} ${plan.name}`;
                return (
                  <div
                    key={plan.key}
                    className={`flex min-w-0 flex-col rounded-2xl border bg-white p-5 shadow-sm sm:p-6 ${
                      isCurrent ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-lg font-semibold text-slate-900">{plan.name}</h3>
                      {isCurrent && <Pill tone="ember">Current plan</Pill>}
                    </div>
                    {plan.description && (
                      <p className="mt-1 text-sm text-slate-600">{plan.description}</p>
                    )}
                    <p className="mt-4 font-heading text-3xl font-semibold tracking-tight text-slate-900">
                      {plan.price === 0 ? "Free" : formatPrice(plan.price, plan.currency)}
                      {plan.price > 0 && (
                        <span className="font-ui text-sm font-normal tracking-normal text-slate-500">/{plan.interval}</span>
                      )}
                    </p>
                    <ul className="mt-4 flex-1 space-y-2 text-sm">
                      <FeatureRow included>{plan.features.productLimit} products</FeatureRow>
                      <FeatureRow included>{plan.features.pageLimit === null ? "Unlimited pages" : `${plan.features.pageLimit} pages, plus your homepage`}</FeatureRow>
                      <FeatureRow included>{plan.features.storageMb === null ? "No media storage limit" : `${plan.features.storageMb} MB media storage`}</FeatureRow>
                      <FeatureRow included>{plan.features.monthlyOrderLimit === null ? "No monthly order limit" : `${plan.features.monthlyOrderLimit} orders a month`}</FeatureRow>
                      <FeatureRow included={plan.features.aiRequestsPerMonth > 0}>{plan.features.aiRequestsPerMonth} AI suggestions a month</FeatureRow>
                      <FeatureRow included={plan.features.staffLimit > 0}>
                        {plan.features.staffLimit} staff member
                        {plan.features.staffLimit === 1 ? "" : "s"}
                      </FeatureRow>
                      <FeatureRow included>
                        {plan.themes.length} of {totalThemes} storefront themes
                        {plan.themes.length > 0 && (
                          <span className="mt-0.5 block text-xs text-slate-500">{plan.themes.join(", ")}</span>
                        )}
                      </FeatureRow>
                      <FeatureRow included={plan.features.customDomain}>
                        {plan.features.customDomain ? "Custom domain" : "Subdomain only"}
                      </FeatureRow>
                      <FeatureRow included={plan.features.removeBranding}>
                        {plan.features.removeBranding ? "Remove SiteForge branding" : "SiteForge branding"}
                      </FeatureRow>
                    </ul>
                    <Button
                      variant={isCurrent ? "secondary" : "primary"}
                      block
                      onClick={() => choose(plan.key)}
                      disabled={!canManage || submitting || isCurrent || !planSelectable(plan.price)}
                      aria-busy={isSubmitting}
                      className="mt-5"
                    >
                      {isSubmitting && <Spinner />}
                      {buttonLabel}
                    </Button>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-500">
              Custom domain means SiteForge verifies that you own the domain. Pointing the domain at SiteForge and setting up
              HTTPS are not automated yet.
            </p>
          </>
        )}
      </section>

      <Card>
        <div className="border-b border-slate-200 px-5 py-4 sm:px-6">
          <h2 className="text-lg font-semibold text-slate-900">Payment history</h2>
          {canManage && onlineBilling?.onProvider && <InvoiceList businessId={businessId} />}
          <p className="mt-1 text-sm text-slate-600">What this business has paid for its SiteForge plan. Payments and refunds from your shoppers are under Orders.</p>
        </div>
        {payments.length === 0 ? (
          <p className="px-5 py-8 text-sm text-slate-500 sm:px-6">
            No payments have been recorded for this business yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-slate-50 text-xs font-medium text-slate-500">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium sm:px-6">Date</th>
                  <th scope="col" className="px-5 py-2.5 font-medium sm:px-6">Description</th>
                  <th scope="col" className="px-5 py-2.5 font-medium sm:px-6">Amount</th>
                  <th scope="col" className="px-5 py-2.5 font-medium sm:px-6">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {payments.map((payment) => (
                  <tr key={payment._id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-5 py-3 text-slate-500 sm:px-6">
                      {new Date(payment.paidAt ?? payment.createdAt).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" })}
                    </td>
                    <td className="px-5 py-3 text-slate-700 sm:px-6">
                      {payment.description || "Subscription"}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 font-medium tabular-nums text-slate-900 sm:px-6">
                      {formatPrice(payment.amount, payment.currency)}
                      {payment.refundedAmount > 0 && (
                        <span className="mt-0.5 block text-xs font-normal text-slate-500">{formatPrice(payment.refundedAmount, payment.currency)} refunded</span>
                      )}
                    </td>
                    <td className="px-5 py-3 sm:px-6">
                      <Pill tone={PAYMENT_TONES[payment.status] ?? "neutral"} dot>
                        {titleCaseStatus(payment.status)}
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {adjustments.length > 0 && (
          <div className="border-t border-slate-200 px-5 py-4 sm:px-6">
            <h3 className="text-sm font-semibold text-slate-900">Refunds and disputes on these payments</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">As Razorpay reports them. They do not change your plan by themselves.</p>
            <ul className="mt-2 space-y-1 text-sm text-slate-700">
              {adjustments.map((item) => (
                <li key={item.id}>
                  {item.kind === "refund" ? "Refund" : "Dispute"} of {formatPrice(item.amount, item.currency)} · {titleCaseStatus(item.status)} · {shortDate(item.createdAt)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}
