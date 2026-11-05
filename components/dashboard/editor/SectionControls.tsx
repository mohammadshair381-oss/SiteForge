"use client";

import { useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { editorFocus } from "./EditorWorkspace";

/**
 * Section management shared by the store homepage editor and the classic
 * section editor, so both behave the same: a row with drag, move, show/hide
 * and remove; the same actions in the settings panel; the same add list.
 */

export type DropPosition = "before" | "after";

const rowIconButton = `inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30 lg:h-7 lg:w-7 ${editorFocus}`;
const panelButton = `inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 lg:min-h-8 ${editorFocus}`;

/** A copy of `list` with one item moved next to another (the order drag and drop produces). */
export function reorderById<T extends { id: string }>(list: readonly T[], fromId: string, toId: string, position: DropPosition): T[] {
  const from = list.findIndex((item) => item.id === fromId);
  const to = list.findIndex((item) => item.id === toId);
  if (from < 0 || to < 0 || fromId === toId) return [...list];
  const next = [...list];
  const [moved] = next.splice(from, 1);
  let at = position === "before" ? to : to + 1;
  if (from < to) at -= 1;
  next.splice(Math.max(0, Math.min(at, next.length)), 0, moved);
  return next;
}

export function SectionSwitch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      title={checked ? "Shown on the page. Select to hide." : "Hidden. Select to show."}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
      className={`inline-flex h-10 shrink-0 items-center rounded-full px-0.5 disabled:cursor-not-allowed disabled:opacity-40 lg:h-7 ${editorFocus}`}
    >
      <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? "bg-slate-900" : "bg-slate-300"}`}>
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-[1.125rem]" : "translate-x-0.5"}`} />
      </span>
    </button>
  );
}

/**
 * Drag to reorder within a section list. Pointer convenience only: the move
 * buttons on each row do the same with a keyboard or on a touch screen.
 */
export function useSectionDrag(onReorder: (fromId: string, toId: string, position: DropPosition) => void) {
  const fromRef = useRef<string | null>(null);
  const [target, setTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  const clear = () => {
    fromRef.current = null;
    setTarget(null);
  };
  const positionOf = (event: React.DragEvent<HTMLElement>): DropPosition => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? "before" : "after";
  };
  return {
    target,
    handle: (id: string) => ({
      draggable: true,
      onDragStart: (event: React.DragEvent<HTMLElement>) => {
        fromRef.current = id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
        const row = event.currentTarget.closest("li");
        if (row) event.dataTransfer.setDragImage(row, 16, 16);
      },
      onDragEnd: clear,
    }),
    row: (id: string) => ({
      onDragOver: (event: React.DragEvent<HTMLElement>) => {
        if (!fromRef.current) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const position = positionOf(event);
        setTarget((current) => (current?.id === id && current.position === position ? current : { id, position }));
      },
      onDrop: (event: React.DragEvent<HTMLElement>) => {
        event.preventDefault();
        const from = fromRef.current;
        const position = positionOf(event);
        clear();
        if (from && from !== id) onReorder(from, id, position);
      },
    }),
  };
}

export function SectionRow({
  id,
  name,
  detail,
  muted,
  selected,
  isFirst,
  isLast,
  visible,
  disabled,
  drag,
  onSelect,
  onMove,
  onToggle,
  onRemove,
}: {
  id: string;
  name: string;
  detail: string;
  muted?: boolean;
  selected?: boolean;
  isFirst: boolean;
  isLast: boolean;
  visible: boolean;
  /** No permission to change the page (the row can still be selected). */
  disabled?: boolean;
  drag: ReturnType<typeof useSectionDrag>;
  onSelect: () => void;
  onMove: (direction: -1 | 1) => void;
  onToggle: (visible: boolean) => void;
  onRemove: () => void;
}) {
  const dropAt = drag.target?.id === id ? drag.target.position : null;
  return (
    <li {...(disabled ? {} : drag.row(id))} className="relative">
      {dropAt && <span aria-hidden="true" className={`absolute inset-x-0 z-10 h-0.5 rounded-full bg-ember ${dropAt === "before" ? "-top-1" : "-bottom-1"}`} />}
      <div className={`flex items-center gap-0.5 rounded-lg border py-1 pl-1 pr-1 transition-colors ${selected ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white hover:border-slate-300"}`}>
        {!disabled && (
          <span {...drag.handle(id)} aria-hidden="true" title="Drag to reorder" className="hidden h-7 w-5 shrink-0 cursor-grab items-center justify-center rounded text-slate-300 hover:text-slate-500 active:cursor-grabbing lg:inline-flex">
            <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
              <circle cx="2.5" cy="3" r="1.3" />
              <circle cx="7.5" cy="3" r="1.3" />
              <circle cx="2.5" cy="8" r="1.3" />
              <circle cx="7.5" cy="8" r="1.3" />
              <circle cx="2.5" cy="13" r="1.3" />
              <circle cx="7.5" cy="13" r="1.3" />
            </svg>
          </span>
        )}
        <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined} className={`min-h-10 min-w-0 flex-1 rounded py-0.5 pl-1.5 text-left lg:min-h-8 lg:pl-0.5 ${editorFocus}`}>
          <span className={`block truncate text-sm font-medium ${muted ? "text-slate-500" : "text-slate-900"}`}>{name}</span>
          <span className="block truncate text-xs text-slate-500">{detail}</span>
        </button>
        <button type="button" className={rowIconButton} disabled={disabled || isFirst} onClick={() => onMove(-1)} title="Move up">
          <span className="sr-only">Move {name} up</span>
          <Icon name="chevron-down" size={14} className="rotate-180" />
        </button>
        <button type="button" className={rowIconButton} disabled={disabled || isLast} onClick={() => onMove(1)} title="Move down">
          <span className="sr-only">Move {name} down</span>
          <Icon name="chevron-down" size={14} />
        </button>
        <SectionSwitch checked={visible} label={`Show ${name}`} disabled={disabled} onChange={onToggle} />
        <button type="button" className={`${rowIconButton} hover:bg-red-50 hover:text-red-700`} disabled={disabled} onClick={onRemove} title="Remove">
          <span className="sr-only">Remove {name}</span>
          <Icon name="x" size={14} />
        </button>
      </div>
    </li>
  );
}

/** The owner's own name for a section, shown only here in the editor. */
export function SectionNameField({ value, placeholder, disabled, onChange }: { value: string | undefined; placeholder: string; disabled?: boolean; onChange: (name: string) => void }) {
  return (
    <label className="block text-xs font-medium text-slate-700">
      Section name
      <input value={value ?? ""} maxLength={60} disabled={disabled} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className={`mt-1 block min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 ${editorFocus}`} />
      <span className="mt-1 block font-normal text-slate-500">Helps you find it in this list. Visitors never see it.</span>
    </label>
  );
}

/** The selected section's actions, at the top of its settings. */
export function SectionPanelActions({
  isFirst,
  isLast,
  visible,
  disabled,
  duplicateDisabled,
  onMove,
  onToggle,
  onDuplicate,
  onRemove,
}: {
  isFirst: boolean;
  isLast: boolean;
  visible: boolean;
  disabled?: boolean;
  duplicateDisabled?: boolean;
  onMove: (direction: -1 | 1) => void;
  onToggle: (visible: boolean) => void;
  /** Absent for sections a page can hold only once. */
  onDuplicate?: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white py-0.5 pl-3 pr-1.5">
        <span className="text-sm font-medium text-slate-800">Show this section</span>
        <SectionSwitch checked={visible} label="Show this section" disabled={disabled} onChange={onToggle} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Section actions">
        <button type="button" className={panelButton} disabled={disabled || isFirst} onClick={() => onMove(-1)}>
          Move up
        </button>
        <button type="button" className={panelButton} disabled={disabled || isLast} onClick={() => onMove(1)}>
          Move down
        </button>
        {onDuplicate && (
          <button type="button" className={panelButton} disabled={disabled || duplicateDisabled} onClick={onDuplicate}>
            Duplicate
          </button>
        )}
        <button type="button" className={`${panelButton} ml-auto border-red-200 text-red-700 hover:border-red-300 hover:bg-red-50`} disabled={disabled} onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

export interface AddSectionOption {
  key: string;
  label: string;
  description: string;
  /** Shown beside the name when the option cannot be added. */
  blockedNote?: string;
}

/** "Add section": opens the list of section types, each with what it is for. */
export function AddSectionMenu({ options, disabled, disabledNote, onAdd, children }: { options: AddSectionOption[]; disabled?: boolean; disabledNote?: string; onAdd: (key: string) => void; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="add-section-list"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className={`flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800 transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:opacity-50 ${editorFocus}`}
      >
        <Icon name={open ? "x" : "plus"} size={15} /> Add section
      </button>
      {disabled && disabledNote && <p className="mt-1 text-xs text-slate-500">{disabledNote}</p>}
      {children}
      {open && (
        <ul id="add-section-list" className="ui-pop mt-2 space-y-1.5" aria-label="Section types">
          {options.map((option) => (
            <li key={option.key}>
              <button
                type="button"
                disabled={disabled || Boolean(option.blockedNote)}
                onClick={() => {
                  setOpen(false);
                  onAdd(option.key);
                }}
                className={`block min-h-10 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 ${editorFocus}`}
              >
                <span className="block text-sm font-medium text-slate-900">
                  {option.label}
                  {option.blockedNote && <span className="ml-1 text-xs font-normal text-slate-500">({option.blockedNote})</span>}
                </span>
                <span className="block text-xs text-slate-500">{option.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
