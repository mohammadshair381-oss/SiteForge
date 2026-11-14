"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { formatPrice } from "@/lib/format";
import { THEMES } from "@/lib/themes";
import { planThemes } from "@/lib/theme-tiers";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { apiErrorFrom, fieldErrorId, invalidProps, summaryMessage } from "@/lib/api-errors";
import { Icon } from "@/components/ui/Icon";
import { EmptyState, Notice, Pill, Skeleton } from "@/components/ui/Surface";
import AdminDialog from "./AdminDialog";
import BusinessStatusAction from "./BusinessStatusAction";
import { Badge, Card, EmptyRow, TableCard, Td, Th, Tr, dangerSmallButtonClass, monoClass, smallButtonClass } from "./ControlCenterUI";

/** Keep in sync with ADMIN_REASON_MIN in lib/admin-audit.ts (server enforces it). */
const REASON_MIN = 5;

interface AdminBusiness {
  _id: string;
  name: string;
  subdomain: string;
  category: string;
  status: string;
  owner: { name: string; email: string } | null;
}

interface AdminPlan {
  key: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  interval: string;
  active: boolean;
  sort: number;
  features: {
    productLimit: number;
    staffLimit: number;
    customDomain: boolean;
    removeBranding: boolean;
    /** Unset = the platform default. */
    aiRequestsPerMonth?: number;
    /** Unset = the default tier for the plan key (lib/theme-tiers.ts). */
    themes?: string[];
    /** Unset or null = no limit. */
    pageLimit?: number | null;
    storageMb?: number | null;
    monthlyOrderLimit?: number | null;
  };
}

type AdminSection = "businesses" | "plans" | "audit";

/** A plan save that failed, with what the server or this form said about each field. */
class PlanFormError extends Error {
  constructor(message: string, readonly fields: Record<string, string>) {
    super(message);
  }
}

const PLAN_FIELDS = ["key", "name", "description", "price", "currency", "interval", "sort", "features.productLimit", "features.staffLimit", "features.aiRequestsPerMonth", "features.themes", "features.pageLimit", "features.storageMb", "features.monthlyOrderLimit"];

/**
 * Businesses quick list, plan management and audit log. Each section can be
 * shown on its own (the control-center pages render one section each).
 */
export default function AdminPanel({
  initialBusinesses,
  initialPlans,
  sections = ["businesses", "plans", "audit"],
}: {
  initialBusinesses: AdminBusiness[];
  initialPlans: AdminPlan[];
  sections?: AdminSection[];
}) {
  const [businesses, setBusinesses] = useState(initialBusinesses);
  const [notice, setNotice] = useState<string | null>(null);
  const [auditVersion, setAuditVersion] = useState(0);

  return (
    <div className="space-y-8">
      {sections.includes("businesses") && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-900">Businesses</h2>
          {notice && (
            <Notice tone="success" role="status">
              {notice}
            </Notice>
          )}
          <TableCard
            label="Businesses"
            minWidth="min-w-[640px]"
            head={
              <>
                <Th>Business</Th>
                <Th>Owner</Th>
                <Th>Category</Th>
                <Th>Status</Th>
                <Th>Action</Th>
              </>
            }
          >
            {businesses.length === 0 && <EmptyRow colSpan={5} title="No businesses have been created yet." />}
            {businesses.map((business) => (
              <Tr key={business._id}>
                <Td>
                  <p className="font-medium text-slate-900">{business.name}</p>
                  <p className="text-xs text-slate-500">{business.subdomain}</p>
                </Td>
                <Td className="text-slate-600">{business.owner?.email ?? "—"}</Td>
                <Td className="capitalize text-slate-600">{business.category}</Td>
                <Td>
                  <Badge value={business.status} />
                </Td>
                <Td>
                  <BusinessStatusAction
                    business={{ id: business._id, name: business.name, status: business.status }}
                    onChanged={(status, message) => {
                      setBusinesses((current) => current.map((b) => (b._id === business._id ? { ...b, status } : b)));
                      setNotice(message);
                      setAuditVersion((v) => v + 1);
                    }}
                  />
                </Td>
              </Tr>
            ))}
          </TableCard>
        </section>
      )}

      {sections.includes("plans") && <PlanManager initialPlans={initialPlans} onChanged={() => setAuditVersion((v) => v + 1)} />}
      {sections.includes("audit") && <AuditLog refreshKey={auditVersion} />}
    </div>
  );
}

const EMPTY_FORM = {
  key: "",
  name: "",
  description: "",
  price: "0",
  currency: "USD",
  interval: "month",
  sort: "0",
  productLimit: "10",
  staffLimit: "1",
  customDomain: false,
  removeBranding: false,
  aiRequestsPerMonth: "",
  pageLimit: "",
  storageMb: "",
  monthlyOrderLimit: "",
  /** null = not chosen: the plan uses the default tier for its key. */
  themes: null as string[] | null,
};

function PlanManager({
  initialPlans,
  onChanged,
}: {
  initialPlans: AdminPlan[];
  onChanged: () => void;
}) {
  const router = useRouter();
  const [plans, setPlans] = useState(initialPlans);
  const intervalId = useId();
  const reasonId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const formTitleRef = useRef<HTMLHeadingElement>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deactivating, setDeactivating] = useState<AdminPlan | null>(null);
  const [reason, setReason] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [reasonError, setReasonError] = useState<string | null>(null);

  /** Razorpay plans have a fixed price, so a changed price needs this again. */
  async function setUpAtRazorpay(plan: AdminPlan) {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/plans/razorpay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: plan.key, reason: "Set up plan for online billing" }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; created?: boolean; mapping?: { mode: string } } | null;
      if (!res.ok) {
        setError(data?.error ?? "This plan could not be set up at Razorpay.");
        return;
      }
      setMessage(`${plan.name} ${data?.created ? "was set up" : "is already set up"} at Razorpay (${data?.mapping?.mode ?? "test"} mode).`);
    } catch {
      setError("Network error. Nothing was changed.");
    } finally {
      setLoading(false);
    }
  }

  function startEdit(plan: AdminPlan) {
    setEditingKey(plan.key);
    setMessage(null);
    setError(null);
    setFieldErrors({});
    setForm({
      key: plan.key,
      name: plan.name,
      description: plan.description ?? "",
      price: String(plan.price),
      currency: plan.currency || "USD",
      interval: plan.interval,
      sort: String(plan.sort ?? 0),
      productLimit: String(plan.features.productLimit),
      staffLimit: String(plan.features.staffLimit),
      customDomain: plan.features.customDomain,
      removeBranding: plan.features.removeBranding,
      aiRequestsPerMonth: typeof plan.features.aiRequestsPerMonth === "number" ? String(plan.features.aiRequestsPerMonth) : "",
      pageLimit: typeof plan.features.pageLimit === "number" ? String(plan.features.pageLimit) : "",
      storageMb: typeof plan.features.storageMb === "number" ? String(plan.features.storageMb) : "",
      monthlyOrderLimit: typeof plan.features.monthlyOrderLimit === "number" ? String(plan.features.monthlyOrderLimit) : "",
      themes: Array.isArray(plan.features.themes) && plan.features.themes.length > 0 ? [...plan.features.themes] : null,
    });
    // The form sits below the plans: bring it into view and move focus to it.
    formRef.current?.scrollIntoView({ block: "start" });
    formTitleRef.current?.focus({ preventScroll: true });
  }

  function resetForm() {
    setEditingKey(null);
    setForm(EMPTY_FORM);
    setFieldErrors({});
  }

  function upsertLocal(plan: AdminPlan) {
    setPlans((current) => {
      const others = current.filter((p) => p.key !== plan.key);
      return [...others, plan].sort((a, b) => a.sort - b.sort || a.price - b.price);
    });
  }

  async function post(body: Record<string, unknown>): Promise<AdminPlan> {
    const res = await fetch("/api/admin/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const info = apiErrorFrom(data, "Unable to save plan");
      throw new PlanFormError(info.message, info.fields);
    }
    return data.plan as AdminPlan;
  }

  /** Parses a required number field; a blank field is an error, never 0. */
  function priceField(value: string): number {
    const trimmed = value.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
      const text = "Price must be a number with at most two decimal places, for example 9.99.";
      throw new PlanFormError(text, { price: text });
    }
    return Number(trimmed);
  }

  function numberField(value: string, label: string, field: string, options: { integer?: boolean; min?: number } = {}): number {
    const trimmed = value.trim();
    const parsed = Number(trimmed);
    if (
      trimmed === "" ||
      !Number.isFinite(parsed) ||
      (options.integer && !Number.isInteger(parsed)) ||
      (options.min !== undefined && parsed < options.min)
    ) {
      const text = `${label} must be ${options.integer ? "a whole number" : "a number"}${options.min !== undefined ? ` of ${options.min} or more` : ""}.`;
      throw new PlanFormError(text, { [field]: text });
    }
    return parsed;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    setFieldErrors({});
    try {
      // Every editable field is sent explicitly. Activation is NOT part of this
      // form: it has its own control so an edit never re-activates a plan.
      // `mode` makes intent explicit: "Create plan" never overwrites an
      // existing key (the server answers 409 instead).
      const plan = await post({
        mode: editingKey ? "update" : "create",
        key: form.key,
        name: form.name,
        description: form.description,
        price: priceField(form.price),
        currency: form.currency,
        interval: form.interval,
        sort: numberField(form.sort, "Sort order", "sort", { integer: true }),
        features: {
          productLimit: numberField(form.productLimit, "Product limit", "features.productLimit", { integer: true, min: 0 }),
          staffLimit: numberField(form.staffLimit, "Staff limit", "features.staffLimit", { integer: true, min: 0 }),
          customDomain: form.customDomain,
          removeBranding: form.removeBranding,
          // Blank keeps the stored value (or the platform default for a new plan).
          ...(form.aiRequestsPerMonth.trim() !== ""
            ? { aiRequestsPerMonth: numberField(form.aiRequestsPerMonth, "AI suggestions per month", "features.aiRequestsPerMonth", { integer: true, min: 0 }) }
            : {}),
          // Blank means no limit, and clears a stored one.
          pageLimit: form.pageLimit.trim() === "" ? null : numberField(form.pageLimit, "Pages", "features.pageLimit", { integer: true, min: 0 }),
          storageMb: form.storageMb.trim() === "" ? null : numberField(form.storageMb, "Media storage", "features.storageMb", { integer: true, min: 0 }),
          monthlyOrderLimit: form.monthlyOrderLimit.trim() === "" ? null : numberField(form.monthlyOrderLimit, "Orders per month", "features.monthlyOrderLimit", { integer: true, min: 0 }),
          // Only once chosen: otherwise the plan keeps the default tier for its key.
          ...(form.themes !== null ? { themes: form.themes } : {}),
        },
      });
      setMessage(`Plan "${plan.name}" saved.`);
      upsertLocal(plan);
      resetForm();
      onChanged();
      router.refresh();
    } catch (err) {
      if (err instanceof PlanFormError) {
        setFieldErrors(err.fields);
        setError(summaryMessage({ message: err.message, code: null, fields: err.fields }, PLAN_FIELDS));
      } else {
        setError(err instanceof Error ? err.message : "Unable to save plan");
      }
    } finally {
      setLoading(false);
    }
  }

  async function setActive(plan: AdminPlan, next: boolean, auditReason = ""): Promise<boolean> {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await post({ mode: "update", key: plan.key, active: next, ...(auditReason ? { reason: auditReason } : {}) });
      upsertLocal(updated);
      setMessage(`Plan "${updated.name}" ${next ? "activated" : "deactivated"}.`);
      onChanged();
      router.refresh();
      return true;
    } catch (err) {
      if (err instanceof PlanFormError && err.fields.reason) setReasonError(err.fields.reason);
      else setError(err instanceof Error ? err.message : "Unable to update plan");
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function toggleActive(plan: AdminPlan) {
    if (plan.active) {
      setError(null);
      setReason("");
      setReasonError(null);
      setDeactivating(plan);
      return;
    }
    const ok = await confirmDialog({
      title: `Activate "${plan.name}"?`,
      message: "It becomes available for new subscriptions.",
      confirmLabel: "Activate plan",
    });
    if (ok) await setActive(plan, true);
  }

  async function confirmDeactivate() {
    if (!deactivating || loading) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN) {
      setReasonError(`Give a reason of at least ${REASON_MIN} characters to deactivate a plan.`);
      return;
    }
    setReasonError(null);
    if (await setActive(deactivating, false, trimmed)) setDeactivating(null);
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold text-slate-900">Subscription plans</h2>
      {error && !deactivating && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {message && (
        <Notice tone="success" role="status">
          {message}
        </Notice>
      )}

      {plans.length === 0 ? (
        <EmptyState icon={<Icon name="layers" size={20} />} title="No plans configured yet">
          Create one using the form below.
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {plans.map((plan) => {
            const explicitThemes = Array.isArray(plan.features.themes) && plan.features.themes.length > 0;
            return (
              <article
                key={plan.key}
                className={`flex min-w-0 flex-col rounded-2xl border border-slate-200 p-4 shadow-sm ${plan.active ? "bg-white" : "bg-slate-50"} ${editingKey === plan.key ? "ring-2 ring-brand-500" : ""}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 break-words text-sm font-semibold text-slate-900">{plan.name}</h3>
                  <Pill tone={plan.active ? "success" : "neutral"} dot={plan.active}>
                    {plan.active ? "Active" : "Inactive"}
                  </Pill>
                </div>
                <p className={`mt-0.5 ${monoClass}`}>{plan.key}</p>
                <p className="mt-3 font-heading text-2xl font-semibold tracking-tight text-slate-900">
                  {plan.price === 0 ? "Free" : formatPrice(plan.price, plan.currency || "USD")}
                  {plan.price > 0 && <span className="font-ui text-sm font-normal tracking-normal text-slate-500">/{plan.interval}</span>}
                </p>
                <ul className="mt-3 flex-1 space-y-1 border-t border-slate-100 pt-3 text-[13px] text-slate-600">
                  <PlanFeature>{plan.features.productLimit} products</PlanFeature>
                  <PlanFeature>{plan.features.staffLimit} staff</PlanFeature>
                  <PlanFeature off={!plan.features.customDomain}>{plan.features.customDomain ? "Custom domain" : "No custom domain"}</PlanFeature>
                  <PlanFeature off={!plan.features.removeBranding}>{plan.features.removeBranding ? "Remove branding" : "Shows SiteForge branding"}</PlanFeature>
                  <PlanFeature>{typeof plan.features.aiRequestsPerMonth === "number" ? `${plan.features.aiRequestsPerMonth} AI suggestions a month` : "Platform default AI allowance"}</PlanFeature>
                  <PlanFeature>{typeof plan.features.pageLimit === "number" ? `${plan.features.pageLimit} pages` : "Unlimited pages"}</PlanFeature>
                  <PlanFeature>{typeof plan.features.storageMb === "number" ? `${plan.features.storageMb} MB media storage` : "No media storage limit"}</PlanFeature>
                  <PlanFeature>{typeof plan.features.monthlyOrderLimit === "number" ? `${plan.features.monthlyOrderLimit} orders a month` : "No monthly order limit"}</PlanFeature>
                  <PlanFeature>
                    {planThemes(plan).length} of {THEMES.length} themes
                    {!explicitThemes && <span className="text-slate-500"> (default for “{plan.key}”)</span>}
                  </PlanFeature>
                </ul>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" onClick={() => startEdit(plan)} disabled={loading} className={smallButtonClass}>
                    Edit
                  </button>
                  {plan.price > 0 && (
                    <button type="button" onClick={() => void setUpAtRazorpay(plan)} disabled={loading} className={smallButtonClass}>
                      Set up at Razorpay
                    </button>
                  )}
                  <button type="button" onClick={() => void toggleActive(plan)} disabled={loading} className={plan.active ? dangerSmallButtonClass : smallButtonClass}>
                    {plan.active ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <form ref={formRef} onSubmit={save} className="scroll-mt-20 rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-3 sm:px-5">
          <h3 ref={formTitleRef} tabIndex={-1} className="break-words text-sm font-semibold text-slate-900 focus:outline-none">
            {editingKey ? `Edit plan "${editingKey}"` : "Create plan"}
          </h3>
        </div>

        <div className="divide-y divide-slate-100">
          <FormGroup title="Identity" hint="How the plan is named. The key cannot change once the plan exists.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Key" value={form.key} onChange={(v) => setForm({ ...form, key: v })} required readOnly={!!editingKey} error={fieldErrors.key} />
              <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required error={fieldErrors.name} />
              <div className="sm:col-span-2">
                <Field label="Description" value={form.description} onChange={(v) => setForm({ ...form, description: v })} error={fieldErrors.description} />
              </div>
            </div>
          </FormGroup>

          <FormGroup title="Price and order" hint="What the plan lists at, and where it sits in plan lists.">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="Price" type="number" min={0} step="0.01" inputMode="decimal" hint="Up to two decimal places, for example 9.99." value={form.price} onChange={(v) => setForm({ ...form, price: v })} error={fieldErrors.price} />
              <Field label="Currency (3 letters)" value={form.currency} onChange={(v) => setForm({ ...form, currency: v.toUpperCase() })} error={fieldErrors.currency} />
              <div>
                <label htmlFor={intervalId} className={labelClass}>
                  Interval
                </label>
                <select id={intervalId} value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })} className={inputClass}>
                  <option value="month">month</option>
                  <option value="year">year</option>
                </select>
                <FieldError message={fieldErrors.interval} />
              </div>
              <Field label="Sort order" type="number" value={form.sort} onChange={(v) => setForm({ ...form, sort: v })} error={fieldErrors.sort} />
            </div>
          </FormGroup>

          <FormGroup title="Limits" hint="Enforced on the server for every business on the plan.">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <Field label="Product limit" type="number" value={form.productLimit} onChange={(v) => setForm({ ...form, productLimit: v })} error={fieldErrors["features.productLimit"]} />
              <Field label="Staff limit" type="number" value={form.staffLimit} onChange={(v) => setForm({ ...form, staffLimit: v })} error={fieldErrors["features.staffLimit"]} />
              <div className="sm:col-span-2 xl:col-span-1">
                <Field
                  label="AI suggestions per month (blank = platform default)"
                  type="number"
                  value={form.aiRequestsPerMonth}
                  onChange={(v) => setForm({ ...form, aiRequestsPerMonth: v })}
                  error={fieldErrors["features.aiRequestsPerMonth"]}
                />
              </div>
              <Field label="Pages, besides the homepage (blank = no limit)" type="number" value={form.pageLimit} onChange={(v) => setForm({ ...form, pageLimit: v })} error={fieldErrors["features.pageLimit"]} />
              <Field label="Media storage in MB (blank = no limit)" type="number" value={form.storageMb} onChange={(v) => setForm({ ...form, storageMb: v })} error={fieldErrors["features.storageMb"]} />
              <Field label="Orders per month (blank = no limit)" type="number" value={form.monthlyOrderLimit} onChange={(v) => setForm({ ...form, monthlyOrderLimit: v })} error={fieldErrors["features.monthlyOrderLimit"]} />
            </div>
          </FormGroup>

          <FormGroup title="Included features">
            <div className="space-y-1">
              <CheckRow label="Include custom domain" checked={form.customDomain} onChange={(customDomain) => setForm({ ...form, customDomain })} />
              <CheckRow label="Remove SiteForge branding from storefront" checked={form.removeBranding} onChange={(removeBranding) => setForm({ ...form, removeBranding })} />
            </div>
          </FormGroup>

          <FormGroup title="Themes" hint="Which themes stores on this plan can choose.">
            <ThemesField
              selected={form.themes ?? planThemes({ key: form.key, price: Number(form.price) || 0 })}
              isDefault={form.themes === null}
              onChange={(themes) => setForm({ ...form, themes })}
              planKey={form.key}
            />
            <FieldError message={fieldErrors["features.themes"]} />
          </FormGroup>
        </div>

        <div className="space-y-3 border-t border-slate-100 px-4 py-4 sm:px-5">
          {editingKey && (
            <Notice tone="warning">Changes apply immediately to every business on this plan, including their limits and price checks for renewals.</Notice>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={loading}>
              {loading ? "Saving…" : editingKey ? "Save changes" : "Create plan"}
            </Button>
            {editingKey && (
              <Button variant="secondary" onClick={resetForm} disabled={loading}>
                Cancel edit
              </Button>
            )}
          </div>
        </div>
      </form>

      {deactivating && (
        <AdminDialog
          title={`Deactivate "${deactivating.name}"?`}
          busy={loading}
          onClose={() => {
            setDeactivating(null);
            setError(null);
          }}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setDeactivating(null);
                  setError(null);
                }}
                disabled={loading}
              >
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void confirmDeactivate()} disabled={loading || reason.trim().length < REASON_MIN}>
                {loading ? "Saving…" : "Deactivate plan"}
              </Button>
            </>
          }
        >
          <p className="mt-2 leading-6 text-slate-600">
            It disappears from the public plan list and cannot be chosen or renewed. Existing subscribers keep their current access until their period ends.
          </p>
          <label htmlFor={reasonId} className={`mt-4 ${labelClass}`}>
            Reason (recorded in the audit log, at least {REASON_MIN} characters)
          </label>
          <textarea id={reasonId} rows={3} maxLength={500} value={reason} onChange={(e) => { setReason(e.target.value); setReasonError(null); }} className={inputClass} {...invalidProps({ reason: reasonError ?? undefined }, "reason", "plan-deactivate")} />
          <FieldError id={fieldErrorId("plan-deactivate", "reason")} message={reasonError} />
          {error && (
            <Notice tone="danger" role="alert" className="mt-3">
              {error}
            </Notice>
          )}
        </AdminDialog>
      )}
    </section>
  );
}

function PlanFeature({ off = false, children }: { off?: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Icon name={off ? "x" : "check"} size={14} className="mt-[3px] text-slate-400" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** One group of the plan form: a title and hint beside its fields on wide screens. */
function FormGroup({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="grid gap-3 px-4 py-4 sm:px-5 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-6">
      <div>
        <h4 id={id} className="text-[13px] font-semibold text-slate-900">
          {title}
        </h4>
        {hint && <p className="mt-0.5 text-xs leading-5 text-slate-500">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex min-h-10 items-center gap-2.5 text-sm text-slate-800">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
      />
      {label}
    </label>
  );
}

interface AuditEntry {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  reason: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
  actor: { id: string; name: string };
}

const AUDIT_PAGE_SIZE = 20;

function summarizeChange(entry: AuditEntry): string {
  const after = entry.after ?? {};
  const before = entry.before ?? {};
  const keys = Object.keys(after);
  if (keys.length === 0) return "—";
  return keys
    .map((key) =>
      key in before
        ? `${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`
        : `${key}: ${JSON.stringify(after[key])}`,
    )
    .join("; ");
}

function AuditLog({ refreshKey }: { refreshKey: number }) {
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/audit-logs?page=${page}&limit=${AUDIT_PAGE_SIZE}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Unable to load the audit log");
      setEntries(data.entries ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the audit log");
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));

  return (
    <Card title="Audit log" flush>
      {error ? (
        <p role="alert" className="px-4 py-6 text-sm text-red-700">{error}</p>
      ) : loading ? (
        <div className="space-y-2 px-4 py-4" aria-busy="true">
          <span className="sr-only">Loading…</span>
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : entries.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-slate-500">No administrative actions recorded yet.</p>
      ) : (
        <TableCard
          flush
          label="Audit log entries"
          head={
            <>
              <Th>When</Th>
              <Th>Admin</Th>
              <Th>Action</Th>
              <Th>Target</Th>
              <Th>Change</Th>
              <Th>Reason</Th>
            </>
          }
        >
          {entries.map((entry) => (
            <Tr key={entry.id}>
              <Td className="whitespace-nowrap text-xs text-slate-500">{new Date(entry.createdAt).toLocaleString()}</Td>
              <Td>{entry.actor.name || entry.actor.id}</Td>
              <Td className="font-mono text-xs">{entry.action}</Td>
              <Td>
                {entry.targetLabel || entry.targetId}
                <span className="block text-xs text-slate-500">{entry.targetType}: {entry.targetId}</span>
              </Td>
              <Td className="max-w-xs break-words text-xs text-slate-600">{summarizeChange(entry)}</Td>
              <Td className="max-w-xs break-words text-slate-600">{entry.reason || "—"}</Td>
            </Tr>
          ))}
        </TableCard>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 text-[13px]">
        <span className="text-slate-500">
          Page {page} of {pages} · {total} {total === 1 ? "entry" : "entries"}
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} className={smallButtonClass}>
            Previous
          </button>
          <button type="button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages || loading} className={smallButtonClass}>
            Next
          </button>
        </div>
      </div>
    </Card>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required,
  readOnly,
  min,
  step,
  inputMode,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  readOnly?: boolean;
  min?: number;
  step?: string;
  inputMode?: "decimal" | "numeric";
  hint?: string;
  error?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        required={required}
        readOnly={readOnly}
        min={min}
        step={step}
        inputMode={inputMode}
        aria-describedby={[hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined}
        aria-invalid={error ? true : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClass} ${readOnly ? "!bg-slate-50 !text-slate-500" : ""}`}
      />
      {hint && <p id={`${id}-hint`} className="mt-1.5 text-xs text-slate-500">{hint}</p>}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/**
 * Themes a plan includes. Unchosen, the plan uses the default tier for its key
 * (shown pre-ticked); ticking or unticking makes the list explicit. Existing
 * stores keep their current theme after a plan change (grandfathered).
 */
function ThemesField({
  selected,
  isDefault,
  onChange,
  planKey,
}: {
  selected: string[];
  isDefault: boolean;
  onChange: (themes: string[]) => void;
  planKey: string;
}) {
  const legendId = useId();
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...selected, id] : selected.filter((t) => t !== id);
    onChange(THEMES.map((t) => t.id).filter((t) => next.includes(t)));
  };
  return (
    <fieldset aria-describedby={`${legendId}-hint`}>
      <legend className="text-sm font-medium text-slate-800">Themes included</legend>
      <p id={`${legendId}-hint`} className="mt-0.5 text-xs leading-5 text-slate-500">
        {isDefault
          ? `Using the default tier for “${planKey || "this key"}”. Change a box to set the list explicitly.`
          : `${selected.length} of ${THEMES.length} themes. At least one is required.`}{" "}
        Stores that already use a theme keep it if the plan changes.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:grid-cols-3">
        {THEMES.map((theme) => {
          const on = selected.includes(theme.id);
          return (
            <label
              key={theme.id}
              className={`flex min-h-10 min-w-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors motion-reduce:transition-none ${
                on ? "border-slate-900 bg-slate-50 font-medium text-slate-900" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
              }`}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => toggle(theme.id, e.target.checked)}
                className="h-4 w-4 shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
              />
              <span className="min-w-0 truncate">{theme.name}</span>
            </label>
          );
        })}
      </div>
      {selected.length === 0 && <p role="alert" className="mt-2 text-xs font-medium text-red-700">Choose at least one theme.</p>}
    </fieldset>
  );
}
