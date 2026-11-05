import Link from "next/link";
import { Logo } from "@/components/ui/Logo";
import { buttonClass } from "@/components/ui/Button";
import SupportContact from "@/components/ui/SupportContact";

export default function NotFound() {
  return (
    <main className="app-surface relative isolate flex min-h-screen flex-col items-center justify-center overflow-hidden bg-ink px-6 py-16 text-center text-white">
      <div aria-hidden="true" className="ui-dots absolute inset-0 -z-10" />
      <div aria-hidden="true" className="ui-ember-glow absolute inset-0 -z-10" />
      <Link href="/" aria-label="SiteForge home" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-soft focus-visible:ring-offset-2 focus-visible:ring-offset-ink">
        <Logo tone="light" />
      </Link>
      <p className="mt-12 font-heading text-7xl font-semibold tracking-tight text-ember-soft sm:text-8xl">404</p>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">We couldn&apos;t find that page</h1>
      <p className="mt-3 max-w-md text-white/70">The link may be old, or the page may have moved. Nothing is wrong with your account.</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link href="/dashboard" className={buttonClass({ variant: "invert" })}>
          Go to your dashboard
        </Link>
        <Link href="/" className={buttonClass({ variant: "outline-light" })}>
          SiteForge home
        </Link>
      </div>
      <SupportContact className="mt-6 text-sm text-white/70" />
    </main>
  );
}
