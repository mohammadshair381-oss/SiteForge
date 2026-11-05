"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Pill, type Tone } from "@/components/ui/Surface";
import DeviceSwitch from "./DeviceSwitch";
import { editorFocus } from "./EditorWorkspace";

export type EditorDevice = "desktop" | "tablet" | "mobile";

const button = `inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-9 ${editorFocus}`;
const iconButton = `inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30 lg:min-h-9 lg:min-w-9 ${editorFocus}`;
const primary = `inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60 lg:min-h-9 ${editorFocus}`;

/** The page switcher in the toolbar's left zone. */
export const editorSelectClass = `min-h-10 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-800 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:max-w-[18rem] lg:min-h-9 ${editorFocus}`;

export interface MoreAction {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export type EditorSaveTone = "saved" | "unsaved" | "busy" | "error";

const SAVE_MARK: Record<EditorSaveTone, string> = {
  saved: "bg-emerald-500",
  unsaved: "bg-amber-500",
  busy: "bg-slate-400",
  error: "bg-red-600",
};

/**
 * Studio toolbar, in two calm rows. Top: page switcher on the left, device
 * switcher in the centre; undo and redo, Preview, Publish and More on the
 * right. Below: what you are looking at (always a draft, with what visitors
 * see) and the save state with Save draft and the AI assistant. Phones get a
 * compact arrangement of the same controls (see below).
 */
export default function EditorToolbar({
  title,
  status,
  saveTone,
  viewing,
  leading,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  device,
  onDeviceChange,
  onSave,
  saveLabel = "Save draft",
  saveDisabled,
  onPreview,
  onPublish,
  publishLabel = "Publish",
  publishDisabled,
  busy,
  more,
  assistant,
}: {
  title: string;
  status: string;
  /** How calm the save state should look. Defaults to "busy" while working, otherwise "saved". */
  saveTone?: EditorSaveTone;
  /** Draft or live: what the canvas shows, and what visitors see. */
  viewing?: { label: string; detail: string; tone?: Tone };
  leading?: React.ReactNode;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  device: EditorDevice;
  onDeviceChange: (device: EditorDevice) => void;
  onSave: () => void;
  saveLabel?: string;
  saveDisabled?: boolean;
  onPreview?: () => void;
  onPublish?: () => void;
  publishLabel?: string;
  publishDisabled?: boolean;
  busy?: boolean;
  more: MoreAction[];
  /** Optional AI assistant toggle (store homepage editor). */
  assistant?: { open: boolean; onToggle: () => void };
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const tone: EditorSaveTone = saveTone ?? (busy ? "busy" : "saved");

  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMoreOpen(false);
        moreButtonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const history = (
    <div role="group" aria-label="Edit history" className="flex items-center">
      <button type="button" onClick={onUndo} disabled={!canUndo} className={iconButton} title="Undo (Ctrl+Z)">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-4" /></svg>
        <span className="sr-only">Undo</span>
      </button>
      <button type="button" onClick={onRedo} disabled={!canRedo} className={iconButton} title="Redo (Ctrl+Y)">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h4" /></svg>
        <span className="sr-only">Redo</span>
      </button>
    </div>
  );
  const menuItem = (danger?: boolean) => `block min-h-10 w-full rounded-lg px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 ${danger ? "text-red-700 hover:bg-red-50" : "text-slate-700 hover:bg-slate-50"} ${editorFocus}`;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/*
        On a phone the toolbar is two slim rows so the preview keeps the screen:
        page, save, publish and More; then device, undo and redo, and save state.
        Preview, the AI assistant and the draft note move into More there.
      */}
      <div className="flex items-center gap-2 px-2.5 py-2 sm:grid sm:grid-cols-1 sm:gap-x-4 sm:px-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {leading ? (
            <>
              <Icon name="pages" size={16} className="hidden text-slate-400 sm:block" />
              <p className="sr-only">{title}</p>
              {leading}
            </>
          ) : (
            <p className="truncate text-sm font-semibold text-slate-900">{title}</p>
          )}
        </div>

        <div className="hidden sm:flex sm:justify-start lg:justify-center">
          <DeviceSwitch device={device} onChange={onDeviceChange} />
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:min-w-0 sm:flex-wrap lg:justify-end">
          <div className="hidden sm:block">{history}</div>

          <div role="group" aria-label="Save and publish" className="flex items-center gap-1.5 sm:flex-wrap">
            {onPreview && (
              <button type="button" onClick={onPreview} disabled={busy} className={`${button} hidden sm:inline-flex`}>
                <Icon name="eye" size={15} />
                Preview
              </button>
            )}
            <button type="button" onClick={onSave} disabled={busy || saveDisabled} className={`${button} px-2.5 sm:hidden`}>
              {busy ? "Saving…" : "Save"}
            </button>
            {onPublish && (
              <button type="button" onClick={onPublish} disabled={busy || publishDisabled} className={`${primary} px-3 sm:px-4`}>
                {publishLabel}
              </button>
            )}
            <div ref={moreRef} className="relative">
              <button
                ref={moreButtonRef}
                type="button"
                aria-expanded={moreOpen}
                aria-controls="editor-more-actions"
                onClick={() => setMoreOpen((v) => !v)}
                className={iconButton}
                title="More actions"
              >
                <span className="sr-only">More</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
                <span className="sr-only">actions</span>
              </button>
              {moreOpen && (
                <div id="editor-more-actions" className="ui-pop absolute right-0 top-full z-50 mt-1 w-64 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
                  <div className="sm:hidden">
                    {viewing && (
                      <p className="border-b border-slate-100 px-3 py-2 text-xs text-slate-600">
                        <Pill tone={viewing.tone ?? "neutral"} dot>{viewing.label}</Pill>
                        <span className="mt-1 block">{viewing.detail}</span>
                      </p>
                    )}
                    {onPreview && (
                      <button type="button" disabled={busy} onClick={() => { setMoreOpen(false); onPreview(); }} className={menuItem()}>
                        Preview
                      </button>
                    )}
                    {assistant && (
                      <button type="button" aria-pressed={assistant.open} onClick={() => { setMoreOpen(false); assistant.onToggle(); }} className={menuItem()}>
                        {assistant.open ? "Close AI assistant" : "AI assistant"}
                      </button>
                    )}
                  </div>
                  {more.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      disabled={action.disabled}
                      onClick={() => {
                        setMoreOpen(false);
                        action.onSelect();
                      }}
                      className={menuItem(action.danger)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-x-3 gap-y-1.5 border-t border-slate-100 px-2.5 py-1 sm:flex-wrap sm:gap-x-4 sm:px-4 sm:py-1.5">
        <div className="flex shrink-0 items-center gap-1 sm:hidden">
          <DeviceSwitch device={device} onChange={onDeviceChange} />
          {history}
        </div>
        {viewing ? (
          <p className="hidden min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600 sm:flex">
            <Pill tone={viewing.tone ?? "neutral"} dot>{viewing.label}</Pill>
            <span className="min-w-0">{viewing.detail}</span>
          </p>
        ) : (
          <span className="hidden sm:block" />
        )}
        <div className="flex min-w-0 items-center gap-2 sm:flex-wrap">
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-slate-600" role="status" aria-live="polite">
            <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${SAVE_MARK[tone]}`} />
            <span className="truncate">{status}</span>
          </span>
          <button type="button" onClick={onSave} disabled={busy || saveDisabled} className={`${button} hidden sm:inline-flex lg:min-h-8 lg:py-1 lg:text-xs`}>
            {busy ? "Saving…" : saveLabel}
          </button>
          {assistant && (
            <button
              type="button"
              onClick={assistant.onToggle}
              aria-pressed={assistant.open}
              className={`hidden min-h-10 items-center justify-center gap-1.5 rounded-lg border px-3 py-1 text-sm font-medium shadow-sm transition-colors sm:inline-flex lg:min-h-8 lg:text-xs ${editorFocus} ${
                assistant.open ? "border-brand-200 bg-brand-50 text-[#b23a12]" : "border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50"
              }`}
            >
              <Icon name="ai-builder" size={14} className="text-ember" />
              <span>AI assistant</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
