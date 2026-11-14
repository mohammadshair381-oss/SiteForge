"use client";

import { useEffect, useRef, useState } from "react";
import ManagementPageHeader from "./ManagementPageHeader";
import { formatPrice } from "@/lib/format";
import { fieldErrorId, invalidProps, readApiError, summaryMessage } from "@/lib/api-errors";
import type { CouponView } from "@/lib/coupons";
import { Button } from "@/components/ui/Button";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Card, EmptyState, Notice, Pill, type Tone } from "@/components/ui/Surface";

interface Draft {
  id?: string;
  code: string;
  description: string;
  type: "percent" | "fixed";
  value: string;
  minSubtotal: string;
  maxDiscount: string;
  appliesTo: "all" | "products" | "categories";
  productIds: string[];
  categories: string[];
  startsAt: string;
  expiresAt: string;
  usageLimit: string;
  perCustomerLimit: string;
  onePerAddress: boolean;
  requiresAccount: boolean;
  active: boolean;
}

const EMPTY: Draft = { code: "", description: "", type: "percent", value: "", minSubtotal: "", maxDiscount: "", appliesTo: "all", productIds: [], categories: [], startsAt: "", expiresAt: "", usageLimit: "", perCustomerLimit: "", onePerAddress: false, requiresAccount: false, active: true };

const toLocal = (iso: string | null) => {
  if (!iso) return "";
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function status(c: CouponView, now = Date.now()): { label: string; tone: Tone } {
  if (!c.active) return { label: "Inactive", tone: "neutral" };
  if (c.expiresAt && Date.parse(c.expiresAt) <= now) return { label: "Expired", tone: "neutral" };
  if (c.startsAt && Date.parse(c.startsAt) > now) return { label: "Scheduled", tone: "info" };
  if (c.usageLimit !== null && c.usedCount >= c.usageLimit) return { label: "Used up", tone: "warning" };
  return { label: "Active", tone: "success" };
}

/** Shared by the list header and its rows, so the columns line up. */
const rowGridClass = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_6rem_6rem_6rem_5rem] lg:gap-x-4";

/**
 * Discount codes: percentage or fixed amount, minimum order, start/end,
 * total and per-customer limits. The server validates every code again at
 * checkout; one code per order (no stacking).
 */
export default function CouponsManager({ businessId, currency, initial, products = [], categories = [] }: { businessId: string; currency: string; initial: CouponView[]; products?: Array<{ id: string; name: string }>; categories?: string[] }) {
  const [coupons, setCoupons] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const draftKey = draft ? draft.id ?? "new" : null;

  // The form sits above the list: bring it into view when a row opens it.
  useEffect(() => {
    if (draftKey) formRef.current?.scrollIntoView({ block: "nearest" });
  }, [draftKey]);

  function edit(c: CouponView) {
    setDraft({
      id: c.id, code: c.code, description: c.description, type: c.type, value: String(c.value), minSubtotal: c.minSubtotal ? String(c.minSubtotal) : "",
      maxDiscount: c.maxDiscount ? String(c.maxDiscount) : "", appliesTo: c.appliesTo ?? "all", productIds: c.productIds ?? [], categories: c.categories ?? [],
      startsAt: toLocal(c.startsAt), expiresAt: toLocal(c.expiresAt), usageLimit: c.usageLimit ? String(c.usageLimit) : "",
      perCustomerLimit: c.perCustomerLimit ? String(c.perCustomerLimit) : "", active: c.active,
      onePerAddress: c.onePerAddress === true, requiresAccount: c.requiresAccount === true,
    });
    setMessage(null);
    setFieldErrors({});
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || saving) return;
    setMessage(null);
    setFieldErrors({});
    const body = {
      code: draft.code,
      description: draft.description,
      type: draft.type,
      value: Number(draft.value),
      minSubtotal: draft.minSubtotal === "" ? 0 : Number(draft.minSubtotal),
      maxDiscount: draft.maxDiscount === "" ? null : Number(draft.maxDiscount),
      appliesTo: draft.appliesTo,
      productIds: draft.appliesTo === "products" ? draft.productIds : [],
      categories: draft.appliesTo === "categories" ? draft.categories : [],
      startsAt: draft.startsAt ? new Date(draft.startsAt).toISOString() : null,
      expiresAt: draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null,
      usageLimit: draft.usageLimit === "" ? null : Number(draft.usageLimit),
      perCustomerLimit: draft.perCustomerLimit === "" ? null : Number(draft.perCustomerLimit),
      onePerAddress: draft.onePerAddress,
      requiresAccount: draft.requiresAccount,
      active: draft.active,
    };
    setSaving(true);
    try {
      const res = await fetch(draft.id ? `/api/businesses/${businessId}/coupons/${draft.id}` : `/api/businesses/${businessId}/coupons`, {
        method: draft.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const info = await readApiError(res, "Could not save the coupon.");
        setFieldErrors(info.fields);
        setMessage({ ok: false, text: summaryMessage(info, ["code", "description", "value", "minSubtotal", "maxDiscount", "usageLimit", "perCustomerLimit", "startsAt", "expiresAt"]) });
        return;
      }
      const data = await res.json().catch(() => ({}));
      const saved = data.coupon as CouponView;
      setCoupons((all) => (draft.id ? all.map((c) => (c.id === saved.id ? saved : c)) : [saved, ...all]));
      setDraft(null);
      setMessage({ ok: true, text: `Coupon ${saved.code} saved.` });
    } catch {
      setMessage({ ok: false, text: "Could not reach the server. The coupon was not saved." });
    } finally {
      setSaving(false);
    }
  }

  const field = (key: keyof Draft, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className={labelClass}>
      {label}
      <input
        value={String(draft?.[key] ?? "")}
        onChange={(e) => setDraft((d) => (d ? { ...d, [key]: e.target.value } : d))}
        className={`mt-1.5 ${inputClass}`}
        {...props}
        {...invalidProps(fieldErrors, key, "coupon")}
      />
      <FieldError id={fieldErrorId("coupon", key)} message={fieldErrors[key]} />
    </label>
  );

  function startNew() {
    setDraft({ ...EMPTY });
    setMessage(null);
    setFieldErrors({});
  }

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Coupons"
        description="Discount codes shoppers enter in the cart. Checked again on the server at checkout; one code per order. Codes are deactivated, never deleted."
        actions={
          <Button onClick={startNew}>
            <Icon name="plus" size={16} />
            New coupon
          </Button>
        }
      />
      {message && (
        <Notice tone={message.ok ? "success" : "danger"} role="status">
          {message.text}
        </Notice>
      )}

      {draft && (
        <form ref={formRef} onSubmit={save} className="scroll-mt-44 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 lg:scroll-mt-32" aria-label={draft.id ? "Edit coupon" : "New coupon"}>
          <h2 className="text-lg font-semibold text-slate-900">{draft.id ? "Edit coupon" : "New coupon"}</h2>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {field("code", "Code", { required: true, maxLength: 32, placeholder: "WELCOME10", className: `mt-1.5 ${inputClass} uppercase` })}
            {field("description", "Description (shown to shoppers)", { maxLength: 160 })}
          </div>

          <h3 className="mt-6 border-t border-slate-200 pt-5 text-sm font-semibold text-slate-900">The discount</h3>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className={labelClass}>
              Type
              <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as Draft["type"] })} className={`mt-1.5 ${inputClass}`}>
                <option value="percent">Percentage off</option>
                <option value="fixed">Fixed amount off ({currency})</option>
              </select>
            </label>
            {field("value", draft.type === "percent" ? "Percent (1-100)" : `Amount (${currency})`, { required: true, type: "number", min: 0, step: "0.01" })}
            {field("minSubtotal", `Minimum order (${currency})`, { type: "number", min: 0, step: "0.01" })}
            {field("maxDiscount", `Largest discount (${currency}, optional)`, { type: "number", min: 0, step: "0.01" })}
          </div>

          <h3 className="mt-6 border-t border-slate-200 pt-5 text-sm font-semibold text-slate-900">What it applies to</h3>
          <label className={`mt-3 max-w-sm ${labelClass}`}>
            Applies to
            <select value={draft.appliesTo} onChange={(e) => setDraft({ ...draft, appliesTo: e.target.value as Draft["appliesTo"] })} className={`mt-1.5 ${inputClass}`}>
              <option value="all">The whole order</option>
              <option value="products">Chosen products</option>
              <option value="categories">Chosen categories</option>
            </select>
          </label>
          {draft.appliesTo === "products" && (
            <fieldset className="mt-3">
              <legend className={labelClass}>Products</legend>
              {products.length === 0 ? (
                <p className="mt-1 text-sm text-slate-600">You have no products yet.</p>
              ) : (
                <ul className="mt-1 grid max-h-56 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2 sm:grid-cols-2">
                  {products.map((product) => (
                    <li key={product.id}>
                      <label className="flex min-h-10 items-center gap-2 text-sm text-slate-800">
                        <input
                          type="checkbox"
                          checked={draft.productIds.includes(product.id)}
                          onChange={(e) => setDraft({ ...draft, productIds: e.target.checked ? [...draft.productIds, product.id] : draft.productIds.filter((id) => id !== product.id) })}
                          className="h-4 w-4 shrink-0"
                        />
                        <span className="min-w-0 truncate">{product.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          )}
          {draft.appliesTo === "categories" && (
            <fieldset className="mt-3">
              <legend className={labelClass}>Categories</legend>
              {categories.length === 0 ? (
                <p className="mt-1 text-sm text-slate-600">None of your products has a category yet.</p>
              ) : (
                <ul className="mt-1 grid max-h-56 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2 sm:grid-cols-2">
                  {categories.map((name) => (
                    <li key={name}>
                      <label className="flex min-h-10 items-center gap-2 text-sm text-slate-800">
                        <input
                          type="checkbox"
                          checked={draft.categories.some((c) => c.toLowerCase() === name.toLowerCase())}
                          onChange={(e) => setDraft({ ...draft, categories: e.target.checked ? [...draft.categories, name] : draft.categories.filter((c) => c.toLowerCase() !== name.toLowerCase()) })}
                          className="h-4 w-4 shrink-0"
                        />
                        <span className="min-w-0 truncate">{name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          )}

          <h3 className="mt-6 border-t border-slate-200 pt-5 text-sm font-semibold text-slate-900">Limits and dates</h3>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {field("usageLimit", "Total uses across all customers (empty = unlimited)", { type: "number", min: 1, step: 1 })}
            {field("perCustomerLimit", "Uses per customer (empty = unlimited)", { type: "number", min: 1, step: 1 })}
            {field("startsAt", "Starts (optional)", { type: "datetime-local" })}
            {field("expiresAt", "Ends (optional)", { type: "datetime-local" })}
          </div>
          <div className="mt-3 space-y-2 text-sm text-slate-700">
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={draft.requiresAccount} onChange={(event) => setDraft({ ...draft, requiresAccount: event.target.checked })} />
              <span>
                <span className="font-medium text-slate-900">Signed-in customers only.</span> Guests must sign in to use this code. This is the strongest limit, since each account has a confirmed email.
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={draft.onePerAddress} onChange={(event) => setDraft({ ...draft, onePerAddress: event.target.checked })} />
              <span>
                <span className="font-medium text-slate-900">One customer per delivery address.</span> Everyone ordering to the same address shares the per-customer limit. Leave off if people in the same household or office may each want to use it.
              </span>
            </label>
          </div>
          <p className="mt-2 text-xs text-slate-500">Per-customer limits count the signed-in account, the email address and the phone number, including guest checkouts that use them. The total is counted across everyone, whoever they are.</p>
          {draft.onePerAddress && draft.perCustomerLimit === "" && (
            <p className="mt-2 text-xs font-medium text-amber-800">The delivery address option only counts when &quot;Uses per customer&quot; has a limit.</p>
          )}
          {draft.perCustomerLimit !== "" && !draft.requiresAccount && (
            <Notice tone="warning" className="mt-3" title="Guests can get around a per-customer limit">
              A guest has no account to count against, so someone can use this code again by entering a different email, phone number or address. SiteForge does not try to identify people in other ways. If this matters for this code, turn on &quot;Signed-in customers only&quot;.
            </Notice>
          )}

          <label className="mt-4 flex min-h-10 items-center gap-2 text-sm font-medium text-slate-800">
            <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} className="h-4 w-4" />
            Active
          </label>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200 pt-4">
            <Button type="submit" disabled={saving} aria-busy={saving}>{saving ? "Saving…" : "Save coupon"}</Button>
            <Button variant="secondary" onClick={() => setDraft(null)} disabled={saving}>Cancel</Button>
          </div>
        </form>
      )}

      {coupons.length === 0 ? (
        !draft && (
          <EmptyState
            icon={<Icon name="coupons" size={20} />}
            title="No coupons yet"
            action={<Button onClick={startNew}>Create your first coupon</Button>}
          >
            A coupon is a code shoppers type in the cart to get a discount, such as WELCOME10 for 10% off a first order.
          </EmptyState>
        )
      ) : (
        <Card as="section" aria-label="Coupons">
          <div aria-hidden="true" className={`${rowGridClass} hidden rounded-t-2xl bg-slate-50 px-5 py-2.5 text-xs font-medium text-slate-500 lg:grid`}>
            <span>Code</span>
            <span>Discount</span>
            <span className="text-right">Used</span>
            <span>Ends</span>
            <span>Status</span>
            <span />
          </div>
          <ul className="divide-y divide-slate-100">
            {coupons.map((c) => {
              const s = status(c);
              return (
                <li key={c.id} className={`${rowGridClass} px-4 py-4 transition-colors hover:bg-slate-50 sm:px-5 lg:py-3`}>
                  <p className="min-w-0 break-all font-mono font-semibold text-slate-900">{c.code}</p>
                  <div className="col-start-1 min-w-0 text-sm text-slate-700 lg:col-start-2">
                    <p>{c.type === "percent" ? `${c.value}% off` : `${formatPrice(c.value, c.currency)} off`}</p>
                    {c.appliesTo && c.appliesTo !== "all" && (
                      <p className="text-xs text-slate-500">{c.appliesTo === "products" ? `On ${c.productIds.length} product${c.productIds.length === 1 ? "" : "s"}` : `On ${c.categories.join(", ")}`}</p>
                    )}
                    {c.maxDiscount !== null && c.maxDiscount !== undefined && <p className="text-xs text-slate-500">Up to {formatPrice(c.maxDiscount, c.currency)}</p>}
                    {(c.minSubtotal > 0 || c.perCustomerLimit !== null || c.requiresAccount === true || c.onePerAddress === true) && (
                      <p className="text-xs text-slate-500">
                        {[c.minSubtotal > 0 ? `min ${formatPrice(c.minSubtotal, c.currency)}` : null, c.perCustomerLimit !== null ? `${c.perCustomerLimit} per customer` : null, c.requiresAccount === true ? "signed-in only" : null, c.onePerAddress === true ? "one per address" : null].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                  <p className="col-start-1 text-xs tabular-nums text-slate-600 lg:col-start-3 lg:text-right lg:text-sm">
                    <span className="lg:hidden">Used </span>
                    {c.usedCount}{c.usageLimit !== null ? ` / ${c.usageLimit}` : ""}
                  </p>
                  <p className="col-start-1 text-xs text-slate-600 lg:col-start-4 lg:text-sm">
                    {c.expiresAt ? (
                      <>
                        <span className="lg:hidden">Ends </span>
                        {new Date(c.expiresAt).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" })}
                      </>
                    ) : (
                      <span className="text-slate-500">No end date</span>
                    )}
                  </p>
                  <div className="col-start-2 row-start-1 justify-self-end lg:col-start-5 lg:justify-self-start">
                    <Pill tone={s.tone} dot>{s.label}</Pill>
                  </div>
                  <div className="col-start-2 row-span-3 row-start-2 self-end justify-self-end lg:col-start-6 lg:row-span-1 lg:row-start-1 lg:self-center">
                    <Button variant="secondary" onClick={() => edit(c)}>Edit</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
