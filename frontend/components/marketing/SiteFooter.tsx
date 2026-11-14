import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/ui/Logo";

const focusLight = "rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-soft focus-visible:ring-offset-2 focus-visible:ring-offset-ink";
export const footerLinkClass = `block text-white/60 transition-colors hover:text-white ${focusLight}`;

const COLUMNS = [
  { title: "Product", links: [["/#build", "Website builder"], ["/#sell", "Selling online"], ["/themes", "Themes"], ["/pricing", "Pricing"]] },
  { title: "Account", links: [["/login", "Log in"], ["/register", "Create an account"], ["/dashboard", "Dashboard"]] },
] as const;

/** Public footer. `children` holds the legal links. */
export default function SiteFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="bg-ink px-4 pb-10 pt-14 text-sm sm:px-6">
      <div className="mx-auto flex max-w-7xl flex-col justify-between gap-10 md:flex-row">
        <div className="max-w-xs">
          <Logo tone="light" />
          <p className="mt-3 leading-6 text-white/60">Everything a business needs to look professional online and sell from its own store.</p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-14 gap-y-8 sm:grid-cols-3">
          {COLUMNS.map((column) => (
            <div key={column.title} className="space-y-2.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-white/40">{column.title}</p>
              {column.links.map(([href, label]) => (
                <Link key={href} href={href} className={footerLinkClass}>
                  {label}
                </Link>
              ))}
            </div>
          ))}
          <div className="space-y-2.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-white/40">Legal</p>
            {children}
          </div>
        </nav>
      </div>
      <p className="mx-auto mt-12 max-w-7xl border-t border-white/10 pt-6 text-xs text-white/40">© {new Date().getFullYear()} SiteForge</p>
    </footer>
  );
}
