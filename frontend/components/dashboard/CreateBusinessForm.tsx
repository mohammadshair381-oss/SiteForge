"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Surface";
import { buttonClass, focusRing } from "@/components/ui/Button";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { fieldErrorId, invalidProps, readApiError, summaryMessage } from "@/lib/api-errors";
import type { ThemeId } from "@/lib/constants";
import { getThemeMeta } from "@/lib/themes";
import { defaultThemeFor } from "@/lib/theme-tiers";
import { SAMPLE_PRODUCT_COUNT, sampleCatalogFor, sampleImage } from "@/lib/theme-preview-samples";
import ThemeThumbnail from "./ThemeThumbnail";

interface CategoryOption {
  key: string;
  name: string;
}

/** A picture for each kind of business: a sample photo where one fits, else an icon. */
const TYPE_PICTURE: Record<string, { photo?: string; icon?: IconName }> = {
  retail: { photo: "canvas-tote" },
  clothing: { photo: "white-cotton-tee" },
  shoes: { photo: "leather-belt" },
  electronics: { photo: "wireless-earbuds" },
  grocery: { photo: "organic-apples" },
  furniture: { photo: "velvet-sofa" },
  cosmetics: { photo: "scented-candle" },
  hardware: { icon: "inventory" },
  food: { photo: "butter-croissant" },
  services: { icon: "business" },
  beauty: { photo: "round-sunglasses" },
  realestate: { icon: "globe" },
  fitness: { photo: "insulated-bottle" },
  education: { photo: "ruled-notebook" },
  technology: { photo: "slim-keyboard" },
  creative: { photo: "pendant-lamp" },
  other: { icon: "storefront" },
};

const STEPS = ["Name", "What you sell", "Look"] as const;

/**
 * Quick start for a new business, in three small steps a non-technical owner can follow:
 * a name, what they sell (picture tiles) and a look (theme tiles). SiteForge then prepares
 * the homepage, draft pages and, if wanted, a few hidden sample products, and opens the
 * guided setup. Nothing is published.
 */
export default function CreateBusinessForm({
  categories,
  rootDomain,
  themes,
}: {
  categories: CategoryOption[];
  rootDomain?: string;
  /** Themes a new store may start with (the free plan's). */
  themes: ThemeId[];
}) {
  const router = useRouter();
  const nameId = useId();
  const subdomainId = useId();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [themeId, setThemeId] = useState<ThemeId | null>(null);
  const [addSamples, setAddSamples] = useState(true);
  const [subdomain, setSubdomain] = useState("");
  const [showAddress, setShowAddress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const suggestedTheme = defaultThemeFor(category, themes);
  const chosenTheme = themeId ?? suggestedTheme;
  const samplesFit = sampleCatalogFor(chosenTheme, category).length > 0;

  useEffect(() => {
    if (!open) return;
    const toggle = toggleRef.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "Tab" && dialogRef.current) {
        const items = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input, select")];
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      toggle?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (open && step === 0) nameRef.current?.focus();
  }, [open, step]);

  function start() {
    setStep(0);
    setError(null);
    setFieldErrors({});
    setOpen(true);
  }

  function next() {
    setError(null);
    if (step === 0 && name.trim().length < 2) {
      setFieldErrors({ name: "Type your business name (at least 2 letters)." });
      return;
    }
    if (step === 1 && !category) {
      setError("Tap the picture that is closest to what you sell.");
      return;
    }
    setFieldErrors({});
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  }

  async function create() {
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch("/api/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          category,
          themeId: chosenTheme,
          addSamples: addSamples && samplesFit,
          subdomain: subdomain || undefined,
        }),
      });
      if (!res.ok) {
        const info = await readApiError(res, "Your business could not be created. Try again.");
        setFieldErrors(info.fields);
        setError(summaryMessage(info, ["name", "category", "subdomain"]));
        // Name and web address problems are fixed on the first step.
        if (info.fields.name || info.fields.subdomain) {
          setShowAddress(Boolean(info.fields.subdomain));
          setStep(0);
        }
        return;
      }
      const data = await res.json();
      // New stores start in the guided setup (it can be left and resumed).
      router.push(`/dashboard/businesses/${data.business._id}/setup`);
      router.refresh();
    } catch {
      setError("Network problem: your business was not created. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  const tile = (selected: boolean) =>
    `flex min-h-24 flex-col items-center justify-center gap-1.5 rounded-xl border p-2 text-center text-xs font-medium transition-colors ${focusRing} ${
      selected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
    }`;

  return (
    <div>
      <button ref={toggleRef} id="create-business-toggle" type="button" onClick={start} className={buttonClass({ block: true, className: "sm:w-auto" })}>
        <Icon name="plus" size={16} />
        Create business
      </button>

      {open &&
        createPortal(
          <div className="ui-fade fixed inset-0 z-[70] flex items-end justify-center overflow-y-auto bg-slate-950/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-4">
            <button type="button" tabIndex={-1} aria-hidden="true" className="absolute inset-0 cursor-default" onClick={() => setOpen(false)} />
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="ui-pop relative max-h-[100dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-lg sm:max-h-[92dvh] sm:rounded-2xl sm:p-7">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-slate-500">
                    Step {step + 1} of {STEPS.length}
                  </p>
                  <h2 id={titleId} className="mt-0.5 text-xl font-semibold text-slate-900">
                    {step === 0 ? "What is your business called?" : step === 1 ? "What do you sell?" : "Pick a look you like"}
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {step === 0
                      ? "You can change everything later. Your store stays private until you publish it."
                      : step === 1
                        ? "Tap the closest one. We use it to prepare pages and words that suit you."
                        : "You can switch to another look at any time, and nothing is lost."}
                  </p>
                </div>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 ${focusRing}`}>
                  <Icon name="x" size={18} />
                </button>
              </div>

              <ol aria-label="Steps" className="mt-4 flex gap-1.5">
                {STEPS.map((label, index) => (
                  <li key={label} className="flex-1">
                    <span className={`block h-1.5 rounded-full ${index <= step ? "bg-slate-900" : "bg-slate-200"}`} />
                    <span className={`mt-1 block text-xs ${index === step ? "font-semibold text-slate-900" : "text-slate-500"}`}>{label}</span>
                  </li>
                ))}
              </ol>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (step < STEPS.length - 1) next();
                  else void create();
                }}
                className="mt-5 space-y-4"
              >
                {step === 0 && (
                  <>
                    <div>
                      <label htmlFor={nameId} className={labelClass}>
                        Business name
                      </label>
                      <input ref={nameRef} id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder="For example: Asha's Bakery" className={`${inputClass} !text-base`} {...invalidProps(fieldErrors, "name", "new-business")} />
                      <FieldError id={fieldErrorId("new-business", "name")} message={fieldErrors.name} />
                    </div>
                    {!showAddress ? (
                      <button type="button" onClick={() => setShowAddress(true)} className={`rounded text-sm font-medium text-slate-700 underline underline-offset-2 ${focusRing}`}>
                        Choose your own web address (optional)
                      </button>
                    ) : (
                      <div>
                        <label htmlFor={subdomainId} className={labelClass}>
                          Web address (optional)
                        </label>
                        <div className="flex items-center gap-2">
                          <input id={subdomainId} value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="ashas-bakery" className={inputClass} {...invalidProps(fieldErrors, "subdomain", "new-business")} />
                          {rootDomain && <span className="shrink-0 text-sm text-slate-500">.{rootDomain}</span>}
                        </div>
                        <p className="mt-1.5 text-xs text-slate-500">Letters, numbers and dashes only. Leave it empty and we make one from your name.</p>
                        <FieldError id={fieldErrorId("new-business", "subdomain")} message={fieldErrors.subdomain} />
                      </div>
                    )}
                  </>
                )}

                {step === 1 && (
                  <div role="radiogroup" aria-label="What you sell" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {categories.map((option) => {
                      const picture = TYPE_PICTURE[option.key] ?? { icon: "storefront" as IconName };
                      const selected = category === option.key;
                      return (
                        <button key={option.key} type="button" role="radio" aria-checked={selected} onClick={() => { setCategory(option.key); setThemeId(null); setError(null); }} className={tile(selected)}>
                          {picture.photo ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={sampleImage(picture.photo)} alt="" loading="lazy" className="h-12 w-12 rounded-lg object-cover" />
                          ) : (
                            <span className={`flex h-12 w-12 items-center justify-center rounded-lg ${selected ? "bg-white/15" : "bg-slate-100"}`}>
                              <Icon name={picture.icon ?? "storefront"} size={22} />
                            </span>
                          )}
                          <span className="leading-tight">{option.name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {step === 2 && (
                  <>
                    <div role="radiogroup" aria-label="Look" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      {themes.map((id) => {
                        const meta = getThemeMeta(id);
                        const selected = chosenTheme === id;
                        return (
                          <button key={id} type="button" role="radio" aria-checked={selected} onClick={() => setThemeId(id)} className={`overflow-hidden rounded-xl border text-left transition-colors ${focusRing} ${selected ? "border-slate-900 ring-2 ring-slate-900" : "border-slate-200 hover:border-slate-400"}`}>
                            <ThemeThumbnail themeId={id} className="rounded-none ring-0" />
                            <span className="block px-3 py-2">
                              <span className="flex items-center justify-between gap-2 text-sm font-semibold text-slate-900">
                                {meta.name}
                                {id === suggestedTheme && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800">Suits you</span>}
                              </span>
                              <span className="mt-0.5 block text-xs leading-5 text-slate-600">{meta.tagline}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {samplesFit ? (
                      <label className="flex items-start gap-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-800">
                        <input type="checkbox" checked={addSamples} onChange={(e) => setAddSamples(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0" />
                        <span>
                          <span className="font-medium">Add {SAMPLE_PRODUCT_COUNT} sample products to get me started</span>
                          <span className="mt-0.5 block text-xs leading-5 text-slate-600">With photos, so you can see how your store looks. Shoppers never see samples: you replace them with your own name, price and photo.</span>
                        </span>
                      </label>
                    ) : null}
                    <p className="text-xs leading-5 text-slate-500">We also prepare your homepage and the usual pages (About, Contact and more) as drafts for you to check. Nothing goes live until you press Publish.</p>
                  </>
                )}

                {error && (
                  <Notice tone="danger" role="alert">
                    {error}
                  </Notice>
                )}

                <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-between">
                  <button type="button" onClick={() => (step === 0 ? setOpen(false) : setStep(step - 1))} className={buttonClass({ variant: "secondary" })}>
                    {step === 0 ? "Cancel" : "Back"}
                  </button>
                  <button type="submit" disabled={loading} className={buttonClass()}>
                    {step < STEPS.length - 1 ? "Next" : loading ? "Preparing your store…" : "Create my store"}
                    {step < STEPS.length - 1 && <Icon name="arrow-right" size={16} />}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
