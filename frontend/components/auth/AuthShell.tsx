import Link from "next/link";
import type { ReactNode } from "react";
import type { ThemeId } from "@/lib/constants";
import ThemePreviewImage from "@/components/marketing/ThemePreviewImage";
import { Logo } from "@/components/ui/Logo";
import { Icon } from "@/components/ui/Icon";

const POINTS = ["Nine complete store designs", "Edit visually, with no code", "Private until you publish"];
const COLLAGE: ThemeId[] = ["bistro", "volt", "atelier", "harvest"];

/**
 * Frame of the sign-in, sign-up and account recovery pages: the form on one
 * side, a window on what the product makes on the other (real theme
 * thumbnails). The side panel is decorative and hidden on small screens.
 */
export default function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-surface grid min-h-screen bg-white text-slate-900 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <main className="flex min-w-0 flex-col px-5 py-6 sm:px-10">
        <Link href="/" aria-label="SiteForge home" className="w-fit rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2">
          <Logo />
        </Link>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">{children}</div>
      </main>
      <aside aria-hidden="true" className="relative isolate hidden overflow-hidden bg-ink p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="ui-dots absolute inset-0 -z-10" />
        <div className="ui-ember-glow absolute inset-0 -z-10" />
        <div>
          <p className="max-w-md font-heading text-4xl font-semibold leading-[1.08] tracking-tight xl:text-5xl">A store that looks custom-built. Without building it.</p>
          <ul className="mt-7 space-y-2.5 text-sm text-white/75">
            {POINTS.map((point) => (
              <li key={point} className="flex items-center gap-2">
                <Icon name="check" size={16} className="text-ember-soft" />
                {point}
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-10 grid max-w-xl grid-cols-2 gap-3">
          {COLLAGE.map((id, index) => (
            <div key={id} style={{ "--ui-i": index } as React.CSSProperties} className={`ui-rise overflow-hidden rounded-xl border border-white/10 shadow-lg ${index % 2 === 1 ? "translate-y-5" : ""}`}>
              <ThemePreviewImage themeId={id} className="aspect-[16/10]" />
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

export function AuthHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{title}</h1>
      {children && <div className="mt-2 text-sm leading-6 text-slate-600">{children}</div>}
    </div>
  );
}

export const authInput = "block w-full min-h-11 rounded-lg border px-3 py-2 text-sm text-slate-900 outline-none";
export const authLabel = "mb-1.5 block text-sm font-medium text-slate-800";
export const authLink = "rounded font-semibold text-slate-900 underline decoration-slate-300 underline-offset-2 transition-colors hover:decoration-ember focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2";
