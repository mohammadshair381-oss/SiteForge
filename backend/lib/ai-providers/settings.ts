import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { PlatformSettings } from "@/models/PlatformSettings";
import { loadAiCredentials } from "./credentials";
import { aiProviders } from "./registry";

/**
 * Stored AI routing choices, part of the platform's own settings document (server-only). They
 * name providers and models and nothing else: credentials and the switch that allows AI at all
 * stay in the server environment, and nothing here can reach them. A Super Admin changes these
 * through `PUT /api/admin/ai-routing`, audited. With nothing saved, the defaults below apply.
 */
export const AI_ROUTE_TASKS = ["conversation", "discovery", "planning", "generation", "website_revision", "page_editing", "homepage_editing", "seo", "theme_advice", "rewriting"] as const;
export type AiRouteTask = (typeof AI_ROUTE_TASKS)[number];

const providerId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Use a provider id from the registry");
const routeSchema = z.object({ providerId, model: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/, "Use a model id from the registry") }).strict();

export const aiRoutingSchema = z
  .object({
    /** Stops a provider being used. There is no opposite: this can never turn a provider on. */
    disabledProviders: z.array(providerId).max(20).prefault([]),
    /** Handles tasks without their own route. Null: the first usable provider. */
    defaultRoute: routeSchema.nullable().prefault(null),
    taskRoutes: z.partialRecord(z.enum(AI_ROUTE_TASKS), routeSchema).prefault({}),
    /** Providers to try next, in order, with their default model. Empty: no switching. */
    fallbackOrder: z.array(providerId).max(10).prefault([]),
  })
  .strict();
export type AiRoutingSettings = z.infer<typeof aiRoutingSchema>;

export const DEFAULT_AI_ROUTING: AiRoutingSettings = { disabledProviders: [], defaultRoute: null, taskRoutes: {}, fallbackOrder: [] };

export interface AiRoutingState {
  settings: AiRoutingSettings;
  /** "saved": read from the database. "default": nothing saved. "unavailable": could not be read. "invalid": stored value refused. */
  source: "saved" | "default" | "unavailable" | "invalid";
  /** What a save must name, so it cannot overwrite a change it has not seen. */
  revision: number;
}

const CACHE_MS = 30 * 1000;
let cached: { settings: AiRoutingSettings; at: number } | null = null;

/** Always asks the database. */
export async function readAiRoutingState(): Promise<AiRoutingState> {
  // Whoever reads the routing decides with it, so the stored API keys are current too.
  await loadAiCredentials();
  try {
    await dbConnect();
    const doc = await PlatformSettings.findById("platform").select("aiRouting aiRoutingRevision").lean();
    if (!doc?.aiRouting) {
      cached = { settings: DEFAULT_AI_ROUTING, at: Date.now() };
      return { settings: DEFAULT_AI_ROUTING, source: "default", revision: doc?.aiRoutingRevision ?? 0 };
    }
    const parsed = aiRoutingSchema.safeParse(doc.aiRouting);
    if (!parsed.success) {
      // Whatever it said may have disabled something, so nothing runs until it is saved again.
      console.error("[ai-routing] stored settings refused; AI stays off until they are saved again");
      const blocked: AiRoutingSettings = { ...DEFAULT_AI_ROUTING, disabledProviders: aiProviders().map((adapter) => adapter.id) };
      cached = { settings: blocked, at: Date.now() };
      return { settings: blocked, source: "invalid", revision: doc.aiRoutingRevision ?? 0 };
    }
    cached = { settings: parsed.data, at: Date.now() };
    return { settings: parsed.data, source: "saved", revision: doc.aiRoutingRevision ?? 0 };
  } catch {
    console.error("[ai-routing] could not be read; using the last known values or defaults");
    return { settings: cached?.settings ?? DEFAULT_AI_ROUTING, source: "unavailable", revision: 0 };
  }
}

export async function getAiRoutingSettings(): Promise<AiRoutingSettings> {
  await loadAiCredentials();
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.settings;
  return (await readAiRoutingState()).settings;
}

export function clearAiRoutingCache(): void {
  cached = null;
}
