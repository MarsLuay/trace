import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import test from "node:test";

const execFile = promisify(execFileCallback);
const root = new URL("..", import.meta.url);

async function pack(destination) {
  const { stdout } = await execFile("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  });
  const [metadata] = JSON.parse(stdout);
  return { metadata, tarball: join(destination, metadata.filename) };
}

test("packed artifact contains only the public package surface and runs its CLI", async () => {
  const directory = await mkdtemp(join("/tmp", "trace-package-"));
  const fixture = join(directory, "fixture");
  try {
    const { metadata, tarball } = await pack(directory);
    const paths = metadata.files.map((file) => file.path);
    assert.ok(paths.includes("bin/trace.mjs"));
    assert.ok(paths.includes("src/adapters.mjs"));
    assert.ok(paths.includes("NOTICE"));
    assert.ok(paths.every((path) => !path.startsWith("test/") && !path.startsWith(".trace/")));
    assert.equal(paths.some((path) => path.includes(".env") || path.includes("credentials")), false);

    await execFile("npm", ["init", "--yes"], { cwd: directory });
    await execFile("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: directory, maxBuffer: 1024 * 1024 });
    await writeFile(join(directory, "index.json"), JSON.stringify({
      schemaVersion: 1,
      sourceIndexId: "empty",
      revision: null,
      buildId: null,
      classifierId: "test",
      classifierVersion: 1,
      functions: [],
      subsystems: [],
    }));
    const { stdout } = await execFile(join(directory, "node_modules/.bin/trace"), [
      "past", "missing", "--store", join(directory, "empty-store"), "--index", join(directory, "index.json"),
    ], { cwd: directory });
    const result = JSON.parse(stdout);
    assert.equal(result.mode, "past");
    assert.equal(result.persistedEventCount, 0);

    const packageJson = JSON.parse(await readFile(join(directory, "node_modules/@marsluay/trace/package.json"), "utf8"));
    assert.equal(packageJson.private, undefined);
    assert.equal(packageJson.exports["./hooks/browser"], "./src/hooks-browser.mjs");
    assert.equal(packageJson.exports["./cli"], "./src/cli.mjs");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
