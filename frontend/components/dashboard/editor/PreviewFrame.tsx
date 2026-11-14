"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorDevice } from "./EditorToolbar";

/** Viewport width of each device preview (desktop: at least this wide). */
export const DEVICE_VIEWPORTS: Record<EditorDevice, number> = { desktop: 1024, tablet: 768, mobile: 375 };

export interface PreviewLayout {
  device: EditorDevice;
  /** Width of the preview viewport in CSS pixels (what the store "sees"). */
  viewport: number;
  /** Zoom applied to fit the canvas (1 = actual size). */
  scale: number;
}

/**
 * The device viewport for a canvas `available` pixels wide, and the zoom that
 * fits it: phones and tablets keep their width, desktop is at least 1024px
 * (wider when the canvas is), and nothing is ever enlarged.
 */
export function fitPreview(device: EditorDevice, available: number): { viewport: number; scale: number } {
  const viewport = device === "desktop" ? Math.max(Math.round(available), DEVICE_VIEWPORTS.desktop) : DEVICE_VIEWPORTS[device];
  return { viewport, scale: available > 0 ? Math.min(1, available / viewport) : 1 };
}

/** Human label for the canvas header, e.g. "Tablet · 768px · 79%". */
export function previewLayoutLabel({ device, viewport, scale }: PreviewLayout): string {
  const name = device === "desktop" ? "Desktop" : device === "tablet" ? "Tablet" : "Mobile";
  return `${name} · ${viewport}px${scale < 0.995 ? ` · ${Math.round(scale * 100)}%` : ""}`;
}

/**
 * The element an event in the preview happened on. Nodes inside the frame
 * belong to the frame's window, so `instanceof Element` (this window's class)
 * would be false for them.
 */
export function previewElement(target: EventTarget | null): HTMLElement | null {
  return target && typeof (target as Element).closest === "function" ? (target as HTMLElement) : null;
}

const FRAME_DOCUMENT = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body data-preview-root></body></html>';

/**
 * The editor's preview canvas. The storefront components are rendered by the
 * editor's own React tree (live draft, same renderer as the public store) into
 * a same-origin iframe whose viewport is the chosen device width, so the
 * store's responsive styles (media queries) behave exactly as they do on that
 * device. When the canvas is narrower than the device, the frame is zoomed out
 * to fit rather than squeezing the layout. The frame has its own scrolling and
 * viewport height, like a real screen.
 */
export default function PreviewFrame({
  device,
  title,
  children,
  onLayout,
  onDocument,
}: {
  device: EditorDevice;
  title: string;
  children: React.ReactNode;
  onLayout?: (layout: PreviewLayout) => void;
  onDocument?: (doc: Document | null) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  // The document whose stylesheets have loaded (the frame stays hidden until
  // then, so the store never flashes unstyled).
  const [styledDoc, setStyledDoc] = useState<Document | null>(null);
  const ready = doc !== null && styledDoc === doc;
  const [box, setBox] = useState({ width: 0, height: 0 });
  const onLayoutRef = useRef(onLayout);
  const onDocumentRef = useRef(onDocument);
  useEffect(() => {
    onLayoutRef.current = onLayout;
    onDocumentRef.current = onDocument;
  });

  // Space available in the canvas.
  useEffect(() => {
    const element = boxRef.current;
    if (!element) return;
    const update = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The frame document is ready once the srcdoc has loaded (it may already
  // have loaded before this effect ran).
  const attach = useCallback(() => {
    const frameDocument = frameRef.current?.contentDocument;
    if (frameDocument?.body?.hasAttribute("data-preview-root")) setDoc((current) => (current === frameDocument ? current : frameDocument));
  }, []);
  useEffect(attach, [attach]);
  const handleLoad = useCallback(() => {
    const frame = frameRef.current;
    if (frame?.contentDocument?.body?.hasAttribute("data-preview-root")) attach();
    // The frame was navigated away (a link or form in the store): restore it.
    else if (frame) frame.srcdoc = FRAME_DOCUMENT;
  }, [attach]);

  useEffect(() => {
    onDocumentRef.current?.(doc);
    if (!doc) return;
    doc.documentElement.lang = document.documentElement.lang;
    doc.body.className = document.body.className;

    // Mirror the app's stylesheets (Tailwind and theme CSS) into the frame and
    // keep them in sync (development style updates).
    const copies = new Map<Element, Element>();
    let pending = 0;
    const settle = () => {
      pending -= 1;
      if (pending <= 0) setStyledDoc(doc);
    };
    const sync = () => {
      const sources = Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style'));
      for (const [source, copy] of copies) {
        if (!sources.includes(source)) {
          copy.remove();
          copies.delete(source);
        }
      }
      for (const source of sources) {
        const copy = copies.get(source);
        if (!copy) {
          const clone = source.cloneNode(true) as Element;
          if (clone.tagName === "LINK") {
            pending += 1;
            clone.addEventListener("load", settle, { once: true });
            clone.addEventListener("error", settle, { once: true });
          }
          doc.head.appendChild(clone);
          copies.set(source, clone);
        } else if (copy.textContent !== source.textContent) {
          copy.textContent = source.textContent;
        } else if (copy.getAttribute("href") !== source.getAttribute("href")) {
          copy.setAttribute("href", source.getAttribute("href") ?? "");
        }
      }
    };
    sync();
    if (pending === 0) setStyledDoc(doc);
    const fallback = window.setTimeout(() => setStyledDoc(doc), 4000);
    const observer = new MutationObserver(sync);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });

    // Editor shortcuts (undo, save, Escape) keep working while focus is in the
    // preview: forward them to the editor window (never while typing).
    const forward = (event: KeyboardEvent) => {
      const target = previewElement(event.target);
      const typing = target && (/^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable);
      if (typing || !(event.ctrlKey || event.metaKey || event.key === "Escape")) return;
      const copy = new KeyboardEvent("keydown", {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        bubbles: true,
        cancelable: true,
      });
      if (!window.dispatchEvent(copy)) event.preventDefault();
    };
    doc.addEventListener("keydown", forward);
    return () => {
      window.clearTimeout(fallback);
      observer.disconnect();
      doc.removeEventListener("keydown", forward);
      onDocumentRef.current?.(null);
    };
  }, [doc]);

  const { viewport, scale } = fitPreview(device, box.width);
  const height = box.height > 0 ? box.height / scale : 0;

  useEffect(() => {
    if (box.width > 0) onLayoutRef.current?.({ device, viewport, scale });
  }, [box.width, device, viewport, scale]);

  // Phones and tablets show overlay scrollbars: keep the full device width.
  useEffect(() => {
    if (!doc) return;
    let style = doc.getElementById("preview-frame-style");
    if (!style) {
      style = doc.createElement("style");
      style.id = "preview-frame-style";
      doc.head.appendChild(style);
    }
    style.textContent = device === "desktop" ? "" : "html{scrollbar-width:none}html::-webkit-scrollbar{display:none}";
  }, [doc, device]);

  return (
    <div ref={boxRef} className="relative h-full w-full overflow-hidden">
      {!ready && <p role="status" className="absolute inset-0 grid place-items-center text-sm text-slate-500">Loading preview…</p>}
      <div
        className={`mx-auto h-full overflow-hidden bg-white shadow-lg ring-1 ring-slate-300/80 ${device === "desktop" ? "rounded-lg" : "rounded-2xl"}`}
        style={{ width: box.width > 0 ? viewport * scale : "100%", visibility: ready ? undefined : "hidden" }}
      >
        <iframe
          ref={frameRef}
          title={title}
          srcDoc={FRAME_DOCUMENT}
          onLoad={handleLoad}
          data-ready={ready ? "true" : undefined}
          className="block border-0"
          style={{
            width: box.width > 0 ? viewport : "100%",
            height: height > 0 ? height : "100%",
            transform: scale < 1 ? `scale(${scale})` : undefined,
            transformOrigin: "0 0",
          }}
        />
      </div>
      {doc && createPortal(children, doc.body)}
    </div>
  );
}
