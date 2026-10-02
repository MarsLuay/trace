import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createTraceHooks } from "../src/hooks.mjs";
import { createTraceHooksWithContext } from "../src/hooks-core.mjs";
import { validateTrace } from "../src/contract.mjs";

const metadata = (functionName, subsystem = "tests") => ({
  function: functionName,
  subsystem,
  language: "javascript",
  runtime: "node",
  source: {
    projectPath: "src/example.js",
    line: 1,
    column: 1,
    revision: "git:test",
    buildId: "build:test",
    sourceIndexId: "index:test",
  },
});

function recordingStore(events, { failure = null } = {}) {
  return {
    append(event) {
      events.push(event);
      if (failure) return Promise.reject(failure);
      return Promise.resolve(true);
    },
  };
}

test("sync wrappers preserve return values and emit enter/exit", () => {
  const events = [];
  const hooks = createTraceHooks({ store: recordingStore(events), idPrefix: "sync" });
  const wrapped = hooks.wrap((left, right) => left + right, metadata("math.add"));
  assert.equal(wrapped(2, 3), 5);
  assert.deepEqual(events.map((event) => event.event), ["enter", "exit"]);
  assert.equal(events[0].invocationId, events[1].invocationId);
  assert.equal(events[0].parentInvocationId, null);
  validateTrace(events, { allowIncomplete: false });
});

test("async wrappers preserve values, ordering, and parent relationships", async () => {
  const events = [];
  const hooks = createTraceHooks({ store: recordingStore(events), idPrefix: "async" });
  const child = hooks.wrap(async () => {
    await delay(1);
    return "child";
  }, metadata("async.child", "child"));
  const parent = hooks.wrap(async () => {
    const value = await child();
    return `${value}:parent`;
  }, metadata("async.parent", "parent"));
  assert.equal(await parent(), "child:parent");
  assert.deepEqual(events.map((event) => event.event), ["enter", "enter", "exit", "exit"]);
  assert.equal(events[1].parentInvocationId, events[0].invocationId);
  validateTrace(events, { allowIncomplete: false });
});

test("sync and async failures emit fail before rethrowing the original error", async () => {
  const events = [];
  const hooks = createTraceHooks({ store: recordingStore(events), idPrefix: "failure" });
  const syncError = new Error("sync-original");
  const sync = hooks.wrap(() => {
    throw syncError;
  }, metadata("failure.sync"));
  assert.throws(() => sync(), (error) => error === syncError);

  const asyncError = new Error("async-original");
  const asynchronous = hooks.wrap(async () => {
    await delay(1);
    throw asyncError;
  }, metadata("failure.async"));
  await assert.rejects(asynchronous(), (error) => error === asyncError);
  assert.deepEqual(events.map((event) => event.event), ["enter", "fail", "enter", "fail"]);
  for (const executionId of new Set(events.map((event) => event.executionId))) {
    validateTrace(events.filter((event) => event.executionId === executionId), { allowIncomplete: false });
  }
});

test("concurrent wrappers use separate roots", async () => {
  const events = [];
  const hooks = createTraceHooks({ store: recordingStore(events), idPrefix: "concurrent" });
  const wrapped = hooks.wrap(async (value, wait) => {
    await delay(wait);
    return value;
  }, metadata("concurrent.work"));
  assert.deepEqual(await Promise.all([wrapped("left", 3), wrapped("right", 1)]), ["left", "right"]);
  const roots = events.filter((event) => event.event === "enter");
  assert.equal(roots.length, 2);
  assert.ok(roots.every((event) => event.parentInvocationId === null));
  validateTrace(events.filter((event) => event.executionId === roots[0].executionId), { allowIncomplete: false });
  validateTrace(events.filter((event) => event.executionId === roots[1].executionId), { allowIncomplete: false });
});

test("recorder failures fail open and do not alter application behavior", async () => {
  const events = [];
  const hooks = createTraceHooks({
    store: recordingStore(events, { failure: new Error("disk unavailable") }),
    idPrefix: "open",
  });
  const wrapped = hooks.wrap(async (value) => {
    await delay(1);
    return value;
  }, metadata("open.return"));
  assert.equal(await wrapped("unchanged"), "unchanged");
  assert.equal(events.length, 2);
});

test("disabled and backpressured hooks bypass event construction and context creation", () => {
  let contextCalls = 0;
  const store = {
    canAccept: () => false,
    append: () => assert.fail("backpressured hooks must not append"),
  };
  const contextRuntime = {
    activeContext() { contextCalls += 1; return null; },
    createContext() { contextCalls += 1; return {}; },
    runWithContext(_context, callback) { contextCalls += 1; return callback(); },
  };
  const hooks = createTraceHooksWithContext({ store, contextRuntime, enabled: true });
  const dangerousMetadata = {};
  Object.defineProperty(dangerousMetadata, "subsystem", {
    get() { assert.fail("backpressure must be checked before reading metadata"); },
  });
  assert.equal(hooks.wrap(() => "unchanged", dangerousMetadata)(), "unchanged");
  assert.equal(contextCalls, 0);

  const events = [];
  const disabled = createTraceHooks({ store: recordingStore(events), enabled: false });
  assert.equal(disabled.wrap(() => "still runs", metadata("disabled"))(), "still runs");
  assert.equal(events.length, 0);
});

test("runtime configuration records only selected subsystems and can switch off", () => {
  const events = [];
  const hooks = createTraceHooks({ store: recordingStore(events), enabled: false, subsystems: [] });
  const browser = hooks.wrap(() => "browser", metadata("renderer", "browser"));
  const tools = hooks.wrap(() => "tools", metadata("tool", "tools"));

  assert.equal(browser(), "browser");
  hooks.configure({ enabled: true, subsystems: ["browser"] });
  assert.equal(tools(), "tools");
  assert.equal(browser(), "browser");
  hooks.configure({ enabled: false });
  assert.equal(browser(), "browser");
  assert.deepEqual(events.map((event) => event.subsystem), ["browser", "browser"]);
  assert.deepEqual(events.map((event) => event.event), ["enter", "exit"]);
});
