"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "@/components/ui/Button";
import { fieldErrorId, invalidProps, readApiError, summaryMessage } from "@/lib/api-errors";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { Card, EmptyState, Notice, Pill, type Tone } from "@/components/ui/Surface";
import { confirmDialog } from "@/components/ui/ConfirmDialog";

interface MemberUser {
  _id: string;
  name: string;
  email: string;
}

interface Member {
  _id: string;
  role: "owner" | "staff" | "manager";
  status: "active" | "invited" | "disabled";
  user: MemberUser | null;
}

const quietDangerClass =
  "inline-flex min-h-10 items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

const ROLE_LABEL: Record<Member["role"], string> = { owner: "Owner", manager: "Manager", staff: "Staff" };

const ROLE_BADGE: Record<Member["role"], string> = {
  owner: "bg-slate-900 text-white",
  manager: "bg-slate-200 text-slate-800",
  staff: "bg-slate-100 text-slate-700",
};

interface Invitation {
  id: string;
  email: string;
  role: Member["role"];
  state: "pending" | "expired" | "accepted" | "revoked";
  expiresAt: string;
  lastSentAt?: string;
  acceptedAt?: string | null;
  revokedAt?: string | null;
  expired: boolean;
}

const INVITATION_STATE: Record<Invitation["state"], { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "info" },
  expired: { label: "Expired", tone: "warning" },
  accepted: { label: "Accepted", tone: "success" },
  revoked: { label: "Revoked", tone: "neutral" },
};

const inviteDate = (value: string) => new Date(value).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });

const NEW_ROLE_NOTICE: Record<Member["role"], string> = { owner: "an owner", manager: "a manager", staff: "staff" };

export default function MembersManager({
  businessId,
  initialMembers,
  canManage,
  staffLimit,
  currentUserId,
  primaryOwnerId,
  initialInvitations,
  inviteRoles,
  initialManagersCanInvite,
  invitationsReady = true,
}: {
  businessId: string;
  initialMembers: Member[];
  canManage: boolean;
  initialInvitations: Invitation[];
  /** What this person may invite to; empty hides the form. */
  inviteRoles: Member["role"][];
  initialManagersCanInvite: boolean;
  /** False until the database is prepared for invitations. */
  invitationsReady?: boolean;
  staffLimit: number;
  currentUserId: string;
  primaryOwnerId: string;
}) {
  const router = useRouter();
  const emailId = useId();
  const roleId = useId();

  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [invitations, setInvitations] = useState<Invitation[]>(initialInvitations);
  const [managersCanInvite, setManagersCanInvite] = useState(initialManagersCanInvite);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"staff" | "manager" | "owner">("staff");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const activeOwnerCount = members.filter(
    (member) => member.role === "owner" && member.status === "active",
  ).length;

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    if (adding) return;
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Enter the email address of the person you want to invite.");
      return;
    }
    setAdding(true);
    setError(null);
    setFieldErrors({});
    setNotice(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmedEmail, role }),
      });
      if (!res.ok) {
        const info = await readApiError(res, "Unable to send the invitation");
        setFieldErrors(info.fields);
        setError(summaryMessage(info, ["email", "role"]));
        return;
      }
      const data = (await res.json().catch(() => null)) as { invitation?: Invitation } | null;
      if (!data?.invitation) {
        setError("Unable to send the invitation");
        return;
      }
      const sent = data.invitation;
      setInvitations((current) => [sent, ...current.filter((item) => item.id !== sent.id)]);
      setNotice(`Invitation sent to ${sent.email}. They join once they accept it, and it holds a team place until then.`);
      setEmail("");
      setRole("staff");
    } catch {
      setError("Network error. No invitation was sent.");
    } finally {
      setAdding(false);
    }
  }

  async function resendInvitation(invitation: Invitation) {
    if (busyId) return;
    setError(null);
    setNotice(null);
    setBusyId(invitation.id);
    try {
      const res = await fetch(`/api/businesses/${businessId}/invitations/${invitation.id}`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as { error?: string; invitation?: Invitation } | null;
      if (!res.ok || !data?.invitation) {
        setError(data?.error ?? "Unable to send the invitation again");
        return;
      }
      const sent = data.invitation;
      setInvitations((current) => current.map((item) => (item.id === sent.id ? sent : item)));
      setNotice(`A new link was sent to ${sent.email}. The old one no longer works.`);
    } catch {
      setError("Network error. Nothing was sent.");
    } finally {
      setBusyId(null);
    }
  }

  async function revokeInvitation(invitation: Invitation) {
    if (busyId) return;
    const confirmed = await confirmDialog({ title: `Revoke the invitation to ${invitation.email}?`, message: "Its link stops working and its team place is freed. You can invite them again later.", confirmLabel: "Revoke invitation", cancelLabel: "Keep it", tone: "danger" });
    if (!confirmed) return;
    setError(null);
    setNotice(null);
    setBusyId(invitation.id);
    try {
      const res = await fetch(`/api/businesses/${businessId}/invitations/${invitation.id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? "Unable to revoke the invitation");
        return;
      }
      setInvitations((current) => current.map((item) => (item.id === invitation.id ? { ...item, state: "revoked" as const, revokedAt: new Date().toISOString() } : item)));
      setNotice(`The invitation to ${invitation.email} was revoked.`);
    } catch {
      setError("Network error. The invitation was not changed.");
    } finally {
      setBusyId(null);
    }
  }

  async function saveManagersCanInvite(next: boolean) {
    setManagersCanInvite(next);
    setError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ managersCanInvite: next }) });
      if (!res.ok) {
        setManagersCanInvite(!next);
        setError("That setting could not be saved.");
      }
    } catch {
      setManagersCanInvite(!next);
      setError("Network error. That setting was not saved.");
    }
  }

  async function changeRole(member: Member, nextRole: "owner" | "staff" | "manager") {
    if (!member.user || nextRole === member.role || busyId) return;
    setError(null);
    setNotice(null);
    setBusyId(member._id);
    try {
      const res = await fetch(`/api/businesses/${businessId}/members/${member._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? "Unable to update role");
        return;
      }
      setMembers((current) =>
        current.map((m) => (m._id === member._id ? { ...m, role: nextRole } : m)),
      );
      setNotice(`${member.user.name} is now ${NEW_ROLE_NOTICE[nextRole]}.`);
      router.refresh();
    } catch {
      setError("Network error. The member list was not changed.");
    } finally {
      setBusyId(null);
    }
  }

  async function removeMember(id: string) {
    const member = members.find((m) => m._id === id);
    if (!member || busyId) return;
    setError(null);
    setNotice(null);
    setBusyId(id);
    try {
      const res = await fetch(`/api/businesses/${businessId}/members/${id}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? "Unable to remove member");
        return;
      }
      setMembers((current) => current.filter((m) => m._id !== id));
      setNotice(
        member.user ? `${member.user.name} was removed from the team.` : "Member removed.",
      );
      router.refresh();
    } catch {
      setError("Network error. The member list was not changed.");
    } finally {
      setBusyId(null);
    }
  }

  async function requestRemove(member: Member) {
    const name = memberName(member);
    const confirmed = await confirmDialog({ title: `Remove ${name} from the team?`, message: "They will immediately lose access to this business. This cannot be undone.", confirmLabel: `Remove ${name}`, tone: "danger" });
    if (confirmed) void removeMember(member._id);
  }

  function isSelf(member: Member) {
    return Boolean(member.user && member.user._id === currentUserId);
  }

  function isPrimary(member: Member) {
    return Boolean(member.user && member.user._id === primaryOwnerId);
  }

  function isLastActiveOwner(member: Member) {
    return member.role === "owner" && member.status === "active" && activeOwnerCount <= 1;
  }

  // Owners can manage everyone except themselves; the primary owner and the
  // last active owner are locked by the server. These checks only drive UI
  // affordances — the API remains the security boundary.
  function managesMember(member: Member) {
    return canManage && Boolean(member.user) && !isSelf(member);
  }

  function roleIsLocked(member: Member) {
    return isPrimary(member) || isLastActiveOwner(member);
  }

  function memberName(member: Member) {
    return member.user?.name ?? "Unknown user";
  }

  function memberEmail(member: Member) {
    return member.user?.email ?? "No account linked";
  }

  // A waiting invitation holds a place; the server counts it the same way.
  const waitingInvitations = invitations.filter((item) => item.state === "pending").length;
  const openInvitations = invitations.filter((item) => item.state === "pending" || item.state === "expired");
  const pastInvitations = invitations.filter((item) => item.state === "accepted" || item.state === "revoked");
  const atMemberLimit = members.length + waitingInvitations >= staffLimit + 1;

  return (
    <Card className="p-5 sm:p-6">
      <div className="sr-only" role="status" aria-live="polite">
        {notice ?? ""}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive">
        {error ?? ""}
      </div>

      {(error || notice) && (
        <Notice tone={error ? "danger" : "success"} className="mb-5">
          {error ?? notice}
        </Notice>
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-900">Team members</h2>
        <span className="text-sm text-slate-500">
          {members.length} / {staffLimit + 1} member limit
          {waitingInvitations > 0 ? ` · ${waitingInvitations} invitation${waitingInvitations === 1 ? "" : "s"} waiting` : ""}
        </span>
      </div>

      <details className="mt-1 text-sm text-slate-600">
        <summary className="inline-flex min-h-10 cursor-pointer select-none items-center rounded font-medium text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2">
          What can each role do?
        </summary>
        <dl className="mb-2 mt-1 space-y-2 rounded-xl bg-slate-50 p-4 text-xs leading-5">
          <div>
            <dt className="font-semibold text-slate-900">Owner</dt>
            <dd>Full control of the business, including billing, team members, domains, publishing, settings and content.</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-900">Manager</dt>
            <dd>Business settings, branding, pages, products, media and publishing. No billing, team members, domains or ownership transfer.</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-900">Staff</dt>
            <dd>Day-to-day product and media tasks. No settings, pages, publishing, billing, domains or team members.</dd>
          </div>
        </dl>
      </details>

      {members.length === 0 ? (
        <EmptyState title="No team members yet" className="mt-4">
          Invite your first member below. They can create a SiteForge account from the link if they don&apos;t have one.
        </EmptyState>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100">
          {members.map((member) => {
            const locked = roleIsLocked(member) && managesMember(member);

            return (
              <li
                key={member._id}
                className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="flex h-10 w-10 shrink-0 select-none items-center justify-center rounded-full bg-slate-100 font-heading text-sm font-semibold text-slate-700"
                  >
                    {memberName(member).trim().charAt(0).toUpperCase() || "?"}
                  </span>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5">
                      <span className="min-w-0 break-words font-medium text-slate-900">{memberName(member)}</span>
                      {isSelf(member) && <Pill tone="ember">You</Pill>}
                      <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${ROLE_BADGE[member.role]}`}>
                        {ROLE_LABEL[member.role]}
                      </span>
                      {isPrimary(member) && <Pill>Primary owner</Pill>}
                      {member.status !== "active" && (
                        <Pill tone="warning" className="capitalize">{member.status}</Pill>
                      )}
                    </p>
                    <p className="truncate text-sm text-slate-500">{memberEmail(member)}</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                  {managesMember(member) && !locked && (
                    <select
                      value={member.role}
                      disabled={busyId !== null}
                      onChange={(e) =>
                        changeRole(member, e.target.value as "owner" | "staff" | "manager")
                      }
                      aria-label={`Role for ${memberName(member)}`}
                      className="min-h-10 rounded-lg border px-3 py-2 text-sm text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <option value="owner">Owner</option>
                      <option value="manager">Manager</option>
                      <option value="staff">Staff</option>
                    </select>
                  )}

                  {managesMember(member) && locked && (
                    <span className="text-xs text-slate-500">
                      {isLastActiveOwner(member)
                        ? "Last active owner — cannot be changed"
                        : "Primary owner — cannot be changed"}
                    </span>
                  )}

                  {managesMember(member) && !locked && member.user != null && (
                    <button
                      type="button"
                      onClick={() => void requestRemove(member)}
                      disabled={busyId !== null}
                      aria-busy={busyId === member._id}
                      className={quietDangerClass}
                    >
                      {busyId === member._id ? "Removing…" : "Remove"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canManage && atMemberLimit && (
        <Notice
          tone="info"
          className="mt-4"
          action={
            <ButtonLink href={`/dashboard/businesses/${businessId}/billing`} variant="secondary">
              Compare plans
            </ButtonLink>
          }
        >
          Every team place on your plan is taken or held by a waiting invitation. Remove a member, revoke an invitation, or move to a plan with more room to add someone new.
        </Notice>
      )}

      {!invitationsReady && inviteRoles.length > 0 && (
        <Notice tone="warning" className="mt-6">
          Team invitations are not switched on yet, because a database step has not been done. Your current team is not affected.
        </Notice>
      )}

      {openInvitations.length > 0 && (
        <div className="mt-6 border-t border-slate-200 pt-5">
          <h3 className="text-sm font-semibold text-slate-900">Open invitations</h3>
          <p className="mt-1 text-xs text-slate-500">A pending invitation holds a team place. An expired one does not, and sending it again needs a free place.</p>
          <ul className="mt-3 space-y-2">
            {openInvitations.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 break-words font-medium text-slate-900">{invitation.email}</span>
                <Pill tone={INVITATION_STATE[invitation.state].tone} dot>{INVITATION_STATE[invitation.state].label}</Pill>
                <span className="text-xs text-slate-600">
                  {ROLE_LABEL[invitation.role]} · {invitation.state === "expired" ? `expired ${inviteDate(invitation.expiresAt)}` : `expires ${inviteDate(invitation.expiresAt)}`}
                </span>
                {inviteRoles.includes(invitation.role) && (
                  <span className="flex gap-1">
                    <Button variant="ghost" disabled={busyId === invitation.id || !invitationsReady} onClick={() => void resendInvitation(invitation)}>Send again</Button>
                    <Button variant="ghost" disabled={busyId === invitation.id} onClick={() => void revokeInvitation(invitation)}>Revoke</Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {pastInvitations.length > 0 && (
        <details className="mt-4 text-sm text-slate-600">
          <summary className="inline-flex min-h-10 cursor-pointer select-none items-center rounded font-medium text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2">
            Past invitations ({pastInvitations.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {pastInvitations.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-slate-50 px-3 py-2">
                <span className="min-w-0 flex-1 break-words text-slate-800">{invitation.email}</span>
                <Pill tone={INVITATION_STATE[invitation.state].tone} dot>{INVITATION_STATE[invitation.state].label}</Pill>
                <span className="text-xs text-slate-600">
                  {ROLE_LABEL[invitation.role]}
                  {invitation.state === "accepted" && invitation.acceptedAt ? ` · ${inviteDate(invitation.acceptedAt)}` : ""}
                  {invitation.state === "revoked" && invitation.revokedAt ? ` · ${inviteDate(invitation.revokedAt)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {inviteRoles.length > 0 && invitationsReady && (
        <form onSubmit={invite} className="mt-6 border-t border-slate-200 pt-5">
          <h3 className="text-sm font-semibold text-slate-900">Invite a team member</h3>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label htmlFor={emailId} className={labelClass}>
                Invite by email
              </label>
              <input
                id={emailId}
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@example.com"
                className={inputClass}
                {...invalidProps(fieldErrors, "email", "invite")}
              />
              <FieldError id={fieldErrorId("invite", "email")} message={fieldErrors.email} />
            </div>
            <div>
              <label htmlFor={roleId} className={labelClass}>
                Role
              </label>
              <select
                id={roleId}
                value={role}
                onChange={(e) => setRole(e.target.value as "staff" | "manager" | "owner")}
                className={inputClass}
              >
                {inviteRoles.includes("staff") && <option value="staff">Staff</option>}
                {inviteRoles.includes("manager") && <option value="manager">Manager</option>}
                {inviteRoles.includes("owner") && <option value="owner">Owner</option>}
              </select>
              <FieldError message={fieldErrors.role} />
            </div>
            <Button type="submit" disabled={adding} className="w-full sm:w-auto">
              {adding ? "Sending…" : "Send invitation"}
            </Button>
          </div>
          <div className="mt-3 text-xs leading-5 text-slate-500">
            <p>We email a link that lasts 7 days. Until they accept, they have no access to this business.</p>
            <p className="mt-1">To accept, they open the link and log in with this same address. If they have no account, they create one with this address and confirm it first. A different address cannot accept. Sending again replaces the old link.</p>
          </div>
        </form>
      )}

      {canManage && (
        <label className="mt-5 flex items-start gap-2 border-t border-slate-200 pt-5 text-sm text-slate-700">
          <input type="checkbox" className="mt-0.5" checked={managersCanInvite} onChange={(event) => void saveManagersCanInvite(event.target.checked)} />
          <span>Let managers invite staff. Managers can never invite other managers or owners.</span>
        </label>
      )}
    </Card>
  );
}
