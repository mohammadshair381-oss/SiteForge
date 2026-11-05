/**
 * Next.js startup hook (`instrumentation.ts`).
 *
 * `register()` runs once when a Next.js server instance boots (`next dev` and
 * `next start`). Next.js deliberately skips it during `next build` (see
 * `next/dist/server/lib/router-utils/instrumentation-globals.external`), so
 * validating here cannot break the build.
 *
 * It exists to fail fast on invalid required configuration. Previously a bad
 * `SESSION_SECRET` / `MONGODB_URI`, or a production deploy missing
 * `TRUSTED_IP_HEADER`, was only discovered lazily on the first request. The
 * `lib/env` module is imported dynamically and only on the Node.js runtime, so
 * server-only secrets are never evaluated in the edge (middleware) bundle.
 *
 * Email configuration is validated too: when `EMAIL_PROVIDER` is explicitly set
 * its requirements are checked at boot (production refuses `console`/`memory`
 * and requires Resend credentials). A production deploy that has not configured
 * email at all is allowed to boot and simply refuses to send until configured.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertStartupEnv } = await import("./lib/env");
  assertStartupEnv();
  const { assertEmailStartupConfig } = await import("./lib/email");
  assertEmailStartupConfig();
}
