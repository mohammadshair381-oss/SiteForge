/**
 * What anyone may know about the platform's state (pure, and safe for client components).
 * The server decides: lib/platform-settings.ts refuses a registration whatever a page shows.
 */
export interface PlatformStatus {
  /** False when the settings could not be read just now, so the rest are the defaults. */
  available: boolean;
  registrationOpen: boolean;
  maintenance: { enabled: boolean; message: string };
  /** Empty when none is set. Never invent one: see `SupportContact`. */
  supportEmail: string;
}

export const REGISTRATION_CLOSED_MESSAGE = "New accounts are not being accepted right now. Please check back later.";
export const MAINTENANCE_DEFAULT_MESSAGE = "SiteForge is undergoing maintenance, so this is paused for now. Your store stays online. Please try again later.";

/** Why a new account cannot be created right now, or null if it can. */
export function registrationUnavailableReason(status: Pick<PlatformStatus, "registrationOpen" | "maintenance">): string | null {
  if (status.maintenance.enabled) return status.maintenance.message || MAINTENANCE_DEFAULT_MESSAGE;
  return status.registrationOpen ? null : REGISTRATION_CLOSED_MESSAGE;
}
