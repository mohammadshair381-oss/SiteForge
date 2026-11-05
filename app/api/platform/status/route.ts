import { handle, ok } from "@/lib/api";
import { getPublicPlatformStatus } from "@/lib/platform-settings";

/**
 * Whether registration is open, whether maintenance is on, and the support email: what the
 * sign-in pages and error pages show. Public, and limited to those fields. The server still
 * decides each action for itself.
 */
export async function GET() {
  return handle(async () => ok(await getPublicPlatformStatus(), { headers: { "Cache-Control": "no-store" } }));
}
