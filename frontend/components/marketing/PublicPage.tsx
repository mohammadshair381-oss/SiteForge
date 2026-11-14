import Link from "next/link";
import type { ReactNode } from "react";
import SiteHeader from "./SiteHeader";
import SiteFooter, { footerLinkClass } from "./SiteFooter";

/** Frame of a public page: header, content and footer on the platform surface. */
export default function PublicPage({ authed = false, children }: { authed?: boolean; children: ReactNode }) {
  return (
    <div className="app-surface flex min-h-screen flex-col bg-white text-slate-900">
      <SiteHeader authed={authed} />
      <main className="flex-1">{children}</main>
      <SiteFooter>
        <Link href="/terms" className={footerLinkClass}>
          Terms of Service
        </Link>
        <Link href="/privacy" className={footerLinkClass}>
          Privacy Policy
        </Link>
      </SiteFooter>
    </div>
  );
}
