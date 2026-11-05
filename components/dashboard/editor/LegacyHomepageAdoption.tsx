"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Surface";

/**
 * An older homepage moves into a page record the first time it is opened for
 * editing. The move is a same-origin POST rather than part of loading the page,
 * and it does not change what visitors see.
 */
export default function LegacyHomepageAdoption({ businessId, mode }: { businessId: string; mode?: string }) {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const adopt = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/homepage/adopt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.pageId) throw new Error(data.error || "Your homepage could not be prepared for editing.");
      const query = new URLSearchParams({ page: data.pageId, ...(mode === "store" ? { mode } : {}) });
      window.location.replace(`/dashboard/businesses/${businessId}/editor?${query}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your homepage could not be prepared for editing.");
    }
  }, [businessId, mode]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void adopt();
  }, [adopt]);

  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-xl font-semibold text-slate-900">Preparing your homepage for editing</h1>
      <p className="mt-2 text-sm leading-6 text-slate-600">Your homepage is moving into the editor, so you can save drafts and publish when you are ready. Your live store does not change.</p>
      {error && (
        <div className="mt-5 space-y-3 text-left">
          <Notice tone="danger" role="alert">{error}</Notice>
          <Button variant="secondary" onClick={() => void adopt()}>Try again</Button>
        </div>
      )}
    </div>
  );
}
