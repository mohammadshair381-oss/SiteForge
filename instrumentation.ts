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
 * Email configuration is validated too (`assertEmailStartupConfig`). In
 * production email must be configured on purpose: `resend`, or `disabled` to run with no
 * email at all. An empty `EMAIL_PROVIDER`, `console`,
 * `memory`, or incomplete or malformed Resend settings fail this hook, because
 * password-reset codes (and every other email) cannot work
 * without delivery. Next.js then answers requests with 500, but the process may
 * keep running and print "Ready": this deliberately never exits, and deployments
 * must rely on a hosting-platform health check of `/login` to keep traffic away.
 * The check is structural and never contacts the provider.
 * Outside production an explicitly set provider is checked and an empty one
 * means `console`. See docs/email-delivery.md.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertStartupEnv } = await import("./backend/lib/env");
  assertStartupEnv();
  const { assertEmailStartupConfig } = await import("./backend/lib/email");
  assertEmailStartupConfig();
}
