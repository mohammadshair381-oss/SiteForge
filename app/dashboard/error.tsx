"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { buttonClass } from "@/components/ui/Button";
import SupportContact from "@/components/ui/SupportContact";

export default function DashboardError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <div role="alert" className="mx-auto mt-8 max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-red-50 text-red-700">
        <Icon name="alert" size={20} />
      </span>
      <h2 ref={headingRef} tabIndex={-1} className="mt-4 text-lg font-semibold text-slate-900 outline-none">
        Something went wrong
      </h2>
      <p className="mt-1.5 text-sm leading-6 text-slate-600">
        We couldn&apos;t load this page. Your work is safe: nothing was changed. Please try again.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={() => reset()} className={buttonClass()}>
          Try again
        </button>
        <Link href="/dashboard" className={buttonClass({ variant: "secondary" })}>
          All businesses
        </Link>
      </div>
      <SupportContact label="If this keeps happening:" className="mt-4 text-sm text-slate-600" />
    </div>
  );
}
