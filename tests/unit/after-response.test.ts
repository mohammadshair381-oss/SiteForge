import assert from "node:assert/strict";
import test from "node:test";

import {
  drainAfterResponseTasks,
  holdAfterResponseTasks,
  releaseAfterResponseTasks,
  runAfterResponse,
  type AfterResponseRuntime,
} from "../../lib/after-response";

/**
 * Scheduling logic of lib/after-response.ts. The Next.js `after()` itself is
 * NOT exercised here (it needs a live Next request scope); a fake runtime
 * stands in for it so the success and failure branches are both covered.
 */

type Task = () => Promise<void>;

function fakeRuntime(options: { scheduleThrows?: Error; production?: boolean } = {}) {
  const scheduled: Task[] = [];
  const warnings: string[] = [];
  const runtime: AfterResponseRuntime = {
    schedule: (task) => {
      if (options.scheduleThrows) throw options.scheduleThrows;
      scheduled.push(task);
    },
    isProduction: () => options.production ?? false,
    warn: (line) => warnings.push(line),
  };
  return { runtime, scheduled, warnings };
}

const noError = () => assert.fail("no error expected");

test("when after() accepts the task it runs only when the runtime invokes it, with no fallback", async () => {
  const { runtime, scheduled, warnings } = fakeRuntime({ production: true });
  let ran = 0;
  const mode = runAfterResponse(async () => {
    ran += 1;
  }, { operation: "register", onError: noError }, runtime);
  assert.equal(mode, "after");
  assert.equal(scheduled.length, 1);
  await drainAfterResponseTasks();
  assert.equal(ran, 0, "nothing ran outside the runtime");
  await scheduled[0]();
  assert.equal(ran, 1);
  assert.deepEqual(warnings, []);
});

test("a task rejected under after() reaches onError, and a throwing reporter is contained", async () => {
  const { runtime, scheduled } = fakeRuntime();
  const errors: unknown[] = [];
  runAfterResponse(async () => {
    throw new Error("boom");
  }, { operation: "forgot", onError: (error) => errors.push(error) }, runtime);
  runAfterResponse(async () => {
    throw new Error("second");
  }, {
    operation: "resend",
    onError: () => {
      throw new Error("a broken reporter must not crash the process");
    },
  }, runtime);
  for (const task of scheduled) await task(); // must not reject
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "boom");
});

test("in production, a scheduling failure falls back AND logs a safe, searchable warning", async () => {
  const failure = new TypeError("after() unavailable for request /secret?token=abc user@example.com");
  const { runtime, warnings } = fakeRuntime({ scheduleThrows: failure, production: true });
  let ran = 0;
  const mode = runAfterResponse(async () => {
    ran += 1;
  }, { operation: "register\nINJECTED user@example.com", onError: noError }, runtime);
  assert.equal(mode, "fallback");
  assert.deepEqual(warnings, [
    "[after-response] event=after_fallback_used operation=registerINJECTEDuserexamplecom reason=TypeError durable=false",
  ]);
  assert.doesNotMatch(warnings[0], /token|secret|@|\n/);
  await drainAfterResponseTasks();
  assert.equal(ran, 1, "the task still runs through the fallback");
});

test("outside production the fallback is silent (the expected path in tests and dev)", async () => {
  const { runtime, warnings } = fakeRuntime({ scheduleThrows: new Error("outside request scope") });
  let ran = 0;
  assert.equal(runAfterResponse(async () => {
    ran += 1;
  }, { operation: "register", onError: noError }, runtime), "fallback");
  await drainAfterResponseTasks();
  assert.equal(ran, 1);
  assert.deepEqual(warnings, []);
});

test("fallback task failures still reach onError", async () => {
  const { runtime } = fakeRuntime({ scheduleThrows: new Error("x") });
  const errors: unknown[] = [];
  runAfterResponse(async () => {
    throw new Error("fallback boom");
  }, { operation: "forgot", onError: (error) => errors.push(error) }, runtime);
  await drainAfterResponseTasks();
  assert.equal((errors[0] as Error).message, "fallback boom");
});

test("the real runtime outside a request scope selects the fallback and runs the task later", async () => {
  const order: string[] = [];
  const mode = runAfterResponse(async () => {
    order.push("task");
  }, { operation: "register", onError: noError });
  order.push("response");
  assert.equal(mode, "fallback");
  assert.deepEqual(order, ["response"], "not run synchronously");
  await drainAfterResponseTasks();
  assert.deepEqual(order, ["response", "task"]);
});

test("held fallback tasks do not start until released", async () => {
  let ran = 0;
  holdAfterResponseTasks();
  const { runtime } = fakeRuntime({ scheduleThrows: new Error("x") });
  assert.equal(runAfterResponse(async () => {
    ran += 1;
  }, { operation: "register", onError: () => {} }, runtime), "held");
  await drainAfterResponseTasks();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ran, 0);
  await releaseAfterResponseTasks();
  assert.equal(ran, 1);
});
