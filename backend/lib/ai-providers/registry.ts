import { isAiProviderEnabled } from "@/lib/env";
import { geminiAdapter } from "./gemini";
import type { AiCapability, AiModelInfo, AiProviderAdapter } from "./types";

/**
 * The providers SiteForge can actually call (server-only). A provider is listed here only
 * when an adapter exists: a name in a setting never makes one available.
 */
const adapters = new Map<string, AiProviderAdapter>();

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function registerAiProvider(adapter: AiProviderAdapter): void {
  if (!PROVIDER_ID.test(adapter.id)) throw new Error("An AI provider id must use lowercase letters, digits and dashes.");
  const existing = adapters.get(adapter.id);
  if (existing && existing !== adapter) throw new Error(`The AI provider "${adapter.id}" is already registered.`);
  adapters.set(adapter.id, adapter);
}

registerAiProvider(geminiAdapter);

/**
 * The providers the consent disclosure names (`AI_CONSENT_DISCLOSURE`, lib/ai-builder/consent.ts).
 * Store data only ever goes to these, so an owner's consent always covers who receives it. Adding
 * a provider means updating the disclosure and bumping `AI_CONSENT_VERSION`, so owners agree again.
 */
export const AI_DISCLOSED_PROVIDER_IDS: readonly string[] = ["gemini"];

export const aiProviders = (): AiProviderAdapter[] => [...adapters.values()];
export const getAiProvider = (id: string): AiProviderAdapter | undefined => adapters.get(id);
export const isDisclosedProvider = (id: string): boolean => AI_DISCLOSED_PROVIDER_IDS.includes(id);

/** Has an adapter, is named in the consent disclosure, and has its credentials. Environment only. */
export const configuredAiProviders = (): AiProviderAdapter[] => aiProviders().filter((adapter) => isDisclosedProvider(adapter.id) && adapter.isConfigured());

/** The model a request uses when no route chooses one. */
export function defaultAiModel(): string | null {
  return configuredAiProviders()[0]?.defaultModel() ?? null;
}

export function modelSupports(model: AiModelInfo, needs: readonly AiCapability[]): boolean {
  return needs.every((capability) => model.capabilities.includes(capability));
}

export interface AiProviderStatus {
  id: string;
  displayName: string;
  /** Always true here: only implemented providers are registered. */
  implemented: true;
  configured: boolean;
  /** Named in the consent disclosure. */
  disclosed: boolean;
  disabledByPlatform: boolean;
  /** The environment switch is on, and nothing above stops it. */
  available: boolean;
  /** Names of required server settings that are missing, never a value. */
  missingConfig: readonly string[];
  /** Why it is not available, in plain words for a Super Admin. */
  reasons: readonly string[];
  requiredConfig: readonly string[];
  optionalConfig: readonly string[];
  defaultModel: string | null;
  models: readonly AiModelInfo[];
}

/** Names and capabilities only: never a credential or any value of a setting. */
export function aiProviderStatuses(disabledProviders: readonly string[]): AiProviderStatus[] {
  return aiProviders().map((adapter) => {
    const configured = adapter.isConfigured();
    const disclosed = isDisclosedProvider(adapter.id);
    const disabledByPlatform = disabledProviders.includes(adapter.id);
    // Whether each is present, and the switch's exact value. No value leaves this function.
    const missingConfig = adapter.requiredConfig.filter((name) => (name === "AI_PROVIDER_ENABLED" ? !isAiProviderEnabled() : !process.env[name]));
    const reasons = [
      ...(missingConfig.includes("AI_PROVIDER_ENABLED") ? ['The server setting AI_PROVIDER_ENABLED is not "true". Only the server environment can change this.'] : []),
      ...missingConfig.filter((name) => name !== "AI_PROVIDER_ENABLED").map((name) => `The server setting ${name} is missing.`),
      ...(adapter.defaultModel() === null ? ["Its configured model id is not valid."] : []),
      ...(disclosed ? [] : ["The AI consent disclosure does not name it, so store data cannot be sent to it."]),
      ...(disabledByPlatform ? ["It is disabled on this platform."] : []),
    ];
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      implemented: true,
      configured,
      disclosed,
      disabledByPlatform,
      available: isAiProviderEnabled() && configured && disclosed && !disabledByPlatform,
      missingConfig,
      reasons,
      requiredConfig: adapter.requiredConfig,
      optionalConfig: adapter.optionalConfig,
      defaultModel: adapter.defaultModel(),
      models: adapter.models(),
    };
  });
}
