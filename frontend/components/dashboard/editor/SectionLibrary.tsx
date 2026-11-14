"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { SECTION_TEMPLATES, TEMPLATE_GROUPS, type SectionTemplate, type TemplateThumb } from "@/lib/section-library";
import { editorFocus } from "./EditorWorkspace";

const bar = "rounded-sm bg-slate-300";
const block = "rounded bg-slate-200";

/** A small drawing of a section's shape. Decorative: the name and description say what it is. */
function Thumb({ kind }: { kind: TemplateThumb }) {
  const inner = (() => {
    switch (kind) {
      case "hero":
        return (
          <div className="flex h-full flex-col items-center justify-center gap-1 rounded bg-slate-200">
            <span className="h-1.5 w-2/3 rounded-sm bg-slate-400" />
            <span className={`h-1 w-1/2 ${bar}`} />
            <span className="mt-1 h-2 w-1/4 rounded-sm bg-slate-500" />
          </div>
        );
      case "split":
        return (
          <div className="grid h-full grid-cols-2 gap-1.5">
            <div className="flex flex-col justify-center gap-1">
              <span className="h-1.5 w-3/4 rounded-sm bg-slate-400" />
              <span className={`h-1 ${bar}`} />
              <span className={`h-1 w-5/6 ${bar}`} />
            </div>
            <span className={block} />
          </div>
        );
      case "grid":
        return <div className="grid h-full grid-cols-3 gap-1">{[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className={block} />)}</div>;
      case "banner":
        return (
          <div className="flex h-full items-center justify-between rounded bg-slate-300 px-2">
            <span className="h-1.5 w-1/2 rounded-sm bg-slate-500" />
            <span className="h-2.5 w-1/5 rounded-sm bg-slate-500" />
          </div>
        );
      case "quotes":
        return (
          <div className="grid h-full grid-cols-2 gap-1.5">
            {[0, 1].map((i) => (
              <div key={i} className="flex flex-col justify-center gap-1 rounded bg-slate-100 p-1">
                <span className={`h-1 ${bar}`} />
                <span className={`h-1 w-4/5 ${bar}`} />
                <span className="mt-0.5 h-1 w-1/2 rounded-sm bg-slate-400" />
              </div>
            ))}
          </div>
        );
      case "people":
        return (
          <div className="grid h-full grid-cols-3 items-center gap-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col items-center gap-1">
                <span className="h-5 w-5 rounded-full bg-slate-300" />
                <span className={`h-1 w-2/3 ${bar}`} />
              </div>
            ))}
          </div>
        );
      case "cards":
        return (
          <div className="grid h-full grid-cols-3 gap-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col justify-center gap-1 rounded bg-slate-100 p-1">
                <span className="h-1.5 w-3/4 rounded-sm bg-slate-400" />
                <span className={`h-1 ${bar}`} />
              </div>
            ))}
          </div>
        );
      case "numbers":
        return (
          <div className="grid h-full grid-cols-3 items-center gap-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col items-center gap-1">
                <span className="h-3 w-3/4 rounded-sm bg-slate-400" />
                <span className={`h-1 w-1/2 ${bar}`} />
              </div>
            ))}
          </div>
        );
      case "list":
        return (
          <div className="flex h-full flex-col justify-center gap-1.5">
            {[0, 1, 2].map((i) => <span key={i} className="h-2.5 rounded-sm bg-slate-200" />)}
          </div>
        );
      case "form":
        return (
          <div className="flex h-full flex-col items-center justify-center gap-1">
            <span className="h-1.5 w-1/2 rounded-sm bg-slate-400" />
            <span className={`h-1 w-2/3 ${bar}`} />
            <span className="mt-0.5 h-2.5 w-1/3 rounded-sm bg-slate-500" />
          </div>
        );
      case "logos":
        return <div className="flex h-full items-center justify-around">{[0, 1, 2, 3].map((i) => <span key={i} className="h-3 w-1/6 rounded-sm bg-slate-300" />)}</div>;
      case "centered":
      default:
        return (
          <div className="flex h-full flex-col items-center justify-center gap-1">
            <span className="h-1.5 w-3/5 rounded-sm bg-slate-400" />
            <span className="mt-0.5 h-2.5 w-1/4 rounded-sm bg-slate-500" />
          </div>
        );
    }
  })();
  return <div aria-hidden="true" className="h-16 rounded-lg border border-slate-200 bg-white p-1.5">{inner}</div>;
}

/**
 * The section library: ready-made sections to insert into the page being edited. What is
 * inserted is an ordinary draft section, shown in the preview straight away.
 */
export default function SectionLibrary({ blockedNote, onInsert, onClose }: { /** Why a template cannot be added here, if so. */ blockedNote?: (template: SectionTemplate) => string | null; onInsert: (template: SectionTemplate) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const found = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? SECTION_TEMPLATES.filter((template) => `${template.label} ${template.description} ${template.group}`.toLowerCase().includes(needle)) : SECTION_TEMPLATES;
  }, [query]);

  return (
    <div className="ui-fade fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-slate-950/50 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="section-library-title">
      <div className="ui-pop my-auto flex max-h-[90dvh] w-full max-w-4xl flex-col rounded-2xl border border-slate-200 bg-white shadow-lg">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 p-5">
          <div className="min-w-0 flex-1 basis-64">
            <h2 id="section-library-title" className="text-lg font-semibold text-slate-900">Add a section</h2>
            <p className="mt-0.5 text-sm text-slate-600">Each one takes the look of your theme. Replace the text in [[double brackets]] with your own: the page can&apos;t be published until you do.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={`inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 ${editorFocus}`}>
            <Icon name="x" size={18} />
          </button>
          <label className="w-full text-xs font-medium text-slate-700">
            Search sections
            <input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} className={`mt-1 block min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 ${editorFocus}`} />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {found.length === 0 && <p className="py-8 text-center text-sm text-slate-600">No section matches that. Try another word.</p>}
          {TEMPLATE_GROUPS.map((group) => {
            const templates = found.filter((template) => template.group === group);
            if (templates.length === 0) return null;
            return (
              <section key={group} className="mb-6 last:mb-0">
                <h3 className="text-sm font-semibold text-slate-900">{group}</h3>
                <ul className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {templates.map((template) => {
                    const blocked = blockedNote?.(template) ?? null;
                    return (
                      <li key={template.key}>
                        <button
                          type="button"
                          disabled={Boolean(blocked)}
                          onClick={() => onInsert(template)}
                          className={`flex h-full w-full flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-left transition-colors hover:border-slate-400 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 ${editorFocus}`}
                        >
                          <Thumb kind={template.thumb} />
                          <span className="text-sm font-medium text-slate-900">
                            {template.label}
                            {blocked && <span className="ml-1 text-xs font-normal text-slate-500">({blocked})</span>}
                          </span>
                          <span className="text-xs leading-5 text-slate-600">{template.description}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
