"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { apiErrorFrom, fieldErrorId, invalidProps, summaryMessage } from "@/lib/api-errors";
import { Notice } from "@/components/ui/Surface";
import AdminDialog from "./AdminDialog";
import { dangerSmallButtonClass, smallButtonClass } from "./ControlCenterUI";

type Action = "deactivate" | "reactivate" | "grant_super_admin" | "revoke_super_admin" | "force_signout";

/** Keep in sync with ADMIN_REASON_MIN in lib/admin-audit.ts (server enforces it). */
const REASON_MIN = 5;

const COPY: Record<Action, { button: string; title: string; body: string; confirm: string; danger: boolean }> = {
  deactivate: {
    button: "Deactivate",
    title: "Deactivate this account?",
    body: "The user is signed out everywhere and cannot sign in. Their businesses and business roles are not changed; storefronts keep running.",
    confirm: "Deactivate account",
    danger: true,
  },
  reactivate: {
    button: "Reactivate",
    title: "Reactivate this account?",
    body: "The user can sign in again with their existing password. Platform role and business roles are unchanged.",
    confirm: "Reactivate account",
    danger: false,
  },
  grant_super_admin: {
    button: "Make super admin",
    title: "Grant platform super admin rights?",
    body: "Super admins can suspend any business, change plans and manage every platform account. They are signed out and must sign in again. Business roles are not affected.",
    confirm: "Grant super admin",
    danger: true,
  },
  revoke_super_admin: {
    button: "Remove super admin",
    title: "Remove platform super admin rights?",
    body: "The user becomes an ordinary platform user and is signed out. Their business roles (owner, manager, staff) are not affected. The last active super admin cannot be removed.",
    confirm: "Remove super admin",
    danger: true,
  },
  force_signout: {
    button: "Sign out everywhere",
    title: "End all of this user's sessions?",
    body: "Every signed-in browser and device of this user is signed out on its next request, and each must confirm an emailed sign-in code the next time it signs in. The account stays active.",
    confirm: "Sign out everywhere",
    danger: false,
  },
};

/**
 * Account actions for one platform user. The server re-checks everything
 * (super admin, self-action, last admin, password for role changes); this
 * component only collects an explicit confirmation and a reason.
 */
export default function UserAdminActions({
  user,
  isSelf,
}: {
  user: { id: string; name: string; platformRole: string; active: boolean };
  isSelf: boolean;
}) {
  const router = useRouter();
  const reasonId = useId();
  const passwordId = useId();
  const [pending, setPending] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  if (isSelf) return <span className="text-xs text-slate-500">Your account</span>;

  const actions: Action[] = user.active
    ? [user.platformRole === "super_admin" ? "revoke_super_admin" : "grant_super_admin", "force_signout", "deactivate"]
    : ["reactivate"];
  const needsPassword = pending === "grant_super_admin" || pending === "revoke_super_admin";

  function open(action: Action) {
    setPending(action);
    setReason("");
    setPassword("");
    setError(null);
    setFieldErrors({});
    setNotice(null);
  }

  async function submit() {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: pending, reason: reason.trim(), ...(needsPassword ? { currentPassword: password } : {}) }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; code?: string; fields?: unknown } | null;
      if (!res.ok) {
        const info = apiErrorFrom(data, "The account was not changed.");
        // A wrong password is reported by code rather than by field.
        const fields = /password/.test(info.code ?? "") ? { ...info.fields, currentPassword: info.message } : info.fields;
        setFieldErrors(fields);
        setError(summaryMessage({ ...info, fields }, ["reason", "currentPassword"]));
        return;
      }
      setNotice(`${COPY[pending].confirm}: done.`);
      setPending(null);
      router.refresh();
    } catch {
      setError("Network error. The account was not changed.");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  const copy = pending ? COPY[pending] : null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {actions.map((action) => (
        <button key={action} type="button" onClick={() => open(action)} className={COPY[action].danger ? dangerSmallButtonClass : smallButtonClass}>
          {COPY[action].button}
        </button>
      ))}
      {notice && <span role="status" className="w-full text-xs text-emerald-800">{notice}</span>}

      {copy && pending && (
        <AdminDialog
          title={copy.title}
          busy={busy}
          onClose={() => setPending(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setPending(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant={copy.danger ? "danger" : "primary"} onClick={() => void submit()} disabled={busy || reason.trim().length < REASON_MIN || (needsPassword && !password)}>
                {busy ? "Saving…" : copy.confirm}
              </Button>
            </>
          }
        >
          <p className="mt-1 font-medium text-slate-800">{user.name}</p>
          <p className="mt-2 leading-6 text-slate-600">{copy.body}</p>
          <label htmlFor={reasonId} className={`mt-4 ${labelClass}`}>Reason (recorded in the audit log)</label>
          <textarea id={reasonId} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} {...invalidProps(fieldErrors, "reason", `user-${user.id}`)} />
          <p className="mt-1.5 text-xs text-slate-500">At least {REASON_MIN} characters.</p>
          <FieldError id={fieldErrorId(`user-${user.id}`, "reason")} message={fieldErrors.reason} />
          {needsPassword && (
            <>
              <label htmlFor={passwordId} className={`mt-3 ${labelClass}`}>Your password (to confirm a role change)</label>
              <input id={passwordId} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} {...invalidProps(fieldErrors, "currentPassword", `user-${user.id}`)} />
              <FieldError id={fieldErrorId(`user-${user.id}`, "currentPassword")} message={fieldErrors.currentPassword} />
            </>
          )}
          {error && (
            <Notice tone="danger" role="alert" className="mt-3">
              {error}
            </Notice>
          )}
        </AdminDialog>
      )}
    </div>
  );
}
