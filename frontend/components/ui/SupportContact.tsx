"use client";

import { usePlatformStatus } from "@/lib/use-platform-status";

/**
 * How to reach platform support, from the Super Admin's setting. With none set, it says who
 * to ask instead of showing an invented address. For platform pages only: a shopper's store
 * shows the store's own contact details, never SiteForge's.
 */
export default function SupportContact({ label = "Need help?", className = "" }: { label?: string; className?: string }) {
  const status = usePlatformStatus();
  if (status === undefined) return null;
  return (
    <p className={className}>
      {label}{" "}
      {status?.supportEmail ? (
        <a href={`mailto:${status.supportEmail}`} className="break-all font-medium underline underline-offset-2">
          {status.supportEmail}
        </a>
      ) : (
        "Contact your platform administrator."
      )}
    </p>
  );
}
