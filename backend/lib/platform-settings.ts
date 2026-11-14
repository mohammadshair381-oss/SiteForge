import { z } from "zod";
import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { MAINTENANCE_DEFAULT_MESSAGE, registrationUnavailableReason, type PlatformStatus } from "@/lib/platform-status";
import { PlatformSettings } from "@/models/PlatformSettings";

/**
 * Settings a Super Admin controls at run time (server-only).
 *
 * Maintenance mode pauses new business from the platform side: registrations, new stores and
 * publishing. Storefronts, checkout, payment webhooks and signing in carry on, so shoppers
 * and money are never caught by it. Closing registration stops only new accounts.
 *
 * If the database cannot be read, the last known values apply, or else the defaults: a
 * settings problem must not lock everyone out of the platform. Saving is refused meanwhile,
 * so defaults can never overwrite what is stored.
 */
export interface PlatformSettingsView {
  supportEmail: string;
  maintenanceEnabled: boolean;
  maintenanceMessage: string;
  registrationOpen: boolean;
}

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettingsView = { supportEmail: "", maintenanceEnabled: false, maintenanceMessage: "", registrationOpen: true };

export const platformSettingsSchema = z.object({
  supportEmail: z.string().trim().toLowerCase().max(254).refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid email address, or leave this empty"),
  maintenanceEnabled: z.boolean(),
  maintenanceMessage: z.string().trim().max(300, "Keep the message under 300 characters").refine((v) => !/[<>]/.test(v), "Use plain text, without < or >"),
  registrationOpen: z.boolean(),
});

const CACHE_MS = 30 * 1000;
let cached: { value: PlatformSettingsView; at: number } | null = null;

export interface PlatformSettingsState {
  settings: PlatformSettingsView;
  /** "saved": read from the database. "default": nothing saved yet. "unavailable": could not be read. */
  source: "saved" | "default" | "unavailable";
  updatedAt: Date | null;
  /** What a save must name, so it cannot overwrite a change it has not seen. 0 before the first save. */
  revision: number;
}

/** Always asks the database. Tells the caller when it could not. */
export async function readPlatformSettingsState(): Promise<PlatformSettingsState> {
  try {
    await dbConnect();
    const doc = await PlatformSettings.findById("platform").lean();
    const settings: PlatformSettingsView = doc
      ? { supportEmail: doc.supportEmail ?? "", maintenanceEnabled: doc.maintenanceEnabled === true, maintenanceMessage: doc.maintenanceMessage ?? "", registrationOpen: doc.registrationOpen !== false }
      : DEFAULT_PLATFORM_SETTINGS;
    cached = { value: settings, at: Date.now() };
    return { settings, source: doc ? "saved" : "default", updatedAt: doc?.updatedAt ?? null, revision: doc?.revision ?? 0 };
  } catch {
    console.error("[platform-settings] could not be read; using the last known values or defaults");
    return { settings: cached?.value ?? DEFAULT_PLATFORM_SETTINGS, source: "unavailable", updatedAt: null, revision: 0 };
  }
}

export async function getPlatformSettings(options: { fresh?: boolean } = {}): Promise<PlatformSettingsView> {
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  return (await readPlatformSettingsState()).settings;
}

export function clearPlatformSettingsCache(): void {
  cached = null;
}

/** The public part only: `GET /api/platform/status`, and pages that show help or availability. */
export async function getPublicPlatformStatus(): Promise<PlatformStatus> {
  const fromCache = cached && Date.now() - cached.at < CACHE_MS ? cached.value : null;
  const state = fromCache ? { settings: fromCache, source: "saved" as const } : await readPlatformSettingsState();
  const { settings } = state;
  return {
    available: state.source !== "unavailable",
    registrationOpen: settings.registrationOpen,
    maintenance: { enabled: settings.maintenanceEnabled, message: settings.maintenanceEnabled ? settings.maintenanceMessage : "" },
    supportEmail: settings.supportEmail,
  };
}

/** Before an action paused by maintenance mode: creating a store or publishing. */
export async function assertNotInMaintenance(): Promise<void> {
  const settings = await getPlatformSettings();
  if (settings.maintenanceEnabled) throw new HttpError(503, settings.maintenanceMessage || MAINTENANCE_DEFAULT_MESSAGE, "platform_maintenance");
}

/** Before a registration. Says nothing about any particular address. */
export async function assertRegistrationOpen(): Promise<void> {
  const settings = await getPlatformSettings();
  const status = { registrationOpen: settings.registrationOpen, maintenance: { enabled: settings.maintenanceEnabled, message: settings.maintenanceMessage } };
  const reason = registrationUnavailableReason(status);
  if (!reason) return;
  throw settings.maintenanceEnabled ? new HttpError(503, reason, "platform_maintenance") : new HttpError(403, reason, "registration_closed");
}
