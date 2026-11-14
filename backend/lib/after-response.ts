import { after } from "next/server";
import { isProduction } from "./env";

/**
 * Runs work AFTER the HTTP response has been sent (server-only).
 *
 * Inside a Next.js request (route handlers, server components) this uses the
 * stable Next 15 `after()` API: on Vercel it is backed by `waitUntil` (bounded
 * by the function's max duration); on `next start` it runs in the same process
 * once the response is flushed. This production path is NOT exercised by the
 * automated tests (they call route handlers outside a Next request).
 *
 * If `after()` throws (outside a request scope, e.g. tests, or an unexpected
 * runtime), the task still runs, deferred to a later turn of the event loop
 * and tracked so it can be awaited. In production that fallback is logged as
 * `[after-response] event=after_fallback_used ...`: a detached task on a
 * serverless instance may be frozen or killed once the response is sent.
 *
 * Every task failure reaches `onError`. This is NOT a durable queue: if the
 * process or instance dies before the task finishes, the task is lost
 * silently (nothing is retried). See docs/customer-accounts.md.
 */

type Task = () => Promise<void>;

export interface AfterResponseOptions {
  /** Short, non-identifying label for logs (e.g. "register"). */
  operation: string;
  /** Receives every task failure; must not throw (a throwing reporter is ignored). */
  onError: (error: unknown) => void;
}

/** The runtime pieces `runAfterResponse` depends on (injectable for tests). */
export interface AfterResponseRuntime {
  schedule: (task: Task) => void;
  isProduction: () => boolean;
  warn: (line: string) => void;
}

const nextRuntime: AfterResponseRuntime = {
  schedule: (task) => after(task),
  isProduction,
  warn: (line) => console.warn(line),
};

/** How a task was scheduled. */
export type AfterResponseMode = "after" | "fallback" | "held";

const state = globalThis as unknown as {
  __siteforgeAfterResponse?: { pending: Set<Promise<void>>; held: Task[] | null };
};
const store = (state.__siteforgeAfterResponse ??= { pending: new Set(), held: null });

/** Log-safe token: letters, digits, "-" and "_" only. */
function safeLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "unknown";
}

export function runAfterResponse(
  task: Task,
  options: AfterResponseOptions,
  runtime: AfterResponseRuntime = nextRuntime,
): AfterResponseMode {
  const guarded: Task = async () => {
    try {
      await task();
    } catch (error) {
      try {
        options.onError(error);
      } catch {
        // A failing error reporter must never crash the process.
      }
    }
  };

  try {
    runtime.schedule(guarded);
    return "after";
  } catch (error) {
    // Not inside a request scope (or `after` unavailable): fall back below.
    if (runtime.isProduction()) {
      const reason = error instanceof Error ? safeLabel(error.name) : "unknown";
      runtime.warn(
        `[after-response] event=after_fallback_used operation=${safeLabel(options.operation)} reason=${reason} durable=false`,
      );
    }
  }

  if (store.held) {
    store.held.push(guarded);
    return "held";
  }
  track(guarded);
  return "fallback";
}

function track(task: Task): void {
  const promise = new Promise<void>((resolve) => {
    setImmediate(() => {
      void task().finally(resolve);
    });
  });
  store.pending.add(promise);
  void promise.finally(() => store.pending.delete(promise));
}

/** Test helper: waits until every fallback task (including chained ones) has finished. */
export async function drainAfterResponseTasks(): Promise<void> {
  while (store.pending.size > 0) {
    await Promise.all([...store.pending]);
  }
}

/** Test helper: queue fallback tasks without starting them (proves the response did not wait). */
export function holdAfterResponseTasks(): void {
  store.held ??= [];
}

/** Test helper: start the held tasks and wait for them. */
export async function releaseAfterResponseTasks(): Promise<void> {
  const held = store.held ?? [];
  store.held = null;
  for (const task of held) track(task);
  await drainAfterResponseTasks();
}
