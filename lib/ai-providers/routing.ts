import { HttpError } from "@/lib/api";
import { isAiProviderEnabled } from "@/lib/env";
import { aiProviders, getAiProvider, isDisclosedProvider, modelSupports } from "./registry";
import type { AiRouteTask, AiRoutingSettings } from "./settings";
import { AI_ROUTE_TASKS } from "./settings";
import type { AiCapability, AiProviderAdapter } from "./types";

/**
 * Which provider and model handles a task (server-only; pure apart from the registry).
 *
 * The order is: the task's own route, or the default route, then the configured fallback order.
 * With no stored settings, the first usable provider handles everything with its default model,
 * and nothing falls back: switching provider only ever happens if the platform has set it up.
 *
 * Settings can only narrow what the environment allows: `AI_PROVIDER_ENABLED` and the provider's
 * credentials decide whether it can run at all, and no setting can turn that on.
 */
export const AI_TASK_REQUIREMENTS: Record<AiRouteTask, readonly AiCapability[]> = {
  conversation: ["conversation"],
  // Earlier messages travel as delimited data (lib/ai-website/prompts.ts), so any model that can answer in JSON will do.
  discovery: ["structured_json"],
  planning: ["structured_json"],
  generation: ["structured_json"],
  website_revision: ["structured_json"],
  page_editing: ["structured_json"],
  homepage_editing: ["structured_json"],
  seo: ["structured_json"],
  theme_advice: ["structured_json"],
  rewriting: ["structured_json"],
};

export const AI_ROUTE_TASK_LABELS: Record<AiRouteTask, string> = {
  conversation: "Business conversation",
  discovery: "Business discovery",
  planning: "Website planning",
  generation: "Complete website generation",
  website_revision: "Website changes in a conversation",
  page_editing: "Page and section editing",
  homepage_editing: "Homepage editing",
  seo: "SEO",
  theme_advice: "Theme advice",
  rewriting: "Content rewriting",
};

export interface AiRoute {
  adapter: AiProviderAdapter;
  model: string;
}

function usable(providerId: string, settings: AiRoutingSettings): AiProviderAdapter | null {
  const adapter = getAiProvider(providerId);
  if (!adapter || !isDisclosedProvider(providerId) || settings.disabledProviders.includes(providerId) || !adapter.isConfigured()) return null;
  return adapter;
}

/** The chosen model if it can do this; with none chosen, the default, or else the first that can. */
function modelFor(adapter: AiProviderAdapter, chosen: string | undefined, needs: readonly AiCapability[]): string | null {
  const models = adapter.models();
  const fits = (id: string | null | undefined) => {
    const model = models.find((candidate) => candidate.id === id);
    return Boolean(model && modelSupports(model, needs));
  };
  if (chosen) return fits(chosen) ? chosen : null;
  const main = adapter.defaultModel();
  if (fits(main)) return main;
  return models.find((model) => modelSupports(model, needs))?.id ?? null;
}

/** Routes to try, in order. Empty when nothing may handle this task. */
export function resolveAiRoutes(task: AiRouteTask, operationNeeds: readonly AiCapability[], settings: AiRoutingSettings): AiRoute[] {
  if (!isAiProviderEnabled()) return [];
  const needs = [...new Set([...AI_TASK_REQUIREMENTS[task], ...operationNeeds])];
  const primary = settings.taskRoutes[task] ?? settings.defaultRoute;
  const firstUsable = aiProviders().find((adapter) => usable(adapter.id, settings) && modelFor(adapter, undefined, needs));
  // A route that was chosen but cannot run is not replaced by another provider unless the
  // platform listed one in its fallback order.
  const wanted: Array<{ providerId: string; model?: string }> = [
    ...(primary ? [primary] : firstUsable ? [{ providerId: firstUsable.id }] : []),
    ...settings.fallbackOrder.map((providerId) => ({ providerId })),
  ];

  const routes: AiRoute[] = [];
  for (const { providerId, model: chosen } of wanted) {
    const adapter = usable(providerId, settings);
    if (!adapter) continue;
    const model = modelFor(adapter, chosen, needs);
    if (model && !routes.some((route) => route.adapter.id === providerId && route.model === model)) routes.push({ adapter, model });
  }
  return routes;
}

/** Refuses settings that could never run, before they are stored. */
export function assertAiRoutingValid(settings: AiRoutingSettings): void {
  const invalid = (message: string) => new HttpError(422, message, "invalid_ai_routing");
  const known = (providerId: string) => {
    const adapter = getAiProvider(providerId);
    if (!adapter) throw invalid(`There is no AI provider called "${providerId}".`);
    if (!isDisclosedProvider(providerId)) throw invalid(`${adapter.displayName} is not named in the AI consent disclosure, so store data cannot be sent to it yet.`);
    if (settings.disabledProviders.includes(providerId)) throw invalid(`${adapter.displayName} is disabled, so nothing can be routed to it.`);
    if (!adapter.isConfigured()) throw invalid(`${adapter.displayName} is missing its server settings, so nothing can be routed to it yet.`);
    return adapter;
  };
  const checkRoute = (route: { providerId: string; model: string }, needs: readonly AiCapability[], label: string) => {
    const model = known(route.providerId).models().find((candidate) => candidate.id === route.model);
    if (!model) throw invalid(`${label}: "${route.model}" is not an available model of this provider.`);
    if (!modelSupports(model, needs)) throw invalid(`${label}: "${route.model}" cannot do what this task needs.`);
  };

  // Any registered provider may be disabled, whatever state it is in. A name with no adapter is refused.
  for (const providerId of settings.disabledProviders) {
    if (!getAiProvider(providerId)) throw invalid(`There is no AI provider called "${providerId}".`);
  }
  settings.fallbackOrder.forEach(known);
  if (new Set(settings.fallbackOrder).size !== settings.fallbackOrder.length) throw invalid("List each provider once in the fallback order.");
  if (settings.defaultRoute) {
    // The default handles any task without its own route, so it needs what all of those need.
    const uncovered = AI_ROUTE_TASKS.filter((task) => !settings.taskRoutes[task]);
    checkRoute(settings.defaultRoute, [...new Set(uncovered.flatMap((task) => AI_TASK_REQUIREMENTS[task]))], "Default route");
  }
  for (const task of AI_ROUTE_TASKS) {
    const route = settings.taskRoutes[task];
    if (route) checkRoute(route, AI_TASK_REQUIREMENTS[task], AI_ROUTE_TASK_LABELS[task]);
  }
}
