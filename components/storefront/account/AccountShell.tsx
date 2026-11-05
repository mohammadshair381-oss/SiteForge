import React from "react";
import Link from "next/link";
import { skinFor } from "@/components/storefront/commerce/skins";
import SignOutButton from "./SignOutButton";

const LINKS = [
  { key: "overview", label: "Overview", href: "/account" },
  { key: "orders", label: "Orders", href: "/account/orders" },
  { key: "addresses", label: "Addresses", href: "/account/addresses" },
  { key: "profile", label: "Profile", href: "/account/profile" },
] as const;

export type AccountSection = (typeof LINKS)[number]["key"];

const ACTIVE = { background: "var(--sf-accent)", color: "var(--sf-accent-text)" };

/**
 * The signed-in account frame: heading, navigation and page content, arranged
 * by the theme (`layout.account`) inside the store's own header and footer.
 * - rail: a side column on large screens (dashboard-like stores);
 * - tabs: a centred heading over underlined tabs (editorial stores);
 * - blocks: joined, bordered cells (poster-like stores).
 * On phones the links become one row that scrolls sideways, with full-size
 * touch targets, and the content takes the full width.
 */
export default function AccountShell({
  themeId,
  customerName,
  active,
  title,
  intro,
  children,
}: {
  themeId: string;
  customerName: string;
  active: AccountSection;
  title: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
}) {
  const layout = skinFor(themeId).layout.account;

  const heading = (
    <div className={layout === "tabs" ? "text-center" : ""}>
      <h1 className="sf-acc-title break-words font-display text-3xl sm:text-4xl">{title}</h1>
      {intro && <div className="sf-acc-muted mt-2 text-sm leading-6 sm:text-base">{intro}</div>}
    </div>
  );

  const signOutClass = "sf-acc-focus inline-flex min-h-11 items-center whitespace-nowrap px-3 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none disabled:opacity-60";

  if (layout === "rail") {
    return (
      <div data-account-layout="rail" className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-10">
        <div className="sf-acc-card mb-6 p-2 lg:sticky lg:top-24 lg:mb-0 lg:p-3">
          <p className="sf-acc-muted hidden truncate px-3 pb-3 pt-2 text-sm lg:block">{customerName}</p>
          <nav aria-label="Account pages" className="sf-scroll-x flex items-center gap-1 overflow-x-auto overflow-y-hidden lg:flex-col lg:items-stretch lg:overflow-visible">
            {LINKS.map((link) => (
              <Link
                key={link.key}
                href={link.href}
                aria-current={active === link.key ? "page" : undefined}
                className="sf-acc-control sf-acc-focus inline-flex min-h-11 shrink-0 items-center px-4 text-sm font-medium transition-opacity hover:opacity-80 focus-visible:outline-none"
                style={active === link.key ? ACTIVE : undefined}
              >
                {link.label}
              </Link>
            ))}
            <div className="sf-acc-rule shrink-0 lg:mt-2 lg:border-t lg:pt-2">
              <SignOutButton className={signOutClass} />
            </div>
          </nav>
        </div>
        <div className="min-w-0">
          {heading}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    );
  }

  if (layout === "blocks") {
    return (
      <div data-account-layout="blocks">
        {heading}
        <nav aria-label="Account pages" className="sf-scroll-x sf-acc-rule mt-6 flex overflow-x-auto overflow-y-hidden border-2">
          {LINKS.map((link) => (
            <Link
              key={link.key}
              href={link.href}
              aria-current={active === link.key ? "page" : undefined}
              className="sf-acc-rule sf-acc-focus inline-flex min-h-12 shrink-0 flex-1 items-center justify-center border-r-2 px-5 text-sm font-bold uppercase tracking-wide focus-visible:outline-none"
              style={active === link.key ? ACTIVE : undefined}
            >
              {link.label}
            </Link>
          ))}
          <div className="flex shrink-0 items-center px-2">
            <SignOutButton className={`${signOutClass} font-bold uppercase tracking-wide`} />
          </div>
        </nav>
        <div className="mt-8">{children}</div>
      </div>
    );
  }

  return (
    <div data-account-layout="tabs" className="mx-auto max-w-4xl">
      {heading}
      <nav aria-label="Account pages" className="sf-scroll-x sf-acc-rule mt-8 flex items-center gap-1 overflow-x-auto overflow-y-hidden border-b sm:justify-center sm:gap-4">
        {LINKS.map((link) => (
          <Link
            key={link.key}
            href={link.href}
            aria-current={active === link.key ? "page" : undefined}
            className={`sf-acc-focus inline-flex min-h-12 shrink-0 items-center border-b-2 px-3 text-sm font-medium focus-visible:outline-none ${active === link.key ? "border-current" : "sf-acc-muted border-transparent hover:border-current"}`}
          >
            {link.label}
          </Link>
        ))}
        <div className="shrink-0">
          <SignOutButton className={`${signOutClass} sf-acc-muted`} />
        </div>
      </nav>
      <div className="mt-8">{children}</div>
    </div>
  );
}
