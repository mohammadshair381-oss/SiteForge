"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";

export const editorFocus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1";

/**
 * Layout shell of the website editor: toolbar, preview canvas and a
 * dedicated editing sidebar that is PART of the layout (never floating over
 * the preview).
 *
 * - Desktop (>= 1024px): the sidebar is a fixed-width column (340px) on the
 *   right of the workspace with its own vertical scrolling; the preview
 *   scrolls independently and takes all remaining width. Closing the sidebar
 *   gives that width back to the preview; a reopen button stays available.
 * - Tablet and mobile: the sidebar is a modal slide-in drawer from the right
 *   with a backdrop. Escape and the close button dismiss it, focus moves
 *   into it, stays inside while open (the rest of the page is inert) and
 *   returns to the button that opened it.
 */
export default function EditorWorkspace({
  toolbar,
  canvasLabel,
  canvasMeta,
  canvas,
  sidebarTitle,
  sidebar,
  sidebarOpen,
  onSidebarOpenChange,
  notices,
}: {
  toolbar: React.ReactNode;
  canvasLabel: string;
  canvasMeta?: React.ReactNode;
  canvas: React.ReactNode;
  sidebarTitle: string;
  sidebar: React.ReactNode;
  sidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
  notices?: React.ReactNode;
}) {
  const [isDesktop, setIsDesktop] = useState(true);
  const overlayRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(query.matches);
    update();
    // Below desktop width the panel is a drawer: start with it closed.
    if (!query.matches) onSidebarOpenChange(false);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Desktop: the preview and sidebar fill the window below the toolbar
  // exactly (the toolbar wraps and notices come and go), so the page itself
  // never scrolls. The CSS height is the fallback before this runs.
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridHeight, setGridHeight] = useState<number | null>(null);
  useEffect(() => {
    const grid = gridRef.current;
    if (!isDesktop || !grid) {
      setGridHeight(null);
      return;
    }
    const update = () => {
      // Space the page keeps below the grid (its ancestors' bottom padding,
      // borders and margins).
      let below = 0;
      for (let node: HTMLElement | null = grid; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        below += parseFloat(style.marginBottom) || 0;
        if (node !== grid) below += (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      }
      const top = grid.getBoundingClientRect().top + window.scrollY;
      setGridHeight(Math.max(512, Math.floor(window.innerHeight - top - below)));
    };
    update();
    const observer = new ResizeObserver(update);
    if (grid.parentElement) observer.observe(grid.parentElement);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [isDesktop]);

  const modal = sidebarOpen && !isDesktop;

  // Modal drawer behaviour (tablet/mobile only).
  useEffect(() => {
    if (!modal) return;
    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? reopenRef.current;
    // Everything outside the drawer (editor, dashboard navigation) is inert
    // while it is open; live regions such as notifications stay available.
    const inerted: Element[] = [];
    for (let node: Element | null = overlayRef.current; node && node !== document.body; node = node.parentElement) {
      for (const sibling of Array.from(node.parentElement?.children ?? [])) {
        if (sibling === node || sibling.hasAttribute("inert") || sibling.hasAttribute("aria-live")) continue;
        sibling.setAttribute("inert", "");
        inerted.push(sibling);
      }
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = drawerRef.current;
    panel?.querySelector<HTMLElement>("button, a, input, select, textarea")?.focus();
    const onKey = (event: KeyboardEvent) => {
      // A dialog opened from the drawer (media picker, confirmation) handles its own Escape.
      const dialog = event.target instanceof Element ? event.target.closest("[role=dialog], [role=alertdialog]") : null;
      if (event.key === "Escape" && (!dialog || dialog === panel)) {
        event.stopPropagation();
        onSidebarOpenChange(false);
      }
      if (event.key === "Tab" && panel) {
        const focusable = [...panel.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex='0']")];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      for (const element of inerted) element.removeAttribute("inert");
      document.body.style.overflow = previousOverflow;
    };
  }, [modal, onSidebarOpenChange]);

  // After the drawer closes (and the reopen button has rendered), return
  // focus to the control that opened it.
  const wasModalRef = useRef(false);
  useEffect(() => {
    if (modal) wasModalRef.current = true;
  }, [modal]);
  useEffect(() => {
    if (sidebarOpen || !wasModalRef.current) return;
    wasModalRef.current = false;
    const restore = restoreFocusRef.current;
    const visible = restore && restore !== document.body && document.contains(restore) && restore.getClientRects().length > 0;
    (visible ? restore : reopenRef.current)?.focus();
  }, [sidebarOpen]);

  const sidebarBody = (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5">
        <h2 id="editor-sidebar-title" className="truncate text-sm font-semibold text-slate-900">{sidebarTitle}</h2>
        <button
          type="button"
          onClick={() => onSidebarOpenChange(false)}
          title="Close editing panel"
          className={`inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 lg:h-8 lg:w-8 ${editorFocus}`}
        >
          <span className="sr-only">Close editing panel</span>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4" data-editor-sidebar-scroll>
        {sidebar}
      </div>
    </>
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {toolbar}
      {notices}
      <div
        ref={gridRef}
        className={`grid min-h-0 min-w-0 gap-3 ${
          sidebarOpen && isDesktop ? "lg:grid-cols-[minmax(0,1fr)_340px]" : "grid-cols-1"
        } lg:h-[calc(100dvh-13.5rem)] lg:min-h-[32rem]`}
        style={gridHeight ? { height: gridHeight } : undefined}
      >
        <section
          aria-label={canvasLabel}
          className="flex h-[calc(100dvh-6.75rem)] min-h-[26rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 shadow-sm lg:h-auto lg:min-h-0"
        >
          <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-1.5 text-xs text-slate-500">
            <span className="font-medium text-slate-700">{canvasLabel}</span>
            <div className="flex items-center gap-3">
              {canvasMeta}
              {!sidebarOpen && (
                <button
                  ref={reopenRef}
                  type="button"
                  onClick={() => onSidebarOpenChange(true)}
                  aria-controls="editor-sidebar"
                  aria-expanded={false}
                  className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50 lg:min-h-8 ${editorFocus}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M15 4v16" />
                  </svg>
                  Show editing panel
                </button>
              )}
            </div>
          </div>
          {/* The neutral stage the device frame sits on. */}
          <div className="ui-dots-ink relative min-h-0 flex-1 overflow-auto" data-editor-canvas-scroll>
            {canvas}
          </div>
        </section>

        {sidebarOpen && isDesktop && (
          <aside
            id="editor-sidebar"
            aria-labelledby="editor-sidebar-title"
            className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
          >
            {sidebarBody}
          </aside>
        )}
      </div>

      {modal && (
        <div ref={overlayRef} className="fixed inset-0 z-[70]">
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => onSidebarOpenChange(false)}
            className="absolute inset-0 h-full w-full cursor-default bg-slate-900/40"
          />
          <aside
            ref={drawerRef}
            id="editor-sidebar"
            role="dialog"
            aria-modal="true"
            aria-labelledby="editor-sidebar-title"
            className="absolute inset-y-0 right-0 flex w-[min(24rem,100vw)] flex-col bg-white shadow-lg"
          >
            {sidebarBody}
          </aside>
        </div>
      )}
    </div>
  );
}
