"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiErrorFrom, fieldErrorId, invalidProps } from "@/lib/api-errors";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatPrice } from "@/lib/format";
import { cartErrorMessage } from "./shopping-messages";
import { notifyCartUpdated } from "@/lib/cart-events";

interface CartItem {
  product: string;
  variant?: string;
  variantLabel?: string;
  quantity: number;
  priceSnapshot: number;
  currency: string;
}

/** What the server says each line means now (lib/cart/lines.ts). Never a stock count. */
interface CartLine {
  key: string;
  product: string;
  variant: string;
  name: string;
  slug: string;
  imageUrl: string;
  variantLabel: string;
  quantity: number;
  unitPrice: number;
  currency: string;
  status: "ok" | "insufficient_stock" | "out_of_stock" | "unavailable";
  priceChanged: boolean;
}

/** A few products of this store, offered when the cart is empty. Display only. */
export interface CatalogEntry {
  id: string;
  name: string;
  slug: string;
  price: number;
  currency: string;
  imageUrl: string;
}

/**
 * The shopper's storefront account as seen by the server when the page was
 * rendered (null while customer accounts are disabled). Display only: the
 * checkout API re-checks the session and the store's COD setting.
 */
export type CheckoutAccount =
  | { status: "signed_in"; name: string; email: string }
  | { status: "signed_out" | "unverified" }
  | null;

export interface SavedAddress {
  id: string;
  label: string;
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone: string;
  isDefault: boolean;
}

type PaymentChoice = "store" | "cod" | "online";

/** Server-computed preview (POST /cart/quote); checkout recomputes it. */
interface Quote {
  currency: string;
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  taxTotal?: number;
  taxLabel?: string;
  taxInclusive?: boolean;
  total: number;
  coupon: { code: string; description: string } | null;
  couponError: { code: string; message: string } | null;
  shipping: {
    enabled: boolean;
    flatRate: number;
    freeOver: number | null;
    requireAddress: boolean;
    deliveryInfo: string;
    deliverable?: boolean;
    refusal?: string | null;
    awaitingAddress?: boolean;
    zoneName?: string | null;
    codAvailable?: boolean;
    codRefusal?: "amount" | "area" | null;
    codMaxOrder?: number | null;
    freeShipping?: { threshold: number; remaining: number } | null;
    minOrderShortfall?: number;
    deliveryAreas?: string[];
  };
}

// Base size on phones stops the page zooming when a field gets focus.
const CHECKOUT_INPUT = "sf-acc-input sf-acc-control mt-1 block w-full min-h-11 px-3 py-2 text-base aria-[invalid=true]:border-red-500 sm:text-sm";
const STEPPER_BUTTON = "sf-acc-secondary sf-acc-control sf-acc-focus inline-flex h-11 w-11 items-center justify-center text-lg font-semibold focus-visible:outline-none disabled:opacity-40";

const LINE_PROBLEM: Record<Exclude<CartLine["status"], "ok">, string> = {
  insufficient_stock: "There aren't enough of these left for this quantity. Lower it to check out.",
  out_of_stock: "Out of stock. Remove it to check out.",
  unavailable: "No longer available. Remove it to check out.",
};

/** One field's message, in the store's own look: this page never takes platform styling. */
function CheckoutFieldError({ name, fields }: { name: string; fields: Record<string, string> }) {
  if (!fields[name]) return null;
  return (
    <span id={fieldErrorId("checkout", name)} className="sf-acc-error mt-1 block text-xs font-medium">
      {fields[name]}
    </span>
  );
}

const EMPTY_ADDRESS = { name: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "", phone: "" };
type Address = typeof EMPTY_ADDRESS;

const addressFrom = (saved: SavedAddress): Address => ({ name: saved.name, line1: saved.line1, line2: saved.line2, city: saved.city, region: saved.region, postalCode: saved.postalCode, country: saved.country, phone: saved.phone });
const savedAddressText = (saved: SavedAddress) => [saved.label, saved.name, saved.line1, saved.city, saved.postalCode].filter(Boolean).join(", ");

export default function CartCheckout({
  businessId,
  catalog,
  codOffered = false,
  guestCod = false,
  onlineOffered = false,
  account = null,
  savedAddresses = [],
}: {
  businessId: string;
  catalog: CatalogEntry[];
  codOffered?: boolean;
  /** The store also takes cash on delivery from guests (display only). */
  guestCod?: boolean;
  /** The store has a connected online-payment account (display only). */
  onlineOffered?: boolean;
  account?: CheckoutAccount;
  savedAddresses?: SavedAddress[];
}) {
  const router = useRouter();
  const signedIn = account?.status === "signed_in" ? account : null;
  const codSelectable = codOffered && (signedIn !== null || guestCod);
  const defaultAddress = savedAddresses.find((a) => a.isDefault) ?? savedAddresses[0] ?? null;
  const [items, setItems] = useState<CartItem[] | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyProduct, setBusyProduct] = useState<string | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [name, setName] = useState(signedIn?.name ?? "");
  const [email, setEmail] = useState(signedIn?.email ?? "");
  const [payment, setPayment] = useState<PaymentChoice>(onlineOffered ? "online" : codSelectable ? "cod" : "store");
  const [placing, setPlacing] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutFields, setCheckoutFields] = useState<Record<string, string>>({});
  const [couponInput, setCouponInput] = useState("");
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [couponMessage, setCouponMessage] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [address, setAddress] = useState<Address>(defaultAddress ? addressFrom(defaultAddress) : { ...EMPTY_ADDRESS, name: signedIn?.name ?? "" });
  const [savedChoice, setSavedChoice] = useState<string>(defaultAddress?.id ?? "");
  const [saveAddress, setSaveAddress] = useState(false);
  const destinationRef = useRef({ country: address.country, region: address.region, postalCode: address.postalCode });
  // One idempotency key per checkout attempt: a double click or a retry after a
  // network failure returns the same order instead of creating a second one.
  const idempotencyKey = useRef<string | null>(null);

  const applyCart = useCallback((data: { items?: CartItem[]; lines?: CartLine[]; notices?: string[] }) => {
    setItems(data.items ?? []);
    setLines(data.lines ?? []);
    if (data.notices && data.notices.length > 0) setNotices(data.notices);
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/cart?consumeNotices=1`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(cartErrorMessage(data.code, data.error));
      applyCart(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load your cart.");
    }
  }, [businessId, applyCart]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshQuote = useCallback(async (code: string | null): Promise<Quote | null> => {
    try {
      const res = await fetch(`/api/businesses/${businessId}/cart/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The destination decides the delivery charge; only these parts are sent.
        body: JSON.stringify({ ...(code ? { couponCode: code } : {}), address: destinationRef.current }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) return null;
      setQuote(data as Quote);
      return data as Quote;
    } catch {
      return null;
    }
  }, [businessId]);

  // The delivery charge follows the address, shortly after the shopper stops typing.
  useEffect(() => {
    destinationRef.current = { country: address.country, region: address.region, postalCode: address.postalCode };
    if (!items || items.length === 0) return;
    const timer = window.setTimeout(() => void refreshQuote(appliedCode), 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address.country, address.region, address.postalCode]);

  // Cash on delivery can stop being available for this address or order size.
  useEffect(() => {
    if (payment === "cod" && quote?.shipping.codAvailable === false) setPayment(onlineOffered ? "online" : "store");
  }, [payment, quote?.shipping.codAvailable, onlineOffered]);

  // Re-price whenever the cart changes (keeps the applied coupon).
  useEffect(() => {
    if (items && items.length > 0) void refreshQuote(appliedCode);
  }, [items, appliedCode, refreshQuote]);

  async function applyCoupon(event: React.FormEvent) {
    event.preventDefault();
    const code = couponInput.trim();
    if (!code) return;
    setCouponMessage(null);
    const result = await refreshQuote(code);
    if (!result) {
      setCouponMessage("Could not check the code. Try again.");
    } else if (result.couponError) {
      setCouponMessage(result.couponError.message);
      setAppliedCode(null);
      await refreshQuote(null);
    } else if (result.coupon) {
      setAppliedCode(result.coupon.code);
      setCouponInput("");
      idempotencyKey.current = null; // different total: a new attempt
    }
  }

  function removeCoupon() {
    setAppliedCode(null);
    setCouponMessage(null);
    idempotencyKey.current = null;
  }

  async function mutate(key: string, init: RequestInit, url = `/api/businesses/${businessId}/cart`) {
    setBusyProduct(key);
    setItemError(null);
    idempotencyKey.current = null; // cart contents changed: a new attempt
    try {
      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setItemError(cartErrorMessage(data.code, data.error));
        return;
      }
      applyCart(data);
      notifyCartUpdated();
    } catch {
      setItemError("Network error. Your cart was not changed.");
    } finally {
      setBusyProduct(null);
    }
  }

  function setQuantity(line: CartLine, quantity: number) {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity === line.quantity) return;
    void mutate(line.key, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: line.product, variantId: line.variant || undefined, quantity }),
    });
  }

  function remove(line: CartLine) {
    const variantQuery = line.variant ? `&variantId=${encodeURIComponent(line.variant)}` : "";
    void mutate(line.key, { method: "DELETE" }, `/api/businesses/${businessId}/cart?productId=${encodeURIComponent(line.product)}${variantQuery}`);
  }

  function chooseSavedAddress(id: string) {
    setSavedChoice(id);
    const saved = savedAddresses.find((a) => a.id === id);
    setAddress(saved ? addressFrom(saved) : { ...EMPTY_ADDRESS, name: signedIn?.name ?? "" });
    setCheckoutFields({});
  }

  async function startPayment(orderId: string, orderProof?: string): Promise<string | null> {
    try {
      const res = await fetch(`/api/storefront/orders/${orderId}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(orderProof ? { "x-order-proof": orderProof } : {}) },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      return res.ok && typeof data.url === "string" && data.url.startsWith("https://") ? data.url : null;
    } catch {
      return null;
    }
  }

  const guestPayingCash = payment === "cod" && signedIn === null;
  const needsAddress = quote?.shipping.requireAddress === true || guestPayingCash;

  async function placeOrder(event: React.FormEvent) {
    event.preventDefault();
    if (placing) return;
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const problems: Record<string, string> = {};
    if (!trimmedName) problems.customerName = "Enter your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) problems.customerEmail = "Enter a valid email address.";
    // The recipient defaults to the person ordering.
    const delivery = { ...address, name: address.name.trim() || trimmedName };
    if (needsAddress) {
      if (!delivery.name.trim()) problems["shippingAddress.name"] = "Enter who the order is for.";
      if (!address.line1.trim()) problems["shippingAddress.line1"] = "Enter the address.";
      if (!address.city.trim()) problems["shippingAddress.city"] = "Enter the city.";
      if (!address.postalCode.trim()) problems["shippingAddress.postalCode"] = "Enter the postal code.";
      if (!address.country.trim()) problems["shippingAddress.country"] = "Enter the country.";
      if (guestPayingCash && address.phone.replace(/\D/g, "").length < 7) problems["shippingAddress.phone"] = "Enter a phone number so the store can confirm your delivery.";
    }
    setCheckoutFields(problems);
    if (Object.keys(problems).length > 0) {
      setCheckoutError("Please correct the highlighted fields.");
      return;
    }
    setPlacing(true);
    setCheckoutError(null);
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const res = await fetch(`/api/businesses/${businessId}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: trimmedName,
          customerEmail: trimmedEmail,
          idempotencyKey: idempotencyKey.current,
          ...(payment !== "store" ? { paymentMethod: payment } : {}),
          ...(appliedCode ? { couponCode: appliedCode } : {}),
          ...(needsAddress ? { shippingAddress: delivery } : {}),
          ...(needsAddress && signedIn && saveAddress ? { saveAddress: true } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Validation errors keep the key (same request, retry is safe); anything
        // that changes the cart requires a fresh attempt.
        if (data.code !== "invalid_customer_name" && data.code !== "invalid_customer_email" && data.code !== "invalid_shipping_address") {
          idempotencyKey.current = null;
          void load();
        }
        // A coupon that stopped applying (e.g. fully used meanwhile) is removed.
        if (typeof data.code === "string" && data.code.startsWith("coupon_")) {
          setAppliedCode(null);
          setCouponMessage(cartErrorMessage(data.code, data.error));
        }
        const fields: Record<string, string> = { ...apiErrorFrom(data, "").fields };
        if (data.code === "invalid_customer_name") fields.customerName = cartErrorMessage(data.code, data.error);
        if (data.code === "invalid_customer_email") fields.customerEmail = cartErrorMessage(data.code, data.error);
        setCheckoutFields(fields);
        setCheckoutError(Object.keys(fields).length > 0 ? "Please correct the highlighted fields." : cartErrorMessage(data.code, data.error));
        return;
      }
      // The cart was checked out; refresh the header count.
      notifyCartUpdated();
      // The server set an httpOnly order-access cookie; the order page uses it.
      if (payment === "online") {
        const url = await startPayment(data.orderId, data.orderProof);
        // Off to the payment provider's hosted page. If starting the payment
        // failed, the order page offers "Pay now" again.
        if (url) {
          window.location.assign(url);
          return;
        }
      }
      router.push(`/order/${data.orderId}`);
    } catch {
      // Keep the key: if the order was created, the retry returns it.
      setCheckoutError("Network error. Please try again — you will not be charged twice or get a duplicate order.");
    } finally {
      setPlacing(false);
    }
  }

  if (loadError) {
    return (
      <div role="alert" className="sf-acc-card p-8 text-center">
        <p className="sf-acc-muted">{loadError}</p>
        <button type="button" onClick={() => void load()} className="sf-acc-secondary sf-acc-control sf-acc-focus mt-4 min-h-11 px-4 py-2 text-sm font-medium focus-visible:outline-none">
          Try again
        </button>
      </div>
    );
  }

  if (items === null) {
    return <p className="sf-acc-muted py-10 text-center">Loading your cart…</p>;
  }

  if (items.length === 0) {
    const suggestions = catalog.slice(0, 3);
    return (
      <div className="space-y-6">
        {notices.length > 0 && <CartNotices notices={notices} />}
        <div className="sf-acc-card p-8 text-center sm:p-10">
          <h2 className="sf-acc-title font-display text-xl">Your cart is empty</h2>
          <p className="sf-acc-muted mx-auto mt-2 max-w-md">Browse the store and add something you like. Your cart stays here for your next visit.</p>
          <Link href="/products" className="sf-acc-action sf-acc-control sf-acc-focus mt-6 inline-flex min-h-11 items-center px-5 py-2.5 font-semibold focus-visible:outline-none">
            Continue shopping
          </Link>
          {account?.status === "signed_out" && (
            <p className="sf-acc-muted mt-4 text-sm">
              Have an account?{" "}
              <Link href="/account/login?next=%2Fcart" className="font-semibold underline">Sign in</Link> to see the cart saved to it.
            </p>
          )}
        </div>
        {suggestions.length > 0 && (
          <section aria-labelledby="cart-suggestions">
            <h2 id="cart-suggestions" className="sf-acc-title font-display text-lg">From this store</h2>
            <ul className="mt-3 grid gap-3 sm:grid-cols-3">
              {suggestions.map((entry) => (
                <li key={entry.id}>
                  <Link href={`/product/${entry.slug}`} className="sf-acc-card sf-acc-focus flex items-center gap-3 p-3 focus-visible:outline-none">
                    {entry.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={entry.imageUrl} alt="" loading="lazy" className="sf-acc-control h-14 w-14 shrink-0 object-cover" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{entry.name}</span>
                      <span className="sf-acc-muted block text-sm">{formatPrice(entry.price, entry.currency)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  const currency = lines[0]?.currency || items[0]?.currency || "USD";
  const blocked = lines.filter((line) => line.status !== "ok");
  // Display estimate at current prices, until the server's breakdown arrives.
  const estimate = lines.reduce((sum, line) => (line.status === "unavailable" ? sum : sum + line.unitPrice * line.quantity), 0);
  const shownTotal = quote ? quote.total : estimate;
  const shownCurrency = quote?.currency ?? currency;
  const free = quote?.shipping.enabled ? quote.shipping.freeShipping ?? null : null;

  return (
    <div className="space-y-6">
      {notices.length > 0 && <CartNotices notices={notices} />}

      {/* On phones the summary sits below the items: this gets there in one tap. */}
      <p className="sf-acc-card flex items-center justify-between gap-3 p-4 lg:hidden">
        <span className="font-semibold">Total {formatPrice(shownTotal, shownCurrency)}</span>
        <a href="#checkout" className="sf-acc-action sf-acc-control sf-acc-focus inline-flex min-h-11 items-center px-4 py-2 text-sm font-semibold focus-visible:outline-none">Go to checkout</a>
      </p>

      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <section aria-labelledby="cart-items" className="sf-acc-card h-fit">
          <h2 id="cart-items" className="sf-acc-rule sf-acc-title border-b px-5 py-4 font-display text-lg">Items</h2>
          {itemError && <p role="alert" className="mx-5 mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{itemError}</p>}
          <ul className="sf-acc-divide divide-y">
            {lines.map((line) => {
              const busy = busyProduct === line.key;
              const saved = items.find((item) => item.product === line.product && (item.variant ?? "") === line.variant);
              const canBuy = line.status !== "unavailable";
              return (
                <li key={line.key} className="flex flex-wrap items-start gap-4 px-5 py-4">
                  {line.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={line.imageUrl} alt="" loading="lazy" className="sf-acc-control h-16 w-16 shrink-0 object-cover" />
                  ) : null}
                  <div className="min-w-0 flex-1 basis-40">
                    {line.slug ? (
                      <Link href={`/product/${line.slug}`} className="font-semibold hover:underline">{line.name}</Link>
                    ) : (
                      <p className="sf-acc-muted font-semibold">{line.name || "Item no longer available"}</p>
                    )}
                    {line.variantLabel && <p className="sf-acc-muted text-sm">{line.variantLabel}</p>}
                    {canBuy && (
                      <p className="sf-acc-muted text-sm">
                        {formatPrice(line.unitPrice, line.currency)}
                        {line.priceChanged && saved ? ` (changed from ${formatPrice(saved.priceSnapshot, saved.currency)})` : ""}
                      </p>
                    )}
                    {line.status !== "ok" && <p className="sf-acc-error mt-1 text-sm font-medium">{LINE_PROBLEM[line.status]}</p>}
                  </div>
                  <div className="flex items-center gap-3">
                    {canBuy && (
                      <div className="flex items-center gap-1" role="group" aria-label={`Quantity of ${line.name}`}>
                        <button type="button" disabled={busy || line.quantity <= 1} onClick={() => setQuantity(line, line.quantity - 1)} aria-label="One fewer" className={STEPPER_BUTTON}>−</button>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          inputMode="numeric"
                          defaultValue={line.quantity}
                          key={`${line.key}-${line.quantity}`}
                          disabled={busy}
                          aria-label="Quantity"
                          onBlur={(e) => setQuantity(line, Math.floor(Number(e.target.value)))}
                          className="sf-acc-input sf-acc-control h-11 w-14 px-1 text-center text-base sm:text-sm"
                        />
                        <button type="button" disabled={busy || line.status !== "ok"} onClick={() => setQuantity(line, line.quantity + 1)} aria-label="One more" className={STEPPER_BUTTON}>+</button>
                      </div>
                    )}
                    <button type="button" disabled={busy} onClick={() => remove(line)} className="sf-acc-error min-h-11 text-sm font-medium hover:underline disabled:opacity-50">
                      {busy ? "Updating…" : "Remove"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section id="checkout" aria-labelledby="checkout-title" className="sf-acc-card h-fit scroll-mt-24 p-5">
          <h2 id="checkout-title" className="sf-acc-title font-display text-lg">Checkout</h2>
          <dl className="mt-3 space-y-1.5 text-sm" aria-live="polite">
            <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatPrice(quote ? quote.subtotal : estimate, shownCurrency)}</dd></div>
            {quote && quote.discountTotal > 0 && (
              <div className="flex justify-between font-medium"><dt>Discount ({quote.coupon?.code})</dt><dd>−{formatPrice(quote.discountTotal, quote.currency)}</dd></div>
            )}
            {quote?.shipping.enabled && (
              <div className="flex justify-between gap-3">
                <dt>Shipping{quote.shipping.zoneName ? ` (${quote.shipping.zoneName})` : ""}</dt>
                <dd className="text-right">{quote.shipping.awaitingAddress ? "Calculated from your address" : quote.shippingTotal === 0 ? "Free" : formatPrice(quote.shippingTotal, quote.currency)}</dd>
              </div>
            )}
            {quote && Number(quote.taxTotal ?? 0) > 0 && (
              <div className="flex justify-between">
                <dt>{quote.taxInclusive ? `Includes ${quote.taxLabel}` : quote.taxLabel}</dt>
                <dd>{formatPrice(Number(quote.taxTotal), quote.currency)}</dd>
              </div>
            )}
            <div className="sf-acc-rule flex justify-between border-t pt-1.5 text-base"><dt className="font-semibold">Total</dt><dd className="font-bold">{formatPrice(shownTotal, shownCurrency)}</dd></div>
          </dl>

          {free && free.remaining > 0 && (
            <div className="mt-3">
              <p className="text-sm font-medium">Add {formatPrice(free.remaining, shownCurrency)} more for free shipping.</p>
              <div aria-hidden="true" className="mt-1.5 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--acc-line, currentColor)", opacity: 0.9 }}>
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.round(((free.threshold - free.remaining) / Math.max(free.threshold, 1)) * 100))}%`, background: "var(--sf-accent, currentColor)" }} />
              </div>
            </div>
          )}
          {free && free.remaining === 0 && <p className="mt-3 text-sm font-medium">This order qualifies for free shipping.</p>}
          {quote?.shipping.deliveryInfo && <p className="sf-acc-muted mt-2 text-xs">Delivery: {quote.shipping.deliveryInfo}</p>}
          {quote?.shipping.refusal && (
            <div role="alert" className="sf-acc-error mt-2 text-sm font-medium">
              <p>{quote.shipping.refusal}</p>
              {Number(quote.shipping.minOrderShortfall ?? 0) > 0 && <p className="mt-0.5 font-normal">Add {formatPrice(Number(quote.shipping.minOrderShortfall), quote.currency)} more to order.</p>}
              {(quote.shipping.deliveryAreas?.length ?? 0) > 0 && <p className="mt-0.5 font-normal">This store delivers to: {quote.shipping.deliveryAreas?.join(", ")}.</p>}
            </div>
          )}
          <p className="sf-acc-muted mt-1 text-xs">The total is confirmed when you place the order.</p>

          <form onSubmit={applyCoupon} className="mt-4">
            {appliedCode ? (
              <p className="flex items-center justify-between rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
                <span>Code <strong>{appliedCode}</strong> applied{quote?.coupon?.description ? ` — ${quote.coupon.description}` : ""}</span>
                <button type="button" onClick={removeCoupon} className="font-semibold underline">Remove</button>
              </p>
            ) : (
              <div className="flex gap-2">
                <label className="flex-1 text-sm">
                  <span className="sr-only">Discount code</span>
                  <input value={couponInput} onChange={(e) => setCouponInput(e.target.value)} maxLength={32} placeholder="Discount code" autoComplete="off" className="sf-acc-input sf-acc-control block min-h-11 w-full px-3 py-2 text-base uppercase sm:text-sm" />
                </label>
                <button type="submit" className="sf-acc-secondary sf-acc-control sf-acc-focus min-h-11 px-3 py-2 text-sm font-semibold focus-visible:outline-none">Apply</button>
              </div>
            )}
            {couponMessage && <p role="alert" className="sf-acc-error mt-1 text-xs">{couponMessage}</p>}
          </form>

          {blocked.length > 0 ? (
            <p role="status" className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              {blocked.length === 1 ? "One item needs" : `${blocked.length} items need`} your attention before you can check out. See the messages beside them.
            </p>
          ) : (
            <form onSubmit={placeOrder} className="mt-5 space-y-3" noValidate>
              <label className="block text-sm font-medium">
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="name" required className={CHECKOUT_INPUT} {...invalidProps(checkoutFields, "customerName", "checkout")} />
                <CheckoutFieldError name="customerName" fields={checkoutFields} />
              </label>
              <label className="block text-sm font-medium">
                Email
                <input
                  type="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={254}
                  autoComplete="email"
                  required
                  readOnly={signedIn !== null}
                  aria-invalid={checkoutFields.customerEmail ? true : undefined}
                  aria-describedby={checkoutFields.customerEmail ? fieldErrorId("checkout", "customerEmail") : signedIn ? "checkout-account-note" : undefined}
                  className={`${CHECKOUT_INPUT} read-only:opacity-75`}
                />
                <CheckoutFieldError name="customerEmail" fields={checkoutFields} />
              </label>
              {signedIn ? (
                <p id="checkout-account-note" className="sf-acc-muted text-xs">
                  Signed in: this order will be saved to your account.
                </p>
              ) : (
                account?.status === "signed_out" && (
                  <p className="sf-acc-muted text-xs">
                    No account needed. <Link href="/account/login?next=%2Fcart" className="font-semibold underline">Sign in</Link> to use your saved addresses and see this order in your account.
                  </p>
                )
              )}

              {needsAddress && (
                <fieldset className="sf-acc-rule sf-acc-control space-y-2 border p-3">
                  <legend className="px-1 text-sm font-semibold">Delivery address</legend>
                  {signedIn && savedAddresses.length > 0 && (
                    <label className="block text-sm font-medium">
                      Saved addresses
                      <select value={savedChoice} onChange={(e) => chooseSavedAddress(e.target.value)} className={CHECKOUT_INPUT}>
                        {savedAddresses.map((saved) => <option key={saved.id} value={saved.id}>{savedAddressText(saved)}</option>)}
                        <option value="">A new address</option>
                      </select>
                    </label>
                  )}
                  {([
                    ["name", "Recipient (if not you)", "name", false, "text"],
                    ["line1", "Address", "address-line1", true, "text"],
                    ["line2", "Apartment, suite (optional)", "address-line2", false, "text"],
                    ["city", "City", "address-level2", true, "text"],
                    ["region", "State / region (optional)", "address-level1", false, "text"],
                    ["postalCode", "Postal code", "postal-code", true, "text"],
                    ["country", "Country", "country-name", true, "text"],
                    ["phone", guestPayingCash ? "Phone" : "Phone (optional)", "tel", guestPayingCash, "tel"],
                  ] as const).map(([key, label, autoComplete, required, type]) => (
                    <label key={key} className="block text-sm font-medium">
                      {label}
                      <input
                        type={type}
                        value={address[key]}
                        onChange={(e) => {
                          setAddress((a) => ({ ...a, [key]: e.target.value }));
                          if (savedChoice) setSavedChoice("");
                        }}
                        autoComplete={autoComplete}
                        required={required}
                        maxLength={key === "line1" || key === "line2" ? 160 : 100}
                        className={CHECKOUT_INPUT}
                        {...invalidProps(checkoutFields, `shippingAddress.${key}`, "checkout")}
                      />
                      <CheckoutFieldError name={`shippingAddress.${key}`} fields={checkoutFields} />
                    </label>
                  ))}
                  {signedIn && !savedChoice && (
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input type="checkbox" checked={saveAddress} onChange={(e) => setSaveAddress(e.target.checked)} className="h-4 w-4" />
                      Save this address to my account
                    </label>
                  )}
                </fieldset>
              )}

              {(codOffered || onlineOffered) && (
                <fieldset className="sf-acc-rule sf-acc-control space-y-2 border p-3">
                  <legend className="px-1 text-sm font-semibold">Payment</legend>
                  {onlineOffered && (
                    <label className="flex min-h-11 items-start gap-2 text-sm">
                      <input type="radio" name="payment" value="online" checked={payment === "online"} onChange={() => setPayment("online")} className="mt-1" />
                      <span>
                        <span className="font-medium">Pay online</span>
                        <span className="sf-acc-muted block text-xs">
                          Card, UPI or netbanking on the secure Razorpay payment page. Your order is confirmed once the payment is verified.
                        </span>
                      </span>
                    </label>
                  )}
                  {codOffered && (
                    <label className="flex min-h-11 items-start gap-2 text-sm">
                      <input
                        type="radio"
                        name="payment"
                        value="cod"
                        checked={payment === "cod"}
                        disabled={!codSelectable || quote?.shipping.codAvailable === false}
                        onChange={() => setPayment("cod")}
                        className="mt-1"
                      />
                      <span>
                        <span className="font-medium">Cash on delivery</span>
                        <span className="sf-acc-muted block text-xs">
                          {quote?.shipping.codRefusal === "amount" && typeof quote.shipping.codMaxOrder === "number"
                            ? `Not available for orders over ${formatPrice(quote.shipping.codMaxOrder, quote.currency)}.`
                            : quote?.shipping.codRefusal === "area"
                              ? "Not available for this delivery address."
                              : guestCod && !signedIn
                                ? "Pay when your order arrives. No account needed: we ask for your phone number and address so the store can confirm your delivery."
                                : guestCod
                                  ? "Pay when your order arrives."
                                  : "Pay when your order arrives. Requires a confirmed account at this store."}
                        </span>
                      </span>
                    </label>
                  )}
                  <label className="flex min-h-11 items-start gap-2 text-sm">
                    <input type="radio" name="payment" value="store" checked={payment === "store"} onChange={() => setPayment("store")} className="mt-1" />
                    <span>
                      <span className="font-medium">Arrange payment with the store</span>
                      <span className="sf-acc-muted block text-xs">Items are reserved for 30 minutes while the store contacts you.</span>
                    </span>
                  </label>
                  {codOffered && !codSelectable && (
                    <p className="sf-acc-muted rounded-lg px-1 py-2 text-xs">
                      {account?.status === "unverified" ? (
                        <>Confirm your email address to use cash on delivery.</>
                      ) : (
                        <>
                          <Link href="/account/login?next=%2Fcart" className="font-semibold underline">
                            Sign in
                          </Link>{" "}
                          or{" "}
                          <Link href="/account/register" className="font-semibold underline">
                            create an account
                          </Link>{" "}
                          to pay with cash on delivery.
                        </>
                      )}
                    </p>
                  )}
                </fieldset>
              )}

              {checkoutError && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{checkoutError}</p>}
              <button type="submit" disabled={placing || busyProduct !== null || quote?.shipping.deliverable === false} aria-busy={placing} className="sf-acc-action sf-acc-control sf-acc-focus min-h-12 w-full px-5 py-3 font-semibold focus-visible:outline-none disabled:opacity-60">
                {placing
                  ? "Placing order…"
                  : payment === "cod"
                    ? "Place order (cash on delivery)"
                    : payment === "online"
                      ? "Place order and pay"
                      : "Place order"}
              </button>
              <p className="sf-acc-muted text-xs">
                {guestPayingCash
                  ? "No payment is taken online. You pay in cash when the order is delivered. The store confirms your order first, and your items are held for up to 7 days until it does."
                  : payment === "cod"
                    ? "No payment is taken online. You pay in cash when the order is delivered."
                    : payment === "online"
                      ? "You will be sent to Razorpay to pay. Items are reserved for 30 minutes; unpaid orders are released after that."
                      : "No payment is taken online. Your items are reserved for 30 minutes while the store arranges payment with you."}
              </p>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}

function CartNotices({ notices }: { notices: string[] }) {
  return (
    <div role="status" className="sf-acc-card p-4 text-sm">
      <p className="font-semibold">Your cart was updated</p>
      <ul className="sf-acc-muted mt-1 list-disc space-y-0.5 pl-5">
        {notices.map((notice) => <li key={notice}>{notice}</li>)}
      </ul>
    </div>
  );
}
