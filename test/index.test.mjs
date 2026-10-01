import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSourceIndex, loadSourceIndex, lookupFunction, saveSourceIndex, sourceDrift } from "../src/index.mjs";
import { createOwnership } from "../src/ownership.mjs";
import { createSubsystemClassifier } from "../src/subsystems.mjs";

const files = [
  {
    projectPath: "src/chat/entry.js",
    source: "function startChat() { return sendMessage(); } function sendMessage() { return true; }",
    runtime: "node",
    layer: "server",
    entryPoints: ["startChat"],
    revision: "git:old",
    buildId: "build:old",
  },
  {
    projectPath: "src/ui/entry.js",
    source: "function startChat() { return false; }",
    runtime: "browser",
    layer: "ui",
    entryPoints: ["startChat"],
    revision: "git:old",
    buildId: "build:old",
  },
  {
    projectPath: "vendor/ignored.js",
    source: "function ignored() { return false; }",
  },
];

function options() {
  return {
    ownership: createOwnership({ projectRoot: "/project", include: ["src/**"] }),
    classifier: createSubsystemClassifier({ pathRules: [{ pattern: "src/chat/**", subsystem: "chat" }, { pattern: "src/ui/**", subsystem: "ui" }] }),
    revision: "git:old",
    buildId: "build:old",
  };
}

test("real source builds a revisioned machine-readable index with real entry points", () => {
  const index = buildSourceIndex(files.map((file) => ({ ...file, projectPath: `/project/${file.projectPath}` })), options());
  assert.equal(index.functions.length, 3);
  assert.equal(index.functions.some(({ identity }) => identity.includes("ignored")), false);
  assert.ok(index.functions.every(({ source, classification }) => source.projectPath.startsWith("src/") && classification.classifierId));
  assert.ok(index.functions.some(({ identity, entryPoint }) => identity.startsWith("startChat@src/chat") && entryPoint));
  assert.equal(index.subsystems.chat.members.length, 2);
});

test("function lookup prefers exact identity and reports same-name ambiguity", () => {
  const index = buildSourceIndex(files.slice(0, 2).map((file) => ({ ...file, projectPath: `/project/${file.projectPath}` })), options());
  const exact = index.functions.find(({ identity }) => identity.startsWith("startChat@src/chat"));
  assert.equal(lookupFunction(index, exact.identity).status, "found");
  assert.equal(lookupFunction(index, "startChat").status, "ambiguous");
  assert.equal(lookupFunction(index, "missing").status, "not-found");
});

test("source indexes retain historical metadata and report current drift", () => {
  const historical = buildSourceIndex(files.slice(0, 2).map((file) => ({ ...file, projectPath: `/project/${file.projectPath}` })), options());
  const current = buildSourceIndex(files.slice(0, 2).map((file) => ({ ...file, projectPath: `/project/${file.projectPath}` })), { ...options(), revision: "git:new", buildId: "build:new" });
  assert.equal(sourceDrift(current, historical).status, "drifted");
  assert.equal(historical.functions[0].revision, "git:old");
  assert.equal(historical.functions[0].source.projectPath.startsWith("/"), false);
});

test("index persistence round-trips without source text or absolute paths", async () => {
  const index = buildSourceIndex(files.slice(0, 1).map((file) => ({ ...file, projectPath: `/project/${file.projectPath}` })), options());
  const directory = await mkdtemp(join(tmpdir(), "trace-index-"));
  const fileName = join(directory, "source-index.json");
  await saveSourceIndex(index, fileName);
  const loaded = await loadSourceIndex(fileName);
  assert.deepEqual(loaded, index);
  assert.equal(JSON.stringify(loaded).includes("function startChat()"), false);
});
