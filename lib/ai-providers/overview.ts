import { isAiProviderEnabled } from "@/lib/env";
import { aiProviderStatuses, modelSupports, type AiProviderStatus } from "./registry";
import type { AiModelInfo } from "./types";
import { AI_ROUTE_TASK_LABELS, AI_TASK_REQUIREMENTS, resolveAiRoutes } from "./routing";
import { AI_ROUTE_TASKS, readAiRoutingState, type AiRouteTask, type AiRoutingSettings, type AiRoutingState } from "./settings";

export interface AiProviderOverview extends Omit<AiProviderStatus, "models"> {
  models: Array<AiModelInfo & {
    /** The tasks this model can handle. */
    tasks: AiRouteTask[];
    /** Why it cannot be chosen for anything; null when it can. */
    unavailableReason: string | null;
  }>;
}

export interface AiRoutingOverview {
  /** `AI_PROVIDER_ENABLED`: only the server environment changes this. */
  enabled: boolean;
  /** At least one task can be handled now. */
  available: boolean;
  providers: AiProviderOverview[];
  tasks: Array<{
    task: AiRouteTask;
    label: string;
    /** What each task would use now, in order. Empty when nothing may handle it. */
    routes: Array<{ providerId: string; providerName: string; model: string }>;
    /** Why nothing can handle it; null when something can. */
    unavailableReason: string | null;
    /** Models of disclosed providers with the capabilities this task needs. */
    compatible: Array<{ providerId: string; providerName: string; model: string }>;
  }>;
  settings: AiRoutingSettings;
  source: AiRoutingState["source"];
  revision: number;
}

/** For a Super Admin. Names, models and capabilities only: never a credential or a setting's value. */
export async function getAiRoutingOverview(): Promise<AiRoutingOverview> {
  const state = await readAiRoutingState();
  const enabled = isAiProviderEnabled();
  const providers = aiProviderStatuses(state.settings.disabledProviders).map((provider) => ({
    ...provider,
    models: provider.models.map((model) => {
      const tasks = AI_ROUTE_TASKS.filter((task) => modelSupports(model, AI_TASK_REQUIREMENTS[task]));
      return { ...model, tasks, unavailableReason: tasks.length === 0 ? "It cannot do what any task needs." : null };
    }),
  }));
  const tasks = AI_ROUTE_TASKS.map((task) => {
    const routes = resolveAiRoutes(task, AI_TASK_REQUIREMENTS[task], state.settings).map((route) => ({ providerId: route.adapter.id, providerName: route.adapter.displayName, model: route.model }));
    const chosen = state.settings.taskRoutes[task] ?? state.settings.defaultRoute;
    return {
      task,
      label: AI_ROUTE_TASK_LABELS[task],
      routes,
      unavailableReason:
        routes.length > 0
          ? null
          : !enabled
            ? "Nothing: the server setting has AI switched off."
            : chosen
              ? "Nothing: the chosen model cannot run now, and no fallback can handle this task."
              : "Nothing: no usable provider has a model that can do this task.",
      compatible: providers
        .filter((provider) => provider.disclosed)
        .flatMap((provider) => provider.models.filter((model) => model.tasks.includes(task)).map((model) => ({ providerId: provider.id, providerName: provider.displayName, model: model.id }))),
    };
  });
  return { enabled, available: tasks.some((task) => task.routes.length > 0), providers, tasks, settings: state.settings, source: state.source, revision: state.revision };
}
