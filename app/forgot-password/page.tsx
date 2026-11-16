"use client";

import { useState } from "react";
import Link from "next/link";
import AuthShell, { AuthHeading, authInput, authLabel, authLink } from "@/components/auth/AuthShell";
import CodeEntry, { pendingFrom, type PendingCode } from "@/components/auth/CodeEntry";
import { fieldErrorId, invalidProps, readApiError, summaryMessage } from "@/lib/api-errors";
import { buttonClass } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";
import SupportContact from "@/components/ui/SupportContact";

/**
 * Password reset: the email, then the 6-digit code emailed to it together with a new password. The
 * server answers the same for every address, so this page never says whether an account exists.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState<PendingCode | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch("/api/auth/password/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        // A malformed address or too many requests. Any real address gets the same answer below.
        const info = await readApiError(res, res.status === 429 ? "Too many requests. Please try again in a little while." : "Unable to send the code");
        setFieldErrors(info.fields);
        setError(summaryMessage(info, ["email"]));
        return;
      }
      setPending(pendingFrom(await res.json()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send the code");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <AuthShell>
        <AuthHeading title="Password changed">
          <p role="status">Your new password is set, and every other session has been signed out. Log in with it now.</p>
        </AuthHeading>
        <p className="mt-6 text-sm text-slate-600">
          <Link href="/login" className={authLink}>Go to log in</Link>
        </p>
      </AuthShell>
    );
  }

  if (pending) {
    return (
      <AuthShell>
        <CodeEntry
          email={email}
          initial={pending}
          title="Reset your password"
          intro="If an account exists for this address, enter the code and choose a new password."
          submitLabel="Set new password"
          idPrefix="reset"
          verifyUrl="/api/auth/password/reset"
          resendUrl="/api/auth/password/forgot"
          resendBody={{ email }}
          withNewPassword
          startOverLabel="Use a different email"
          onDone={() => setDone(true)}
          onStartOver={() => setPending(null)}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <AuthHeading title="Forgot your password?">Enter your email and we&apos;ll send you a 6-digit code to reset it.</AuthHeading>

      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <div>
          <label htmlFor="forgot-email" className={authLabel}>
            Email
          </label>
          <input
            id="forgot-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={authInput}
            suppressHydrationWarning
            {...invalidProps(fieldErrors, "email", "forgot")}
          />
          <FieldError id={fieldErrorId("forgot", "email")} message={fieldErrors.email} />
        </div>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <button type="submit" disabled={loading} className={buttonClass({ block: true, size: "lg", className: "mt-2" })}>
          {loading ? "Sending…" : "Send code"}
        </button>
      </form>

      <p className="mt-6 text-sm text-slate-600">
        Remembered it?{" "}
        <Link href="/login" className={authLink}>
          Back to log in
        </Link>
      </p>
      <SupportContact label="Still stuck?" className="mt-2 text-sm text-slate-600" />
    </AuthShell>
  );
}
