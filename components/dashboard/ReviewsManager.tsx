"use client";

import { useCallback, useEffect, useState } from "react";
import ManagementPageHeader from "./ManagementPageHeader";
import type { ReviewView } from "@/lib/reviews";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Card, EmptyState, Notice, Skeleton } from "@/components/ui/Surface";

type Status = "pending" | "approved" | "rejected";
const TABS: Array<{ value: Status; label: string }> = [
  { value: "pending", label: "Waiting" },
  { value: "approved", label: "Published" },
  { value: "rejected", label: "Rejected" },
];

const EMPTY_COPY: Record<Status, { title: string; body: string }> = {
  pending: {
    title: "No reviews waiting",
    body: "When a customer with a paid order reviews a product, the review waits here until you publish it.",
  },
  approved: {
    title: "No published reviews",
    body: "Reviews you publish appear on your store, and your product ratings are worked out from them.",
  },
  rejected: {
    title: "No rejected reviews",
    body: "Reviews you reject stay here and are never shown on your store.",
  },
};

const segmentClass = (selected: boolean) =>
  `inline-flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
    selected ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
  }`;

/**
 * Review moderation. Only verified purchases can be reviewed; nothing is
 * public until approved. Review text is never edited by the business.
 */
export default function ReviewsManager({ businessId }: { businessId: string }) {
  const [status, setStatus] = useState<Status>("pending");
  const [reviews, setReviews] = useState<ReviewView[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setReviews(null);
    const res = await fetch(`/api/businesses/${businessId}/reviews?status=${status}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    setReviews(res.ok ? data.reviews : []);
  }, [businessId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function moderate(review: ReviewView, action: "approve" | "reject") {
    setBusy(review.id);
    try {
      const res = await fetch(`/api/businesses/${businessId}/reviews/${review.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error || "Could not update the review.");
        return;
      }
      setMessage(action === "approve" ? "Review published." : "Review rejected.");
      setReviews((list) => (list ?? []).filter((r) => r.id !== review.id));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Reviews"
        description="Reviews come only from customers with a paid order for the product. They appear on your store after you publish them; ratings are calculated from published reviews only."
      />
      <div className="ui-scroll-x flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-lg border bg-slate-100 p-0.5" role="tablist" aria-label="Review status">
        {TABS.map((tab) => (
          <button key={tab.value} type="button" role="tab" aria-selected={status === tab.value} onClick={() => setStatus(tab.value)} className={segmentClass(status === tab.value)}>
            {tab.label}
          </button>
        ))}
      </div>
      {message && (
        <Notice tone="info" role="status">
          {message}
        </Notice>
      )}
      {reviews === null ? (
        <Card>
          <p role="status" className="sr-only">Loading…</p>
          <ul aria-hidden="true" className="divide-y divide-slate-100">
            {Array.from({ length: 3 }, (_, index) => (
              <li key={index} className="space-y-2 px-4 py-5 sm:px-6">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </li>
            ))}
          </ul>
        </Card>
      ) : reviews.length === 0 ? (
        <EmptyState icon={<Icon name="reviews" size={20} />} title={EMPTY_COPY[status].title}>
          {EMPTY_COPY[status].body}
        </EmptyState>
      ) : (
        <Card as="section" aria-label="Reviews">
          <ul className="divide-y divide-slate-100">
            {reviews.map((r) => (
              <li key={r.id} className="px-4 py-5 sm:px-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 text-sm font-semibold text-slate-900">{r.productName ?? "Product"}</p>
                  <p className="text-sm tracking-wide text-amber-600" role="img" aria-label={`${r.rating} out of 5`}>
                    {"★".repeat(r.rating)}
                    <span className="text-slate-300">{"★".repeat(5 - r.rating)}</span>
                  </p>
                </div>
                {r.title && <p className="mt-2 font-medium text-slate-900">{r.title}</p>}
                {r.body && <p className="mt-1 max-w-2xl whitespace-pre-line text-sm leading-6 text-slate-700">{r.body}</p>}
                <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-xs text-slate-500">
                  <span>{r.authorName}</span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                    <Icon name="check" size={13} />
                    verified purchase
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{new Date(r.createdAt).toLocaleString()}</span>
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {r.status !== "approved" && (
                    <Button disabled={busy === r.id} onClick={() => void moderate(r, "approve")}>Publish</Button>
                  )}
                  {r.status !== "rejected" && (
                    <Button variant="secondary" disabled={busy === r.id} onClick={() => void moderate(r, "reject")}>{r.status === "approved" ? "Unpublish" : "Reject"}</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
