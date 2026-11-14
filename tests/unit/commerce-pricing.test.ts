import assert from "node:assert/strict";
import test from "node:test";

import { discountFor, eligibleSubtotal, matchShippingZone, priceOrder, quoteShipping, readShippingSettings, readTaxSettings, taxFor } from "../../backend/lib/checkout-pricing";
import { csvCell } from "../../backend/lib/orders/management-query";
import { renderOrderEmail } from "../../backend/lib/email-templates";

const zones = [
  { id: "a", name: "Bengaluru", countries: ["India"], regions: [], postalPrefixes: ["560"], rate: 40, freeOver: 500, deliveryInfo: "Next day", codAvailable: true },
  { id: "b", name: "India", countries: ["india"], regions: [], postalPrefixes: [], rate: 80, freeOver: null, deliveryInfo: "", codAvailable: false },
];

test("coupon cap and eligible lines limit the discount", () => {
  assert.equal(discountFor(1000, { type: "percent", value: 50, maxDiscount: 100 }), 100);
  assert.equal(discountFor(100, { type: "fixed", value: 500 }), 100);
  const lines = [
    { product: "p1", category: "Tea", lineTotal: 100 },
    { product: "p2", category: "Coffee", lineTotal: 50 },
  ];
  assert.equal(eligibleSubtotal(lines, { appliesTo: "all" }), 150);
  assert.equal(eligibleSubtotal(lines, { appliesTo: "products", productIds: ["p2"] }), 50);
  assert.equal(eligibleSubtotal(lines, { appliesTo: "categories", categories: ["  tea "] }), 100);
  assert.equal(eligibleSubtotal(lines, { appliesTo: "categories", categories: ["Cups"] }), 0);
  // An older coupon without these fields applies to everything.
  assert.equal(eligibleSubtotal(lines, {}), 150);
});

test("the first matching zone sets the charge, without case or spaces mattering", () => {
  const settings = readShippingSettings({ enabled: true, flatRate: 100, zones });
  assert.equal(matchShippingZone(settings, { country: "INDIA", postalCode: "560 001" })?.name, "Bengaluru");
  assert.equal(matchShippingZone(settings, { country: "India", postalCode: "110001" })?.name, "India");
  assert.equal(matchShippingZone(settings, { country: "Nepal", postalCode: "44600" }), null);
  assert.equal(quoteShipping(settings, 200, 200, { country: "India", postalCode: "560001" }).amount, 40);
  assert.equal(quoteShipping(settings, 600, 600, { country: "India", postalCode: "560001" }).amount, 0, "free over the zone's amount");
  assert.equal(quoteShipping(settings, 200, 200, { country: "Nepal", postalCode: "44600" }).amount, 100, "elsewhere uses the standard rate");
  assert.equal(quoteShipping(settings, 200, 200, { country: "India", postalCode: "110001" }).codAvailable, false);
});

test("shipping refuses what the store cannot accept, and waits for an address", () => {
  const closed = readShippingSettings({ enabled: true, flatRate: 100, zones, shipElsewhere: false, minOrder: 150 });
  assert.equal(quoteShipping(closed, 100, 100, { country: "India", postalCode: "560001" }).refusal, "below_minimum");
  assert.equal(quoteShipping(closed, 200, 200, { country: "Nepal", postalCode: "44600" }).refusal, "not_deliverable");
  const waiting = quoteShipping(closed, 200, 200, { country: "India" });
  assert.equal(waiting.awaitingAddress, true);
  assert.equal(waiting.deliverable, true);
  // Off means off.
  assert.equal(quoteShipping(readShippingSettings({ enabled: false, minOrder: 1000 }), 1, 1).deliverable, true);
});

test("older stored settings keep working unchanged", () => {
  const old = readShippingSettings({ enabled: true, flatRate: 5, freeOver: 50, requireAddress: true, deliveryInfo: "" });
  assert.equal(old.shipElsewhere, true);
  assert.deepEqual(old.zones, []);
  assert.equal(quoteShipping(old, 10, 10).amount, 5);
  assert.equal(quoteShipping(old, 60, 60).amount, 0);
});

test("tax: added on top, or shown as part of the price", () => {
  const added = readTaxSettings({ enabled: true, label: "GST", rate: 18, inclusive: false });
  const included = readTaxSettings({ enabled: true, label: "GST", rate: 18, inclusive: true });
  assert.equal(taxFor(added, 100, 0), 18);
  assert.equal(taxFor(included, 118, 0), 18);
  assert.equal(taxFor(readTaxSettings({ enabled: true, rate: 10, inclusive: false, applyToShipping: true }), 100, 50), 15);
  assert.equal(taxFor(readTaxSettings(undefined), 100, 0), 0);
  assert.equal(readTaxSettings({ rate: 999 }).enabled, false, "invalid settings mean no tax");

  const shipping = readShippingSettings({ enabled: true, flatRate: 10 });
  const on = priceOrder({ subtotal: 100, coupon: { type: "fixed", value: 20 }, shipping, tax: added });
  assert.deepEqual([on.discountTotal, on.shippingTotal, on.taxTotal, on.total], [20, 10, 14.4, 104.4]);
  const inPrice = priceOrder({ subtotal: 118, coupon: null, shipping, tax: included });
  assert.deepEqual([inPrice.taxTotal, inPrice.total], [18, 128]);
});

test("a coupon on some lines discounts only them, and free shipping follows the discount", () => {
  const shipping = readShippingSettings({ enabled: true, flatRate: 10, freeOver: 100 });
  const tax = readTaxSettings(undefined);
  const priced = priceOrder({ subtotal: 110, eligible: 20, coupon: { type: "percent", value: 50 }, shipping, tax });
  assert.deepEqual([priced.discountTotal, priced.shippingTotal, priced.total], [10, 0, 100]);
  const below = priceOrder({ subtotal: 105, eligible: 105, coupon: { type: "fixed", value: 10 }, shipping, tax });
  assert.deepEqual([below.shippingTotal, below.total], [10, 105]);
});

test("spreadsheet cells cannot run as formulas", () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell("+91 555"), `"'+91 555"`);
  assert.equal(csvCell("Plain"), '"Plain"');
  assert.equal(csvCell(null), '""');
});

test("order emails escape store and shopper text and link only https tracking", () => {
  const base = {
    storeName: "<b>Shop</b>", orderNumber: "abc", customerName: "<script>x</script>", currency: "INR",
    items: [{ name: "<img src=x>", variant: "", quantity: 1, lineTotal: 10 }], subtotal: 10, discount: 0, shipping: null,
    tax: 0, taxLabel: "Tax", taxInclusive: false, total: 10, paymentMethod: "cod" as const,
    trackingCarrier: "", trackingNumber: "T1", trackingUrl: "javascript:alert(1)", refundedTotal: 0,
  };
  const shipped = renderOrderEmail("shipped", base);
  assert.equal(shipped.html.includes("<script>"), false);
  assert.equal(shipped.html.includes("<img src=x>"), false);
  assert.equal(shipped.html.includes("<b>Shop"), false);
  assert.equal(shipped.html.includes("javascript:"), false);
  assert.match(renderOrderEmail("shipped", { ...base, trackingUrl: "https://track.example/1" }).html, /https:\/\/track\.example\/1/);
  // No button appears when there is nothing to click.
  assert.equal(renderOrderEmail("paid", base).html.includes("If the button does not work"), false);
});
