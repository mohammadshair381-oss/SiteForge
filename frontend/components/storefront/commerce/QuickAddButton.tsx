"use client";

import { useState } from "react";
import { notifyCartUpdated } from "@/lib/cart-events";
import { cartErrorMessage } from "../shopping-messages";

/**
 * Adds one unit through the existing cart API (business from the Host, cart
 * from the HttpOnly cookie; the server re-checks stock and price). Disabled
 * when the product is known to be out of stock, and in dashboard previews,
 * where there is no store cart.
 */
export default function QuickAddButton({
  businessId,
  productId,
  productName,
  outOfStock,
  preview,
  className,
  style,
}: {
  businessId: string;
  productId: string;
  productName: string;
  outOfStock: boolean;
  preview: boolean;
  className: string;
  style: React.CSSProperties;
}) {
  const [state, setState] = useState<"idle" | "adding" | "added" | "error">("idle");
  const [message, setMessage] = useState("");

  async function add() {
    if (state === "adding" || outOfStock || preview) return;
    setState("adding");
    setMessage("");
    try {
      const res = await fetch(`/api/businesses/${businessId}/cart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, quantity: 1 }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        setState("error");
        setMessage(cartErrorMessage(data.code, data.error));
        return;
      }
      setState("added");
      setMessage(`${productName} added to cart`);
      notifyCartUpdated();
      window.setTimeout(() => setState((s) => (s === "added" ? "idle" : s)), 2500);
    } catch {
      setState("error");
      setMessage("Network error");
    }
  }

  const label = outOfStock ? "Sold out" : state === "adding" ? "Adding…" : state === "added" ? "Added ✓" : "Add to cart";
  return (
    <div>
      <button
        type="button"
        onClick={() => void add()}
        disabled={outOfStock || preview || state === "adding"}
        aria-label={outOfStock ? `${productName} is sold out` : `Add ${productName} to cart`}
        className={`w-full px-3 py-2 text-sm font-semibold transition motion-safe:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
        style={style}
      >
        {/* A short pop confirms the add (off with reduced motion). */}
        <span key={state} className={state === "added" ? "sf-pop inline-block" : undefined}>{label}</span>
      </button>
      <p aria-live="polite" className="sr-only">{message}</p>
      {state === "error" && <p role="alert" className="mt-1 rounded bg-red-50 px-2 py-1 text-xs text-red-800">{message}</p>}
    </div>
  );
}
