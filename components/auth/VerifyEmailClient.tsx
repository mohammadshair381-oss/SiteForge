"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ResendVerificationButton from "./ResendVerificationButton";
import { AuthHeading, authInput, authLabel, authLink } from "./AuthShell";
import { buttonClass } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Surface";
import { useLinkToken } from "@/lib/use-link-token";

/**
 * Confirms an address with the emailed link and the account's password. It waits
 * for the person to act: mail scanners open links, and this stops them using one.
 */
export default function VerifyEmailClient() {
  const router = useRouter();
  const token = useLinkToken();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/email/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        router.push("/dashboard");
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(res.status === 429 ? "Too many attempts. Please try again in a little while." : data.error ?? "We could not confirm your email.");
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (token === null) {
    return (
      <p role="status" aria-live="polite" className="text-sm text-slate-600">
        Checking your link…
      </p>
    );
  }

  if (!token) {
    return (
      <div>
        <AuthHeading title="Verify your email">
          <p>
            This page confirms the link we email you. If you are signed in and still need to verify your address,
            request a new email below. Otherwise, logging in sends a new link.
          </p>
        </AuthHeading>
        <div className="mt-6">
          <ResendVerificationButton />
        </div>
        <p className="mt-6 text-sm text-slate-600">
          <Link href="/login" className={authLink}>
            Log in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      <AuthHeading title="Confirm your email">Enter your password to finish confirming this address.</AuthHeading>
      <form onSubmit={confirm} className="mt-8 space-y-4">
        <div>
          <label htmlFor="verify-password" className={authLabel}>
            Password
          </label>
          <input
            id="verify-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={authInput}
          />
        </div>
        {error && (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        )}
        <button type="submit" disabled={busy} className={buttonClass({ block: true, size: "lg" })}>
          {busy ? "Confirming…" : "Confirm email"}
        </button>
      </form>
      <p className="mt-6 text-sm text-slate-600">
        <Link href="/forgot-password" className={authLink}>
          Forgot your password?
        </Link>
      </p>
    </div>
  );
}
