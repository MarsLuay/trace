import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSourceIndex, saveSourceIndex } from "../src/index.mjs";
import { createCurrentProbe } from "../src/probe.mjs";
import { runCli, formatResult, parseCliArgs } from "../src/cli.mjs";
import { TraceStore } from "../src/storage.mjs";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "trace-cli-"));
  const index = buildSourceIndex([{
    projectPath: "src/chat.mjs",
    source: 'export function start() { return "ok"; }',
    entryPoints: true,
    revision: "git:current",
    buildId: "build:current",
  }]);
  const indexFile = join(directory, "source-index.json");
  await saveSourceIndex(index, indexFile);
  const identity = index.functions[0].identity;
  const runnerFile = join(directory, "runner.mjs");
  await writeFile(runnerFile, `export const entryFunctions = { ${JSON.stringify(identity)}: () => "real result" };\n`, "utf8");
  return { directory, index, indexFile, identity, runnerFile };
}

test("CLI current executes a real entry and reports observed subsystem flow", async () => {
  const fixture = await setup();
  try {
    const current = await runCli([
      "current",
      fixture.identity,
      "--index", fixture.indexFile,
      "--runner", fixture.runnerFile,
    ]);
    assert.equal(current.result.mode, "current");
    assert.equal(current.result.status, "completed");
    assert.equal(current.result.targetReached, true);
    assert.equal(current.result.flow.function, fixture.identity);
    assert.equal(current.result.output.observed, true);

    const subsystem = await runCli([
      "current",
      "unclassified",
      "--index", fixture.indexFile,
      "--runner", fixture.runnerFile,
    ]);
    assert.equal(subsystem.result.status, "completed");
    assert.equal(subsystem.result.target, "unclassified");
    assert.equal(subsystem.result.targetReached, true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("CLI past reads persisted real events and reports source parity", async () => {
  const fixture = await setup();
  const traceDirectory = join(fixture.directory, "traces");
  const store = new TraceStore({ directory: traceDirectory, maxFileBytes: 2048, maxFiles: 2 });
  try {
    const entryFunctions = { [fixture.identity]: () => "persisted result" };
    const probe = createCurrentProbe({ index: fixture.index, store });
    await probe.current(fixture.identity, { entryFunctions });
    await store.flush();

    const past = await runCli([
      "past",
      fixture.identity,
      "--store", traceDirectory,
      "--index", fixture.indexFile,
    ]);
    assert.equal(past.result.mode, "past");
    assert.equal(past.result.queryKind, "function");
    assert.equal(past.result.targetReached, true);
    assert.equal(past.result.root.function, fixture.identity);
    assert.equal(past.result.sourceDrift.status, "same");
    assert.equal(past.result.skippedRecords, 0);
  } finally {
    await store.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("CLI returns structured ambiguity instead of choosing a current entry", async () => {
  const fixture = await setup();
  try {
    const secondIndex = buildSourceIndex([{
      projectPath: "src/chat-two.mjs",
      source: 'export function start() { return "ok"; }',
      entryPoints: true,
      revision: "git:current",
      buildId: "build:current",
    }]);
    const index = {
      ...fixture.index,
      functions: [...fixture.index.functions, ...secondIndex.functions].map((entry) => ({ ...entry, subsystem: "chat" })),
    };
    await saveSourceIndex(index, fixture.indexFile);
    const runnerFile = join(fixture.directory, "ambiguous-runner.mjs");
    const first = index.functions[0].identity;
    const second = index.functions[1].identity;
    await writeFile(
      runnerFile,
      `export const entryFunctions = { ${JSON.stringify(first)}: () => "first", ${JSON.stringify(second)}: () => "second" };\n`,
      "utf8",
    );
    const current = await runCli([
      "current",
      "chat",
      "--index", fixture.indexFile,
      "--runner", runnerFile,
    ]);
    assert.equal(current.result.status, "entry-candidates");
    assert.deepEqual(current.result.candidates, [first, second].sort());
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("CLI parser keeps JSON as the default and rejects unsafe mode combinations", () => {
  assert.equal(parseCliArgs(["past", "chat"]).format, "json");
  assert.throws(() => parseCliArgs(["past", "chat", "--direct"]), /only valid/);
  assert.match(formatResult({ mode: "past", root: { function: "chat", status: "ok", children: [] } }, "tree"), /chat ok/);
});
