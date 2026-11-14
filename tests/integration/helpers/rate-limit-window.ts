/**
 * Fixed-window rate limits (lib/rate-limit.ts) count per clock-aligned bucket
 * (`Math.floor(Date.now() / windowMs)`), so a burst that crosses a boundary starts
 * counting again and gets more attempts than the limit. That is the documented design.
 * A test that expects a limit to trigger at an exact attempt calls this first, naming
 * every window its burst depends on, so the whole burst stays inside one bucket of each.
 */
export const RATE_LIMIT_SAFETY_MARGIN_MS = 45_000;

/** Waits until at least `marginMs` remain in the current bucket of every given window. */
export async function waitForSafeRateLimitWindow(
  windowsMs: readonly number[],
  marginMs: number = RATE_LIMIT_SAFETY_MARGIN_MS,
): Promise<void> {
  if (windowsMs.length === 0) throw new Error("Name the rate-limit windows the burst depends on.");
  if (windowsMs.some((windowMs) => windowMs <= marginMs)) {
    throw new Error("Every window must be longer than the safety margin, or no moment would be safe.");
  }
  for (;;) {
    const now = Date.now();
    const remaining = Math.min(...windowsMs.map((windowMs) => windowMs - (now % windowMs)));
    if (remaining >= marginMs) return;
    // Sleep just past the nearest boundary, then check every window again.
    await new Promise((resolve) => setTimeout(resolve, remaining + 50));
  }
}
