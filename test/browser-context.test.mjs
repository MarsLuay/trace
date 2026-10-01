import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { activeContext, bindContext, runWithContext } from "../src/context-browser.mjs";
import { injectCorrelation, runWithPropagatedContext } from "../src/correlation-browser.mjs";
import { createBrowserTraceHooks } from "../src/hooks-browser.mjs";
import { createBrowserTraceRecorder } from "../src/recorder-browser.mjs";

const metadata = (name, subsystem = "renderer") => ({
  function: name,
  subsystem,
  language: "javascript",
  runtime: "browser",
  source: {
    projectPath: `src/${name}.mjs`,
    line: 1,
    column: 1,
    revision: "git:renderer",
    buildId: "build:renderer",
    sourceIndexId: "index:renderer",
  },
});

function recorder(events) {
  return { append: (event) => events.push(event) };
}

test("browser adapter has no Node-only runtime dependency", async () => {
  const source = await readFile(new URL("../src/context-browser.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:/u);
});

test("browser promises and bound callbacks preserve renderer parentage", async () => {
  const events = [];
  const hooks = createBrowserTraceHooks({ store: recorder(events), idPrefix: "renderer" });
  const child = hooks.wrap(() => "child", metadata("worker"));
  const parent = hooks.wrap(() => Promise.resolve().then(bindContext(() => child())), metadata("render"));

  await Promise.all([parent(), parent()]);
  const parentIds = events.filter((event) => event.function === "render" && event.event === "enter");
  const childEvents = events.filter((event) => event.function === "worker" && event.event === "enter");
  assert.equal(parentIds.length, 2);
  assert.equal(childEvents.length, 2);
  assert.deepEqual(new Set(childEvents.map((event) => event.parentInvocationId)), new Set(parentIds.map((event) => event.invocationId)));
  assert.equal(activeContext(), null);
});

test("browser recorder sends contract events and fails open", async () => {
  const requests = [];
  const recorder = createBrowserTraceRecorder({
    endpoint: "/api/trace/events",
    fetcher: async (url, init) => { requests.push({ url, init }); return { ok: true }; },
  });
  assert.equal(await recorder.append({ schemaVersion: 1, event: "enter" }), true);
  assert.equal(requests[0].url, "/api/trace/events");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(createBrowserTraceRecorder({ fetcher: null }).append({}), false);
});

test("renderer correlation joins a main execution without exposing transport details", () => {
  const events = [];
  const hooks = createBrowserTraceHooks({ store: recorder(events), idPrefix: "renderer" });
  const child = hooks.wrap(() => "child", metadata("render.callback"));
  runWithContext({ executionId: "execution-1", invocationId: "main-root" }, () => {
    const carrier = injectCorrelation({}, { executionId: "execution-1", invocationId: "main-root" });
    runWithPropagatedContext(carrier, {}, () => child());
  });
  assert.equal(events[0].executionId, "execution-1");
  assert.equal(events[0].parentInvocationId, "main-root");
  assert.equal(Object.hasOwn(events[0], "arguments"), false);
});
