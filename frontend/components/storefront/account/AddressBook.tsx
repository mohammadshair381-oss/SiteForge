"use client";

import { useState, type FormEvent } from "react";
import { apiErrorFrom, fieldErrorId, invalidProps, summaryMessage } from "@/lib/api-errors";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import type { CustomerAddressView } from "@/lib/customer-addresses";

const EMPTY = { label: "", name: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "", phone: "" };
type Draft = typeof EMPTY & { id?: string };

const FIELDS = [
  ["label", "Label (optional)", "off", "Home, office…"],
  ["name", "Recipient", "name", ""],
  ["line1", "Address", "address-line1", ""],
  ["line2", "Apartment, suite (optional)", "address-line2", ""],
  ["city", "City", "address-level2", ""],
  ["region", "State / region (optional)", "address-level1", ""],
  ["postalCode", "Postal code", "postal-code", ""],
  ["country", "Country", "country-name", ""],
  ["phone", "Phone (optional)", "tel", ""],
] as const;

const INPUT = "sf-acc-input sf-acc-control mt-1 block min-h-11 w-full px-3 py-2 text-base aria-[invalid=true]:border-red-500 sm:text-sm";
const BUTTON = "sf-acc-secondary sf-acc-control sf-acc-focus inline-flex min-h-11 items-center justify-center px-4 py-2 text-sm font-semibold focus-visible:outline-none disabled:opacity-60";

/**
 * The signed-in customer's saved delivery addresses. Only their own come back from the
 * server, and it checks everything again. Takes its look from the store's theme.
 */
export default function AddressBook({ initial, maxAddresses }: { initial: CustomerAddressView[]; maxAddresses: number }) {
  const [addresses, setAddresses] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function send(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    setStatus(null);
    setFields({});
    try {
      const res = await fetch(`/api/storefront/account/addresses${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const data = (await res.json().catch(() => ({}))) as { addresses?: CustomerAddressView[]; message?: string };
      if (!res.ok) {
        const info = apiErrorFrom(data as { error?: unknown; code?: unknown; fields?: unknown }, "That could not be saved. Please try again.");
        setFields(info.fields);
        setError(summaryMessage(info, FIELDS.map(([key]) => key)));
        return false;
      }
      if (data.addresses) setAddresses(data.addresses);
      setStatus(data.message ?? "Saved.");
      return true;
    } catch {
      setError("We could not reach the store. Check your connection and try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const { id, ...body } = draft;
    if (await send(id ? `/${id}` : "", id ? "PATCH" : "POST", body)) setDraft(null);
  }

  async function remove(address: CustomerAddressView) {
    const confirmed = await confirmDialog({ title: "Delete this address?", message: "Orders you have already placed keep their own copy of it.", confirmLabel: "Delete address", tone: "danger" });
    if (confirmed) await send(`/${address.id}`, "DELETE");
  }

  return (
    <div className="space-y-4">
      <div role="status" aria-atomic="true" className="empty:hidden">
        {status && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">{status}</p>}
      </div>
      <div role="alert" aria-atomic="true" className="empty:hidden">
        {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">{error}</p>}
      </div>

      {addresses.length === 0 && !draft && (
        <div className="sf-acc-card px-6 py-12 text-center">
          <p className="font-semibold">You have no saved addresses yet.</p>
          <p className="sf-acc-muted mx-auto mt-1 max-w-sm text-sm leading-6">Save an address here, or tick the box at checkout, to fill it in faster next time.</p>
        </div>
      )}

      {addresses.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2">
          {addresses.map((address) => (
            <li key={address.id} className="sf-acc-card flex flex-col p-5">
              <p className="flex flex-wrap items-center gap-2 font-semibold">
                <span className="min-w-0 break-words">{address.label || address.name}</span>
                {address.isDefault && <span className="sf-acc-action rounded-full px-2.5 py-0.5 text-xs font-semibold">Default</span>}
              </p>
              <address className="sf-acc-muted mt-2 flex-1 break-words text-sm not-italic leading-6">
                {address.label && <span className="block">{address.name}</span>}
                <span className="block">{address.line1}</span>
                {address.line2 && <span className="block">{address.line2}</span>}
                <span className="block">{[address.city, address.region, address.postalCode].filter(Boolean).join(", ")}</span>
                <span className="block">{address.country}</span>
                {address.phone && <span className="block">{address.phone}</span>}
              </address>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" className={BUTTON} disabled={busy} onClick={() => { setDraft({ id: address.id, label: address.label, name: address.name, line1: address.line1, line2: address.line2, city: address.city, region: address.region, postalCode: address.postalCode, country: address.country, phone: address.phone }); setFields({}); setError(null); }}>
                  Edit
                </button>
                {!address.isDefault && (
                  <button type="button" className={BUTTON} disabled={busy} onClick={() => void send(`/${address.id}`, "PATCH", { action: "set_default" })}>
                    Make default
                  </button>
                )}
                <button type="button" className="sf-acc-error sf-acc-focus inline-flex min-h-11 items-center px-3 text-sm font-medium hover:underline focus-visible:outline-none disabled:opacity-60" disabled={busy} onClick={() => void remove(address)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {draft ? (
        <form onSubmit={save} noValidate className="sf-acc-card space-y-3 p-5 sm:p-6" aria-label={draft.id ? "Edit address" : "New address"}>
          <h2 className="sf-acc-title font-display text-lg">{draft.id ? "Edit address" : "New address"}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map(([key, label, autoComplete, placeholder]) => (
              <label key={key} className="block text-sm font-medium">
                {label}
                <input
                  value={draft[key]}
                  type={key === "phone" ? "tel" : "text"}
                  autoComplete={autoComplete}
                  placeholder={placeholder}
                  maxLength={key === "line1" || key === "line2" ? 160 : 100}
                  onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  className={INPUT}
                  {...invalidProps(fields, key, "address")}
                />
                {fields[key] && <span id={fieldErrorId("address", key)} className="sf-acc-error mt-1 block text-xs font-medium">{fields[key]}</span>}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="submit" disabled={busy} aria-busy={busy} className="sf-acc-action sf-acc-control sf-acc-focus inline-flex min-h-11 items-center justify-center px-5 py-2 text-sm font-semibold focus-visible:outline-none disabled:opacity-60">
              {busy ? "Saving…" : "Save address"}
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => { setDraft(null); setFields({}); setError(null); }}>Cancel</button>
          </div>
        </form>
      ) : (
        addresses.length < maxAddresses && (
          <button type="button" className={BUTTON} onClick={() => { setDraft({ ...EMPTY }); setStatus(null); setError(null); }}>Add an address</button>
        )
      )}
    </div>
  );
}
