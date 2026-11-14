"use client";

import { useCallback, useEffect, useState } from "react";

interface Reviewable {
  productId: string;
  productName: string;
  review: { status: "pending" | "approved" | "rejected"; rating: number } | null;
}

const STATUS_TEXT = {
  pending: "Thanks! Your review is waiting for the store's approval.",
  approved: "Your review is published.",
  rejected: "The store did not publish this review.",
} as const;

/**
 * Verified-purchase reviews for a PAID order. Ownership is proven by the
 * order-access cookie (the server checks it); reviews are moderated before
 * they appear on the store.
 */
export default function ReviewPanel({ orderId }: { orderId: string }) {
  const [items, setItems] = useState<Reviewable[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/storefront/orders/${orderId}/reviews`, { cache: "no-store" });
      if (res.ok) setItems((await res.json()).items);
    } catch {
      setError("We couldn't load your reviews. Please reload the page.");
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(productId: string) {
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/storefront/orders/${orderId}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, rating, title, body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Your review could not be sent.");
        return;
      }
      setOpen(null);
      setTitle("");
      setBody("");
      setRating(5);
      await load();
    } finally {
      setSending(false);
    }
  }

  if (!items || items.length === 0) return null;
  return (
    <section aria-labelledby="order-reviews" className="sf-acc-rule sf-acc-control mt-6 border p-4">
      <h2 id="order-reviews" className="text-sm font-semibold">Review your purchase</h2>
      <ul className="mt-3 space-y-3">
        {items.map((item) => (
          <li key={item.productId}>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium">{item.productName}</span>
              {item.review ? (
                <span className="sf-acc-muted text-xs">{STATUS_TEXT[item.review.status]}</span>
              ) : (
                <button type="button" aria-expanded={open === item.productId} onClick={() => setOpen(open === item.productId ? null : item.productId)} className="sf-acc-secondary sf-acc-control sf-acc-focus px-3 py-1.5 text-xs font-semibold focus-visible:outline-none">
                  Write a review
                </button>
              )}
            </div>
            {open === item.productId && (
              <form
                className="sf-acc-rule sf-acc-control mt-3 space-y-3 border p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit(item.productId);
                }}
              >
                <fieldset>
                  <legend className="text-sm font-medium">Rating</legend>
                  <div className="mt-1 flex gap-1">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <label key={n} className="cursor-pointer">
                        <input type="radio" name={`rating-${item.productId}`} value={n} checked={rating === n} onChange={() => setRating(n)} className="sr-only" />
                        <span aria-hidden="true" className={`text-2xl ${rating >= n ? "text-amber-500" : "sf-acc-muted opacity-40"}`}>★</span>
                        <span className="sr-only">{n} {n === 1 ? "star" : "stars"}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="block text-sm font-medium">
                  Title (optional)
                  <input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} className="sf-acc-input sf-acc-control mt-1 block w-full px-3 py-2" />
                </label>
                <label className="block text-sm font-medium">
                  Your review (optional)
                  <textarea value={body} maxLength={2000} rows={4} onChange={(e) => setBody(e.target.value)} className="sf-acc-input sf-acc-control mt-1 block w-full px-3 py-2" />
                </label>
                <p className="sf-acc-muted text-xs">Shown with your first name and last initial after the store approves it.</p>
                {error && <p role="alert" className="sf-acc-error text-sm">{error}</p>}
                <button type="submit" disabled={sending} className="sf-acc-action sf-acc-control sf-acc-focus px-4 py-2 text-sm font-semibold focus-visible:outline-none disabled:opacity-60">
                  {sending ? "Sending…" : "Send review"}
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
