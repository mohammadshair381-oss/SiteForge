import type { Metadata } from "next";
import AuthShell from "@/components/auth/AuthShell";
import AcceptInvitationClient from "@/components/auth/AcceptInvitationClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Team invitation", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function AcceptInvitationPage() {
  return (
    <AuthShell>
      <AcceptInvitationClient />
    </AuthShell>
  );
}
