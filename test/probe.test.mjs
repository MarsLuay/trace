import assert from "node:assert/strict";
import test from "node:test";

import { buildSourceIndex } from "../src/index.mjs";
import { createOwnership } from "../src/ownership.mjs";
import { createSubsystemClassifier } from "../src/subsystems.mjs";
import { createCurrentProbe, EffectRegistry, ProbeBoundaryError } from "../src/probe.mjs";

function makeIndex(files) {
  return buildSourceIndex(files.map((file) => ({ ...file, projectPath: `/project/${file.projectPath}` })), {
    ownership: createOwnership({ projectRoot: "/project", include: ["src/**"] }),
    classifier: createSubsystemClassifier({ pathRules: [{ pattern: "src/app/**", subsystem: "app" }] }),
    revision: "git:current",
    buildId: "build:current",
  });
}

const baseIndex = makeIndex([{
  projectPath: "src/app/entry.js",
  source: "function start() { return target(); } function target() { return true; }",
  entryPoints: ["start"],
}]);

const identity = (prefix) => baseIndex.functions.find(({ identity: value }) => value.startsWith(`${prefix}@`)).identity;
const startIdentity = identity("start");
const targetIdentity = identity("target");

test("current probe starts from a real entry and reports naturally reached targets", async () => {
  const events = [];
  const probe = createCurrentProbe({ index: baseIndex, events });
  const target = probe.wrap(targetIdentity, () => true);
  const result = await probe.current(targetIdentity, {
    entryFunctions: { [startIdentity]: () => target() },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.targetReached, true);
  assert.equal(result.selectedEntry, startIdentity);
  assert.equal(result.flow.function, startIdentity);
  assert.equal(result.stoppingPoint, targetIdentity);
});

test("current probe reports an actual stopping point without invoking an unreachable target", async () => {
  const events = [];
  const probe = createCurrentProbe({ index: baseIndex, events });
  let invoked = false;
  const result = await probe.current(targetIdentity, {
    entryFunctions: { [startIdentity]: () => "stopped" },
  });
  invoked = events.some((event) => event.function === targetIdentity);
  assert.equal(result.targetReached, false);
  assert.equal(result.stoppingPoint, startIdentity);
  assert.equal(invoked, false);
});

test("registered effects are intercepted with bounded wrapper/category metadata", async () => {
  const events = [];
  const boundaries = new EffectRegistry().register({ name: "sendProviderRequest", category: "network", simulate: () => "simulated" });
  const probe = createCurrentProbe({ index: baseIndex, events, boundaries });
  const target = probe.wrap(targetIdentity, () => probe.boundary("sendProviderRequest", { route: "/provider", secret: "never-record" }));
  const result = await probe.current(targetIdentity, { entryFunctions: { [startIdentity]: () => target() } });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.intercepted, [{ wrapper: "sendProviderRequest", effect: "network", intercepted: true, details: { route: "/provider" } }]);
});

test("unknown effects fail closed and do not execute the external action", async () => {
  const events = [];
  const probe = createCurrentProbe({ index: baseIndex, events });
  let externalAction = false;
  const target = probe.wrap(targetIdentity, () => {
    const result = probe.boundary("unregisteredMutation", { operation: "write" });
    externalAction = true;
    return result;
  });
  const result = await probe.current(targetIdentity, { entryFunctions: { [startIdentity]: () => target() } });
  assert.equal(externalAction, false);
  assert.equal(result.status, "failed");
  assert.equal(result.targetReached, true);
  assert.equal(result.error.name, "ProbeBoundaryError");
});

test("multiple real subsystem entries return candidates, while direct mode is explicit", async () => {
  const index = makeIndex([
    { projectPath: "src/app/one.js", source: "function startOne() { return true; }", entryPoints: ["startOne"] },
    { projectPath: "src/app/two.js", source: "function startTwo() { return true; }", entryPoints: ["startTwo"] },
  ]);
  const startOne = index.functions.find(({ identity }) => identity.startsWith("startOne@")).identity;
  const startTwo = index.functions.find(({ identity }) => identity.startsWith("startTwo@")).identity;
  const probe = createCurrentProbe({ index });
  const ambiguous = await probe.current(startOne, {
    entryFunctions: { [startOne]: () => true, [startTwo]: () => true },
  });
  assert.equal(ambiguous.status, "entry-candidates");
  assert.deepEqual(ambiguous.candidates, [startOne, startTwo].sort());
  const direct = await probe.current(startOne, { direct: true, entryFunctions: { [startOne]: () => true } });
  assert.equal(direct.direct, true);
  assert.equal(direct.targetReached, true);
});

test("effect registry rejects malformed registrations and unknown boundaries", () => {
  const registry = new EffectRegistry();
  assert.throws(() => registry.register({ name: "", category: "network" }));
  assert.throws(() => registry.intercept("unknown"), (error) => error instanceof ProbeBoundaryError);
});
