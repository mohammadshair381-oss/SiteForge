"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { Icon, SectionIcon } from "@/components/ui/Icon";
import { businessNavHref, visibleBusinessTabs, type BusinessMembershipRole } from "./BusinessTabs";

const OPEN_EVENT = "siteforge:command-palette";

export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

interface PaletteBusiness {
  id: string;
  name: string;
  role: BusinessMembershipRole;
}

interface Command {
  id: string;
  label: string;
  group: string;
  href: string;
  icon: React.ReactNode;
  keywords?: string;
}

const ADMIN_PAGES = [
  ["/admin", "Admin overview", "activity"],
  ["/admin/businesses", "Admin: businesses", "business"],
  ["/admin/users", "Admin: users", "users"],
  ["/admin/payments", "Admin: payments", "billing"],
  ["/admin/plans", "Admin: plans", "layers"],
  ["/admin/ai-usage", "Admin: AI usage", "ai-builder"],
  ["/admin/security", "Admin: security", "shield"],
  ["/admin/audit", "Admin: audit log", "pages"],
] as const;

/** Extra words people may search for, by section. */
const SECTION_KEYWORDS: Record<string, string> = {
  editor: "design homepage sections customize visual",
  "ai-builder": "assistant gemini generate write suggestions",
  theme: "template marketplace look",
  storefront: "homepage hero footer policies",
  proposals: "review approve suggestions",
  orders: "sales fulfil delivery tracking",
  inventory: "stock",
  coupons: "discount promotion code",
  carts: "abandoned basket recovery",
  insights: "analytics reports revenue",
  notifications: "alerts activity bell",
  billing: "plan upgrade payment",
  settings: "domain team staff members contact",
  shipping: "delivery charges",
  media: "images photos uploads",
};

/**
 * Keyboard-first navigation (Ctrl/Cmd + K): every destination the person can
 * actually open, filtered by their role through the same tab model as the
 * sidebar. It only navigates; it never performs an action itself.
 */
export default function CommandPalette({ businesses, isSuperAdmin }: { businesses: PaletteBusiness[]; isSuperAdmin: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setIndex(0);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (restoreRef.current?.isConnected) restoreRef.current.focus();
    };
  }, [open]);

  const active = businesses.find((b) => pathname === `/dashboard/businesses/${b.id}` || pathname.startsWith(`/dashboard/businesses/${b.id}/`));

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    if (active) {
      for (const tab of visibleBusinessTabs(active.role)) {
        list.push({
          id: `tab:${tab.segment}`,
          label: tab.label,
          group: active.name,
          href: businessNavHref(active.id, tab.segment),
          icon: <SectionIcon segment={tab.segment} />,
          keywords: SECTION_KEYWORDS[tab.segment],
        });
      }
      list.push({ id: "action:add-product", label: "Add a product", group: active.name, href: `${businessNavHref(active.id, "products")}#add-product`, icon: <Icon name="plus" />, keywords: "new create item" });
    }
    list.push({ id: "all", label: "All businesses", group: "Workspace", href: "/dashboard", icon: <Icon name="overview" />, keywords: "home switch create new business" });
    for (const business of businesses) {
      if (business.id === active?.id) continue;
      list.push({ id: `business:${business.id}`, label: business.name, group: "Your businesses", href: `/dashboard/businesses/${business.id}`, icon: <Icon name="business" />, keywords: "switch store" });
    }
    if (isSuperAdmin) {
      for (const [href, label, icon] of ADMIN_PAGES) list.push({ id: href, label, group: "Platform", href, icon: <Icon name={icon} /> });
    }
    return list;
  }, [active, businesses, isSuperAdmin]);

  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return commands;
    return commands.filter((command) => {
      const text = `${command.label} ${command.group} ${command.keywords ?? ""}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [commands, query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  function go(command: Command | undefined) {
    if (!command) return;
    setOpen(false);
    router.push(command.href);
  }

  if (!open) return null;
  let lastGroup = "";

  return createPortal(
    <div className="ui-fade fixed inset-0 z-[1800] flex items-start justify-center bg-slate-950/50 px-4 pt-[12vh] backdrop-blur-[2px]">
      <button type="button" tabIndex={-1} aria-hidden="true" className="absolute inset-0 cursor-default" onClick={() => setOpen(false)} />
      <div role="dialog" aria-modal="true" aria-label="Go to" className="ui-pop relative flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 px-4">
          <Icon name="search" className="text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setOpen(false);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((value) => Math.min(value + 1, results.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((value) => Math.max(value - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                go(results[index]);
              } else if (event.key === "Tab") {
                event.preventDefault();
              }
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={results[index] ? `command-${index}` : undefined}
            aria-label="Search pages and actions"
            placeholder="Where do you want to go?"
            className="!border-0 !shadow-none h-14 w-full bg-transparent text-base text-slate-900 outline-none placeholder:text-slate-400"
          />
          <kbd className="hidden rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-500 sm:block">Esc</kbd>
        </div>
        <ul ref={listRef} id="command-results" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {results.length === 0 && <li className="px-3 py-8 text-center text-sm text-slate-500">Nothing matches &ldquo;{query}&rdquo;.</li>}
          {results.map((command, i) => {
            const showGroup = command.group !== lastGroup;
            lastGroup = command.group;
            return (
              <li key={command.id} role="presentation">
                {showGroup && <p className="truncate px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{command.group}</p>}
                <div
                  id={`command-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === index}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => go(command)}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${i === index ? "bg-slate-900 text-white" : "text-slate-700"}`}
                >
                  <span className={i === index ? "text-ember-soft" : "text-slate-400"}>{command.icon}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{command.label}</span>
                  {i === index && <Icon name="arrow-right" size={16} className="text-white/60" />}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
