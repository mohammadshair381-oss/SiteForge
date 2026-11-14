"use client";

import { useState } from "react";
import ManagementPageHeader from "./ManagementPageHeader";
import { apiErrorFrom, fieldErrorId, invalidProps } from "@/lib/api-errors";
import type { ShippingSettings, TaxSettings } from "@/lib/checkout-pricing";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { Card, Notice } from "@/components/ui/Surface";

interface ZoneDraft {
  id: string;
  name: string;
  countries: string;
  regions: string;
  postalPrefixes: string;
  rate: string;
  freeOver: string;
  deliveryInfo: string;
  codAvailable: boolean;
}

const list = (value: string) => value.split(",").map((part) => part.trim()).filter(Boolean);
const newId = () => Math.random().toString(36).slice(2, 12);

/**
 * Shipping charges, delivery areas, order limits and tax. Everything here is applied
 * again on the server at checkout, so what a shopper sees is what they are charged.
 * Carrier tracking is entered per order.
 */
export default function ShippingSettingsForm({ businessId, currency, initial, initialTax }: { businessId: string; currency: string; initial: ShippingSettings; initialTax: TaxSettings }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [flatRate, setFlatRate] = useState(String(initial.flatRate));
  const [freeOver, setFreeOver] = useState(initial.freeOver === null ? "" : String(initial.freeOver));
  const [requireAddress, setRequireAddress] = useState(initial.requireAddress);
  const [deliveryInfo, setDeliveryInfo] = useState(initial.deliveryInfo);
  const [shipElsewhere, setShipElsewhere] = useState(initial.shipElsewhere);
  const [minOrder, setMinOrder] = useState(initial.minOrder ? String(initial.minOrder) : "");
  const [codMaxOrder, setCodMaxOrder] = useState(initial.codMaxOrder === null ? "" : String(initial.codMaxOrder));
  const [zones, setZones] = useState<ZoneDraft[]>(
    initial.zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      countries: zone.countries.join(", "),
      regions: zone.regions.join(", "),
      postalPrefixes: zone.postalPrefixes.join(", "),
      rate: String(zone.rate),
      freeOver: zone.freeOver === null ? "" : String(zone.freeOver),
      deliveryInfo: zone.deliveryInfo,
      codAvailable: zone.codAvailable,
    })),
  );
  const [taxEnabled, setTaxEnabled] = useState(initialTax.enabled);
  const [taxLabel, setTaxLabel] = useState(initialTax.label);
  const [taxRate, setTaxRate] = useState(String(initialTax.rate));
  const [taxInclusive, setTaxInclusive] = useState(initialTax.inclusive);
  const [taxOnShipping, setTaxOnShipping] = useState(initialTax.applyToShipping);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // The input's attributes and its message, for a field the server may report on.
  const check = (name: string) => invalidProps(fieldErrors, name, "shipping");
  const errorFor = (name: string) => <FieldError id={fieldErrorId("shipping", name)} message={fieldErrors[name]} />;

  const updateZone = (id: string, patch: Partial<ZoneDraft>) => setZones((all) => all.map((zone) => (zone.id === id ? { ...zone, ...patch } : zone)));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage(null);
    setFieldErrors({});
    const put = (path: string, body: unknown) =>
      fetch(`/api/businesses/${businessId}/${path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const shipping = await put("shipping", {
        enabled,
        flatRate: Number(flatRate || 0),
        freeOver: freeOver === "" ? null : Number(freeOver),
        requireAddress,
        deliveryInfo,
        shipElsewhere,
        minOrder: Number(minOrder || 0),
        codMaxOrder: codMaxOrder === "" ? null : Number(codMaxOrder),
        zones: zones.map((zone) => ({
          id: zone.id,
          name: zone.name,
          countries: list(zone.countries),
          regions: list(zone.regions),
          postalPrefixes: list(zone.postalPrefixes),
          rate: Number(zone.rate || 0),
          freeOver: zone.freeOver === "" ? null : Number(zone.freeOver),
          deliveryInfo: zone.deliveryInfo,
          codAvailable: zone.codAvailable,
        })),
      });
      const shippingData = await shipping.json().catch(() => ({}));
      if (!shipping.ok) {
        const info = apiErrorFrom(shippingData, "Your shipping settings could not be saved.");
        setFieldErrors(info.fields);
        setMessage({ ok: false, text: info.message });
        return;
      }
      const tax = await put("tax", { enabled: taxEnabled, label: taxLabel.trim() || "Tax", rate: Number(taxRate || 0), inclusive: taxInclusive, applyToShipping: taxOnShipping });
      const taxData = await tax.json().catch(() => ({}));
      if (!tax.ok) {
        const info = apiErrorFrom(taxData, "Your tax settings could not be saved.");
        setFieldErrors(Object.fromEntries(Object.entries(info.fields).map(([key, value]) => [`tax.${key}`, value])));
        setMessage({ ok: false, text: info.message });
        return;
      }
      setMessage({ ok: true, text: "Saved. New orders use these settings; existing orders keep what they were charged." });
    } catch {
      setMessage({ ok: false, text: "Could not reach the server. Your settings were not saved." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Shipping and tax"
        description="Set what delivery costs and where you deliver, and the tax you charge. Shoppers see the exact amounts before they place an order."
      />
      <form onSubmit={save} className="space-y-6">
        <Card as="section" className="p-5 sm:p-6" aria-labelledby="shipping-charge">
          <h2 id="shipping-charge" className="text-lg font-semibold text-slate-900">Shipping charge</h2>
          <p className="mt-1 text-sm text-slate-600">When this is off, no shipping charge is added at checkout.</p>
          <label className="mt-4 flex min-h-10 items-center gap-2 text-sm font-medium text-slate-800">
            <input type="checkbox" role="switch" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4" />
            Ship orders (charge shipping at checkout)
          </label>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className={labelClass}>
              Standard shipping rate ({currency})
              <input type="number" min={0} step="0.01" value={flatRate} disabled={!enabled} onChange={(e) => setFlatRate(e.target.value)} className={`mt-1.5 ${inputClass}`} {...check("flatRate")} />
              {errorFor("flatRate")}
            </label>
            <label className={labelClass}>
              Free shipping from ({currency}, optional)
              <input type="number" min={0} step="0.01" value={freeOver} disabled={!enabled} onChange={(e) => setFreeOver(e.target.value)} className={`mt-1.5 ${inputClass}`} {...check("freeOver")} />
              {errorFor("freeOver")}
            </label>
            <label className={labelClass}>
              Minimum order ({currency}, optional)
              <input type="number" min={0} step="0.01" value={minOrder} disabled={!enabled} onChange={(e) => setMinOrder(e.target.value)} className={`mt-1.5 ${inputClass}`} {...check("minOrder")} />
              {errorFor("minOrder")}
            </label>
            <label className={labelClass}>
              Largest cash-on-delivery order ({currency}, optional)
              <input type="number" min={0} step="0.01" value={codMaxOrder} disabled={!enabled} onChange={(e) => setCodMaxOrder(e.target.value)} className={`mt-1.5 ${inputClass}`} {...check("codMaxOrder")} />
              {errorFor("codMaxOrder")}
            </label>
          </div>
          <p className="mt-2 text-xs text-slate-500">Free shipping is checked against the order amount after any discount code.</p>
          <label className="mt-4 flex min-h-10 items-center gap-2 text-sm font-medium text-slate-800">
            <input type="checkbox" checked={requireAddress} disabled={!enabled} onChange={(e) => setRequireAddress(e.target.checked)} className="h-4 w-4" />
            Ask for a delivery address at checkout
          </label>
        </Card>

        <Card as="section" className="p-5 sm:p-6" aria-labelledby="shipping-zones">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="shipping-zones" className="text-lg font-semibold text-slate-900">Delivery areas</h2>
              <p className="mt-1 max-w-2xl text-sm text-slate-600">Optional: a different charge for different places. The first area that matches an address is used. They need the delivery address step above.</p>
            </div>
            <Button
              variant="secondary"
              disabled={!enabled || !requireAddress || zones.length >= 30}
              onClick={() => setZones((all) => [...all, { id: newId(), name: "", countries: "", regions: "", postalPrefixes: "", rate: "0", freeOver: "", deliveryInfo: "", codAvailable: true }])}
            >
              <Icon name="plus" size={15} /> Add an area
            </Button>
          </div>
          {zones.length > 0 && (
            <ul className="mt-4 space-y-3">
              {zones.map((zone, index) => (
                <li key={zone.id} className="rounded-xl border border-slate-200 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900">Area {index + 1}</p>
                    <button type="button" onClick={() => setZones((all) => all.filter((item) => item.id !== zone.id))} className="inline-flex min-h-10 items-center rounded-lg px-2 text-sm font-medium text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                      Remove
                    </button>
                  </div>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    <label className={labelClass}>
                      Name (shown at checkout)
                      <input required maxLength={80} value={zone.name} onChange={(e) => updateZone(zone.id, { name: e.target.value })} placeholder="Within Karnataka" className={`mt-1.5 ${inputClass}`} {...check(`zones.${index}.name`)} />
                      {errorFor(`zones.${index}.name`)}
                    </label>
                    <label className={labelClass}>
                      Countries (comma separated; empty = any)
                      <input value={zone.countries} onChange={(e) => updateZone(zone.id, { countries: e.target.value })} placeholder="India" className={`mt-1.5 ${inputClass}`} {...check(`zones.${index}.countries`)} />
                      {errorFor(`zones.${index}.countries`)}
                    </label>
                    <label className={labelClass}>
                      States or regions (empty = any)
                      <input value={zone.regions} onChange={(e) => updateZone(zone.id, { regions: e.target.value })} placeholder="Karnataka, Kerala" className={`mt-1.5 ${inputClass}`} {...check(`zones.${index}.regions`)} />
                      {errorFor(`zones.${index}.regions`)}
                    </label>
                    <label className={labelClass}>
                      Postal codes starting with (empty = any)
                      <input value={zone.postalPrefixes} onChange={(e) => updateZone(zone.id, { postalPrefixes: e.target.value })} placeholder="560, 561" className={`mt-1.5 ${inputClass}`} {...check(`zones.${index}.postalPrefixes`)} />
                      {errorFor(`zones.${index}.postalPrefixes`)}
                    </label>
                    <label className={labelClass}>
                      Shipping rate ({currency})
                      <input type="number" min={0} step="0.01" value={zone.rate} onChange={(e) => updateZone(zone.id, { rate: e.target.value })} className={`mt-1.5 ${inputClass}`} {...check(`zones.${index}.rate`)} />
                      {errorFor(`zones.${index}.rate`)}
                    </label>
                    <label className={labelClass}>
                      Free from ({currency}, optional)
                      <input type="number" min={0} step="0.01" value={zone.freeOver} onChange={(e) => updateZone(zone.id, { freeOver: e.target.value })} className={`mt-1.5 ${inputClass}`} {...check(`zones.${index}.freeOver`)} />
                      {errorFor(`zones.${index}.freeOver`)}
                    </label>
                    <label className={`${labelClass} sm:col-span-2`}>
                      Delivery information (optional)
                      <input maxLength={200} value={zone.deliveryInfo} onChange={(e) => updateZone(zone.id, { deliveryInfo: e.target.value })} placeholder="Delivered in 2-3 days" className={`mt-1.5 ${inputClass}`} {...check(`zones.${index}.deliveryInfo`)} />
                      {errorFor(`zones.${index}.deliveryInfo`)}
                    </label>
                  </div>
                  <label className="mt-2 flex min-h-10 items-center gap-2 text-sm text-slate-800">
                    <input type="checkbox" checked={zone.codAvailable} onChange={(e) => updateZone(zone.id, { codAvailable: e.target.checked })} className="h-4 w-4" />
                    Offer cash on delivery here
                  </label>
                </li>
              ))}
            </ul>
          )}
          {zones.length > 0 && (
            <label className="mt-4 flex min-h-10 items-start gap-2 text-sm font-medium text-slate-800">
              <input type="checkbox" checked={shipElsewhere} onChange={(e) => setShipElsewhere(e.target.checked)} className="mt-0.5 h-4 w-4" />
              <span>
                Deliver everywhere else at the standard rate
                <span className="block text-xs font-normal text-slate-500">Off: addresses outside these areas cannot place an order.</span>
              </span>
            </label>
          )}
        </Card>

        <Card as="section" className="p-5 sm:p-6" aria-labelledby="tax-settings">
          <h2 id="tax-settings" className="text-lg font-semibold text-slate-900">Tax</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">One rate for the whole store. SiteForge calculates and shows it, but does not file or remit tax. Check the right treatment with your accountant.</p>
          <label className="mt-4 flex min-h-10 items-center gap-2 text-sm font-medium text-slate-800">
            <input type="checkbox" role="switch" checked={taxEnabled} onChange={(e) => setTaxEnabled(e.target.checked)} className="h-4 w-4" />
            Charge tax
          </label>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <label className={labelClass}>
              Name on receipts
              <input maxLength={40} value={taxLabel} disabled={!taxEnabled} onChange={(e) => setTaxLabel(e.target.value)} placeholder="GST" className={`mt-1.5 ${inputClass}`} {...check("tax.label")} />
              {errorFor("tax.label")}
            </label>
            <label className={labelClass}>
              Rate (%)
              <input type="number" min={0} max={100} step="0.01" value={taxRate} disabled={!taxEnabled} onChange={(e) => setTaxRate(e.target.value)} className={`mt-1.5 ${inputClass}`} {...check("tax.rate")} />
              {errorFor("tax.rate")}
            </label>
          </div>
          <label className="mt-3 flex min-h-10 items-start gap-2 text-sm font-medium text-slate-800">
            <input type="checkbox" checked={taxInclusive} disabled={!taxEnabled} onChange={(e) => setTaxInclusive(e.target.checked)} className="mt-0.5 h-4 w-4" />
            <span>
              My prices already include tax
              <span className="block text-xs font-normal text-slate-500">On: the tax is shown as part of the price. Off: it is added on top at checkout.</span>
            </span>
          </label>
          <label className="flex min-h-10 items-center gap-2 text-sm font-medium text-slate-800">
            <input type="checkbox" checked={taxOnShipping} disabled={!taxEnabled} onChange={(e) => setTaxOnShipping(e.target.checked)} className="h-4 w-4" />
            Charge tax on shipping too
          </label>
        </Card>

        <Card as="section" className="p-5 sm:p-6" aria-labelledby="shipping-info">
          <h2 id="shipping-info" className="text-lg font-semibold text-slate-900">What shoppers are told</h2>
          <label className={`mt-3 ${labelClass}`}>
            Delivery information (shown at checkout and on product pages)
            <textarea rows={3} maxLength={500} value={deliveryInfo} onChange={(e) => setDeliveryInfo(e.target.value)} placeholder="Delivered in 3-5 working days" className={`mt-1.5 ${inputClass}`} {...check("deliveryInfo")} />
            {errorFor("deliveryInfo")}
          </label>
        </Card>

        {message && (
          <Notice tone={message.ok ? "success" : "danger"} role="status">
            {message.text}
          </Notice>
        )}
        <Button type="submit" disabled={saving} aria-busy={saving}>{saving ? "Saving…" : "Save"}</Button>
      </form>
    </div>
  );
}
