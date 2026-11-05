"use client";

import { useId } from "react";
import MediaPicker from "../MediaPicker";
import { Icon } from "@/components/ui/Icon";
import { parseVideoUrl, type Section } from "@/lib/sections";
import { editorFocus } from "./EditorWorkspace";

const input = `mt-1 block min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 ${editorFocus}`;
const labelClass = "block text-xs font-medium text-slate-700";
const hint = "mt-1 text-xs leading-5 text-slate-500";
const iconButton = `inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30 lg:h-8 lg:w-8 ${editorFocus}`;

function Text({ label, value, max, onChange, placeholder, rows, help }: { label: string; value: string | undefined; max: number; onChange: (value: string) => void; placeholder?: string; rows?: number; help?: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={labelClass}>{label}</label>
      {rows ? (
        <textarea id={id} rows={rows} maxLength={max} value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={input} />
      ) : (
        <input id={id} maxLength={max} value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={input} />
      )}
      {help && <p className={hint}>{help}</p>}
    </div>
  );
}

function Picture({ businessId, label, url, alt, onChange }: { businessId: string; label: string; url: string | undefined; alt?: string; onChange: (url: string, alt: string) => void }) {
  return (
    <div>
      <p className={labelClass}>{label}</p>
      <div className="mt-1 flex items-center gap-2">
        {url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={alt ?? ""} className="h-12 w-16 shrink-0 rounded-lg border border-slate-200 object-cover" />
        )}
        <MediaPicker businessId={businessId} selectedUrl={url ?? ""} allowClear contextLabel={label.toLowerCase()} onSelect={(media) => onChange(media?.url ?? "", media?.altText ?? "")} />
      </div>
    </div>
  );
}

/** A repeating list of things (people, steps, logos) with add, reorder and remove. */
function Items<T>({ title, items, max, addLabel, blank, onChange, render }: { title: string; items: T[]; max: number; addLabel: string; blank: T; onChange: (items: T[]) => void; render: (item: T, update: (patch: Partial<T>) => void) => React.ReactNode }) {
  const move = (index: number, direction: -1 | 1) => {
    const next = [...items];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <p className={labelClass}>{title} ({items.length})</p>
      {items.map((item, index) => (
        <div key={index} className="space-y-2 rounded-xl border border-slate-200 p-3">
          <div className="-mr-1 -mt-1 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">{index + 1}</span>
            <span className="flex items-center">
              <button type="button" aria-label={`Move item ${index + 1} up`} disabled={index === 0} className={iconButton} onClick={() => move(index, -1)}><Icon name="arrow-up" size={14} /></button>
              <button type="button" aria-label={`Move item ${index + 1} down`} disabled={index === items.length - 1} className={iconButton} onClick={() => move(index, 1)}><Icon name="arrow-down" size={14} /></button>
              <button type="button" aria-label={`Remove item ${index + 1}`} className={`${iconButton} hover:!bg-red-50 hover:!text-red-700`} onClick={() => onChange(items.filter((_, i) => i !== index))}><Icon name="x" size={14} /></button>
            </span>
          </div>
          {render(item, (patch) => onChange(items.map((current, i) => (i === index ? { ...current, ...patch } : current))))}
        </div>
      ))}
      <button type="button" disabled={items.length >= max} onClick={() => onChange([...items, blank])} className={`inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 ${editorFocus}`}>
        <Icon name="plus" size={14} /> {items.length >= max ? `Up to ${max}` : addLabel}
      </button>
    </div>
  );
}

const FORMATTING_HELP = "Start a line with ## for a heading or - for a bullet. Use **bold** for emphasis and [words](/products) for a link.";

/** Editing fields of the content sections: text, image and text, video, logos, team, steps, space. */
export default function ContentSectionFields({ section, businessId, onChange }: { section: Section; businessId: string; onChange: (patch: Record<string, unknown>) => void }) {
  switch (section.type) {
    case "richText": {
      const s = section.settings;
      return (
        <div className="space-y-3">
          <Text label="Heading" value={s.title} max={160} onChange={(title) => onChange({ title })} />
          <Text label="Text" value={s.body} max={8000} rows={10} help={FORMATTING_HELP} onChange={(body) => onChange({ body })} />
        </div>
      );
    }
    case "imageText": {
      const s = section.settings;
      return (
        <div className="space-y-3">
          <Picture businessId={businessId} label="Picture" url={s.imageUrl} alt={s.imageAlt} onChange={(imageUrl, imageAlt) => onChange({ imageUrl, imageAlt })} />
          <Text label="Picture description (for screen readers)" value={s.imageAlt} max={160} onChange={(imageAlt) => onChange({ imageAlt })} />
          <div>
            <label className={labelClass}>
              Picture side
              <select value={s.imageSide ?? "right"} onChange={(e) => onChange({ imageSide: e.target.value })} className={input}>
                <option value="left">Left of the text</option>
                <option value="right">Right of the text</option>
              </select>
            </label>
          </div>
          <Text label="Heading" value={s.title} max={160} onChange={(title) => onChange({ title })} />
          <Text label="Text" value={s.body} max={4000} rows={6} help={FORMATTING_HELP} onChange={(body) => onChange({ body })} />
          <Text label="Button text (optional)" value={s.ctaText} max={60} onChange={(ctaText) => onChange({ ctaText })} />
          <Text label="Button link" value={s.ctaHref} max={300} placeholder="/products or https://…" onChange={(ctaHref) => onChange({ ctaHref })} />
        </div>
      );
    }
    case "video": {
      const s = section.settings;
      const parsed = s.url ? parseVideoUrl(s.url) : null;
      return (
        <div className="space-y-3">
          <Text label="Heading" value={s.title} max={160} onChange={(title) => onChange({ title })} />
          <Text label="YouTube or Vimeo link" value={s.url} max={300} placeholder="https://www.youtube.com/watch?v=…" onChange={(url) => onChange({ url })} />
          {s.url && !parsed && <p className="text-xs text-red-700">This does not look like a YouTube or Vimeo video link, so it cannot be saved yet.</p>}
          {parsed && <p className={hint}>Visitors see a picture with a play button, and the video opens on {parsed.provider}.</p>}
          <Picture businessId={businessId} label={parsed?.provider === "Vimeo" ? "Picture to show (needed for Vimeo)" : "Picture to show (optional)"} url={s.imageUrl} alt={s.imageAlt} onChange={(imageUrl, imageAlt) => onChange({ imageUrl, imageAlt })} />
          <Text label="Caption (optional)" value={s.caption} max={240} onChange={(caption) => onChange({ caption })} />
        </div>
      );
    }
    case "logos": {
      const s = section.settings;
      return (
        <div className="space-y-3">
          <Text label="Heading (optional)" value={s.title} max={160} onChange={(title) => onChange({ title })} />
          <Items
            title="Logos"
            items={s.items ?? []}
            max={24}
            addLabel="Add a logo"
            blank={{ imageUrl: "", alt: "", href: "" }}
            onChange={(items) => onChange({ items })}
            render={(item, update) => (
              <>
                <Picture businessId={businessId} label="Logo" url={item.imageUrl} alt={item.alt} onChange={(imageUrl, alt) => update({ imageUrl, alt: item.alt || alt })} />
                <Text label="Name" value={item.alt} max={160} onChange={(alt) => update({ alt })} />
                <Text label="Link (optional)" value={item.href} max={300} placeholder="https://…" onChange={(href) => update({ href })} />
              </>
            )}
          />
        </div>
      );
    }
    case "team": {
      const s = section.settings;
      return (
        <div className="space-y-3">
          <Text label="Heading" value={s.title} max={160} onChange={(title) => onChange({ title })} />
          <Items
            title="People"
            items={s.items ?? []}
            max={24}
            addLabel="Add a person"
            blank={{ name: "", role: "", bio: "", imageUrl: "", imageAlt: "" }}
            onChange={(items) => onChange({ items })}
            render={(item, update) => (
              <>
                <Picture businessId={businessId} label="Photo" url={item.imageUrl} alt={item.imageAlt} onChange={(imageUrl, imageAlt) => update({ imageUrl, imageAlt })} />
                <Text label="Name" value={item.name} max={120} onChange={(name) => update({ name })} />
                <Text label="Role" value={item.role} max={120} onChange={(role) => update({ role })} />
                <Text label="A few words" value={item.bio} max={600} rows={3} onChange={(bio) => update({ bio })} />
              </>
            )}
          />
        </div>
      );
    }
    case "steps": {
      const s = section.settings;
      return (
        <div className="space-y-3">
          <Text label="Heading" value={s.title} max={160} onChange={(title) => onChange({ title })} />
          <Items
            title="Steps"
            items={s.items ?? []}
            max={12}
            addLabel="Add a step"
            blank={{ title: "", description: "" }}
            onChange={(items) => onChange({ items })}
            render={(item, update) => (
              <>
                <Text label="Step" value={item.title} max={160} onChange={(title) => update({ title })} />
                <Text label="Details" value={item.description} max={600} rows={2} onChange={(description) => update({ description })} />
              </>
            )}
          />
        </div>
      );
    }
    case "spacer": {
      const s = section.settings;
      return (
        <div className="space-y-3">
          <label className={labelClass}>
            Height
            <select value={s.size ?? "medium"} onChange={(e) => onChange({ size: e.target.value })} className={input}>
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </label>
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-slate-800">
            <input type="checkbox" checked={Boolean(s.line)} onChange={(e) => onChange({ line: e.target.checked })} className="h-4 w-4 rounded" />
            Show a line
          </label>
        </div>
      );
    }
    case "reviews": {
      const s = section.settings;
      return (
        <div className="space-y-3">
          <Text label="Heading" value={s.title} max={160} onChange={(title) => onChange({ title })} />
          <label className={labelClass}>
            How many to show
            <select value={s.limit ?? 6} onChange={(e) => onChange({ limit: Number(e.target.value) })} className={input}>
              {[3, 6, 9, 12].map((count) => <option key={count} value={count}>{count} reviews</option>)}
            </select>
          </label>
          <p className={hint}>Shows the newest reviews you have approved, from real orders. You can&apos;t write or change them here, and this section stays hidden until you have some.</p>
        </div>
      );
    }
    default:
      return null;
  }
}
