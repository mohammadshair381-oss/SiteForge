"use client";

import { useState } from "react";
import Link from "next/link";
import { useEffect } from "react";
import { apiErrorFrom, fieldErrorId, invalidProps, summaryMessage } from "@/lib/api-errors";
import { useLinkToken } from "@/lib/use-link-token";
import { AuthHeading, authInput, authLabel, authLink } from "./AuthShell";
import { buttonClass } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";

type Status = "form" | "submitting" | "success";

export default function ResetPasswordForm() {
  // The token lives only in this component's state; it is cleared on success
  // and never written to logs or rendered.
  const linkToken = useLinkToken();
  const [token, setToken] = useState("");
  useEffect(() => {
    if (linkToken) setToken(linkToken);
  }, [linkToken]);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<Status>("form");
  const [error, setError] = useState<string | null>(null);
  const [offerNewLink, setOfferNewLink] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const hasToken = token.trim().length > 0;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setOfferNewLink(false);
    setFieldErrors({});

    if (password.length < 8) {
      setFieldErrors({ password: "Password must be at least 8 characters." });
      return;
    }
    if (password !== confirm) {
      setFieldErrors({ confirm: "Passwords do not match." });
      return;
    }

    setStatus("submitting");
    try {
      const res = await fetch("/api/auth/password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });

      if (res.ok) {
        // Only claim success once the API confirms it, and drop the token.
        setToken("");
        setPassword("");
        setConfirm("");
        setStatus("success");
        return;
      }

      const data = (await res.json().catch(() => ({}))) as { error?: string; fields?: unknown };
      if (res.status === 429) {
        setError("Too many requests. Please try again in a little while.");
      } else if (res.status === 422) {
        const info = apiErrorFrom(data, "Please check your new password.");
        setFieldErrors(info.fields);
        // A problem with the link has no field here, so it stays in the general message.
        if (!info.fields.password || Object.keys(info.fields).length > 1) setError(summaryMessage(info, ["password"]));
      } else {
        setError("This reset link is invalid or has expired. Please request a new one.");
        setOfferNewLink(true);
      }
      setStatus("form");
    } catch {
      setError("Something went wrong. Please try again.");
      setStatus("form");
    }
  }

  if (status === "success") {
    return (
      <div>
        <AuthHeading title="Password updated">
          <p role="status">
            Your password has been changed and any other sessions have been signed
            out. You can now log in with your new password.
          </p>
        </AuthHeading>
        <Link
          href="/login"
          className={buttonClass({ size: "lg", block: true, className: "mt-6" })}
        >
          Go to log in
        </Link>
      </div>
    );
  }

  if (!hasToken) {
    return (
      <div>
        <AuthHeading title="Reset your password">
          <p role="alert">This page needs a valid reset link. Request a new one to continue.</p>
        </AuthHeading>
        <Link
          href="/forgot-password"
          className={buttonClass({ size: "lg", block: true, className: "mt-6" })}
        >
          Request a new reset link
        </Link>
      </div>
    );
  }

  const submitting = status === "submitting";

  return (
    <div>
      <AuthHeading title="Choose a new password">Pick a strong password you don&apos;t use anywhere else.</AuthHeading>

      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <div>
          <label htmlFor="reset-password" className={authLabel}>
            New password
          </label>
          <input
            id="reset-password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={authInput}
            {...invalidProps(fieldErrors, "password", "reset")}
          />
          <p className="mt-1 text-xs text-slate-500">At least 8 characters.</p>
          <FieldError id={fieldErrorId("reset", "password")} message={fieldErrors.password} />
        </div>
        <div>
          <label htmlFor="reset-confirm" className={authLabel}>
            Confirm new password
          </label>
          <input
            id="reset-confirm"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={authInput}
            {...invalidProps(fieldErrors, "confirm", "reset")}
          />
          <FieldError id={fieldErrorId("reset", "confirm")} message={fieldErrors.confirm} />
        </div>
        {error && (
          <Notice tone="danger" role="alert">
            {error}
            {offerNewLink && (
              <>
                {" "}
                <Link href="/forgot-password" className="font-semibold underline">
                  Request a new link
                </Link>
              </>
            )}
          </Notice>
        )}
        <button
          type="submit"
          disabled={submitting}
          className={buttonClass({ block: true, size: "lg", className: "mt-2" })}
        >
          {submitting ? "Updating…" : "Update password"}
        </button>
      </form>

      <p className="mt-6 text-sm text-slate-600">
        <Link href="/login" className={authLink}>
          Back to log in
        </Link>
      </p>
    </div>
  );
}
