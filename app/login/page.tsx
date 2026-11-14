"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AuthShell, { AuthHeading, authInput, authLabel, authLink } from "@/components/auth/AuthShell";
import { fieldErrorId, invalidProps, readApiError, summaryMessage } from "@/lib/api-errors";
import { buttonClass } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";
import SupportContact from "@/components/ui/SupportContact";
import { usePlatformStatus } from "@/lib/use-platform-status";

/**
 * Timings of a pending new-device sign-in, as the server sent them (seconds), turned into
 * deadlines on this clock. The code itself is never sent to the browser: the person types it.
 */
interface PendingCode {
  expiresAt: number;
  resendAt: number;
  resendsLeft: number;
}

function pendingFrom(view: { expiresInSeconds?: unknown; resendInSeconds?: unknown; resendsLeft?: unknown }): PendingCode {
  const seconds = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const now = Date.now();
  return {
    expiresAt: now + seconds(view.expiresInSeconds) * 1000,
    resendAt: now + seconds(view.resendInSeconds) * 1000,
    resendsLeft: typeof view.resendsLeft === "number" ? view.resendsLeft : 0,
  };
}

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const status = usePlatformStatus();
  // New-device step: shown only after the server answered 202 to a right password.
  const [pending, setPending] = useState<PendingCode | null>(null);
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [startOver, setStartOver] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

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
      if (res.status === 202) {
        // A device this account has not confirmed: a code was emailed. Nothing is signed in yet.
        setPending(pendingFrom(await res.json()));
        setNow(Date.now());
        setPassword("");
        setCode("");
        setNotice(null);
        setStartOver(false);
        return;
      }
      finishLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to log in");
    } finally {
      setLoading(false);
    }
  }

  async function onVerify(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErrors({});
    setNotice(null);
    try {
      const res = await fetch("/api/auth/login/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const info = await readApiError(res, "That code could not be checked");
        setFieldErrors(info.fields);
        setError(info.fields.code ? null : info.message);
        // No new code can help: the guesses are used up, or the sign-in or the account is locked.
        if (info.code === "login_expired" || info.code === "code_attempts_exceeded" || info.code === "login_code_locked") setStartOver(true);
        if (info.code !== "code_invalid") setCode("");
        return;
      }
      finishLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code could not be checked");
    } finally {
      setLoading(false);
    }
  }

  async function onResend() {
    setLoading(true);
    setError(null);
    setFieldErrors({});
    setNotice(null);
    try {
      const res = await fetch("/api/auth/login/code/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        const info = await readApiError(res, "A new code could not be sent");
        setError(info.message);
        if (["login_expired", "resend_limit", "code_attempts_exceeded", "login_code_locked"].includes(info.code ?? "")) setStartOver(true);
        return;
      }
      setPending(pendingFrom(await res.json()));
      setNow(Date.now());
      setCode("");
      setNotice("We sent a new code. Earlier codes no longer work.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "A new code could not be sent");
    } finally {
      setLoading(false);
    }
  }

  function backToPassword() {
    setPending(null);
    setCode("");
    setError(null);
    setFieldErrors({});
    setNotice(null);
    setStartOver(false);
  }

  if (pending) {
    const expiresIn = pending.expiresAt - now;
    const resendIn = pending.resendAt - now;
    const canResend = !startOver && pending.resendsLeft > 0 && resendIn <= 0;
    return (
      <AuthShell>
        <AuthHeading title="Check your email">
          This device is new to your account. We sent a 6-digit code to <span className="font-medium text-slate-900">{email}</span>. Enter it to finish logging in.
        </AuthHeading>

        <form onSubmit={onVerify} className="mt-8 space-y-4">
          <div>
            <label htmlFor="login-code" className={authLabel}>Sign-in code</label>
            <input
              id="login-code"
              name="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className={`${authInput} text-center font-mono text-lg tracking-[0.4em]`}
              suppressHydrationWarning
              {...invalidProps(fieldErrors, "code", "login")}
            />
            <FieldError id={fieldErrorId("login", "code")} message={fieldErrors.code} />
            <p className="mt-2 text-sm text-slate-600" aria-live="polite">
              {expiresIn > 0 ? <>This code expires in {clock(expiresIn)}.</> : <>This code has expired. Send a new code to continue.</>}
            </p>
          </div>
          {notice && <Notice tone="info" role="status">{notice}</Notice>}
          {error && <Notice tone="danger" role="alert">{error}</Notice>}
          <button
            type="submit"
            disabled={loading || startOver || code.length !== 6}
            className={buttonClass({ block: true, size: "lg", className: "mt-2" })}
          >
            {loading ? "Checking…" : "Verify and log in"}
          </button>
        </form>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-6 text-sm text-slate-600">
          <button type="button" onClick={onResend} disabled={loading || !canResend} className={buttonClass({ variant: "secondary", size: "sm" })}>
            {pending.resendsLeft <= 0 || startOver
              ? "No more codes for this sign-in"
              : resendIn > 0
                ? `Send a new code in ${clock(resendIn)}`
                : "Send a new code"}
          </button>
          <button type="button" onClick={backToPassword} className={authLink}>
            {startOver ? "Log in again" : "Use a different account"}
          </button>
        </div>
        <p className="mt-4 text-sm text-slate-500">
          Did not get it? Check your spam folder. If you did not try to log in, change your password.
        </p>
        <SupportContact label="Trouble logging in?" className="mt-2 text-sm text-slate-600" />
      </AuthShell>
    );
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
        <button
          type="submit"
          disabled={loading}
          className={buttonClass({ block: true, size: "lg", className: "mt-2" })}
        >
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
      <p className="mt-2 text-sm text-slate-600">
        Need to verify your email?{" "}
        <Link href="/verify-email" className={authLink}>
          Resend the verification link
        </Link>
      </p>
      <SupportContact label="Trouble logging in?" className="mt-2 text-sm text-slate-600" />
    </AuthShell>
  );
}
