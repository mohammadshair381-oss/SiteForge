import { Suspense } from "react";
import AuthShell from "@/components/auth/AuthShell";
import VerifyEmailClient from "@/components/auth/VerifyEmailClient";

export const dynamic = "force-dynamic";

export default function VerifyEmailPage() {
  return (
    <AuthShell>
      <Suspense
        fallback={
          <p role="status" className="text-sm text-slate-600">
            Checking your verification link…
          </p>
        }
      >
        <VerifyEmailClient />
      </Suspense>
    </AuthShell>
  );
}
