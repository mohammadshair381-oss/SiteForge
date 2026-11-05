"use client";

import { useState } from "react";
import Link from "next/link";
import AuthShell, { AuthHeading, authInput, authLabel, authLink } from "@/components/auth/AuthShell";
import { fieldErrorId, invalidProps, readApiError, summaryMessage } from "@/lib/api-errors";
import { buttonClass } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";
import SupportContact from "@/components/ui/SupportContact";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
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
      if (res.status === 429) {
        setError("Too many requests. Please try again in a little while.");
        return;
      }
      if (res.status === 422) {
        // The address as typed is malformed. Any real address gets the same answer below.
        const info = await readApiError(res, "Enter a valid email address.");
        setFieldErrors(info.fields);
        setError(summaryMessage(info, ["email"]));
        return;
      }
      if (!res.ok) throw new Error("Unable to send the reset email");
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send the reset email");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <AuthShell>
        <AuthHeading title="Check your email">
          <p role="status">
            If an account exists for <span className="font-medium text-slate-900">{email}</span>,
            we&apos;ve sent a password reset link. It expires in 1 hour.
          </p>
        </AuthHeading>
        <p className="mt-6 text-sm text-slate-600">
          <Link href="/login" className={authLink}>
            Back to log in
          </Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <AuthHeading title="Forgot your password?">Enter your email and we&apos;ll send you a link to reset it.</AuthHeading>

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
            {...invalidProps(fieldErrors, "email", "forgot")}
          />
          <FieldError id={fieldErrorId("forgot", "email")} message={fieldErrors.email} />
        </div>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <button
          type="submit"
          disabled={loading}
          className={buttonClass({ block: true, size: "lg", className: "mt-2" })}
        >
          {loading ? "Sending…" : "Send reset link"}
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
