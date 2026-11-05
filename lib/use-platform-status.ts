"use client";

import { useEffect, useState } from "react";
import type { PlatformStatus } from "@/lib/platform-status";

const REUSE_MS = 60 * 1000;
let last: { at: number; request: Promise<PlatformStatus | null> } | null = null;

function fetchStatus(): Promise<PlatformStatus | null> {
  if (last && Date.now() - last.at < REUSE_MS) return last.request;
  const request = fetch("/api/platform/status", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<PlatformStatus>) : null))
    .catch(() => null);
  last = { at: Date.now(), request };
  return request;
}

/**
 * `undefined` while asking, `null` if the answer could not be read. Nothing is rendered from
 * it on the server, so it cannot cause a hydration mismatch. For display only: the server
 * still decides every action.
 */
export function usePlatformStatus(): PlatformStatus | null | undefined {
  const [status, setStatus] = useState<PlatformStatus | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void fetchStatus().then((result) => {
      if (active) setStatus(result);
    });
    return () => {
      active = false;
    };
  }, []);
  return status;
}
