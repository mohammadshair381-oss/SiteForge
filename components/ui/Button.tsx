import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export type ButtonVariant = "primary" | "ember" | "secondary" | "ghost" | "danger" | "invert" | "outline-light";
export type ButtonSize = "sm" | "md" | "lg";

export const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white shadow-sm hover:bg-brand-700",
  // A shade deeper than the ember accent: white text on it meets AA contrast.
  ember: "bg-ember-deep text-white shadow-sm hover:bg-[#a93109]",
  secondary: "border border-slate-300 bg-white text-slate-800 shadow-sm hover:border-slate-400 hover:bg-slate-50",
  ghost: "text-slate-700 hover:bg-slate-100 hover:text-slate-900",
  danger: "bg-red-600 text-white shadow-sm hover:bg-red-700",
  // On dark backgrounds.
  invert: "bg-white text-ink hover:bg-slate-100",
  "outline-light": "border border-white/25 text-white hover:border-white/50 hover:bg-white/5",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-8 gap-1.5 rounded-lg px-3 py-1.5 text-xs",
  md: "min-h-10 gap-2 rounded-lg px-4 py-2 text-sm",
  lg: "min-h-12 gap-2 rounded-xl px-6 py-3 text-base",
};

/** The class list of a button, for elements that cannot use the components below. */
export function buttonClass({ variant = "primary", size = "md", block = false, className = "" }: { variant?: ButtonVariant; size?: ButtonSize; block?: boolean; className?: string } = {}): string {
  return `inline-flex items-center justify-center font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focusRing} ${VARIANTS[variant]} ${SIZES[size]} ${block ? "w-full" : ""} ${className}`;
}

type Styling = { variant?: ButtonVariant; size?: ButtonSize; block?: boolean };

export function Button({ variant, size, block, className, type = "button", children, ...props }: Styling & ComponentProps<"button"> & { children: ReactNode }) {
  return (
    <button type={type} className={buttonClass({ variant, size, block, className })} {...props}>
      {children}
    </button>
  );
}

export function ButtonLink({ variant, size, block, className, children, ...props }: Styling & ComponentProps<typeof Link> & { children: ReactNode }) {
  return (
    <Link className={buttonClass({ variant, size, block, className })} {...props}>
      {children}
    </Link>
  );
}
