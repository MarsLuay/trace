import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parseCliArgs, runCli } from "../src/cli.mjs";

test("trace init configures one deterministic Vite/TypeScript project idempotently", async () => {
  const root = await mkdtemp(join("/tmp", "trace-init-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", devDependencies: { vite: "latest", typescript: "latest" }, scripts: { build: "vite build" } }), "utf8");
    await writeFile(join(root, "vite.config.js"), "export default { plugins: [] };\n", "utf8");
    await writeFile(join(root, "tsconfig.json"), "{}\n", "utf8");
    await writeFile(join(root, "src-entry.ts"), "export const value = 1;\n", "utf8");
    await (await import("node:fs/promises")).mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "export function start() { return 1; }\n", "utf8");

    assert.deepEqual(parseCliArgs(["init", "--check", "--root", root]), { mode: "init", root, check: true, format: "json" });
    const preview = await runCli(["init", "--check", "--root", root]);
    assert.equal(preview.result.status, "configured");
    assert.equal(preview.result.check, true);
    assert.equal(preview.result.changes.some((change) => change.path === ".trace/config.json"), true);
    assert.equal(await (async () => { try { await readFile(join(root, ".trace/config.json")); return true; } catch { return false; } })(), false);

    const first = await runCli(["init", "--root", root]);
    assert.equal(first.result.status, "configured");
    const config = JSON.parse(await readFile(join(root, ".trace/config.json"), "utf8"));
    assert.deepEqual(config.sourceRoots, ["src"]);
    assert.deepEqual(config.adapters.map((adapter) => adapter.adapter), ["vite", "typescript"]);
    const patched = await readFile(join(root, "vite.config.js"), "utf8");
    assert.match(patched, /__traceVitePlugin\(\)/u);

    const second = await runCli(["init", "--root", root]);
    assert.equal(second.result.status, "unchanged");
    assert.equal(await readFile(join(root, "vite.config.js"), "utf8"), patched);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trace init refuses ambiguous configs and mixed mutation wrappers without mutating them", async () => {
  const root = await mkdtemp(join("/tmp", "trace-init-ambiguous-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "ambiguous" }), "utf8");
    await writeFile(join(root, "vite.config.js"), "export default { plugins: [] };\n", "utf8");
    await writeFile(join(root, "vite.config.mjs"), "export default { plugins: [] };\n", "utf8");
    await (await import("node:fs/promises")).mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "effects.js"), "export function maybe() { fetch('/data'); return fs.readFileSync('x'); }\n", "utf8");
    const before = await readFile(join(root, "vite.config.js"), "utf8");
    const result = await runCli(["init", "--root", root]);
    assert.equal(result.result.status, "ambiguous");
    assert.equal(result.result.changes.length, 0);
    assert.equal(await readFile(join(root, "vite.config.js"), "utf8"), before);
    assert.equal(await (async () => { try { await readFile(join(root, ".trace/config.json")); return true; } catch { return false; } })(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
