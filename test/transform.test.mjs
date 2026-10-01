import assert from "node:assert/strict";
import test from "node:test";

import { validateTrace } from "../src/contract.mjs";
import { createTraceHooks } from "../src/hooks.mjs";
import { transformSource } from "../src/transform.mjs";

const source = `
function add(value) { return value + 1; }
async function asyncAdd(value) { await Promise.resolve(); return add(value); }
const double = (value) => value * 2;
const asyncDouble = async (value) => { await Promise.resolve(); return double(value); };
function closure(value) { const nested = () => asyncDouble(value); return nested(); }
const callbacks = [1, 2].map(function callback(value) { return double(value); });
class Box {
  constructor(value) { this._value = value; }
  get value() { return this._value; }
  set value(next) { this._value = next; }
  async method(value) { return await asyncAdd(this._value + value); }
}
`;

function compile(transformed, hooks) {
  return new Function("__traceHooks", `${transformed}\nreturn { add, asyncAdd, double, asyncDouble, closure, callbacks, Box };`)(hooks);
}

test("transforms supported function forms and preserves behavior", async () => {
  const events = [];
  const hooks = createTraceHooks({
    store: { append: (event) => events.push(event) },
    idPrefix: "transform",
  });
  const result = transformSource(source, {
    projectPath: "src/forms.js",
    revision: "git:forms",
    buildId: "build:forms",
    sourceIndexId: "index:forms",
  });
  const compiled = compile(result.code, hooks);
  assert.equal(compiled.add(2), 3);
  assert.equal(await compiled.asyncAdd(4), 5);
  assert.equal(compiled.double(3), 6);
  assert.equal(await compiled.asyncDouble(3), 6);
  assert.equal(await compiled.closure(3), 6);
  assert.deepEqual(compiled.callbacks, [2, 4]);
  const box = new compiled.Box(5);
  assert.equal(box.value, 5);
  box.value = 7;
  assert.equal(await box.method(2), 10);
  assert.ok(result.map.x_traceLocations.length >= 8);
  assert.ok(result.functions.some(({ kind }) => kind === "method"));
  assert.ok(result.functions.some(({ kind }) => kind === "arrow-expression"));
  assert.ok(events.some((event) => event.function === "callback"));
  for (const executionId of new Set(events.map((event) => event.executionId))) {
    validateTrace(events.filter((event) => event.executionId === executionId), { allowIncomplete: false });
  }
});

test("transformed failures preserve the original error and emit fail", () => {
  const result = transformSource("function fail() { throw original; }", { projectPath: "src/fail.js" });
  const events = [];
  const hooks = createTraceHooks({ store: { append: (event) => events.push(event) }, idPrefix: "failure" });
  const original = new Error("original");
  const { fail } = new Function("__traceHooks", "original", `${result.code}\nreturn { fail };`)(hooks, original);
  assert.throws(() => fail(), (error) => error === original);
  assert.deepEqual(events.map((event) => event.event), ["enter", "fail"]);
});

test("ownership filtering can leave generated or third-party source untouched", () => {
  const sourceCode = "function untouched() { return 1; }";
  const result = transformSource(sourceCode, { projectPath: "vendor/generated.js", shouldInstrument: () => false });
  assert.equal(result.code, sourceCode);
  assert.deepEqual(result.functions, []);
  assert.deepEqual(result.map.x_traceLocations, []);
});
