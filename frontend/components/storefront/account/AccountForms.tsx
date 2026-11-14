"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiErrorFrom } from "@/lib/api-errors";
import { useLinkToken } from "@/lib/use-link-token";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

/**
 * Storefront customer account forms (register, login, verify email, forgot
 * and reset password, profile, change password). They call only
 * `/api/storefront/account/*` on the current storefront host; the business is
 * resolved server-side from that host, never sent from here. They take their
 * look from the active theme: `--acc-*` tokens (the `sf-acc-*` classes in
 * app/globals.css) and the accent `--sf-accent`, all set by
 * `app/store/account/layout.tsx`.
 */

// Text colour is black or white, whichever contrasts more with the theme
// colour (computed server-side in the layout, see lib/color-contrast.ts).
const ACCENT = { background: "var(--sf-accent, #4f46e5)", color: "var(--sf-accent-text, #ffffff)" } as const;
const MIN_PASSWORD = 8;

type ApiFailure = { ok: false; status: number; code: string; message: string; fields: Record<string, string> };
type ApiResult = { ok: true; data: Record<string, unknown> } | ApiFailure;

/** Once a field shows each problem, the summary only has to point at them. */
function failureText(result: ApiFailure, shown: string[]): string {
  const keys = Object.keys(result.fields);
  return keys.length > 0 && keys.every((key) => shown.includes(key)) ? "Please correct the highlighted fields." : result.message;
}

async function post(path: string, body: Record<string, string>, method: "POST" | "PATCH" = "POST"): Promise<ApiResult> {
  try {
    const res = await fetch(`/api/storefront/account/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, data };
    const code = typeof data.code === "string" ? data.code : "error";
    let message = typeof data.error === "string" ? data.error : "Something went wrong. Please try again.";
    if (res.status === 429) message = "Too many attempts. Please wait a few minutes and try again.";
    else if (res.status >= 500) message = "Something went wrong on our side. Please try again.";
    else if (res.status === 404) message = "This store is not accepting sign-ins right now.";
    return { ok: false, status: res.status, code, message, fields: apiErrorFrom(data, "").fields };
  } catch {
    return { ok: false, status: 0, code: "network", message: "We could not reach the store. Check your connection and try again.", fields: {} };
  }
}

function message(result: ApiResult, fallback: string): string {
  return result.ok && typeof result.data.message === "string" ? result.data.message : fallback;
}

/** Keeps a link token in memory and removes it from the address bar/history. */

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export function AccountCard({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby="account-title" className="sf-acc-card mx-auto w-full max-w-md p-6 sm:p-8">
      <h1 id="account-title" className="sf-acc-title break-words font-display text-2xl sm:text-[1.7rem]">
        {title}
      </h1>
      {intro && <div className="sf-acc-muted mt-2 text-sm leading-6">{intro}</div>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (ids: { id: string; describedBy?: string }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      {children({ id, describedBy })}
      {hint && (
        <p id={hintId} className="sf-acc-muted mt-1.5 text-xs leading-5">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="sf-acc-error mt-1.5 text-xs font-medium">
          {error}
        </p>
      )}
    </div>
  );
}

// The focus ring uses the theme's text colour: the brand colour could fail contrast.
// Base size on small screens stops phones zooming in on focus.
const INPUT =
  "sf-acc-input sf-acc-control block min-h-11 w-full px-3 py-2 text-base transition-colors focus:outline-none aria-[invalid=true]:border-red-500 motion-reduce:transition-none sm:text-sm";

function TextField(props: {
  label: string;
  name: string;
  type?: "text" | "email" | "tel";
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  maxLength: number;
  error?: string;
  hint?: string;
  optional?: boolean;
}) {
  return (
    <Field label={props.label} hint={props.hint} error={props.error}>
      {({ id, describedBy }) => (
        <input
          id={id}
          name={props.name}
          type={props.type ?? "text"}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          autoComplete={props.autoComplete}
          maxLength={props.maxLength}
          required={!props.optional}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={describedBy}
          className={INPUT}
        />
      )}
    </Field>
  );
}

function PasswordField(props: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  hint?: string;
  error?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={props.label} hint={props.hint} error={props.error}>
      {({ id, describedBy }) => (
        <div className="relative">
          <input
            id={id}
            name={props.name}
            type={visible ? "text" : "password"}
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            autoComplete={props.autoComplete}
            maxLength={200}
            required
            aria-invalid={props.error ? true : undefined}
            aria-describedby={describedBy}
            className={`${INPUT} pr-16`}
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-controls={id}
            aria-label={`${visible ? "Hide" : "Show"} ${props.label.toLowerCase()}`}
            className="sf-acc-muted absolute inset-y-0 right-0 flex min-w-14 items-center justify-center px-3 text-sm font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-current"
          >
            {visible ? "Hide" : "Show"}
          </button>
        </div>
      )}
    </Field>
  );
}

function Submit({ busy, children, busyLabel }: { busy: boolean; children: ReactNode; busyLabel: string }) {
  return (
    <button
      type="submit"
      disabled={busy}
      aria-busy={busy}
      className="sf-acc-control sf-acc-action sf-acc-focus min-h-12 w-full px-5 py-3 font-semibold transition-opacity hover:opacity-90 focus-visible:outline-none disabled:opacity-60 motion-reduce:transition-none"
      style={ACCENT}
    >
      {busy ? busyLabel : children}
    </button>
  );
}

/**
 * Error feedback. The `role="alert"` container stays mounted (empty) so a
 * message inserted later is announced reliably; there is exactly one live
 * region, so nothing is announced twice. While empty it takes no space in the
 * form's rhythm (it must stay displayed, or the live region would be lost).
 */
function ErrorBox({ text }: { text: string | null }) {
  return (
    <div role="alert" aria-atomic="true" className="empty:!mt-0">
      {text && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm leading-6 text-red-800">{text}</p>}
    </div>
  );
}

/** Inline success feedback while the form stays on screen (persistent polite region). */
function StatusRegion({ text }: { text: string | null }) {
  return (
    <div role="status" aria-atomic="true" className="empty:!mt-0">
      {text && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm leading-6 text-emerald-900">{text}</p>}
    </div>
  );
}

/** Moves keyboard focus to the first invalid field after client-side validation. */
function focusFirstInvalid(form: HTMLFormElement) {
  requestAnimationFrame(() => form.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
}

/**
 * Shown INSTEAD of a submitted form. The form (and the focused button) is
 * gone, so focus moves here; screen readers read it on focus. No live-region
 * role on top, which would announce it twice.
 */
export function SuccessBox({ text, children }: { text: string; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-account-success=""
      className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
    >
      <p>{text}</p>
      {children}
    </div>
  );
}

const LINK = "rounded font-medium underline underline-offset-2 hover:opacity-80 focus:outline-none sf-acc-focus";
/** A link that stands on its own, not inside a sentence: a full touch target. */
const LINK_TARGET = `inline-flex min-h-10 items-center ${LINK}`;
/** The way to the other form, set apart from the fields under a hairline. */
const ALTERNATIVE = "sf-acc-rule sf-acc-muted border-t pt-3 text-center text-sm";

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export function RegisterForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ name?: string; email?: string; password?: string; confirm?: string }>({});
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const form = event.currentTarget as HTMLFormElement;
    const errors: typeof fieldError = {};
    if (password.length < MIN_PASSWORD) errors.password = `Use at least ${MIN_PASSWORD} characters.`;
    if (password !== confirm) errors.confirm = "The passwords do not match.";
    setFieldError(errors);
    if (errors.password || errors.confirm) {
      focusFirstInvalid(form);
      return;
    }

    setBusy(true);
    const result = await post("register", { name, email, password });
    setBusy(false);
    if (!result.ok) {
      setFieldError({ name: result.fields.name, email: result.fields.email, password: result.fields.password });
      focusFirstInvalid(form);
      return setError(failureText(result, ["name", "email", "password"]));
    }
    setPassword("");
    setConfirm("");
    setDone(message(result, "If this email can be used, we will send a confirmation link shortly."));
  }

  if (done) {
    return (
      <SuccessBox text={done}>
        <p className="mt-2">
          The link expires in 24 hours. Didn&apos;t get it?{" "}
          <Link href="/account/verify-email" className={LINK}>
            Send a new link
          </Link>
          .
        </p>
      </SuccessBox>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <TextField label="Full name" name="name" value={name} onChange={setName} autoComplete="name" maxLength={120} error={fieldError.name} />
      <TextField label="Email" name="email" type="email" value={email} onChange={setEmail} autoComplete="email" maxLength={254} error={fieldError.email} />
      <PasswordField
        label="Password"
        name="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD} characters.`}
        error={fieldError.password}
      />
      <PasswordField
        label="Confirm password"
        name="confirmPassword"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        error={fieldError.confirm}
      />
      <ErrorBox text={error} />
      <Submit busy={busy} busyLabel="Creating account…">
        Create account
      </Submit>
      <p className={ALTERNATIVE}>
        Already have an account?{" "}
        <Link href="/account/login" className={LINK_TARGET}>
          Sign in
        </Link>
      </p>
    </form>
  );
}

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ email?: string; password?: string }>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    setError(null);
    setFieldError({});
    setUnverified(false);
    setResent(null);
    setBusy(true);
    const result = await post("login", { email, password });
    if (result.ok) {
      // Full navigation so every server component re-renders signed in.
      window.location.assign(next);
      return;
    }
    setBusy(false);
    setUnverified(result.code === "customer_email_unverified");
    // Field messages only describe what was typed: wrong details get one general answer,
    // so this never reveals whether an account exists.
    setFieldError({ email: result.fields.email, password: result.fields.password });
    focusFirstInvalid(form);
    setError(failureText(result, ["email", "password"]));
  }

  async function resend() {
    setBusy(true);
    const result = await post("email/resend", { email });
    setBusy(false);
    if (!result.ok) {
      setFieldError({ email: result.fields.email });
      return setError(failureText(result, ["email"]));
    }
    setError(null);
    setUnverified(false);
    setResent(message(result, "If a confirmation is pending for this email, we will send a new link shortly."));
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <TextField label="Email" name="email" type="email" value={email} onChange={setEmail} autoComplete="email" maxLength={254} error={fieldError.email} />
      <PasswordField label="Password" name="password" value={password} onChange={setPassword} autoComplete="current-password" error={fieldError.password} />
      <div className="!mt-1 text-right text-sm">
        <Link href="/account/forgot-password" className={LINK_TARGET}>
          Forgot your password?
        </Link>
      </div>
      <ErrorBox text={error} />
      {unverified && (
        <button
          type="button"
          onClick={() => void resend()}
          disabled={busy}
          className="sf-acc-secondary sf-acc-control sf-acc-focus min-h-11 w-full px-5 py-2.5 text-sm font-semibold focus-visible:outline-none disabled:opacity-60"
        >
          Send a new confirmation link
        </button>
      )}
      <StatusRegion text={resent} />
      <Submit busy={busy} busyLabel="Signing in…">
        Sign in
      </Submit>
      <p className={ALTERNATIVE}>
        New here?{" "}
        <Link href="/account/register" className={LINK_TARGET}>
          Create an account
        </Link>
      </p>
    </form>
  );
}

function ResendVerificationForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await post("email/resend", { email });
    setBusy(false);
    if (!result.ok) return setError(result.message);
    setDone(message(result, "If a confirmation is pending for this email, we will send a new link shortly."));
  }

  if (done) return <SuccessBox text={done} />;
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <TextField label="Email" name="email" type="email" value={email} onChange={setEmail} autoComplete="email" maxLength={254} />
      <ErrorBox text={error} />
      <Submit busy={busy} busyLabel="Sending…">
        Send confirmation link
      </Submit>
    </form>
  );
}

export function VerifyEmailForm({ token: givenToken }: { token?: string }) {
  const linkToken = useLinkToken();
  const token = givenToken ?? linkToken;
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; text: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (token === null) return <p className="sf-acc-muted text-sm" role="status">Checking your link…</p>;
  if (!token) {
    return (
      <div className="space-y-4">
        <p className="sf-acc-muted text-sm leading-6">
          Enter the email you registered with and we will send you a new confirmation link.
        </p>
        <ResendVerificationForm />
        <p className={ALTERNATIVE}>
          <Link href="/account/login" className={LINK_TARGET}>
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await post("email/verify", { token: token ?? "", password });
    setBusy(false);
    setPassword("");
    if (!result.ok) return setError({ code: result.code, text: result.message });
    setDone(message(result, "Your email address is confirmed."));
  }

  if (done) {
    return (
      <SuccessBox text={done}>
        <p className="mt-1">
          <Link href="/account/login" className={LINK_TARGET}>
            Sign in
          </Link>
        </p>
      </SuccessBox>
    );
  }

  if (error?.code === "invalid_token") {
    return (
      <div className="space-y-4">
        <ErrorBox text={error.text} />
        <ResendVerificationForm />
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <PasswordField
        label="Password"
        name="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        hint="For your security, enter the password you chose when you registered."
      />
      <ErrorBox text={error?.text ?? null} />
      {error?.code === "invalid_password" && (
        <p className="text-sm">
          <Link href="/account/forgot-password" className={LINK_TARGET}>
            Reset your password
          </Link>
        </p>
      )}
      <Submit busy={busy} busyLabel="Confirming…">
        Confirm my email
      </Submit>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    setError(null);
    setEmailError(undefined);
    setBusy(true);
    const result = await post("password/forgot", { email });
    setBusy(false);
    if (!result.ok) {
      // Only ever about the address as typed. Any valid address gets the same answer.
      setEmailError(result.fields.email);
      focusFirstInvalid(form);
      return setError(failureText(result, ["email"]));
    }
    setDone(message(result, "If an account exists, we will send a reset link shortly."));
  }

  if (done) {
    return (
      <SuccessBox text={done}>
        <p className="mt-2">
          The link expires in 1 hour.{" "}
          <Link href="/account/login" className={LINK}>
            Back to sign in
          </Link>
        </p>
      </SuccessBox>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <TextField label="Email" name="email" type="email" value={email} onChange={setEmail} autoComplete="email" maxLength={254} error={emailError} />
      <ErrorBox text={error} />
      <Submit busy={busy} busyLabel="Sending…">
        Send reset link
      </Submit>
      <p className={ALTERNATIVE}>
        Remembered it?{" "}
        <Link href="/account/login" className={LINK_TARGET}>
          Sign in
        </Link>
      </p>
    </form>
  );
}

/** The signed-in customer's own name and phone. The email cannot be changed here. */
export function ProfileForm({ initial }: { initial: { name: string; phone: string; email: string } }) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [phone, setPhone] = useState(initial.phone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ name?: string; phone?: string }>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    setError(null);
    setSaved(null);
    setFieldError({});
    setBusy(true);
    const result = await post("profile", { name, phone }, "PATCH");
    setBusy(false);
    if (!result.ok) {
      setFieldError({ name: result.fields.name, phone: result.fields.phone });
      focusFirstInvalid(form);
      return setError(failureText(result, ["name", "phone"]));
    }
    setSaved(message(result, "Your details have been saved."));
    // The header and account navigation show the name.
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <TextField label="Full name" name="name" value={name} onChange={setName} autoComplete="name" maxLength={120} error={fieldError.name} />
      <TextField label="Phone" name="phone" type="tel" value={phone} onChange={setPhone} autoComplete="tel" maxLength={32} optional hint="Optional." error={fieldError.phone} />
      <Field label="Email" hint="Your email signs you in, so it cannot be changed here.">
        {({ id, describedBy }) => <input id={id} type="email" value={initial.email} readOnly aria-describedby={describedBy} className={`${INPUT} opacity-75`} />}
      </Field>
      <ErrorBox text={error} />
      <StatusRegion text={saved} />
      <Submit busy={busy} busyLabel="Saving…">
        Save details
      </Submit>
    </form>
  );
}

/** Proves the current password; other devices are signed out and this one stays signed in. */
export function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ password?: string; confirm?: string }>({});
  const [saved, setSaved] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(null);
    const errors: typeof fieldError = {};
    if (password.length < MIN_PASSWORD) errors.password = `Use at least ${MIN_PASSWORD} characters.`;
    if (password !== confirm) errors.confirm = "The passwords do not match.";
    setFieldError(errors);
    if (errors.password || errors.confirm) {
      focusFirstInvalid(event.currentTarget as HTMLFormElement);
      return;
    }

    setBusy(true);
    const result = await post("password/change", { currentPassword: current, newPassword: password });
    setBusy(false);
    setCurrent("");
    if (!result.ok) {
      setFieldError({ password: result.fields.newPassword });
      return setError(failureText(result, ["newPassword"]));
    }
    setPassword("");
    setConfirm("");
    setSaved(message(result, "Your password has been changed."));
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <PasswordField label="Current password" name="currentPassword" value={current} onChange={setCurrent} autoComplete="current-password" />
      <PasswordField
        label="New password"
        name="newPassword"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD} characters. This signs you out on your other devices.`}
        error={fieldError.password}
      />
      <PasswordField
        label="Confirm new password"
        name="confirmNewPassword"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        error={fieldError.confirm}
      />
      <ErrorBox text={error} />
      <StatusRegion text={saved} />
      <Submit busy={busy} busyLabel="Saving…">
        Change password
      </Submit>
    </form>
  );
}

export function ResetPasswordForm({ token: givenToken }: { token?: string }) {
  const linkToken = useLinkToken();
  const token = givenToken ?? linkToken;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ password?: string; confirm?: string }>({});
  const [done, setDone] = useState<string | null>(null);

  if (token === null) return <p className="sf-acc-muted text-sm" role="status">Checking your link…</p>;
  if (!token) {
    return (
      <div className="space-y-4">
        <ErrorBox text="This reset link is incomplete. Request a new one." />
        <Link href="/account/forgot-password" className={LINK_TARGET}>
          Request a new reset link
        </Link>
      </div>
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const errors: typeof fieldError = {};
    if (password.length < MIN_PASSWORD) errors.password = `Use at least ${MIN_PASSWORD} characters.`;
    if (password !== confirm) errors.confirm = "The passwords do not match.";
    setFieldError(errors);
    if (errors.password || errors.confirm) {
      focusFirstInvalid(event.currentTarget as HTMLFormElement);
      return;
    }

    setBusy(true);
    const result = await post("password/reset", { token: token ?? "", password });
    setBusy(false);
    if (!result.ok) {
      setFieldError({ password: result.fields.password });
      return setError(failureText(result, ["password"]));
    }
    setPassword("");
    setConfirm("");
    setDone(message(result, "Your password has been changed."));
  }

  if (done) {
    return (
      <SuccessBox text={done}>
        <p className="mt-1">
          <Link href="/account/login" className={LINK_TARGET}>
            Sign in
          </Link>
        </p>
      </SuccessBox>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <PasswordField
        label="New password"
        name="newPassword"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD} characters. This signs you out on every device.`}
        error={fieldError.password}
      />
      <PasswordField
        label="Confirm new password"
        name="confirmNewPassword"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        error={fieldError.confirm}
      />
      <ErrorBox text={error} />
      {error && (
        <Link href="/account/forgot-password" className={`${LINK_TARGET} text-sm`}>
          Request a new reset link
        </Link>
      )}
      <Submit busy={busy} busyLabel="Saving…">
        Set new password
      </Submit>
    </form>
  );
}
