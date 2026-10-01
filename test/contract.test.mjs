import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TraceContractError,
  TRACE_SCHEMA_VERSION,
  validateEvent,
  validateTrace,
} from "../src/contract.mjs";

const fixture = (name) => import(`./fixtures/${name}`, { with: { type: "json" } });

function expectContractError(fn, text) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TraceContractError);
    assert.match(error.message, new RegExp(text));
    return true;
  });
}

test("the versioned schema is closed and documents the correlation boundary", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/trace-event-v1.schema.json", import.meta.url)));
  assert.equal(schema.properties.schemaVersion.const, TRACE_SCHEMA_VERSION);
  assert.deepEqual(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.event.enum, ["enter", "exit", "fail"]);
  assert.ok(schema.properties.source.properties.revision);
});

test("JavaScript and Python fixtures validate against the same graph contract", async () => {
  const javascript = (await fixture("javascript-node.json")).default;
  const python = (await fixture("python-asyncio.json")).default;
  assert.equal(validateTrace(javascript, { allowIncomplete: false }), javascript);
  assert.equal(validateTrace(python, { allowIncomplete: false }), python);
  assert.notEqual(javascript[0].language, python[0].language);
});

test("a child must reference an active parent and exits must match an enter", async () => {
  const events = (await fixture("javascript-node.json")).default;
  const orphan = structuredClone(events);
  orphan[1].parentInvocationId = "missing";
  expectContractError(() => validateTrace(orphan), "active invocation");

  const mismatched = structuredClone(events);
  mismatched[2].function = "provider.other";
  expectContractError(() => validateTrace(mismatched), "identity must match");
});

test("duplicate, cross-execution, and non-monotonic records are rejected", async () => {
  const events = (await fixture("javascript-node.json")).default;
  const duplicate = structuredClone(events);
  duplicate[3].eventId = duplicate[0].eventId;
  expectContractError(() => validateTrace(duplicate), "eventId: must be unique");

  const crossExecution = structuredClone(events);
  crossExecution[2].executionId = "other-execution";
  expectContractError(() => validateTrace(crossExecution), "one execution");

  const outOfOrder = structuredClone(events);
  outOfOrder[2].sequence = "1";
  expectContractError(() => validateTrace(outOfOrder), "increase strictly");
});

test("sensitive fields and absolute source paths are outside the closed contract", async () => {
  const events = (await fixture("javascript-node.json")).default;
  const withArguments = structuredClone(events[0]);
  withArguments.arguments = ["not persisted"];
  expectContractError(() => validateEvent(withArguments), "sensitive payload");

  const withAbsolutePath = structuredClone(events[0]);
  withAbsolutePath.source.projectPath = "/private/project/src/file.js";
  expectContractError(() => validateEvent(withAbsolutePath), "must not be absolute");
});

test("crash-truncated prefixes remain readable but complete validation is strict", async () => {
  const events = (await fixture("javascript-node.json")).default.slice(0, 2);
  assert.equal(validateTrace(events), events);
  expectContractError(() => validateTrace(events, { allowIncomplete: false }), "incomplete");
});

test("historical revision identity is retained without requiring the current checkout", async () => {
  const events = (await fixture("javascript-node.json")).default;
  const historical = structuredClone(events);
  for (const event of historical) {
    event.source.revision = "git:old-revision";
    event.source.buildId = "build:historical";
    event.source.sourceIndexId = "index:historical";
  }
  assert.equal(validateTrace(historical, { allowIncomplete: false }), historical);
});
