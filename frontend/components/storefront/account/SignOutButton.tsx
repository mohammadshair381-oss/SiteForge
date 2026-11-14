"use client";

import { useState } from "react";

/** Signs the customer out (every device, see the logout route) and returns to the store. */
export default function SignOutButton({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/storefront/account/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error("logout failed");
      window.location.assign("/");
    } catch {
      setError("Could not sign out. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void signOut()}
        disabled={busy}
        className={className ?? "sf-acc-secondary sf-acc-control sf-acc-focus inline-flex min-h-11 items-center justify-center px-4 py-2 text-sm font-semibold focus-visible:outline-none disabled:opacity-60"}
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
      {error && (
        <p role="alert" className="sf-acc-error mt-2 text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
