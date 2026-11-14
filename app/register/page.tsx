"use client";

import { useState } from "react";
import Link from "next/link";
import AuthShell, { AuthHeading, authInput, authLabel, authLink } from "@/components/auth/AuthShell";
import { fieldErrorId, invalidProps, readApiError, summaryMessage } from "@/lib/api-errors";
import { buttonClass } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";
import SupportContact from "@/components/ui/SupportContact";
import { registrationUnavailableReason } from "@/lib/platform-status";
import { usePlatformStatus } from "@/lib/use-platform-status";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  // For display only: the server refuses a registration whatever this says.
  const status = usePlatformStatus();
  const unavailableReason = status ? registrationUnavailableReason(status) : null;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!res.ok) {
        const info = await readApiError(res, "Unable to register");
        setFieldErrors(info.fields);
        setError(summaryMessage(info, ["name", "email", "password"]));
        return;
      }
      setSubmitted(email);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to register");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <AuthShell>
        <AuthHeading title="Check your inbox">
          We sent a message to {submitted} with what to do next. Open it to confirm your address, then you can start
          building your store. It can take a few minutes, and may land in your spam folder.
        </AuthHeading>
        <p className="mt-6 text-sm text-slate-600">
          Already confirmed? <Link href="/login" className={authLink}>Log in</Link>
        </p>
      </AuthShell>
    );
  }

  if (unavailableReason) {
    return (
      <AuthShell>
        <AuthHeading title="New accounts aren't available right now">{unavailableReason}</AuthHeading>
        <p className="mt-6 text-sm text-slate-600">
          Already have an account? <Link href="/login" className={authLink}>Log in</Link>
        </p>
        <SupportContact label="Questions?" className="mt-2 text-sm text-slate-600" />
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <AuthHeading title="Create your account">Start building your business website. We&apos;ll email you a link to verify your address.</AuthHeading>

      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <div>
          <label htmlFor="register-name" className={authLabel}>Full name</label>
          <input
            id="register-name"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={authInput}
            {...invalidProps(fieldErrors, "name", "register")}
          />
          <FieldError id={fieldErrorId("register", "name")} message={fieldErrors.name} />
        </div>
        <div>
          <label htmlFor="register-email" className={authLabel}>Email</label>
          <input
            id="register-email"
            autoComplete="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={authInput}
            suppressHydrationWarning
            {...invalidProps(fieldErrors, "email", "register")}
          />
          <FieldError id={fieldErrorId("register", "email")} message={fieldErrors.email} />
        </div>
        <div>
          <label htmlFor="register-password" className={authLabel}>Password</label>
          <input
            id="register-password"
            autoComplete="new-password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={authInput}
            suppressHydrationWarning
            {...invalidProps(fieldErrors, "password", "register")}
          />
          <p className="mt-1 text-xs text-slate-500">At least 8 characters.</p>
          <FieldError id={fieldErrorId("register", "password")} message={fieldErrors.password} />
        </div>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <button
          type="submit"
          disabled={loading}
          className={buttonClass({ block: true, size: "lg", className: "mt-2" })}
        >
          {loading ? "Creating account…" : "Create account"}
        </button>
      </form>

      <p className="mt-6 text-sm text-slate-600">
        Already have an account?{" "}
        <Link href="/login" className={authLink}>Log in</Link>
      </p>
      <SupportContact className="mt-2 text-sm text-slate-600" />
      <p className="mt-2 text-xs text-slate-500">
        By creating an account, you agree to our{" "}
        <Link href="/terms" className={authLink}>
          Terms of Service
        </Link>
        {" and "}
        <Link href="/privacy" className={authLink}>
          Privacy Policy
        </Link>
        .
      </p>
    </AuthShell>
  );
}
