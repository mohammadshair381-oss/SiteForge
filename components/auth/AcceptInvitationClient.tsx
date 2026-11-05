"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthHeading, authLink } from "./AuthShell";
import { buttonClass } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Surface";
import { useLinkToken } from "@/lib/use-link-token";

interface Details {
  businessName: string;
  role: "owner" | "manager" | "staff";
  email: string;
  signedIn: boolean;
  sameAccount: boolean;
}

const ROLE_TEXT: Record<Details["role"], string> = { owner: "an owner", manager: "a manager", staff: "a staff member" };
const STORAGE_KEY = "sf_invitation";

/**
 * Joining a team is the person's own choice: the link only shows the invitation.
 * The token stays in this tab while they log in, and leaves with the tab.
 */
export default function AcceptInvitationClient() {
  const router = useRouter();
  const linkToken = useLinkToken();
  const [token, setToken] = useState<string | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (value: string) => {
    try {
      const res = await fetch("/api/invitations/inspect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: value }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setDetails(data as Details);
      else setProblem((data as { error?: string }).error ?? "This invitation is no longer valid.");
    } catch {
      setProblem("We could not reach the server. Check your connection and try again.");
    }
  }, []);

  useEffect(() => {
    if (linkToken === null) return;
    let value = linkToken;
    try {
      if (value) window.sessionStorage.setItem(STORAGE_KEY, value);
      else value = window.sessionStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
      // Storage can be blocked; the link in the email still works.
    }
    if (!value) {
      setProblem("This invitation link is incomplete. Open it again from your email.");
      return;
    }
    setToken(value);
    void load(value);
  }, [linkToken, load]);

  async function accept() {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch("/api/invitations/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setProblem((data as { error?: string }).error ?? "This invitation could not be accepted.");
        return;
      }
      try {
        window.sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        // Nothing to clean up if storage is blocked.
      }
      router.push(`/dashboard/businesses/${(data as { businessId: string }).businessId}`);
      router.refresh();
    } catch {
      setProblem("We could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (problem && !details) {
    return (
      <div>
        <AuthHeading title="Invitation problem">
          <span role="alert">{problem}</span>
        </AuthHeading>
        <p className="mt-6 text-sm text-slate-600">
          <Link href="/dashboard" className={authLink}>Go to your dashboard</Link>
        </p>
      </div>
    );
  }
  if (!details) {
    return <p role="status" aria-live="polite" className="text-sm text-slate-600">Checking your invitation…</p>;
  }

  return (
    <div>
      <AuthHeading title={`Join ${details.businessName}`}>
        You have been invited to join {details.businessName} on SiteForge as {ROLE_TEXT[details.role]}.
      </AuthHeading>
      {problem && <Notice tone="danger" role="alert" className="mt-6">{problem}</Notice>}
      {details.sameAccount ? (
        <button type="button" onClick={() => void accept()} disabled={busy} className={buttonClass({ block: true, size: "lg", className: "mt-6" })}>
          {busy ? "Joining…" : "Accept invitation"}
        </button>
      ) : details.signedIn ? (
        <Notice tone="warning" className="mt-6">
          This invitation was sent to {details.email}. Log out, then log in with that address to accept it.
        </Notice>
      ) : (
        <div className="mt-6 space-y-3">
          <p className="text-sm text-slate-600">Log in with {details.email} to accept.</p>
          <Link href="/login?next=/invitations/accept" className={buttonClass({ block: true, size: "lg" })}>
            Log in
          </Link>
          <p className="text-sm text-slate-600">
            New to SiteForge? <Link href="/register" className={authLink}>Create an account</Link> with this address,
            confirm it, then open this invitation again from your email.
          </p>
        </div>
      )}
    </div>
  );
}
