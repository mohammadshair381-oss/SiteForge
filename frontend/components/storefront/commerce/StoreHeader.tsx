import React from "react";
import Link from "next/link";
import type { StorefrontView } from "@/lib/storefront";
import type { CommerceData, CommerceLink } from "@/lib/storefront-home";
import { readableOn, type StoreSkin } from "./skins";
import CartCount from "./CartCount";
import MobileMenu from "./MobileMenu";
import NavDropdown from "./NavDropdown";
import AccountMenu from "./AccountMenu";

/**
 * The one storefront header for every theme: announcement bar, brand, shop,
 * category and page navigation, search, account and a live cart count; on
 * small screens the links move into an accessible drawer. Only real links are
 * rendered (pages are published, categories have active products).
 *
 * The theme's `layout.header` arranges the SAME elements (see `StoreLayout`):
 * a floating pill, a coloured marketplace bar, a signboard, a minimal row,
 * joined slab cells, a centred masthead, a console, a grocer's search and chips,
 * or a row of words without icons.
 */
export default function StoreHeader({
  view,
  commerce,
  skin,
  preview,
  editable,
}: {
  view: StorefrontView;
  commerce: CommerceData;
  skin: StoreSkin;
  preview?: boolean;
  editable?: boolean;
}) {
  const { theme } = view;
  // The owner's choices. "theme" (the default everywhere) keeps exactly what the theme does.
  const options = commerce.header.options;
  const layout = options.layout === "theme" ? skin.layout.header : options.layout;
  const sticky = options.sticky === "theme" ? skin.sticky : options.sticky === "on";
  /** Where a row's links sit, for the arrangements that have room to move them. */
  const placement = (themeDefault: "left" | "right") => (options.navAlign === "theme" ? themeDefault : options.navAlign);
  const showLogo = Boolean(view.logoUrl) && options.logoDisplay !== "name";
  const logoOnly = showLogo && options.logoDisplay === "logo";
  const logoSize = options.logoSize === "small" ? "h-7" : options.logoSize === "large" ? "h-12 lg:h-14" : "h-9 lg:h-10";
  const logoWidth = options.logoSize === "small" ? "w-7" : options.logoSize === "large" ? "w-12 lg:w-14" : "w-9 lg:w-10";
  const target = (key: string, label: string) =>
    editable ? { "data-editor-id": `header:${key}`, "data-editor-section-id": "header", "data-editor-label": label, tabIndex: 0 } : {};
  const preventNav = editable ? (e: React.MouseEvent) => e.preventDefault() : undefined;

  const hasProducts = commerce.totalProducts > 0;
  const shopLinks: CommerceLink[] = hasProducts ? [{ label: commerce.labels.shopAll, href: "/products" }] : [];
  const categoryLinks = commerce.header.categoryLinks;
  const pageLinks = commerce.header.navLinks.filter((link) => link.showOn !== "mobile");
  const mobilePageLinks = commerce.header.navLinks.filter((link) => link.showOn !== "desktop");
  // Customer accounts are a platform feature flag: when off, no account
  // entry is shown at all (the account routes would 404).
  const signedIn = Boolean(commerce.header.signedInName) || commerce.header.signedInUnverified;
  const account = commerce.header.accountsEnabled ? { signedIn, name: commerce.header.signedInName } : null;
  const announcement = commerce.announcement;
  const onPrimary = { background: theme.primaryColor, color: readableOn(theme.primaryColor) };
  // Icons on the coloured marketplace bar take its readable text colour.
  const actionClass = layout === "marketplace" ? "text-current transition-colors hover:bg-black/10" : skin.iconButton;
  // Words instead of icons on large screens.
  const wordy = layout === "textual" ? "lg:[&>svg]:hidden" : "";
  // Editorial headers set the name in type (no letter tile).
  const noTile = layout === "centered" || layout === "minimal" || layout === "signboard" || layout === "textual" || layout === "slab";
  const tileStyle = layout === "marketplace" ? { background: onPrimary.color, color: onPrimary.background } : onPrimary;

  const navLink = (l: CommerceLink, className = skin.navLink) =>
    l.children?.length ? (
      <NavDropdown key={`${l.href}-${l.label}`} label={l.label} href={l.href} external={l.external} links={l.children} className={className} panelClassName={skin.panel} linkClassName={`${skin.menuLink} ${skin.focus}`} focusClassName={skin.focus} />
    ) : (
      <a key={`${l.href}-${l.label}`} href={l.href} {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})} className={`${className} whitespace-nowrap rounded ${skin.focus}`}>{l.label}</a>
    );

  const brand = (
    <Link href="/" onClick={preventNav} {...target("brand", "Branding")} className={`flex min-w-0 items-center gap-2.5 rounded ${skin.focus}`}>
      {showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img {...target("logo", "Logo")} src={view.logoUrl} alt="" className={logoOnly ? `${logoSize} w-auto max-w-[12rem] shrink-0 object-contain` : `${logoSize} ${logoWidth} shrink-0 rounded-lg object-cover`} />
      ) : noTile || options.logoDisplay === "name" ? null : (
        <span {...target("logo", "Logo")} aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base font-bold" style={tileStyle}>
          {view.name.charAt(0).toUpperCase()}
        </span>
      )}
      <span {...target("name", "Business name")} className={logoOnly ? "sr-only" : `truncate ${skin.brand}`}>{view.name}</span>
    </Link>
  );

  const searchIcon = (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );

  // One search form per header (the shared field id).
  const searchForm = (formClass: string, inputClass: string, options: { button?: boolean; prefix?: string } = {}) =>
    hasProducts ? (
      <form action="/products" method="get" role="search" className={formClass}>
        <label htmlFor="store-search" className="sr-only">Search products</label>
        <div className="relative flex items-center">
          {options.button && <span className={`pointer-events-none absolute left-3 ${skin.subtle}`}>{searchIcon}</span>}
          {options.prefix && <span aria-hidden="true" className={`pointer-events-none absolute left-3 font-mono text-sm ${skin.subtle}`}>{options.prefix}</span>}
          <input id="store-search" type="search" name="q" placeholder="Search products" className={`w-full text-sm ${inputClass} ${skin.input} ${skin.focus}`} />
          {options.button && (
            <button type="submit" className={`absolute right-1 rounded-md px-3 py-1.5 text-xs font-semibold ${skin.focus}`} style={onPrimary}>
              Search
            </button>
          )}
        </div>
      </form>
    ) : null;

  const searchLink = (className = "md:hidden") =>
    hasProducts ? (
      <a href="/products" onClick={preventNav} className={`inline-flex h-10 min-w-10 items-center justify-center rounded-md ${className} ${actionClass} ${skin.focus}`}>
        {layout === "textual" ? (
          <>
            <span className="lg:hidden">{searchIcon}</span>
            <span className="hidden px-2 text-sm font-medium lg:inline">Search</span>
            <span className="sr-only lg:hidden">Search products</span>
          </>
        ) : (
          <>
            <span className="sr-only">Search products</span>
            {searchIcon}
          </>
        )}
      </a>
    ) : null;

  const accountMenu = account ? (
    <div className="hidden min-[340px]:block" onClick={preventNav}>
      <AccountMenu
        signedIn={account.signedIn}
        signedInName={account.name}
        preview={preview}
        className={`${actionClass} ${wordy} ${skin.focus}`}
        panelClassName={skin.panel}
        linkClassName={`${skin.menuLink} ${skin.focus}`}
      />
    </div>
  ) : null;

  const cart = (
    <span onClick={preventNav}>
      <CartCount
        businessId={commerce.businessId}
        preview={preview}
        compact={layout === "minimal" || layout === "centered" || layout === "signboard" || layout === "slab" || layout === "console"}
        className={`h-10 rounded-md px-2 ${actionClass} ${wordy} ${skin.focus}`}
        badgeStyle={layout === "marketplace" ? tileStyle : onPrimary}
      />
    </span>
  );

  const mobileMenu = (
    <MobileMenu
      shopHeading={commerce.labels.shopHeading}
      storeName={view.name}
      shopLinks={shopLinks}
      categoryLinks={categoryLinks}
      pageLinks={mobilePageLinks.flatMap((l) => (l.children?.length ? [...(l.href === "#" ? [] : [l]), ...l.children] : [l]))}
      account={account}
      buttonClass={`${actionClass} ${skin.focus}`}
      panelClass={skin.panel}
      linkClass={`${skin.menuLink} ${skin.focus}`}
      inputClass={skin.input}
      dark={skin.dark}
    />
  );

  const desktopNav = (links: CommerceLink[], className: string, linkClass = skin.navLink) => (
    <nav {...target("nav", "Navigation")} onClick={preventNav} aria-label="Main" className={className}>
      {links.map((l) => navLink(l, linkClass))}
    </nav>
  );

  // A long link list (e.g. several pages) moves to its own wrapping row
  // instead of overflowing the bar.
  const inlineLinks = [...shopLinks, ...categoryLinks.slice(0, 3), ...pageLinks];
  const crowded = inlineLinks.length > 5;
  const linkRow = crowded ? (
    <div className={`hidden border-t lg:block ${skin.border}`}>
      <div className={skin.container}>{desktopNav(inlineLinks, "flex flex-wrap items-center gap-x-7 gap-y-2 py-3")}</div>
    </div>
  ) : null;

  let body: React.ReactNode;
  switch (layout) {
    case "glass":
      // A pill that floats over the hero (the hero starts behind it).
      body = (
        <div className={`${skin.container} py-3`}>
          <div className="rounded-[1.75rem] border border-white/10 bg-[#0d1322]/80 shadow-[0_20px_50px_-30px_rgba(0,0,0,0.9)] backdrop-blur-xl">
            <div className="flex h-14 items-center gap-1 px-2 sm:gap-2 sm:px-4">
              {mobileMenu}
              {brand}
              {!crowded && placement("left") !== "right" && desktopNav(inlineLinks, placement("left") === "center" ? "mx-auto hidden items-center gap-6 lg:flex" : "ml-6 hidden items-center gap-6 lg:flex")}
              <div className="ml-auto flex items-center gap-1">
                {!crowded && placement("left") === "right" && desktopNav(inlineLinks, "mr-4 hidden items-center gap-6 lg:flex")}
                {searchLink("")}
                {accountMenu}
                {cart}
              </div>
            </div>
            {crowded && (
              <div className={`hidden border-t px-5 lg:block ${skin.border}`}>
                {desktopNav(inlineLinks, "flex flex-wrap items-center gap-x-6 gap-y-1 py-2")}
              </div>
            )}
          </div>
        </div>
      );
      break;

    case "marketplace":
      body = (
        <>
          <div style={onPrimary}>
            <div className={`${skin.container} flex flex-wrap items-center gap-x-2 gap-y-2 py-3 sm:gap-x-4 lg:py-4 [&_a>span.truncate]:!text-current`}>
              {mobileMenu}
              <div className="min-w-0 shrink">{brand}</div>
              {searchForm("order-last w-full md:order-none md:mx-4 md:w-auto md:flex-1 lg:mx-8 lg:max-w-3xl", "rounded-lg border-0 py-2.5 pl-10 pr-24", { button: true })}
              <div className="ml-auto flex items-center gap-1 sm:gap-2">
                {accountMenu}
                {cart}
              </div>
            </div>
          </div>
          {(shopLinks.length > 0 || categoryLinks.length > 0 || pageLinks.length > 0) && (
            <div className={`hidden border-b lg:block ${skin.border}`}>
              <div className={`${skin.container} flex h-11 items-center gap-6`}>
                {desktopNav([...shopLinks, ...categoryLinks.slice(0, 8)], "flex min-w-0 items-center gap-6 overflow-hidden")}
                {pageLinks.length > 0 && (
                  <nav aria-label="Pages" onClick={preventNav} className="ml-auto flex items-center gap-6">
                    {pageLinks.map((l) => navLink(l))}
                  </nav>
                )}
              </div>
            </div>
          )}
        </>
      );
      break;

    case "signboard":
      body = (
        <div className={skin.container}>
          <div className="grid h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 lg:h-24 lg:grid-cols-[1fr_auto_1fr] lg:gap-8">
            <div className="flex min-w-0 items-center">
              {mobileMenu}
              {desktopNav([...shopLinks, ...categoryLinks.slice(0, 3)], "hidden flex-wrap items-center gap-x-6 gap-y-1 lg:flex")}
            </div>
            <div className="flex min-w-0 justify-center">{brand}</div>
            <div className="flex items-center justify-end gap-1 sm:gap-2 lg:gap-5">
              {pageLinks.length > 0 && (
                <nav aria-label="Pages" onClick={preventNav} className="hidden flex-wrap items-center justify-end gap-x-6 gap-y-1 lg:flex">
                  {pageLinks.map((l) => navLink(l))}
                </nav>
              )}
              <div className="flex items-center gap-1">
                {searchLink("")}
                {accountMenu}
                {cart}
              </div>
            </div>
          </div>
        </div>
      );
      break;

    case "slab":
      // Joined cells with no gaps: the name is the brand-coloured cell.
      body = (
        <>
          <div className="flex min-h-16 items-stretch">
            <div className="flex items-center border-r-2 border-neutral-950 px-1 lg:hidden">{mobileMenu}</div>
            <div className="flex min-w-0 items-center border-r-2 border-neutral-950 px-3 sm:px-6 [&_a>span.truncate]:!text-base [&_a>span.truncate]:!text-current sm:[&_a>span.truncate]:!text-xl" style={onPrimary}>{brand}</div>
            {!crowded && (
              <nav {...target("nav", "Navigation")} onClick={preventNav} aria-label="Main" className="hidden items-stretch lg:flex">
                {inlineLinks.map((l) => (
                  <span key={`${l.href}-${l.label}`} className="flex items-center border-r-2 border-neutral-950 px-5">{navLink(l)}</span>
                ))}
              </nav>
            )}
            <div className="ml-auto flex items-stretch">
              {hasProducts && <div className="hidden items-center border-l-2 border-neutral-950 px-3 md:flex">{searchForm("md:w-44 lg:w-56", "px-3 py-1.5")}</div>}
              <div className="flex items-center border-l-2 border-neutral-950 px-1 md:hidden">{searchLink("")}</div>
              {account && <div className="hidden items-center border-l-2 border-neutral-950 px-1 min-[340px]:flex sm:px-2">{accountMenu}</div>}
              <div className="flex items-center border-l-2 border-neutral-950 pl-1 pr-2 sm:px-2">{cart}</div>
            </div>
          </div>
          {crowded && (
            <div className="hidden border-t-2 border-neutral-950 lg:block">
              <div className="px-6">{desktopNav(inlineLinks, "flex flex-wrap items-center gap-x-7 gap-y-2 py-3")}</div>
            </div>
          )}
        </>
      );
      break;

    case "centered":
      body = (
        <div className={skin.container}>
          <div className="grid h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 md:grid-cols-[1fr_minmax(0,auto)_1fr] lg:h-24">
            <div className="flex min-w-0 items-center gap-2">
              {mobileMenu}
              {searchForm("hidden md:block md:w-44 lg:w-56", "px-1 py-2")}
            </div>
            <div className="flex min-w-0 justify-center">{brand}</div>
            <div className="flex items-center justify-end gap-1 sm:gap-2">
              {searchLink()}
              {accountMenu}
              {cart}
            </div>
          </div>
          {desktopNav([...shopLinks, ...categoryLinks.slice(0, 5), ...pageLinks], "hidden flex-wrap items-center justify-center gap-x-8 gap-y-2 pb-5 lg:flex")}
        </div>
      );
      break;

    case "console":
      body = (
        <>
          <div className={`${skin.container} flex h-14 items-center gap-2 sm:gap-3`}>
            {mobileMenu}
            {brand}
            {!crowded && desktopNav(inlineLinks, placement("left") === "center" ? "mx-auto hidden items-center gap-1 lg:flex" : placement("left") === "right" ? "ml-auto hidden items-center gap-1 lg:flex" : "ml-5 hidden items-center gap-1 lg:flex", `${skin.navLink} rounded-md px-3 py-1.5 font-mono !text-xs hover:bg-white/10`)}
            <div className={`${placement("left") === "left" ? "ml-auto " : ""}flex items-center gap-1 sm:gap-2`}>
              {searchForm("hidden md:block md:w-56 lg:w-72", "rounded-md py-1.5 pl-7 pr-3 font-mono", { prefix: ">" })}
              {searchLink()}
              {accountMenu}
              {cart}
            </div>
          </div>
          {linkRow}
        </>
      );
      break;

    case "grocer":
      body = (
        <>
          <div className={`${skin.container} flex flex-wrap items-center gap-x-2 gap-y-2 py-3 sm:gap-x-4`}>
            <span className="lg:hidden">{mobileMenu}</span>
            <div className="min-w-0 shrink">{brand}</div>
            {searchForm("order-last w-full md:order-none md:mx-4 md:w-auto md:flex-1 lg:mx-8", "rounded-full py-3 pl-10 pr-24", { button: true })}
            <div className="ml-auto flex items-center gap-1 sm:gap-2">
              {accountMenu}
              {cart}
            </div>
          </div>
          {(shopLinks.length > 0 || categoryLinks.length > 0 || pageLinks.length > 0) && (
            // Chips stay reachable on phones: they scroll sideways on every screen.
            <nav {...target("nav", "Navigation")} onClick={preventNav} aria-label="Main" className={skin.container}>
              <ul className="sf-scroll-x flex gap-2 overflow-x-auto pb-3">
                {[...shopLinks, ...categoryLinks, ...pageLinks.flatMap((l) => (l.children?.length ? [...(l.href === "#" ? [] : [l]), ...l.children] : [l]))].map((l, i) => (
                  <li key={`${l.href}-${l.label}`} className="shrink-0">
                    <a
                      href={l.href}
                      {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      className={`inline-flex min-h-9 items-center whitespace-nowrap rounded-full px-4 text-sm font-semibold ${skin.focus}`}
                      style={i === 0 ? onPrimary : { background: `${theme.primaryColor}14` }}
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </>
      );
      break;

    case "textual":
      body = (
        <>
          <div className={`${skin.container} flex h-16 items-center gap-2 lg:h-20`}>
            {mobileMenu}
            {brand}
            {!crowded && placement("right") !== "right" && desktopNav(inlineLinks, placement("right") === "center" ? "mx-auto hidden items-center gap-6 lg:flex" : "ml-6 hidden items-center gap-6 lg:flex")}
            <div className="ml-auto flex items-center gap-1 lg:gap-4">
              {!crowded && placement("right") === "right" && desktopNav(inlineLinks, "mr-4 hidden items-center gap-6 lg:flex")}
              {searchLink("")}
              {accountMenu}
              {cart}
            </div>
          </div>
          {linkRow}
        </>
      );
      break;

    case "minimal":
    default:
      body = (
        <>
          <div className={`${skin.container} flex h-14 items-center gap-3 lg:h-16`}>
            {mobileMenu}
            {brand}
            {!crowded && placement("right") !== "right" && desktopNav(inlineLinks, placement("right") === "center" ? "mx-auto hidden items-center gap-7 lg:flex" : "ml-6 hidden items-center gap-7 lg:flex")}
            <div className="ml-auto flex items-center gap-1 sm:gap-3">
              {!crowded && placement("right") === "right" && desktopNav(inlineLinks, "mr-4 hidden items-center gap-7 lg:flex")}
              {searchLink("")}
              {accountMenu}
              {cart}
            </div>
          </div>
          {linkRow}
        </>
      );
  }

  return (
    <header {...target("container", "Header")} data-layout={layout} className={`${skin.header} ${sticky ? "sticky top-0 z-40" : "relative"}`}>
      {announcement && (
        <div {...target("banner", "Announcement")} className={skin.announcement} style={announcement.tone === "brand" ? onPrimary : undefined}>
          <p className={`${skin.container} py-2 text-center text-xs font-medium sm:text-sm`}>
            {announcement.href ? (
              <a href={announcement.href} onClick={preventNav} className={`rounded underline-offset-4 hover:underline ${skin.focus}`}>
                {announcement.text}
              </a>
            ) : (
              announcement.text
            )}
          </p>
        </div>
      )}
      {/* Headers without a letter tile keep the owner's colour visible with a thin rule. */}
      {noTile && layout !== "slab" && <span aria-hidden="true" className="block h-0.5 w-full" style={{ background: theme.primaryColor }} />}
      {body}
    </header>
  );
}
