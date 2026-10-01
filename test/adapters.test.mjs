import assert from "node:assert/strict";
import test from "node:test";

import {
  TraceBuildError,
  createTypeScriptTransformer,
  createViteTracePlugin,
  transformTypeScriptSource,
} from "../src/adapters.mjs";
import { createOwnership } from "../src/ownership.mjs";
import { createSubsystemClassifier } from "../src/subsystems.mjs";

const source = "function greet(value) { return `hello ${value}`; }";
const ownership = createOwnership({ projectRoot: "/project", include: ["src/**"] });
const subsystems = createSubsystemClassifier({ pathRules: [{ pattern: "src/**", subsystem: "greetings" }] });
const options = { ownership, subsystems, hooksIdentifier: "__traceHooks" };

function compile(code, hooks) {
  return new Function("__traceHooks", `${code}\nreturn greet;`)(hooks);
}

test("Vite adapter instruments owned source and skips non-owned modules", () => {
  const plugin = createViteTracePlugin(options);
  const transformed = plugin.transform(source, "/project/src/greet.ts?import");
  assert.ok(transformed);
  assert.ok(transformed.code.includes("__traceHooks.invoke"));
  assert.equal(transformed.map.file, "src/greet.ts");
  assert.equal(plugin.transform(source, "/project/node_modules/pkg/index.js"), null);
});

test("TypeScript adapter preserves output behavior and uses shared transform semantics", () => {
  const transformed = transformTypeScriptSource(source, { ...options, fileName: "/project/src/greet.ts" });
  const events = [];
  const greet = compile(transformed.code, { invoke(fn, metadata, receiver, args) {
    events.push(metadata);
    return fn.apply(receiver, args);
  } });
  assert.equal(greet("world"), "hello world");
  assert.equal(events[0].subsystem, "greetings");

  const transformer = createTypeScriptTransformer(options)({});
  const sourceFile = { fileName: "/project/src/greet.ts", text: source };
  const output = transformer(sourceFile);
  assert.ok(output.text.includes("__traceHooks.invoke"));
  assert.equal(output.traceMap.file, "src/greet.ts");
  assert.equal(transformTypeScriptSource(source, { ...options, fileName: "/project/vendor/greet.ts" }).skipped, true);
});

test("instrumentation errors fail clearly and do not produce partial output", () => {
  assert.throws(
    () => transformTypeScriptSource("function broken(", { ...options, fileName: "/project/src/broken.ts" }),
    (error) => error instanceof TraceBuildError && error.adapter === "typescript" && error.fileName.endsWith("broken.ts"),
  );
});
