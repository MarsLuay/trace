import assert from "node:assert/strict";
import test from "node:test";

import {
  CORRELATION_HEADER,
  deserializeCorrelationContext,
  extractCorrelation,
  injectCorrelation,
  runWithPropagatedContext,
  serializeCorrelationContext,
} from "../src/correlation.mjs";
import { createTraceHooks } from "../src/hooks.mjs";

const metadata = (name, subsystem) => ({
  function: name,
  subsystem,
  language: "javascript",
  runtime: "node",
  source: {
    projectPath: `src/${name}.mjs`,
    line: 1,
    column: 1,
    revision: "git:test",
    buildId: "build:test",
    sourceIndexId: "index:test",
  },
});

test("correlation crosses a transport boundary into one parent-child trace", async () => {
  const events = [];
  const hooks = createTraceHooks({ store: { append: (event) => events.push(event) }, idPrefix: "boundary" });
  const child = hooks.wrap(() => "done", metadata("worker.process", "worker"));
  const parent = hooks.wrap(async () => {
    const propagated = injectCorrelation({}, { executionId: events[0].executionId, invocationId: events[0].invocationId });
    return runWithPropagatedContext(propagated, {}, () => child());
  }, metadata("chat.send", "chat"));

  await parent();
  const childEnter = events.find((event) => event.function === "worker.process" && event.event === "enter");
  assert.equal(childEnter.parentInvocationId, events[0].invocationId);
  assert.equal(childEnter.executionId, events[0].executionId);
});

test("invalid or missing correlation fails safely without merging executions", () => {
  assert.equal(deserializeCorrelationContext("not-base64-context"), null);
  assert.equal(extractCorrelation({ [CORRELATION_HEADER]: "bad" }), null);
  assert.deepEqual(injectCorrelation({ operation: "read" }, undefined), { operation: "read" });

  const calls = [];
  runWithPropagatedContext({}, {}, () => calls.push("local"));
  assert.deepEqual(calls, ["local"]);
});

test("correlation serialization is bounded and does not carry payload fields", () => {
  const encoded = serializeCorrelationContext({ executionId: "exec", invocationId: "invoke", prompt: "secret" });
  assert.equal(encoded, null);
  const valid = serializeCorrelationContext({ executionId: "exec", invocationId: "invoke" });
  assert.deepEqual(deserializeCorrelationContext(valid), { executionId: "exec", invocationId: "invoke" });
});
