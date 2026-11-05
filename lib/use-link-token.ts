"use client";

import { useEffect, useState } from "react";

/**
 * Reads the one-time token of an emailed link, in the browser only.
 *
 * Links carry it after `#`, which browsers never send to a server, so it stays out
 * of request logs, proxies and referrers, and out of the page data a server would
 * otherwise render it into. Links sent before this change use `?token=`; those still
 * work. Either way it leaves the address bar as soon as it has been read.
 *
 * `null` until the page is running in the browser, then the token or "".
 */
export function useLinkToken(): string | null {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const { hash, search, pathname } = window.location;
    const value = new URLSearchParams(hash.replace(/^#/, "")).get("token") ?? new URLSearchParams(search).get("token") ?? "";
    if (value) window.history.replaceState(null, "", pathname);
    setToken(value.trim().slice(0, 512));
  }, []);
  return token;
}
