"use client";

import { useState } from "react";

export default function PublishToggle({
  businessId,
  initialStatus,
  storefrontUrl,
}: {
  businessId: string;
  initialStatus: string;
  storefrontUrl?: string | null;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isPublished = status === "published";

  async function toggle() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publish: !isPublished }),
      });
      const data = (await res.json().catch(() => null)) as
        | { status?: string; error?: string }
        | null;
      if (!res.ok) {
        setError(data?.error ?? "Unable to update publishing");
        return;
      }
      setStatus(data?.status ?? (isPublished ? "draft" : "published"));
      setNotice(
        isPublished
          ? "Your storefront is now unpublished."
          : "Your storefront is now live.",
      );
    } catch {
      setError("Network error. Publishing was not changed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="sr-only" role="status" aria-live="polite">
        {notice ?? ""}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive">
        {error ?? ""}
      </div>

      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-slate-900">Publishing</h3>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${isPublished ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
          {isPublished ? "Published" : "Draft"}
        </span>
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        {isPublished
          ? "Customers can see your storefront right now."
          : "Your storefront is private until you publish it."}
      </p>

      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          onClick={toggle}
          disabled={loading}
          aria-pressed={isPublished}
          aria-busy={loading}
          className={`min-h-10 rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-60 ${
            isPublished
              ? "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
              : "bg-brand-600 text-white hover:bg-brand-700"
          }`}
        >
          {loading
            ? isPublished
              ? "Unpublishing…"
              : "Publishing…"
            : isPublished
              ? "Unpublish"
              : "Publish"}
        </button>
        {isPublished && storefrontUrl && (
          <a
            href={storefrontUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open live storefront in a new tab"
            className="inline-flex min-h-10 items-center justify-center gap-1 rounded-lg px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            View live site{" "}
            <span aria-hidden="true" className="text-base leading-none">
              ↗
            </span>
          </a>
        )}
      </div>

      {(error || notice) && (
        <div
          className={`mt-3 rounded-lg px-3 py-2 text-sm ${
            error ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800"
          }`}
        >
          {error ?? notice}
        </div>
      )}
    </div>
  );
}