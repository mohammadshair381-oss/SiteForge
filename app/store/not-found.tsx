import type { Metadata } from "next";
import Link from "next/link";

// Set here so a shopper on a business's own website never sees the platform's
// default title or description on a missing page.
export const metadata: Metadata = {
  title: { absolute: "Page not found" },
  description: "This page could not be found.",
  robots: { index: false, follow: false },
};

/** A store's missing page: neutral and unbranded, with no data access. */
export default function StoreNotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-4 py-16 text-slate-900">
      <div className="w-full max-w-md text-center">
        <p className="text-sm font-medium text-slate-500">Page not found</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">We couldn&apos;t find that page</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">The link may be out of date, or the page may have moved.</p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
        >
          Go to the home page
        </Link>
      </div>
    </main>
  );
}
