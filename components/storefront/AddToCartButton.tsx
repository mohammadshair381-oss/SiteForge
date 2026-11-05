"use client";

import Link from "next/link";
import { useState } from "react";
import { cartErrorMessage } from "./shopping-messages";
import { notifyCartUpdated } from "@/lib/cart-events";
import { readableOn } from "./commerce/skins";
import { MAX_QUANTITY_PER_LINE } from "@/lib/inventory-rules";

/**
 * Add-to-cart control for the public product page. The request carries only
 * the product id and quantity; the server resolves the store from the Host
 * header and prices the item itself.
 */
export default function AddToCartButton({
  businessId,
  productId,
  variantId,
  inStock,
  color,
  buttonClass,
  inputClass,
}: {
  businessId: string;
  productId: string;
  /** Chosen variant of a variant product. */
  variantId?: string;
  inStock: boolean;
  color: string;
  /** The theme's button shape and type (storefront skin); styling only. */
  buttonClass?: string;
  /** The theme's field style (dark themes must not get a white box). */
  inputClass?: string;
}) {
  const [quantity, setQuantity] = useState(1);
  const [state, setState] = useState<"idle" | "adding" | "added">("idle");
  const [error, setError] = useState<string | null>(null);

  if (!inStock) {
    return (
      <p className="rounded-xl bg-slate-100 px-4 py-3 text-sm font-medium text-slate-600">
        Out of stock. {variantId ? "Choose another option, or check back later." : "Please check back later."}
      </p>
    );
  }

  async function add() {
    if (state === "adding") return;
    setState("adding");
    setError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/cart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, ...(variantId ? { variantId } : {}), quantity }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(cartErrorMessage(data.code, data.error));
        setState("idle");
        return;
      }
      setState("added");
      setQuantity(1);
      notifyCartUpdated();
    } catch {
      setError("Network error. The item was not added — please try again.");
      setState("idle");
    }
  }

  // A fixed per-line cap: the real stock is never sent to the browser; the
  // server rejects quantities it cannot fill.
  const max = MAX_QUANTITY_PER_LINE;
  const change = (next: number) => {
    setQuantity(Number.isFinite(next) ? Math.min(Math.max(Math.floor(next), 1), max) : 1);
    setError(null);
    if (state === "added") setState("idle");
  };
  const field = inputClass ?? "rounded-lg border border-slate-300 bg-white text-slate-900";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <p id={`${productId}-qty`} className="text-sm font-medium">Quantity</p>
          <div role="group" aria-labelledby={`${productId}-qty`} className="mt-1 flex items-center gap-1">
            <button type="button" aria-label="One fewer" disabled={quantity <= 1} onClick={() => change(quantity - 1)} className={`h-11 w-11 text-lg font-semibold disabled:opacity-40 ${field}`}>−</button>
            <input
              type="number"
              inputMode="numeric"
              aria-label="Quantity"
              min={1}
              max={max}
              step={1}
              value={quantity}
              onChange={(e) => change(Number(e.target.value))}
              className={`h-11 w-16 px-1 text-center text-base sm:text-sm ${field}`}
            />
            <button type="button" aria-label="One more" disabled={quantity >= max} onClick={() => change(quantity + 1)} className={`h-11 w-11 text-lg font-semibold disabled:opacity-40 ${field}`}>+</button>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void add()}
          disabled={state === "adding"}
          className={`${buttonClass ? `font-semibold ${buttonClass}` : "rounded-xl font-semibold"} min-h-11 px-6 py-2.5 shadow-sm transition hover:opacity-90 motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-60`}
          style={{ background: color, color: readableOn(color) }}
        >
          {state === "adding" ? "Adding…" : "Add to cart"}
        </button>
      </div>
      {state === "added" && (
        <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
          Added to your cart.{" "}
          <Link href="/cart" className="font-semibold underline">
            View cart and check out
          </Link>
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}
