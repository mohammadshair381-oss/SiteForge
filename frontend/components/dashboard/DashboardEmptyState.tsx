"use client";

import { Icon } from "@/components/ui/Icon";
import { buttonClass } from "@/components/ui/Button";

const STEPS = [
  { icon: "business", title: "Create your business", text: "Your name and what you sell." },
  { icon: "theme", title: "Pick a design", text: "See it with your own store first." },
  { icon: "rocket", title: "Publish when ready", text: "It stays private until you do." },
] as const;

export default function DashboardEmptyState() {
  function openCreateBusiness() {
    const toggle = document.getElementById("create-business-toggle");
    toggle?.click();
  }

  return (
    <div className="relative isolate overflow-hidden rounded-2xl bg-ink p-8 text-white sm:p-12">
      <div aria-hidden="true" className="ui-dots absolute inset-0 -z-10" />
      <div aria-hidden="true" className="ui-ember-glow absolute inset-0 -z-10" />
      <h2 className="max-w-lg text-3xl font-semibold tracking-tight [text-wrap:balance] sm:text-4xl">Create your first business</h2>
      <p className="mt-3 max-w-md text-white/70">Add your business profile, pick a category and publish a professional storefront. Guided setup walks you through it.</p>
      <button type="button" onClick={openCreateBusiness} className={buttonClass({ variant: "ember", size: "lg", className: "mt-7" })}>
        <Icon name="plus" size={18} />
        Create your business
      </button>
      <ol className="mt-10 grid gap-3 sm:grid-cols-3">
        {STEPS.map((step) => (
          <li key={step.title} className="rounded-xl border border-white/10 bg-white/5 p-4">
            <Icon name={step.icon} className="text-ember-soft" />
            <p className="mt-3 text-sm font-semibold">{step.title}</p>
            <p className="mt-0.5 text-sm text-white/60">{step.text}</p>
          </li>
        ))}
      </ol>
      <p className="mt-6 text-xs text-white/50">Owners can invite staff members once a business is set up.</p>
    </div>
  );
}
