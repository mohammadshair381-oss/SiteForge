"use client";

import { useEffect, useState } from "react";
import { authInput, authLabel, authLink, AuthHeading } from "@/components/auth/AuthShell";
import { fieldErrorId, invalidProps, readApiError } from "@/lib/api-errors";
import { buttonClass } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";
import SupportContact from "@/components/ui/SupportContact";

/**
 * The six-digit code step shared by login, signup and password reset. The server sent only timings
 * (seconds); the code itself never reaches the browser: the person types it from the email (or, in
 * local development, from the server terminal).
 */
export interface PendingCode {
  expiresAt: number;
  resendAt: number;
  resendsLeft: number;
}

export function pendingFrom(view: { expiresInSeconds?: unknown; resendInSeconds?: unknown; resendsLeft?: unknown }): PendingCode {
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

/** Answers after which no new code for this pending one can help: start over instead. */
const START_OVER_CODES = new Set(["login_expired", "code_attempts_exceeded", "login_code_locked", "resend_limit"]);

export default function CodeEntry({
  email,
  initial,
  title,
  intro,
  submitLabel,
  idPrefix,
  verifyUrl,
  resendUrl,
  resendBody = {},
  withNewPassword = false,
  startOverLabel,
  onDone,
  onStartOver,
}: {
  email: string;
  initial: PendingCode;
  title: string;
  intro: React.ReactNode;
  submitLabel: string;
  idPrefix: string;
  verifyUrl: string;
  resendUrl: string;
  /** JSON body for the resend request (password reset asks again with the email). */
  resendBody?: Record<string, unknown>;
  /** Password reset: ask for the new password together with the code. */
  withNewPassword?: boolean;
  startOverLabel: string;
  onDone: () => void;
  onStartOver: () => void;
}) {
  const [pending, setPending] = useState<PendingCode>(initial);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [startOver, setStartOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function onVerify(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErrors({});
    setNotice(null);
    try {
      const res = await fetch(verifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withNewPassword ? { code, password } : { code }),
      });
      if (!res.ok) {
        const info = await readApiError(res, "That code could not be checked");
        setFieldErrors(info.fields);
        setError(info.fields.code || info.fields.password ? null : info.message);
        if (START_OVER_CODES.has(info.code ?? "")) setStartOver(true);
        if (info.code !== "code_invalid" && !info.fields.password) setCode("");
        return;
      }
      onDone();
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
      const res = await fetch(resendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resendBody),
      });
      if (!res.ok) {
        const info = await readApiError(res, "A new code could not be sent");
        setError(info.message);
        if (START_OVER_CODES.has(info.code ?? "")) setStartOver(true);
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

  const expiresIn = pending.expiresAt - now;
  const resendIn = pending.resendAt - now;
  const canResend = !startOver && pending.resendsLeft > 0 && resendIn <= 0;
  const ready = code.length === 6 && (!withNewPassword || password.length >= 8);

  return (
    <>
      <AuthHeading title={title}>
        {intro} We sent a 6-digit code to <span className="font-medium text-slate-900">{email}</span>.
      </AuthHeading>

      <form onSubmit={onVerify} className="mt-8 space-y-4">
        <div>
          <label htmlFor={`${idPrefix}-code`} className={authLabel}>6-digit code</label>
          <input
            id={`${idPrefix}-code`}
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
            {...invalidProps(fieldErrors, "code", idPrefix)}
          />
          <FieldError id={fieldErrorId(idPrefix, "code")} message={fieldErrors.code} />
          <p className="mt-2 text-sm text-slate-600" aria-live="polite">
            {expiresIn > 0 ? <>This code expires in {clock(expiresIn)}.</> : <>This code has expired. Send a new code to continue.</>}
          </p>
        </div>
        {withNewPassword && (
          <div>
            <label htmlFor={`${idPrefix}-password`} className={authLabel}>New password</label>
            <input
              id={`${idPrefix}-password`}
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={authInput}
              suppressHydrationWarning
              {...invalidProps(fieldErrors, "password", idPrefix)}
            />
            <p className="mt-1 text-xs text-slate-500">At least 8 characters.</p>
            <FieldError id={fieldErrorId(idPrefix, "password")} message={fieldErrors.password} />
          </div>
        )}
        {notice && <Notice tone="info" role="status">{notice}</Notice>}
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <button type="submit" disabled={loading || startOver || !ready} className={buttonClass({ block: true, size: "lg", className: "mt-2" })}>
          {loading ? "Checking…" : submitLabel}
        </button>
      </form>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-6 text-sm text-slate-600">
        <button type="button" onClick={onResend} disabled={loading || !canResend} className={buttonClass({ variant: "secondary", size: "sm" })}>
          {pending.resendsLeft <= 0 || startOver ? "No more codes for this request" : resendIn > 0 ? `Send a new code in ${clock(resendIn)}` : "Send a new code"}
        </button>
        <button type="button" onClick={onStartOver} className={authLink}>
          {startOverLabel}
        </button>
      </div>
      <p className="mt-4 text-sm text-slate-500">Did not get it? Check your spam folder.</p>
      <SupportContact label="Trouble?" className="mt-2 text-sm text-slate-600" />
    </>
  );
}
