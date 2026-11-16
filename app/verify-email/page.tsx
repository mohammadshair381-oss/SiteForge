import { redirect } from "next/navigation";

/**
 * Email addresses are confirmed with an emailed six-digit code now (signup, or the first login), not
 * a link. An old link lands here and is sent to log in, which emails a code. Nothing in the link is read.
 */
export default function VerifyEmailPage() {
  redirect("/login");
}
