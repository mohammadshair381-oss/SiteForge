import React from "react";
import type { StorefrontView } from "@/lib/storefront";
import { socialLabel, type CommerceData, type CommerceLink } from "@/lib/storefront-home";
import { readableOn, type StoreSkin } from "./skins";

/**
 * Storefront footer for every theme: brand and description, shop links, page
 * and policy links, account links, contact details, social profiles and
 * copyright. Groups without content are left out; nothing is shown as "coming
 * soon". The theme's `layout.footer` arranges the SAME content: link columns
 * with a giant wordmark, a postcard, a ledger of ruled rows, bordered slabs, a
 * couture masthead, a terminal, a rounded sheet or a two-column colophon.
 */
export default function StoreFooter({
  view,
  commerce,
  skin,
  editable,
}: {
  view: StorefrontView;
  commerce: CommerceData;
  skin: StoreSkin;
  editable?: boolean;
}) {
  const target = (key: string, label: string) =>
    editable ? { "data-editor-id": `footer:${key}`, "data-editor-section-id": "footer", "data-editor-label": label, tabIndex: 0 } : {};
  const preventNav = editable ? (e: React.MouseEvent) => e.preventDefault() : undefined;
  const { footer, header } = commerce;
  // "theme" (the default everywhere) keeps exactly what the theme does.
  const layout = footer.layout === "theme" ? skin.layout.footer : footer.layout;
  const hasContact = footer.showContact && Boolean(view.contactEmail || view.phone || view.address || view.serviceArea);
  const linkClass = `rounded hover:underline underline-offset-4 ${skin.focus}`;
  const copyright = footer.copyright || `© ${new Date().getFullYear()} ${view.name}. All rights reserved.`;
  const signedIn = Boolean(header.signedInName) || header.signedInUnverified;
  // Customer accounts are a platform feature flag: when off, no links (the routes would 404).
  const accountLinks: CommerceLink[] = !header.accountsEnabled
    ? []
    : signedIn
      ? [{ label: "My account", href: "/account" }, { label: "Order history", href: "/account/orders" }, { label: "Profile", href: "/account/profile" }]
      : [{ label: "Sign in", href: "/account/login" }, { label: "Create account", href: "/account/register" }];

  const name = (className = skin.footerBrand) => <p {...target("name", "Business name")} className={className}>{view.name}</p>;
  const about = (className = "mt-3 max-w-sm text-sm leading-6") => (footer.about ? <p className={className}>{footer.about}</p> : null);

  const social = (className = "mt-5 flex flex-wrap gap-x-4 gap-y-2 text-sm") =>
    footer.social.length > 0 ? (
      <ul className={className} aria-label="Social media">
        {footer.social.map((s) => (
          <li key={s.network}>
            <a href={s.href} onClick={preventNav} target="_blank" rel="noopener noreferrer" className={linkClass}>
              {socialLabel(s.network)}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
    ) : null;

  const groups = [
    { key: "shop", title: commerce.labels.shopHeading, links: footer.shopLinks, editor: {} },
    { key: "info", title: "Information", links: footer.infoLinks, editor: target("nav", "Footer navigation") },
    ...footer.columns.map((column, index) => ({ key: `column-${index}`, title: column.title, links: column.links, editor: {} })),
    { key: "account", title: "Your account", links: accountLinks, editor: {} },
  ].filter((group) => group.links.length > 0);

  const linkList = (links: CommerceLink[], className: string, itemClass = linkClass, itemStyle?: React.CSSProperties) => (
    <ul className={className}>
      {links.map((l) => (
        <li key={`${l.href}-${l.label}`}><a href={l.href} {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})} className={itemClass} style={itemStyle}>{l.label}</a></li>
      ))}
    </ul>
  );

  const contactDetails = (className = "mt-4 space-y-2.5 text-sm not-italic") => (
    <address className={className}>
      {view.contactEmail && <p><a href={`mailto:${view.contactEmail}`} onClick={preventNav} className={linkClass}>{view.contactEmail}</a></p>}
      {view.phone && <p><a href={`tel:${view.phone.replace(/[^\d+]/g, "")}`} onClick={preventNav} className={linkClass}>{view.phone}</a></p>}
      {view.address && <p {...target("address", "Address")}>{view.address}</p>}
      {view.serviceArea && <p>Serving {view.serviceArea}</p>}
    </address>
  );

  const contactGroup = (headingClass: string, addressClass?: string) =>
    hasContact ? (
      <div {...target("contact", "Contact details")}>
        <p className={headingClass}>Contact</p>
        {contactDetails(addressClass)}
      </div>
    ) : null;

  /** Link groups as columns under their headings. */
  const columns = (headingClass = skin.footerHeading, listClass = "mt-4 space-y-2.5 text-sm") =>
    groups.map((group) => (
      <nav key={group.key} {...group.editor} aria-label={group.title} onClick={preventNav}>
        <p className={headingClass}>{group.title}</p>
        {linkList(group.links, listClass)}
      </nav>
    ));

  const legal = (className: string) => (
    <div className={`border-t ${skin.border}`}>
      <div className={`${skin.container} flex flex-col gap-2 py-5 text-xs sm:flex-row sm:items-center sm:justify-between ${className}`}>
        <p>{copyright}</p>
        {!view.removeBranding && <p>Powered by SiteForge</p>}
      </div>
    </div>
  );

  const shell = (children: React.ReactNode, className = "") => (
    <footer {...target("container", "Footer")} id="contact" data-footer={layout} className={`${skin.footer} ${className}`}>
      {children}
    </footer>
  );

  switch (layout) {
    case "postcard":
      // Centred like the back of a menu: every group is one line of links.
      return shell(
        <>
          <div className={`${skin.container} py-14 text-center sm:py-20`}>
            <p aria-hidden="true" className="text-2xl leading-none opacity-70">❦</p>
            <div className="mt-4">{name()}</div>
            {about("mx-auto mt-3 max-w-xl text-sm leading-6")}
            <div className="mt-8 space-y-5">
              {groups.map((group) => (
                <nav key={group.key} {...group.editor} aria-label={group.title} onClick={preventNav}>
                  <p className={skin.footerHeading}>{group.title}</p>
                  {linkList(group.links, "mt-2 flex flex-wrap justify-center gap-x-6 gap-y-1 text-sm")}
                </nav>
              ))}
            </div>
            {hasContact && (
              <div {...target("contact", "Contact details")} className="mt-8">
                <p className="sr-only">Contact</p>
                {contactDetails("flex flex-wrap justify-center gap-x-6 gap-y-1 text-sm not-italic")}
              </div>
            )}
            {social("mt-5 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm")}
          </div>
          {legal("sm:justify-center sm:gap-6")}
        </>,
      );

    case "ledger":
      // Ruled rows: the label in one column, the entries in the next.
      return shell(
        <>
          <div className={`${skin.container} py-12 lg:py-16`}>
            <div className="grid gap-4 pb-8 lg:grid-cols-12">
              <div className="lg:col-span-4">{name()}</div>
              <div className="lg:col-span-8">{about("max-w-xl text-sm leading-6")}</div>
            </div>
            <dl className="border-b border-neutral-200">
              {groups.map((group) => (
                <div key={group.key} className="grid gap-2 border-t border-neutral-200 py-4 lg:grid-cols-12">
                  <dt className={`lg:col-span-4 ${skin.footerHeading}`}>{group.title}</dt>
                  <dd className="lg:col-span-8">
                    <nav {...group.editor} aria-label={group.title} onClick={preventNav}>
                      {linkList(group.links, "flex flex-wrap gap-x-6 gap-y-1 text-sm")}
                    </nav>
                  </dd>
                </div>
              ))}
              {hasContact && (
                <div {...target("contact", "Contact details")} className="grid gap-2 border-t border-neutral-200 py-4 lg:grid-cols-12">
                  <dt className={`lg:col-span-4 ${skin.footerHeading}`}>Contact</dt>
                  <dd className="lg:col-span-8">{contactDetails("flex flex-wrap gap-x-6 gap-y-1 text-sm not-italic")}</dd>
                </div>
              )}
              {footer.social.length > 0 && (
                <div className="grid gap-2 border-t border-neutral-200 py-4 lg:grid-cols-12">
                  <dt className={`lg:col-span-4 ${skin.footerHeading}`}>Follow</dt>
                  <dd className="lg:col-span-8">{social("flex flex-wrap gap-x-6 gap-y-1 text-sm")}</dd>
                </div>
              )}
            </dl>
          </div>
          {legal("")}
        </>,
      );

    case "slab": {
      const primary = view.theme.primaryColor;
      return shell(
        <>
          <div className="overflow-hidden border-b-2 border-neutral-950 px-4 py-8 sm:px-8 sm:py-12" style={{ background: primary, color: readableOn(primary) }}>
            <p {...target("name", "Business name")} className="break-words font-display text-[clamp(2.5rem,10vw,8rem)] font-black uppercase leading-[0.9] tracking-tight">{view.name}</p>
            {about("mt-4 max-w-2xl text-sm font-medium leading-6 sm:text-base")}
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4">
            {groups.map((group) => (
              <nav key={group.key} {...group.editor} aria-label={group.title} onClick={preventNav} className="border-b-2 border-neutral-700 p-6 sm:border-r-2">
                <p className={skin.footerHeading}>{group.title}</p>
                {linkList(group.links, "mt-4 space-y-2 text-sm font-semibold")}
              </nav>
            ))}
            {hasContact && (
              <div {...target("contact", "Contact details")} className="border-b-2 border-neutral-700 p-6">
                <p className={skin.footerHeading}>Contact</p>
                {contactDetails("mt-4 space-y-2 text-sm font-semibold not-italic")}
                {social("mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm font-semibold")}
              </div>
            )}
          </div>
          {!hasContact && footer.social.length > 0 && <div className="border-b-2 border-neutral-700 p-6">{social("flex flex-wrap gap-x-4 gap-y-2 text-sm font-semibold")}</div>}
          <div className="flex flex-col gap-2 px-6 py-5 text-xs font-semibold uppercase tracking-wider sm:flex-row sm:justify-between">
            <p>{copyright}</p>
            {!view.removeBranding && <p>Powered by SiteForge</p>}
          </div>
        </>,
      );
    }

    case "couture":
      return shell(
        <>
          <div className={`${skin.container} py-16 text-center sm:py-24`}>
            <p {...target("name", "Business name")} className="break-words font-display text-4xl leading-tight text-[#faf8f4] sm:text-6xl">{view.name}</p>
            {about("mx-auto mt-4 max-w-xl text-sm leading-7")}
            <div className="mx-auto mt-12 grid max-w-5xl gap-10 sm:grid-cols-2 lg:grid-flow-col lg:auto-cols-fr lg:grid-cols-none">
              {columns(skin.footerHeading, "mt-4 space-y-2 text-sm")}
              {contactGroup(skin.footerHeading, "mt-4 space-y-2 text-sm not-italic")}
            </div>
            {social("mt-12 flex flex-wrap justify-center gap-x-6 gap-y-2 text-[11px] uppercase tracking-[0.25em]")}
          </div>
          {legal("sm:justify-center sm:gap-8")}
        </>,
      );

    case "terminal":
      return shell(
        <>
          <div className={`${skin.container} grid gap-8 py-10 font-mono sm:grid-cols-2 lg:grid-cols-4`}>
            <div className="sm:col-span-2 lg:col-span-1">
              {name("font-display text-base font-semibold text-white")}
              {about("mt-3 max-w-sm text-xs leading-6")}
              {social("mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs")}
            </div>
            {groups.map((group) => (
              <nav key={group.key} {...group.editor} aria-label={group.title} onClick={preventNav}>
                <p className="text-xs text-zinc-300"><span aria-hidden="true" className="text-zinc-500">{"// "}</span>{group.title}</p>
                {linkList(group.links, "mt-3 space-y-1.5 text-xs")}
              </nav>
            ))}
            {hasContact && (
              <div {...target("contact", "Contact details")}>
                <p className="text-xs text-zinc-300"><span aria-hidden="true" className="text-zinc-500">{"// "}</span>Contact</p>
                {contactDetails("mt-3 space-y-1.5 text-xs not-italic")}
              </div>
            )}
          </div>
          {legal("font-mono")}
        </>,
      );

    case "sheet":
      // A rounded sheet with its links as tappable pills.
      return shell(
        <>
          <div className={`${skin.container} py-10 sm:py-14`}>
            <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-start">
              <div>
                {name()}
                {about()}
              </div>
              {hasContact && <div {...target("contact", "Contact details")}><p className="sr-only">Contact</p>{contactDetails("space-y-1.5 text-sm not-italic lg:text-right")}</div>}
            </div>
            <div className="mt-8 space-y-5">
              {groups.map((group) => (
                <nav key={group.key} {...group.editor} aria-label={group.title} onClick={preventNav}>
                  <p className={skin.footerHeading}>{group.title}</p>
                  {linkList(group.links, "mt-2 flex flex-wrap gap-2 text-sm", `inline-flex min-h-10 items-center rounded-full bg-white/10 px-4 font-semibold transition-colors hover:bg-white/20 ${skin.focus}`)}
                </nav>
              ))}
            </div>
            {social()}
          </div>
          {legal("")}
        </>,
        "mt-6 rounded-t-[2.5rem]",
      );

    case "colophon":
      return shell(
        <>
          <div className={`${skin.container} grid gap-12 py-16 lg:grid-cols-2 lg:py-24`}>
            <div>
              <p {...target("name", "Business name")} className="break-words font-display text-4xl font-light leading-tight tracking-tight text-[#2a2621] sm:text-6xl">{view.name}</p>
              {about("mt-6 max-w-md text-base leading-7")}
              {social("mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm")}
            </div>
            <div className="grid gap-10 sm:grid-cols-2">
              {columns()}
              {contactGroup(skin.footerHeading)}
            </div>
          </div>
          {legal("")}
        </>,
      );

    case "wordmark":
    case "columns":
    default:
      return shell(
        <>
          <div className={`${skin.container} grid gap-10 py-12 sm:grid-cols-2 lg:grid-flow-col lg:auto-cols-fr lg:grid-cols-none lg:py-16`}>
            <div className="sm:col-span-2 lg:col-span-1">
              {name()}
              {about()}
              {social()}
            </div>
            {columns()}
            {contactGroup(skin.footerHeading)}
          </div>
          {layout === "wordmark" && (
            <div className={`${skin.container} overflow-hidden`} aria-hidden="true">
              <p className="truncate pb-6 font-display text-[clamp(3rem,13vw,11rem)] leading-[0.95] tracking-tight opacity-90">{view.name}</p>
            </div>
          )}
          {legal("")}
        </>,
      );
  }
}
