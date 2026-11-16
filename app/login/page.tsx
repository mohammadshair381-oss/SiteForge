"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AuthShell, { AuthHeading, authInput, authLabel, authLink } from "@/components/auth/AuthShell";
import { fieldErrorId, invalidProps, readApiError, summaryMessage } from "@/lib/api-errors";
import { buttonClass } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";
import SupportContact from "@/components/ui/SupportContact";
import { usePlatformStatus } from "@/lib/use-platform-status";

/** Login with email and password: the right password signs in directly. */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const status = usePlatformStatus();

  function finishLogin() {
    const next = new URLSearchParams(window.location.search).get("next");
    router.push(next === "/invitations/accept" ? next : "/dashboard");
    router.refresh();
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        // Field messages only ever describe what was typed. A wrong password or unknown
        // address gets the same general answer, so this cannot reveal an account.
        const info = await readApiError(res, "Unable to log in");
        setFieldErrors(info.fields);
        setError(summaryMessage(info, ["email", "password"]));
        return;
      }
      finishLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to log in");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell>
      <AuthHeading title="Welcome back">Log in to manage your businesses.</AuthHeading>
      {status?.maintenance.enabled && (
        <Notice tone="info" role="status" className="mt-6" title="SiteForge is undergoing maintenance">
          {status.maintenance.message || "You can still log in, and stores stay online. Creating stores and publishing are paused for now."}
        </Notice>
      )}

      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <div>
          <label htmlFor="login-email" className={authLabel}>Email</label>
          <input
            id="login-email"
            autoComplete="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={authInput}
            // Email autofill extensions (e.g. Temp Mail) inject attributes/styles
            // into this field before hydration; ignore those client-only diffs.
            suppressHydrationWarning
            {...invalidProps(fieldErrors, "email", "login")}
          />
          <FieldError id={fieldErrorId("login", "email")} message={fieldErrors.email} />
        </div>
        <div>
          <label htmlFor="login-password" className={authLabel}>Password</label>
          <input
            id="login-password"
            autoComplete="current-password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={authInput}
            // Password managers inject attributes here before hydration; ignore them.
            suppressHydrationWarning
            {...invalidProps(fieldErrors, "password", "login")}
          />
          <FieldError id={fieldErrorId("login", "password")} message={fieldErrors.password} />
        </div>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <button type="submit" disabled={loading} className={buttonClass({ block: true, size: "lg", className: "mt-2" })}>
          {loading ? "Logging in…" : "Log in"}
        </button>
      </form>

      <p className="mt-6 border-t border-slate-200 pt-6 text-sm text-slate-600">
        <Link href="/forgot-password" className={authLink}>
          Forgot your password?
        </Link>
      </p>
      <p className="mt-2 text-sm text-slate-600">
        No account?{" "}
        <Link href="/register" className={authLink}>Create one</Link>
        {status && (!status.registrationOpen || status.maintenance.enabled) && <span className="text-slate-500"> (new accounts are paused right now)</span>}
      </p>
      <SupportContact label="Trouble logging in?" className="mt-2 text-sm text-slate-600" />
    </AuthShell>
  );
}
