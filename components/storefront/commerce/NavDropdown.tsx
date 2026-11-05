"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * A header link with a dropdown under it: opens on hover and on click, works by
 * keyboard, and closes on Escape or a click elsewhere. Uses its own document, as
 * the editor renders the store inside a frame.
 */
export default function NavDropdown({
  label,
  href,
  external,
  links,
  className,
  panelClassName,
  linkClassName,
  focusClassName,
}: {
  label: string;
  href: string;
  external?: boolean;
  links: Array<{ label: string; href: string; external?: boolean }>;
  className: string;
  panelClassName: string;
  linkClassName: string;
  focusClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const doc = rootRef.current?.ownerDocument ?? document;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    doc.addEventListener("keydown", onKey);
    doc.addEventListener("mousedown", onPointer);
    return () => {
      doc.removeEventListener("keydown", onKey);
      doc.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const all = href && href !== "#" ? [{ label, href, external }, ...links] : links;
  return (
    <div ref={rootRef} className="relative flex items-center" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button ref={buttonRef} type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)} className={`inline-flex items-center gap-1 whitespace-nowrap rounded ${className} ${focusClassName}`}>
        {label}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 pt-2">
          <ul id={panelId} className={`min-w-48 rounded-xl p-1.5 shadow-xl ring-1 ring-black/10 ${panelClassName}`}>
            {all.map((link) => (
              <li key={link.href}>
                <a href={link.href} {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})} className={`block whitespace-nowrap rounded-lg px-3 py-2 text-sm ${linkClassName}`}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
