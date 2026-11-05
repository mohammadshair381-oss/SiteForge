"use client";

import Link from "next/link";
import { useId, useState } from "react";
import MediaPicker from "../MediaPicker";
import { SectionContentFields } from "../VisualEditor";
import { editorFocus } from "./EditorWorkspace";
import { SectionNameField, SectionPanelActions } from "./SectionControls";
import ResponsiveControls from "./ResponsiveControls";
import type { ResponsiveDevice } from "@/lib/section-responsive";
import {
  HOME_SECTION_DESCRIPTIONS,
  HOME_SECTION_LABELS,
  homeSectionName,
  SINGLE_INSTANCE_TYPES,
  SOCIAL_NETWORKS,
  type HomeSection,
  type SectionAppearance,
  type StorefrontConfig,
} from "@/lib/storefront-config";
import { socialLabel } from "@/lib/storefront-home";
import { SECTION_TYPE_DESCRIPTIONS } from "@/lib/sections";

export const fieldInput = `mt-1 block min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 ${editorFocus}`;
export const fieldLabel = "block text-xs font-medium text-slate-700";
const smallButton = `inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-8 ${editorFocus}`;
const hintText = "text-xs leading-5 text-slate-500";

export interface LinkOption {
  label: string;
  href: string;
}

export interface EditorCatalog {
  businessId: string;
  products: Array<{ id: string; name: string; imageUrl: string }>;
  categoryNames: string[];
  linkOptions: LinkOption[];
}

function TextField({ label, value, onChange, max, placeholder, multiline, rows = 3, list }: { label: string; value: string; onChange: (v: string) => void; max: number; placeholder?: string; multiline?: boolean; rows?: number; list?: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={fieldLabel}>{label}</label>
      {multiline ? (
        <textarea id={id} value={value} maxLength={max} rows={rows} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={fieldInput} />
      ) : (
        <input id={id} value={value} maxLength={max} placeholder={placeholder} list={list} onChange={(e) => onChange(e.target.value)} className={fieldInput} />
      )}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 transition-colors focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-1 hover:border-slate-300">
      {label}
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only" />
      <span aria-hidden="true" className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-slate-900" : "bg-slate-300"}`}>
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-[1.125rem]" : "translate-x-0.5"}`} />
      </span>
    </label>
  );
}

function Select<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={fieldLabel}>{label}</label>
      <select
        id={id}
        value={String(value)}
        onChange={(e) => onChange((typeof value === "number" ? Number(e.target.value) : e.target.value) as T)}
        className={fieldInput}
      >
        {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
    </div>
  );
}

function ImageField({ label, businessId, value, onChange, context }: { label: string; businessId: string; value: string; onChange: (url: string, alt?: string) => void; context: string }) {
  return (
    <div>
      <p className={fieldLabel}>{label}</p>
      <div className="mt-1 flex items-center gap-2">
        {value && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="" className="h-12 w-16 shrink-0 rounded-lg border border-slate-200 object-cover" />
        )}
        <MediaPicker businessId={businessId} selectedUrl={value} allowClear contextLabel={context} onSelect={(m) => onChange(m?.url ?? "", m?.altText)} />
      </div>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="border-t border-slate-200 pt-4 text-sm font-semibold text-slate-900">{children}</h3>;
}

// ---------------------------------------------------------------------------

/** Hero banner settings. */
export function HeroSettings({ hero, onChange, catalog, linkListId }: { hero: StorefrontConfig["hero"]; onChange: (patch: Partial<StorefrontConfig["hero"]>) => void; catalog: EditorCatalog; linkListId: string }) {
  return (
    <div className="space-y-4">
      <Toggle label="Show hero banner" checked={hero.enabled} onChange={(enabled) => onChange({ enabled })} />
      <TextField label="Small heading" value={hero.eyebrow} max={60} onChange={(eyebrow) => onChange({ eyebrow })} />
      <TextField label="Headline" value={hero.headline} max={120} placeholder="Your store name is used when empty" onChange={(headline) => onChange({ headline })} />
      <TextField label="Description" value={hero.description} max={300} multiline rows={3} placeholder="Your business description is used when empty" onChange={(description) => onChange({ description })} />
      <ImageField label="Desktop image" businessId={catalog.businessId} value={hero.imageUrl} context="hero image" onChange={(imageUrl, alt) => onChange({ imageUrl, ...(alt && !hero.imageAlt ? { imageAlt: alt } : {}) })} />
      <ImageField label="Mobile image (optional)" businessId={catalog.businessId} value={hero.mobileImageUrl} context="mobile hero image" onChange={(mobileImageUrl) => onChange({ mobileImageUrl })} />
      <TextField label="Image description (alt text)" value={hero.imageAlt} max={160} onChange={(imageAlt) => onChange({ imageAlt })} />
      <div className="grid grid-cols-2 gap-3">
        <Select label="Text alignment" value={hero.align} options={[{ value: "left", label: "Left" }, { value: "center", label: "Centre" }]} onChange={(align) => onChange({ align })} />
        <Select label="Image darkening" value={hero.overlay} options={[0, 20, 30, 40, 50, 60, 70, 80].map((v) => ({ value: v, label: `${v}%` }))} onChange={(overlay) => onChange({ overlay })} />
      </div>
      <SectionHeading>Buttons</SectionHeading>
      <TextField label="Main button text" value={hero.primaryCta.label} max={40} placeholder="Shop now" onChange={(label) => onChange({ primaryCta: { ...hero.primaryCta, label } })} />
      <TextField label="Main button link" value={hero.primaryCta.href} max={200} placeholder="/products" list={linkListId} onChange={(href) => onChange({ primaryCta: { ...hero.primaryCta, href } })} />
      <TextField label="Second button text (optional)" value={hero.secondaryCta.label} max={40} onChange={(label) => onChange({ secondaryCta: { ...hero.secondaryCta, label } })} />
      <TextField label="Second button link" value={hero.secondaryCta.href} max={200} list={linkListId} onChange={(href) => onChange({ secondaryCta: { ...hero.secondaryCta, href } })} />
      <p className={hintText}>Buttons appear only when their link leads to a real page of your store.</p>
    </div>
  );
}

export function AnnouncementSettings({ announcement, onChange, linkListId }: { announcement: StorefrontConfig["announcement"]; onChange: (patch: Partial<StorefrontConfig["announcement"]>) => void; linkListId: string }) {
  return (
    <div className="space-y-4">
      <Toggle label="Show announcement bar" checked={announcement.enabled} onChange={(enabled) => onChange({ enabled })} />
      <TextField label="Message" value={announcement.text} max={140} placeholder="Free delivery on orders over ₹999" onChange={(text) => onChange({ text })} />
      <TextField label="Link (optional)" value={announcement.href} max={200} placeholder="/products" list={linkListId} onChange={(href) => onChange({ href })} />
      <Select label="Colour" value={announcement.tone} options={[{ value: "theme", label: "The theme's own" }, { value: "brand", label: "Your main colour" }]} onChange={(tone) => onChange({ tone })} />
    </div>
  );
}

export function FooterSettings({ footer, onChange, businessId, linkListId }: { footer: StorefrontConfig["footer"]; onChange: (patch: Partial<StorefrontConfig["footer"]>) => void; businessId: string; linkListId: string }) {
  const setColumn = (index: number, next: StorefrontConfig["footer"]["columns"][number]) => onChange({ columns: footer.columns.map((column, i) => (i === index ? next : column)) });
  return (
    <div className="space-y-4">
      <Select label="Layout" value={footer.layout} options={[{ value: "theme", label: "The theme's own" }, { value: "columns", label: "Columns" }, { value: "postcard", label: "Centred" }]} onChange={(layout) => onChange({ layout })} />
      <TextField label="Short description" value={footer.about} max={400} multiline rows={3} placeholder="Your business description is used when empty" onChange={(about) => onChange({ about })} />
      <TextField label="Copyright line (optional)" value={footer.copyright} max={160} placeholder="The usual notice is used when empty" onChange={(copyright) => onChange({ copyright })} />
      <SectionHeading>What to show</SectionHeading>
      <Toggle label="Contact details" checked={footer.showContact} onChange={(showContact) => onChange({ showContact })} />
      <Toggle label="Social profiles" checked={footer.showSocial} onChange={(showSocial) => onChange({ showSocial })} />
      <Toggle label="Shop links" checked={footer.showShopLinks} onChange={(showShopLinks) => onChange({ showShopLinks })} />
      <Toggle label="Your footer menu" checked={footer.showMenuLinks} onChange={(showMenuLinks) => onChange({ showMenuLinks })} />
      <SectionHeading>Your own columns</SectionHeading>
      <p className={hintText}>Up to 4 columns of links, shown with the others in your theme&apos;s style.</p>
      {footer.columns.map((column, index) => (
        <div key={index} className="space-y-2 rounded-lg border border-slate-200 p-3">
          <TextField label="Column heading" value={column.title} max={40} onChange={(title) => setColumn(index, { ...column, title })} />
          {column.links.map((link, linkIndex) => (
            <div key={linkIndex} className="space-y-1.5 rounded-lg bg-slate-50 p-2">
              <TextField label="Link text" value={link.label} max={60} onChange={(label) => setColumn(index, { ...column, links: column.links.map((l, i) => (i === linkIndex ? { ...l, label } : l)) })} />
              <TextField label="Link address" value={link.href} max={300} placeholder="/products or https://" list={linkListId} onChange={(href) => setColumn(index, { ...column, links: column.links.map((l, i) => (i === linkIndex ? { ...l, href } : l)) })} />
              <button type="button" className={`${smallButton} text-red-700`} onClick={() => setColumn(index, { ...column, links: column.links.filter((_, i) => i !== linkIndex) })}>Remove link</button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={smallButton} disabled={column.links.length >= 8} onClick={() => setColumn(index, { ...column, links: [...column.links, { label: "", href: "" }] })}>Add link</button>
            <button type="button" className={`${smallButton} text-red-700`} onClick={() => onChange({ columns: footer.columns.filter((_, i) => i !== index) })}>Remove column</button>
          </div>
        </div>
      ))}
      <button type="button" className={smallButton} disabled={footer.columns.length >= 4} onClick={() => onChange({ columns: [...footer.columns, { title: "", links: [] }] })}>Add a column</button>
      <SectionHeading>Social profiles</SectionHeading>
      {SOCIAL_NETWORKS.map((network) => (
        <TextField key={network} label={socialLabel(network)} value={footer.social[network]} max={300} placeholder="https://" onChange={(v) => onChange({ social: { ...footer.social, [network]: v } })} />
      ))}
      <p className={hintText}>
        Contact details come from <Link className="font-medium text-slate-800 underline underline-offset-2" href={`/dashboard/businesses/${businessId}/settings`}>Business settings</Link>; page links from{" "}
        <Link className="font-medium text-slate-800 underline underline-offset-2" href={`/dashboard/businesses/${businessId}/navigation`}>Navigation</Link>; policies from{" "}
        <Link className="font-medium text-slate-800 underline underline-offset-2" href={`/dashboard/businesses/${businessId}/storefront`}>Storefront</Link>.
      </p>
    </div>
  );
}

/** How the header is arranged. "The theme's own" keeps exactly what the theme does. */
export function HeaderSettings({ header, onChange, businessId, accountsEnabled }: { header: StorefrontConfig["header"]; onChange: (patch: Partial<StorefrontConfig["header"]>) => void; businessId: string; accountsEnabled: boolean }) {
  return (
    <div className="space-y-4">
      <Select label="Layout" value={header.layout} options={[{ value: "theme", label: "The theme's own" }, { value: "minimal", label: "One simple row" }, { value: "centered", label: "Name in the centre, links below" }, { value: "signboard", label: "Name in the centre, links either side" }]} onChange={(layout) => onChange({ layout })} />
      <Select label="Logo" value={header.logoDisplay} options={[{ value: "auto", label: "Automatic" }, { value: "both", label: "Logo and name" }, { value: "logo", label: "Logo only" }, { value: "name", label: "Name only" }]} onChange={(logoDisplay) => onChange({ logoDisplay })} />
      <Select label="Logo size" value={header.logoSize} options={[{ value: "small", label: "Small" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }]} onChange={(logoSize) => onChange({ logoSize })} />
      <Select label="Where the links sit" value={header.navAlign} options={[{ value: "theme", label: "The theme's own" }, { value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }]} onChange={(navAlign) => onChange({ navAlign })} />
      <p className={hintText}>Links can only move in layouts with a single row. Others keep their own arrangement.</p>
      <Select label="Stay at the top when scrolling" value={header.sticky} options={[{ value: "theme", label: "The theme's own" }, { value: "on", label: "Yes" }, { value: "off", label: "No" }]} onChange={(sticky) => onChange({ sticky })} />
      <HeaderInfo businessId={businessId} accountsEnabled={accountsEnabled} />
    </div>
  );
}

export function HeaderInfo({ businessId, accountsEnabled }: { businessId: string; accountsEnabled: boolean }) {
  const base = `/dashboard/businesses/${businessId}`;
  return (
    <div className="space-y-3 text-sm text-slate-700">
      <p>The header is built from your store data so it is always correct:</p>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm [&>li]:px-3 [&>li]:py-2.5">
        <li>Logo and name: <Link className="font-medium text-slate-900 underline underline-offset-2" href={`${base}/settings`}>Business settings</Link></li>
        <li>Category links: <Link className="font-medium text-slate-900 underline underline-offset-2" href={`${base}/categories`}>Categories</Link></li>
        <li>Page links: <Link className="font-medium text-slate-900 underline underline-offset-2" href={`${base}/navigation`}>Navigation</Link></li>
        <li>Search and cart are always included.</li>
        <li>
          Customer sign-in and account:{" "}
          {accountsEnabled ? "shown (customer accounts are enabled)." : "hidden while customer accounts are disabled on this platform."}
        </li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

const APPEARANCE_OPTIONS = {
  background: [
    { value: "default", label: "Page background" },
    { value: "alt", label: "Alternate" },
    { value: "accent", label: "Brand tint" },
  ],
  spacing: [
    { value: "compact", label: "Compact" },
    { value: "normal", label: "Normal" },
    { value: "spacious", label: "Spacious" },
  ],
  align: [
    { value: "left", label: "Left" },
    { value: "center", label: "Centre" },
  ],
} as const;

/**
 * Settings of one homepage section: content, appearance and the section
 * actions (move, duplicate, remove). Every change goes through `onChange`
 * (one undoable step); the server validates everything again on save.
 */
export function SectionSettings({
  section,
  index,
  count,
  hiddenReason,
  catalog,
  linkListId,
  device,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
}: {
  /** The screen size chosen in the toolbar. */
  device: ResponsiveDevice;
  section: HomeSection;
  index: number;
  count: number;
  hiddenReason: string | null;
  catalog: EditorCatalog;
  linkListId: string;
  onChange: (next: HomeSection) => void;
  onMove: (direction: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const patch = (p: Partial<HomeSection>) => onChange({ ...section, ...p } as HomeSection);
  const organise = (
    <>
      <SectionNameField value={section.name} placeholder={homeSectionName({ ...section, name: undefined } as HomeSection)} onChange={(name) => patch({ name: name || undefined } as Partial<HomeSection>)} />
      <ResponsiveControls device={device} value={section.responsive} onChange={(responsive) => patch({ responsive } as Partial<HomeSection>)} />
    </>
  );
  const [productQuery, setProductQuery] = useState("");
  const appearance = (p: Partial<SectionAppearance>) => patch({ appearance: { ...section.appearance, ...p } });
  const limitOptions = [2, 3, 4, 6, 8, 12, 16, 24].map((v) => ({ value: v, label: `${v} products` }));

  // A content block keeps its own fields, the same ones as on other pages.
  if (section.type === "block") {
    const block = section.block;
    return (
      <div className="space-y-4">
        <p className={hintText}>{SECTION_TYPE_DESCRIPTIONS[block.type]}</p>
        <SectionPanelActions
          isFirst={index === 0}
          isLast={index === count - 1}
          visible={section.enabled}
          onMove={onMove}
          onToggle={(enabled) => patch({ enabled })}
          onDuplicate={onDuplicate}
          onRemove={onRemove}
        />
        {organise}
        <SectionHeading>Content</SectionHeading>
        <SectionContentFields
          section={block}
          businessId={catalog.businessId}
          categories={catalog.categoryNames}
          onChange={(p) => patch({ block: { ...block, settings: { ...(block.settings as Record<string, unknown>), ...p } } } as Partial<HomeSection>)}
        />
        <SectionHeading>Appearance</SectionHeading>
        <Select
          label="Show on"
          value={block.hideOn ?? "all"}
          options={[{ value: "all", label: "All screen sizes" }, { value: "mobile", label: "Larger screens only" }, { value: "desktop", label: "Phones only" }]}
          onChange={(value) => {
            const { hideOn: _hideOn, ...rest } = block;
            patch({ block: (value === "all" ? rest : { ...rest, hideOn: value }) as typeof block } as Partial<HomeSection>);
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className={hintText}>{HOME_SECTION_DESCRIPTIONS[section.type]}</p>
      {section.enabled && hiddenReason && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">Not shown on the store yet: {hiddenReason}</p>
      )}
      <SectionPanelActions
        isFirst={index === 0}
        isLast={index === count - 1}
        visible={section.enabled}
        onMove={onMove}
        onToggle={(enabled) => patch({ enabled })}
        onDuplicate={SINGLE_INSTANCE_TYPES.includes(section.type) ? undefined : onDuplicate}
        onRemove={onRemove}
      />
      {organise}

      <SectionHeading>Content</SectionHeading>
      <TextField label="Heading" value={section.title} max={80} placeholder={HOME_SECTION_LABELS[section.type]} onChange={(title) => patch({ title })} />
      <TextField label="Small heading above" value={section.subtitle} max={160} onChange={(subtitle) => patch({ subtitle })} />

      {section.type === "categories" && (
        <div className="space-y-2">
          <p className={fieldLabel}>Categories to show</p>
          {catalog.categoryNames.length === 0 ? (
            <p className={hintText}>None of your products has a category yet.</p>
          ) : (
            <ul className="space-y-2">
              {catalog.categoryNames.map((name) => {
                const chosenIndex = section.categories.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
                const chosen = chosenIndex >= 0;
                return (
                  <li key={name} className="rounded-lg border border-slate-200 px-3 py-2">
                    <label className="flex min-h-10 items-center gap-2 text-sm font-medium text-slate-800">
                      <input
                        type="checkbox"
                        checked={chosen}
                        disabled={!chosen && section.categories.length >= 12}
                        onChange={(e) =>
                          patch({
                            categories: e.target.checked
                              ? [...section.categories, { name, imageUrl: "" }]
                              : section.categories.filter((c) => c.name.toLowerCase() !== name.toLowerCase()),
                          })
                        }
                        className="h-4 w-4"
                      />
                      {name}
                    </label>
                    {chosen && (
                      <div className="mt-2">
                        <ImageField
                          label="Tile image (optional)"
                          businessId={catalog.businessId}
                          value={section.categories[chosenIndex].imageUrl}
                          context={`${name} category image`}
                          onChange={(imageUrl) => patch({ categories: section.categories.map((c, i) => (i === chosenIndex ? { ...c, imageUrl } : c)) })}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className={hintText}>None chosen: your largest categories are shown.</p>
          <Select label="Show up to" value={section.limit} options={[2, 3, 4, 6, 8, 12].map((v) => ({ value: v, label: `${v} categories` }))} onChange={(limit) => patch({ limit })} />
        </div>
      )}

      {section.type === "featured" && (
        <div className="space-y-2">
          <p className={fieldLabel}>Products ({section.productIds.length} chosen)</p>
          {catalog.products.length > 8 && (
            <input type="search" value={productQuery} onChange={(e) => setProductQuery(e.target.value)} placeholder="Search products" aria-label="Search products to feature" className={fieldInput} />
          )}
          <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-1.5">
            {catalog.products
              .filter((p) => !productQuery || p.name.toLowerCase().includes(productQuery.toLowerCase()))
              .map((p) => {
                const position = section.productIds.indexOf(p.id);
                return (
                  <li key={p.id}>
                    <label className="flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50 lg:min-h-8">
                      <input
                        type="checkbox"
                        checked={position >= 0}
                        disabled={position < 0 && section.productIds.length >= 24}
                        onChange={(e) =>
                          patch({ productIds: e.target.checked ? [...section.productIds, p.id] : section.productIds.filter((x) => x !== p.id) })
                        }
                        className="h-4 w-4"
                      />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      {position >= 0 && <span className="text-xs font-semibold text-slate-900">#{position + 1}</span>}
                    </label>
                  </li>
                );
              })}
            {catalog.products.length === 0 && <li className="px-2 py-1.5 text-xs text-slate-500">No active products yet.</li>}
          </ul>
          <p className={hintText}>None chosen: your newest products are shown.</p>
          <Select label="Show up to" value={section.limit} options={limitOptions} onChange={(limit) => patch({ limit })} />
        </div>
      )}

      {(section.type === "bestSellers" || section.type === "newArrivals" || section.type === "sale") && (
        <Select label="Show up to" value={section.limit} options={limitOptions} onChange={(limit) => patch({ limit })} />
      )}

      {section.type === "promotions" && (
        <div className="space-y-3">
          {section.items.map((item, i) => {
            const setItem = (p: Partial<typeof item>) => patch({ items: section.items.map((x, j) => (j === i ? { ...x, ...p } : x)) });
            return (
              <fieldset key={i} className="space-y-3 rounded-xl border border-slate-200 p-3">
                <legend className="px-1 text-xs font-semibold text-slate-700">Banner {i + 1}</legend>
                <Toggle label="Show banner" checked={item.enabled} onChange={(enabled) => setItem({ enabled })} />
                <TextField label="Small heading" value={item.eyebrow} max={40} onChange={(eyebrow) => setItem({ eyebrow })} />
                <TextField label="Title (required to show)" value={item.title} max={80} onChange={(title) => setItem({ title })} />
                <TextField label="Text" value={item.text} max={200} multiline rows={2} onChange={(text) => setItem({ text })} />
                <ImageField label="Image (optional)" businessId={catalog.businessId} value={item.imageUrl} context={`banner ${i + 1} image`} onChange={(imageUrl, alt) => setItem({ imageUrl, ...(alt && !item.imageAlt ? { imageAlt: alt } : {}) })} />
                <TextField label="Image description" value={item.imageAlt} max={160} onChange={(imageAlt) => setItem({ imageAlt })} />
                <TextField label="Button text" value={item.cta.label} max={40} onChange={(label) => setItem({ cta: { ...item.cta, label } })} />
                <TextField label="Button link" value={item.cta.href} max={200} list={linkListId} onChange={(href) => setItem({ cta: { ...item.cta, href } })} />
                <button type="button" className={`${smallButton} border-red-200 text-red-700 hover:border-red-300 hover:bg-red-50`} onClick={() => patch({ items: section.items.filter((_, j) => j !== i) })}>Remove banner</button>
              </fieldset>
            );
          })}
          <button
            type="button"
            className={smallButton}
            disabled={section.items.length >= 3}
            onClick={() => patch({ items: [...section.items, { enabled: true, eyebrow: "", title: "", text: "", imageUrl: "", imageAlt: "", cta: { label: "", href: "" } }] })}
          >
            Add banner
          </button>
        </div>
      )}

      {section.type === "benefits" && (
        <div className="space-y-3">
          <TextField label="Delivery" value={section.shipping} max={160} placeholder="Ships within 2 business days" onChange={(shipping) => patch({ shipping })} />
          <TextField label="Returns" value={section.returns} max={160} onChange={(returns) => patch({ returns })} />
          <TextField label="Customer support" value={section.support} max={160} placeholder="Your contact e-mail and phone are used when empty" onChange={(support) => patch({ support })} />
          <TextField label="Your promise" value={section.guarantee} max={160} onChange={(guarantee) => patch({ guarantee })} />
          <p className={hintText}>Only write what you offer. Secure online payment and cash on delivery are added automatically when they are switched on.</p>
        </div>
      )}

      {section.type === "story" && (
        <TextField label="Your story" value={section.text} max={2000} multiline rows={6} placeholder="Your business description from Business settings is used when empty" onChange={(text) => patch({ text })} />
      )}

      <SectionHeading>Appearance</SectionHeading>
      <Select label="Background" value={section.appearance.background} options={[...APPEARANCE_OPTIONS.background]} onChange={(background) => appearance({ background })} />
      <div className="grid grid-cols-2 gap-3">
        <Select label="Spacing" value={section.appearance.spacing} options={[...APPEARANCE_OPTIONS.spacing]} onChange={(spacing) => appearance({ spacing })} />
        <Select label="Heading alignment" value={section.appearance.align} options={[...APPEARANCE_OPTIONS.align]} onChange={(align) => appearance({ align })} />
      </div>
      <p className={hintText}>Colours and type follow your theme so every section matches.</p>
    </div>
  );
}

/** How the homepage appears in search results and when shared. */
export function HomeSeoSettings({ seo, businessName, businessId, onChange }: { seo: StorefrontConfig["seo"]; businessName: string; businessId: string; onChange: (patch: Partial<StorefrontConfig["seo"]>) => void }) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 p-3" aria-hidden="true">
        <p className="text-xs font-medium text-slate-500">How it may look in search results</p>
        <p className="mt-2 truncate text-sm text-[#1a0dab]">{seo.title || businessName}</p>
        <p className="line-clamp-2 text-xs leading-5 text-slate-600">{seo.description || "Your business description is used when this is empty."}</p>
      </div>
      <TextField label={`Search title (${seo.title.length}/160)`} value={seo.title} max={160} placeholder={businessName} onChange={(title) => onChange({ title })} />
      <TextField label={`Search description (${seo.description.length}/320)`} value={seo.description} max={320} multiline rows={4} placeholder="Your business description is used when empty" onChange={(description) => onChange({ description })} />
      <ImageField label="Picture when shared" businessId={businessId} value={seo.imageUrl} context="sharing picture" onChange={(imageUrl) => onChange({ imageUrl })} />
      <p className={hintText}>These go live when you publish the homepage. Around 50 to 60 title characters and 150 to 160 description characters show fully.</p>
    </div>
  );
}
