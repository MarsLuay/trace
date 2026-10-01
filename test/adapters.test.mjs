import assert from "node:assert/strict";
import test from "node:test";

import {
  TraceBuildError,
  createBabelTracePlugin,
  createEsbuildTracePlugin,
  createSwcTracePlugin,
  createTypeScriptTransformer,
  createViteTracePlugin,
  transformBabelSource,
  transformSwcSource,
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
  const plugin = createViteTracePlugin({ ...options, hooksPrelude: "const __traceHooks = globalThis.__traceHooks;" });
  const transformed = plugin.transform(source, "/project/src/greet.ts?import");
  assert.ok(transformed);
  assert.ok(transformed.code.startsWith("const __traceHooks = globalThis.__traceHooks;"));
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

test("Babel, SWC, and esbuild adapters share one transform and ownership boundary", async () => {
  const shared = { ...options, fileName: "/project/src/greet.ts", runtime: "shared-runtime" };
  const babel = transformBabelSource(source, shared);
  const swc = transformSwcSource(source, shared);
  const swcPlugin = createSwcTracePlugin(options);
  const swcResult = swcPlugin.transform(source, "/project/src/greet.ts");
  assert.equal(babel.code, swc.code);
  assert.equal(babel.map.file, "src/greet.ts");
  assert.equal(swcResult.code.includes("__traceHooks.invoke"), true);
  assert.equal(transformBabelSource(source, { ...options, fileName: "/project/vendor/greet.ts" }).skipped, true);

  const plugin = createBabelTracePlugin({ ...options, runtime: "shared-runtime" });
  let replaced = null;
  const state = {
    filename: "/project/src/greet.ts",
    file: { code: source, metadata: {}, opts: { filename: "/project/src/greet.ts" } },
  };
  plugin({}).visitor.Program({ marker: true }, state);
  assert.ok(state.file.metadata.trace.code.includes("__traceHooks.invoke"));
  const replacingPlugin = createBabelTracePlugin({
    ...options,
    replaceProgram: (_path, code) => { replaced = code; },
  });
  replacingPlugin({}).visitor.Program({}, state);
  assert.ok(replaced.includes("__traceHooks.invoke"));

  let onLoad = null;
  const esbuild = createEsbuildTracePlugin({
    ...options,
    readFile: async () => source,
  });
  esbuild.setup({ onLoad: (_filter, callback) => { onLoad = callback; } });
  const loaded = await onLoad({ path: "/project/src/greet.ts" });
  assert.equal(loaded.loader, "ts");
  assert.ok(loaded.contents.includes("__traceHooks.invoke"));
});

test("instrumentation errors fail clearly and do not produce partial output", () => {
  assert.throws(
    () => transformTypeScriptSource("function broken(", { ...options, fileName: "/project/src/broken.ts" }),
    (error) => error instanceof TraceBuildError && error.adapter === "typescript" && error.fileName.endsWith("broken.ts"),
  );
  const failOpen = createViteTracePlugin({ ...options, failOpen: true });
  assert.equal(failOpen.transform("function broken(", "/project/src/broken.ts"), null);
});
