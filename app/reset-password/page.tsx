import { Suspense } from "react";
import AuthShell from "@/components/auth/AuthShell";
import ResetPasswordForm from "@/components/auth/ResetPasswordForm";

export const dynamic = "force-dynamic";

export default function ResetPasswordPage() {
  return (
    <AuthShell>
      <Suspense
        fallback={
          <p role="status" className="text-sm text-slate-600">
            Loading…
          </p>
        }
      >
        <ResetPasswordForm />
      </Suspense>
    </AuthShell>
  );
}
