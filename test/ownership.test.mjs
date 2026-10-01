import assert from "node:assert/strict";
import test from "node:test";

import { createOwnership, normalizeOwnershipPath } from "../src/ownership.mjs";
import { transformSource } from "../src/transform.mjs";

test("owned roots are exhaustive while dependencies and generated paths are excluded", () => {
  const ownership = createOwnership({
    projectRoot: "/workspace/project",
    include: ["src/**", "packages/**"],
    exclude: ["src/ignored/**"],
  });
  assert.equal(ownership.isOwned("/workspace/project/src/app.js"), true);
  assert.equal(ownership.isOwned("/workspace/project/packages/tool.ts"), true);
  assert.equal(ownership.isOwned("/workspace/project/src/ignored/generated.js"), false);
  assert.equal(ownership.isOwned("/workspace/project/node_modules/pkg/index.js"), false);
  assert.equal(ownership.isOwned("/workspace/project/dist/app.js"), false);
  assert.equal(ownership.isOwned("/workspace/project/vendor/app.js"), false);
  assert.equal(ownership.isOwned("/workspace/other/src/app.js"), false);
  assert.deepEqual(ownership.select(["src/a.js", "node_modules/x.js", "src/b.js"]), ["src/a.js", "src/b.js"]);
});

test("Windows and POSIX spellings classify the same project-relative path", () => {
  const ownership = createOwnership({ projectRoot: "C:\\work\\project", include: ["src/**"] });
  const expected = { owned: true, path: "src\\app.js".replaceAll("\\", "/"), reason: "owned" };
  assert.deepEqual(ownership.classify("C:\\work\\project\\src\\app.js"), expected);
  assert.deepEqual(ownership.classify("C:/work/project/src/app.js"), { ...expected, path: "src/app.js" });
  assert.equal(normalizeOwnershipPath("src\\nested\\file.ts"), "src/nested/file.ts");
});

test("ownership decisions are deterministic and configurable without changing the transform", () => {
  const config = { projectRoot: "/repo", include: ["app/**"], exclude: ["app/vendor/**"] };
  const first = createOwnership(config);
  const second = createOwnership(config);
  assert.deepEqual(first.configuration, second.configuration);
  assert.deepEqual(first.classify("/repo/app/main.js"), second.classify("/repo/app/main.js"));
  assert.equal(first.isOwned("/repo/app/vendor/lib.js"), false);

  const transformed = transformSource("function owned() { return 1; }", {
    projectPath: "app/main.js",
    shouldInstrument: ({ source }) => first.isOwned(source.projectPath),
  });
  assert.equal(transformed.functions.length, 1);
  const excluded = transformSource("function ignored() { return 1; }", {
    projectPath: "app/vendor/lib.js",
    shouldInstrument: ({ source }) => first.isOwned(source.projectPath),
  });
  assert.equal(excluded.functions.length, 0);
  assert.equal(excluded.code, "function ignored() { return 1; }");
});
