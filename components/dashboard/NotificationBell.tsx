"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { focusRing } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";

const POLL_MS = 60 * 1000;

/**
 * The unread count in a store's header. It asks once a minute, and only while this tab is
 * in view. Hidden until the notification centre is switched on.
 */
export default function NotificationBell({ businessId }: { businessId: string }) {
  const [unread, setUnread] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    async function check() {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/businesses/${businessId}/notifications?summary=1`, { cache: "no-store" });
        const data = (await res.json().catch(() => null)) as { ready?: boolean; unread?: number } | null;
        if (active && res.ok && data?.ready) setUnread(data.unread ?? 0);
      } catch {
        // A missed check is harmless: the next one will catch up.
      }
    }
    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [businessId]);

  if (unread === null) return null;
  return (
    <Link
      href={`/dashboard/businesses/${businessId}/notifications`}
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      className={`relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 ${focusRing}`}
    >
      <Icon name="notifications" size={18} />
      {unread > 0 && (
        <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-red-600 px-1 text-[0.65rem] font-semibold leading-[1.1rem] text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
