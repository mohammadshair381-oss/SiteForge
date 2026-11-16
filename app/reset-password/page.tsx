import { redirect } from "next/navigation";

/**
 * Passwords are reset with an emailed six-digit code now (/forgot-password), not a link. An old link
 * lands here and is sent to start over. Nothing in the link is read.
 */
export default function ResetPasswordPage() {
  redirect("/forgot-password");
}
