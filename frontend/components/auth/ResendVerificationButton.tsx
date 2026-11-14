"use client";

import { useState } from "react";
import Link from "next/link";

type Status = "idle" | "sending" | "sent" | "error";

/**
 * Requests a new verification email for the signed-in user. The endpoint is
 * authenticated and rate limited; this component only surfaces a safe message
 * and never sees a token.
 */
export default function ResendVerificationButton({
  className = "",
}: {
  className?: string;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);

  async function onClick() {
    setStatus("sending");
    setMessage(null);
    setNeedsLogin(false);
    try {
      const res = await fetch("/api/auth/email/resend", { method: "POST" });
      if (res.status === 401) {
        setNeedsLogin(true);
        setStatus("error");
        setMessage("Please log in to request a new verification email.");
        return;
      }
      if (res.status === 429) {
        setStatus("error");
        setMessage("Too many requests. Please try again in a little while.");
        return;
      }
      if (!res.ok) {
        setStatus("error");
        setMessage("We could not send the email right now. Please try again shortly.");
        return;
      }
      setStatus("sent");
      setMessage("Verification email sent. Check your inbox.");
    } catch {
      setStatus("error");
      setMessage("We could not send the email right now. Please try again shortly.");
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={onClick}
        disabled={status === "sending" || status === "sent"}
        className="rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-900 transition hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-60"
      >
        {status === "sending"
          ? "Sending…"
          : status === "sent"
            ? "Email sent"
            : "Resend verification email"}
      </button>
      {message && (
        <p
          role={status === "error" ? "alert" : "status"}
          className={`mt-2 text-sm ${
            status === "error" ? "text-red-700" : "text-green-700"
          }`}
        >
          {message}
          {needsLogin && (
            <>
              {" "}
              <Link href="/login" className="font-semibold underline">
                Log in
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}
