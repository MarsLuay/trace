import assert from "node:assert/strict";
import test from "node:test";

import { queryFunction, querySubsystem, reconstructGraph } from "../src/graph.mjs";

const fixture = (name) => import(`./fixtures/${name}`, { with: { type: "json" } });

function reentryFixture(events) {
  const [rootEnter, providerEnter, providerExit, rootExit] = structuredClone(events);
  const innerEnter = {
    ...providerExit,
    eventId: "js-e3-reentry",
    invocationId: "js-i-reentry",
    parentInvocationId: "js-i-child",
    sequence: "3",
    event: "enter",
    function: "chat.retry",
    subsystem: "chat",
    source: rootEnter.source,
  };
  const innerExit = {
    ...innerEnter,
    eventId: "js-e4-reentry",
    sequence: "4",
    event: "exit",
  };
  return [
    rootEnter,
    providerEnter,
    innerEnter,
    innerExit,
    { ...providerExit, eventId: "js-e5-provider", sequence: "5" },
    { ...rootExit, eventId: "js-e6-root", sequence: "6" },
  ];
}

test("reconstructs nested success and failure trees", async () => {
  const javascript = (await fixture("javascript-node.json")).default;
  const python = (await fixture("python-asyncio.json")).default;
  const graph = reconstructGraph(javascript);
  assert.equal(graph.roots.length, 1);
  assert.equal(graph.roots[0].function, "chat.sendMessage");
  assert.equal(graph.roots[0].status, "ok");
  assert.equal(graph.roots[0].children[0].function, "provider.select");
  assert.equal(graph.roots[0].children[0].status, "ok");

  const failed = reconstructGraph(python).roots[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.children[0].status, "failed");
});

test("does not fabricate completion for crash-truncated streams", async () => {
  const javascript = (await fixture("javascript-node.json")).default;
  const graph = reconstructGraph(javascript.slice(0, 2));
  assert.equal(graph.roots[0].status, "incomplete");
  assert.equal(graph.roots[0].children[0].status, "incomplete");
  assert.equal(querySubsystem(javascript.slice(0, 2), "chat").root.status, "incomplete");
});

test("keeps independent execution roots separate", async () => {
  const javascript = (await fixture("javascript-node.json")).default;
  const second = javascript.map((event) => ({
    ...structuredClone(event),
    eventId: `second-${event.eventId}`,
    executionId: "exec-js-2",
    invocationId: `second-${event.invocationId}`,
    parentInvocationId: event.parentInvocationId ? `second-${event.parentInvocationId}` : null,
  }));
  const graph = reconstructGraph([...javascript, ...second]);
  assert.equal(graph.executions.length, 2);
  assert.equal(graph.roots.length, 2);
  assert.deepEqual(graph.roots.map((root) => root.children.length), [1, 1]);
});

test("rewinds a function to the first node in its contiguous subsystem segment", async () => {
  const javascript = (await fixture("javascript-node.json")).default;
  const events = reentryFixture(javascript);
  const sameSubsystem = structuredClone(events);
  for (const event of sameSubsystem) {
    if (event.invocationId === "js-i-child") {
      event.function = "chat.format";
      event.subsystem = "chat";
    }
  }
  const result = queryFunction(sameSubsystem, "chat.format");
  assert.equal(result.targetReached, true);
  assert.equal(result.root.function, "chat.sendMessage");
  assert.equal(result.target.function, "chat.format");
});

test("returns the latest distinct subsystem-entry segment and preserves cross-subsystem children", async () => {
  const javascript = (await fixture("javascript-node.json")).default;
  const events = reentryFixture(javascript);
  const result = querySubsystem(events, "chat");
  assert.equal(result.root.function, "chat.retry");
  assert.equal(result.root.subsystem, "chat");
  assert.deepEqual(result.root.children, []);

  const provider = querySubsystem(events, "providers");
  assert.equal(provider.root.function, "provider.select");
  assert.equal(provider.root.children[0].function, "chat.retry");
});

test("returns a deterministic not-found result", async () => {
  const javascript = (await fixture("javascript-node.json")).default;
  assert.deepEqual(queryFunction(javascript, "database.save"), {
    function: "database.save",
    targetReached: false,
    root: null,
    target: null,
  });
  assert.equal(querySubsystem(javascript, "database").root, null);
});
