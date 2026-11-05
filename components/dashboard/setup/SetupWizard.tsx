"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { SETUP_STEPS, SETUP_STEP_INFO, nextStep, previousStep, type SetupStep, type StepState } from "@/lib/store-setup";
import { buttonClass, focusRing } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Eyebrow, Notice } from "@/components/ui/Surface";

export const setupButton = buttonClass({ variant: "secondary" });
export const setupPrimaryButton = buttonClass({ variant: "primary" });
export const setupInput = `min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-brand-500 ${focusRing}`;
export const setupLabel = "mb-1.5 block text-sm font-medium text-slate-800";

/** Why each step matters, in one plain sentence. */
const STEP_PURPOSE: Record<SetupStep, string> = {
  business: "Customers use these details to recognise and contact you.",
  brand: "This is how your store looks. You can change it at any time.",
  structure: "This decides what visitors see first and in what order.",
  products: "Your store is ready to sell once it has something to sell.",
  settings: "Customers see these choices at checkout and in your footer.",
  launch: "Nothing goes live on its own: publishing is always your decision.",
};

interface SetupContextValue {
  businessId: string;
  step: SetupStep;
  busy: boolean;
  error: string | null;
  /** Records progress (`mark` the current step done or skipped) and opens `to`. */
  go: (to: SetupStep | "overview", mark?: "done" | "skipped") => Promise<void>;
}

const SetupContext = createContext<SetupContextValue | null>(null);

export function useSetup(): SetupContextValue {
  const value = useContext(SetupContext);
  if (!value) throw new Error("useSetup must be used inside SetupWizard");
  return value;
}

/**
 * Guided store setup: a progress indicator, the current step and its
 * navigation. Each step saves through the store's existing routes; the
 * wizard itself only records where the owner is (PUT /setup), so they can
 * leave and resume at any time.
 */
export default function SetupWizard({
  businessId,
  businessName,
  step,
  states,
  children,
}: {
  businessId: string;
  businessName: string;
  step: SetupStep;
  states: Record<SetupStep, StepState>;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const index = SETUP_STEPS.indexOf(step);
  // The wizard stays mounted across steps: the arrival of the next step ends
  // the navigation that `go` started.
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [step]);

  const go = useCallback(
    async (to: SetupStep | "overview", mark?: "done" | "skipped") => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/businesses/${businessId}/setup`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(to === "overview" ? {} : { step: to }),
            ...(mark === "done" ? { done: step } : mark === "skipped" ? { skipped: step } : {}),
            ...(to === "overview" && mark === "done" && step === "launch" ? { finished: true } : {}),
          }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Your progress could not be saved.");
        router.push(to === "overview" ? `/dashboard/businesses/${businessId}` : `/dashboard/businesses/${businessId}/setup?step=${to}`);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error. Please try again.");
        setBusy(false);
      }
    },
    [businessId, router, step],
  );

  const value = useMemo(() => ({ businessId, step, busy, error, go }), [businessId, step, busy, error, go]);
  const info = SETUP_STEP_INFO[step];
  const completed = SETUP_STEPS.filter((s) => states[s] === "complete").length;

  return (
    <SetupContext.Provider value={value}>
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm text-slate-500">Store setup · {businessName}</p>
            <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-slate-900 sm:text-[1.75rem] sm:leading-9">Set up your store</h1>
            <p className="mt-1 text-sm text-slate-600">
              Step {index + 1} of {SETUP_STEPS.length}. Your progress is saved, so you can stop and come back at any time.
            </p>
          </div>
          <Link href={`/dashboard/businesses/${businessId}`} className={buttonClass({ variant: "ghost" })}>
            Exit setup
          </Link>
        </header>

        <nav aria-label="Setup steps" className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="mb-2 flex items-center gap-3 px-1">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label="Steps completed" aria-valuemin={0} aria-valuemax={SETUP_STEPS.length} aria-valuenow={completed}>
              <div className="h-full rounded-full bg-slate-900 transition-[width]" style={{ width: `${(completed / SETUP_STEPS.length) * 100}%` }} />
            </div>
            <span className="shrink-0 text-xs font-medium text-slate-500">{completed} of {SETUP_STEPS.length} done</span>
          </div>
          <ol className="ui-scroll-x flex gap-1 overflow-x-auto lg:grid lg:grid-cols-6 lg:overflow-visible">
            {SETUP_STEPS.map((s, i) => {
              const current = s === step;
              const state = states[s];
              return (
                <li key={s} className="relative w-40 shrink-0 lg:w-auto">
                  {i < SETUP_STEPS.length - 1 && (
                    <span aria-hidden="true" className={`absolute left-[2.75rem] right-0 top-[1.3rem] hidden h-px lg:block ${state === "complete" ? "bg-slate-900" : "bg-slate-200"}`} />
                  )}
                  <button
                    type="button"
                    onClick={() => void go(s)}
                    disabled={busy || current}
                    aria-current={current ? "step" : undefined}
                    className={`relative flex w-full flex-col items-start gap-1.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors disabled:cursor-default ${focusRing} ${
                      current ? "text-slate-900" : "text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        state === "complete" ? "bg-slate-900 text-white" : current ? "bg-white text-slate-900 ring-2 ring-ember" : state === "skipped" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {state === "complete" ? <Icon name="check" size={13} /> : i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className={`block truncate ${current ? "font-semibold" : "font-medium"}`}>{SETUP_STEP_INFO[s].title}</span>
                      <span className="block text-xs text-slate-500">{state === "complete" ? "Done" : state === "skipped" ? "Skipped for now" : current ? "In progress" : "To do"}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <section aria-labelledby="setup-step-title" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <Eyebrow>Step {index + 1} of {SETUP_STEPS.length}</Eyebrow>
          <h2 id="setup-step-title" className="mt-1 text-lg font-semibold text-slate-900">{info.title}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{info.description} {STEP_PURPOSE[step]}</p>
          <div className="mt-5">{children}</div>
        </section>
      </div>
    </SetupContext.Provider>
  );
}

/**
 * Back / Skip / Continue for a step. `onContinue` saves the step's own data
 * first (return false to stay); without it the step is simply confirmed.
 */
export function SetupFooter({
  onContinue,
  continueLabel = "Save and continue",
  saving = false,
  canContinue = true,
  hint,
}: {
  onContinue?: () => Promise<boolean>;
  continueLabel?: string;
  saving?: boolean;
  canContinue?: boolean;
  hint?: React.ReactNode;
}) {
  const { step, busy, error, go } = useSetup();
  const back = previousStep(step);
  const next = nextStep(step);
  const working = busy || saving;
  return (
    <div className="mt-6 border-t border-slate-200 pt-4">
      {error && (
        <Notice tone="danger" role="alert" className="mb-3">
          {error}
        </Notice>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {back && (
            <button type="button" className={setupButton} disabled={working} onClick={() => void go(back)}>
              <Icon name="arrow-left" size={15} /> Back
            </button>
          )}
          {hint && <span className="text-xs text-slate-500">{hint}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {SETUP_STEP_INFO[step].skippable && next && (
            <button type="button" className={buttonClass({ variant: "ghost" })} disabled={working} onClick={() => void go(next, "skipped")}>
              Skip for now
            </button>
          )}
          <button
            type="button"
            className={setupPrimaryButton}
            disabled={working || !canContinue}
            onClick={async () => {
              if (onContinue && !(await onContinue())) return;
              await go(next ?? "overview", "done");
            }}
          >
            {working ? "Saving…" : next ? continueLabel : "Finish setup"}
            {!working && next && <Icon name="arrow-right" size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}
