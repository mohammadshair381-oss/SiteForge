import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { Logo } from "@/components/ui/Logo";
import { buttonClass } from "@/components/ui/Button";
import SupportContact from "@/components/ui/SupportContact";
import { isProduction } from "@/lib/env";
import { storeLinkRoot } from "@/lib/host";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Customer accounts are on each store" },
  robots: { index: false, follow: false },
  // An old reset or verification link may carry a token in its address.
  referrer: "no-referrer",
};

/**
 * `/account/*` on the PLATFORM host. Customer accounts belong to one business,
 * which comes only from the store's Host (middleware rewrites store hosts to
 * `/store/account/*` before this route can match), so there is no sign-in here:
 * this page only says where to go. It reads no data and never echoes the path
 * or query, and it is deliberately not a form.
 */
export default async function PlatformAccountHelp() {
  const root = storeLinkRoot((await headers()).get("host"));
  const example = `${isProduction() ? "https" : "http"}://your-store.${root}/account/login`;

  return (
    <main className="app-surface relative isolate flex min-h-screen flex-col items-center justify-center overflow-hidden bg-ink px-6 py-16 text-center text-white">
      <div aria-hidden="true" className="ui-dots absolute inset-0 -z-10" />
      <div aria-hidden="true" className="ui-ember-glow absolute inset-0 -z-10" />
      <Link href="/" aria-label="SiteForge home" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-soft focus-visible:ring-offset-2 focus-visible:ring-offset-ink">
        <Logo tone="light" />
      </Link>
      <h1 className="mt-12 text-2xl font-semibold tracking-tight sm:text-3xl">Customer accounts are on each store</h1>
      <p className="mt-3 max-w-lg text-white/70">
        Each store keeps its own customer accounts. Open the website of the store you shop at and choose Sign in there.
      </p>
      <p className="mt-6 max-w-full break-all rounded-lg border border-white/15 bg-white/5 px-4 py-2 font-mono text-sm text-white/85">{example}</p>
      <p className="mt-2 max-w-lg text-sm text-white/60">
        Replace <span className="font-mono">your-store</span> with the store&apos;s web address. The store must be published.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link href="/dashboard" className={buttonClass({ variant: "invert" })}>
          Business owner? Go to your dashboard
        </Link>
        <Link href="/" className={buttonClass({ variant: "outline-light" })}>
          SiteForge home
        </Link>
      </div>
      <p className="mt-6 max-w-lg text-sm text-white/60">For anything about an order, contact the store you bought from.</p>
      <SupportContact label="Run a store and need help?" className="mt-1 max-w-lg text-sm text-white/60" />
    </main>
  );
}
