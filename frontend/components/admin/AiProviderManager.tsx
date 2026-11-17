"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { Notice, Pill } from "@/components/ui/Surface";
import { apiErrorFrom, fieldErrorId, invalidProps, summaryMessage } from "@/lib/api-errors";
import type { AiProviderOverview, AiRoutingOverview } from "@/lib/ai-providers/overview";
import type { AiRouteTask, AiRoutingSettings } from "@/lib/ai-providers/settings";

/** Keep in sync with ADMIN_REASON_MIN in lib/admin-audit.ts (the server enforces it). */
const REASON_MIN = 5;
const ID_PREFIX = "ai-routing";

type Route = { providerId: string; model: string };

const routeValue = (route: Route | null | undefined) => (route ? `${route.providerId}|${route.model}` : "");
const parseRoute = (value: string): Route | null => {
  const [providerId, model] = value.split("|");
  return providerId && model ? { providerId, model } : null;
};

/**
 * Which AI provider and model handles what. Every save names a reason and the revision it was based on,
 * and the server checks the choices again (`assertAiRoutingValid`). What is on offer comes from the
 * server. Nothing here can turn AI on, supply a credential (keys: AiKeyManager) or list a provider without an adapter.
 */
export default function AiProviderManager({ initial }: { initial: AiRoutingOverview }) {
  const router = useRouter();
  const [overview, setOverview] = useState(initial);
  const [form, setForm] = useState<AiRoutingSettings>(initial.settings);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [outdated, setOutdated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  // Compared field by field, in a fixed order, so a key order can never look like a change.
  const key = (settings: AiRoutingSettings) =>
    JSON.stringify([settings.disabledProviders, routeValue(settings.defaultRoute), overview.tasks.map(({ task }) => routeValue(settings.taskRoutes[task])), settings.fallbackOrder]);
  const dirty = key(form) !== key(overview.settings);
  const unavailable = overview.source === "unavailable";

  const selectable = (provider: AiProviderOverview) => provider.configured && provider.disclosed && !form.disabledProviders.includes(provider.id);
  const nameOf = (providerId: string) => overview.providers.find((provider) => provider.id === providerId)?.displayName ?? providerId;

  function update(next: (current: AiRoutingSettings) => AiRoutingSettings) {
    setForm(next);
    setSavedAt(null);
    setError(null);
  }

  /** Disabling also clears the routes that name the provider: the server refuses to keep them. */
  function setAllowed(providerId: string, allowed: boolean) {
    update((current) => {
      if (allowed) return { ...current, disabledProviders: current.disabledProviders.filter((id) => id !== providerId) };
      return {
        disabledProviders: [...current.disabledProviders, providerId],
        defaultRoute: current.defaultRoute?.providerId === providerId ? null : current.defaultRoute,
        taskRoutes: Object.fromEntries(Object.entries(current.taskRoutes).filter(([, route]) => route?.providerId !== providerId)) as AiRoutingSettings["taskRoutes"],
        fallbackOrder: current.fallbackOrder.filter((id) => id !== providerId),
      };
    });
  }

  function setTaskRoute(task: AiRouteTask, value: string) {
    update((current) => {
      const { [task]: _removed, ...others } = current.taskRoutes;
      const route = parseRoute(value);
      return { ...current, taskRoutes: (route ? { ...others, [task]: route } : others) as AiRoutingSettings["taskRoutes"] };
    });
  }

  function moveFallback(index: number, by: -1 | 1) {
    update((current) => {
      const next = [...current.fallbackOrder];
      const target = index + by;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...current, fallbackOrder: next };
    });
  }

  /** The default route handles every task without its own, so its model must be able to do them all. */
  const tasksOnDefault = overview.tasks.filter(({ task }) => !form.taskRoutes[task]).map(({ task }) => task);
  const defaultOptions = overview.providers.filter(selectable).flatMap((provider) =>
    provider.models.filter((model) => tasksOnDefault.every((task) => model.tasks.includes(task))).map((model) => ({ providerId: provider.id, providerName: provider.displayName, model: model.id })),
  );
  const fallbackOptions = overview.providers.filter((provider) => selectable(provider) && !form.fallbackOrder.includes(provider.id));

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/ai-routing", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(apiErrorFrom(data, "The latest settings could not be loaded.").message);
        return;
      }
      setOverview(data as AiRoutingOverview);
      setForm((data as AiRoutingOverview).settings);
      setOutdated(false);
    } catch {
      setError("The server could not be reached.");
    } finally {
      setLoading(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSavedAt(null);
    if (reason.trim().length < REASON_MIN) {
      setFields({ reason: `Give a reason of at least ${REASON_MIN} characters.` });
      setError("Check the highlighted fields. Nothing was saved.");
      return;
    }
    setFields({});
    setError(null);
    const newlyDisabled = form.disabledProviders.filter((id) => !overview.settings.disabledProviders.includes(id));
    if (newlyDisabled.length > 0) {
      const confirmed = await confirmDialog({
        title: `Disable ${newlyDisabled.map(nameOf).join(", ")}?`,
        message: "Requests stop going to it within about 30 seconds. If nothing else can handle a task, store owners will see that AI suggestions are not available.",
        confirmLabel: "Disable and save",
        tone: "danger",
      });
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/ai-routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, reason, expectedRevision: overview.revision }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const info = apiErrorFrom(data, "The AI routing could not be saved.");
        setFields(info.fields);
        setOutdated(info.code === "settings_changed");
        setError(info.code === "settings_changed" ? info.message : `${summaryMessage(info, ["reason"])} Nothing was changed.`);
        return;
      }
      setReason("");
      setSavedAt(new Date().toLocaleTimeString(undefined, { timeStyle: "short" }));
      await reload();
      router.refresh();
    } catch {
      setError("The server could not be reached. Nothing was changed.");
    } finally {
      setSaving(false);
    }
  }

  const heading = "text-sm font-semibold text-slate-900";
  const hint = "mt-1 text-xs leading-5 text-slate-500";
  const select = `${inputClass} mt-1`;

  return (
    <form onSubmit={save} noValidate className="space-y-6">
      {!overview.enabled && (
        <Notice tone="info" role="status">
          AI is switched off by the server setting <code>AI_PROVIDER_ENABLED</code>, so nothing is sent to any provider. You can prepare the routing here, but only the server environment can turn AI on.
        </Notice>
      )}
      {overview.source === "invalid" && (
        <Notice tone="danger" role="alert">The saved routing could not be read, so AI stays off until it is saved again.</Notice>
      )}
      {unavailable && (
        <Notice tone="warning" role="alert">The saved routing could not be read just now, so saving is off. What is shown may be out of date.</Notice>
      )}

      <section aria-labelledby="ai-providers-heading">
        <h3 id="ai-providers-heading" className={heading}>Providers</h3>
        <p className={hint}>Only providers with an adapter in the code appear here. To use only one, untick &quot;Allow this provider&quot; for the others and save. API keys are set in the card above and are never shown.</p>
        <ul className="mt-2 space-y-3">
          {overview.providers.map((provider) => (
            <li key={provider.id} className="rounded-xl border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words text-sm font-medium text-slate-900">{provider.displayName}</span>
                <Pill tone={provider.available ? "success" : "neutral"} dot>{provider.available ? "Available" : "Not available"}</Pill>
              </div>
              {provider.reasons.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs leading-5 text-slate-700">
                  {provider.reasons.map((text) => <li key={text}>{text}</li>)}
                </ul>
              )}
              <label className="mt-2 flex min-h-10 items-start gap-2.5 text-sm text-slate-800">
                <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" disabled={unavailable} checked={!form.disabledProviders.includes(provider.id)} onChange={(event) => setAllowed(provider.id, event.target.checked)} />
                <span>
                  Allow this provider
                  <span className="block text-xs leading-5 text-slate-500">Turning this off stops it being used. Turning it on only removes that stop: everything listed above must still be in place.</span>
                </span>
              </label>
              <div className="mt-2 overflow-x-auto">
                <ul className="space-y-1 text-xs leading-5 text-slate-600">
                  {provider.models.length === 0 && <li>No valid model is configured.</li>}
                  {provider.models.map((model) => (
                    <li key={model.id} className="break-words">
                      <span className="font-medium text-slate-800">{model.id}</span>
                      {model.id === provider.defaultModel ? " (default)" : ""}: {model.unavailableReason ?? `can do ${model.capabilities.join(", ").replaceAll("_", " ")}`}
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ai-default-heading">
        <h3 id="ai-default-heading" className={heading}>Default provider and model</h3>
        <label className="mt-2 block text-xs font-medium text-slate-700">
          Handles every task without its own choice below
          <select className={select} disabled={unavailable} value={routeValue(form.defaultRoute)} onChange={(event) => update((current) => ({ ...current, defaultRoute: parseRoute(event.target.value) }))}>
            <option value="">Automatic: the first usable provider and its default model</option>
            {form.defaultRoute && !defaultOptions.some((option) => routeValue({ providerId: option.providerId, model: option.model }) === routeValue(form.defaultRoute)) && (
              <option value={routeValue(form.defaultRoute)}>{nameOf(form.defaultRoute.providerId)}: {form.defaultRoute.model} (cannot be used)</option>
            )}
            {defaultOptions.map((option) => (
              <option key={`${option.providerId}|${option.model}`} value={`${option.providerId}|${option.model}`}>{option.providerName}: {option.model}</option>
            ))}
          </select>
        </label>
      </section>

      <section aria-labelledby="ai-tasks-heading">
        <h3 id="ai-tasks-heading" className={heading}>What handles each task</h3>
        <p className={hint}>A task offers only models that can do what it needs. &quot;Now&quot; shows the saved setting, with any fallbacks after an arrow.</p>
        <ul className="mt-2 divide-y divide-slate-100">
          {overview.tasks.map((task) => {
            const options = task.compatible.filter((option) => {
              const provider = overview.providers.find((candidate) => candidate.id === option.providerId);
              return provider ? selectable(provider) : false;
            });
            const chosen = form.taskRoutes[task.task];
            return (
              <li key={task.task} className="py-3">
                <label className="block text-xs font-medium text-slate-700">
                  {task.label}
                  <select className={select} disabled={unavailable} value={routeValue(chosen)} onChange={(event) => setTaskRoute(task.task, event.target.value)}>
                    <option value="">Use the default</option>
                    {chosen && !options.some((option) => routeValue(option) === routeValue(chosen)) && <option value={routeValue(chosen)}>{nameOf(chosen.providerId)}: {chosen.model} (cannot be used)</option>}
                    {options.map((option) => <option key={routeValue(option)} value={routeValue(option)}>{option.providerName}: {option.model}</option>)}
                  </select>
                </label>
                <p className="mt-1 break-words text-xs leading-5 text-slate-500">
                  Now: {task.routes.length > 0 ? task.routes.map((route) => `${route.providerName}: ${route.model}`).join(" → ") : task.unavailableReason}
                </p>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="ai-fallback-heading">
        <h3 id="ai-fallback-heading" className={heading}>Fallback order</h3>
        <p className={hint}>If a provider fails with a problem of its own, the next one here is tried with a model that can do the task. Only providers named in the owners&apos; consent can be listed. With none listed, a request never moves to another provider.</p>
        {form.fallbackOrder.length > 0 && (
          <ol className="mt-2 space-y-2">
            {form.fallbackOrder.map((providerId, index) => (
              <li key={providerId} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800">
                <span className="min-w-0 flex-1 basis-40 break-words">{index + 1}. {nameOf(providerId)}</span>
                <Button variant="ghost" size="sm" disabled={unavailable || index === 0} aria-label={`Move ${nameOf(providerId)} up`} onClick={() => moveFallback(index, -1)}>Up</Button>
                <Button variant="ghost" size="sm" disabled={unavailable || index === form.fallbackOrder.length - 1} aria-label={`Move ${nameOf(providerId)} down`} onClick={() => moveFallback(index, 1)}>Down</Button>
                <Button variant="ghost" size="sm" disabled={unavailable} aria-label={`Remove ${nameOf(providerId)}`} onClick={() => update((current) => ({ ...current, fallbackOrder: current.fallbackOrder.filter((id) => id !== providerId) }))}>Remove</Button>
              </li>
            ))}
          </ol>
        )}
        {fallbackOptions.length > 0 ? (
          <label className="mt-2 block text-xs font-medium text-slate-700">
            Add a fallback provider
            <select className={select} disabled={unavailable} value="" onChange={(event) => { const value = event.target.value; if (value) update((current) => ({ ...current, fallbackOrder: [...current.fallbackOrder, value] })); }}>
              <option value="">Choose…</option>
              {fallbackOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}
            </select>
          </label>
        ) : (
          form.fallbackOrder.length === 0 && <p className={hint}>No provider can be added: none is available to fall back to.</p>
        )}
      </section>

      <div>
        <label htmlFor={`${ID_PREFIX}-reason`} className={labelClass}>Reason for this change (recorded in the audit log)</label>
        <input id={`${ID_PREFIX}-reason`} maxLength={500} value={reason} disabled={unavailable} onChange={(event) => setReason(event.target.value)} className={inputClass} {...invalidProps(fields, "reason", ID_PREFIX)} />
        <FieldError id={fieldErrorId(ID_PREFIX, "reason")} message={fields.reason} />
      </div>
      {error && (
        <Notice tone="danger" role="alert" action={outdated ? <Button variant="secondary" disabled={loading} onClick={() => void reload()}>{loading ? "Loading…" : "Load the latest settings"}</Button> : undefined}>
          {error}
        </Notice>
      )}
      {savedAt && <Notice tone="success" role="status">Saved at {savedAt}. Changes can take up to 30 seconds to apply everywhere.</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving || loading || unavailable || outdated || !dirty}>{saving ? "Saving…" : "Save AI routing"}</Button>
        {dirty && !saving && <span className="text-xs text-slate-500">You have unsaved changes.</span>}
        {loading && !outdated && <span role="status" className="text-xs text-slate-500">Loading the latest settings…</span>}
      </div>
    </form>
  );
}
