import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { join } from "node:path";
import test from "node:test";

import { CORRELATION_HEADER, injectCorrelation } from "../src/correlation.mjs";
import { TraceStore } from "../src/storage.mjs";

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL("..", import.meta.url));
const childScript = `
import asyncio, os, sys
from pathlib import Path
sys.path.insert(0, os.environ["TRACE_PYTHON"])
from trace_runtime import TraceRuntime

runtime = TraceRuntime(
    directory=os.environ["TRACE_STORE"],
    project_root=Path(os.environ["TRACE_PROJECT"]),
    sequence_start=int(os.environ["TRACE_SEQUENCE"]),
)
@runtime.trace
def python_child():
    return "payload remains local"

runtime.start()
if os.environ.get("TRACE_CARRIER"):
    carrier = {"x-trace-correlation": os.environ["TRACE_CARRIER"]}
    asyncio.run(runtime.run_with_propagated_context(carrier, python_child))
else:
    python_child()
runtime.stop()
`;

function nodeEvent(kind, sequence, invocationId, parentInvocationId = null) {
  return {
    schemaVersion: 1,
    eventId: `node-event-${kind}`,
    executionId: "cross-execution",
    invocationId,
    parentInvocationId,
    sequence: String(sequence),
    emittedAt: "2026-01-01T00:00:00.000Z",
    event: kind === "enter" ? "enter" : "exit",
    function: "node_parent",
    subsystem: "node",
    language: "javascript",
    runtime: "node",
    source: { projectPath: "src/node-parent.mjs", line: 1, column: 1, revision: null, buildId: null, sourceIndexId: null },
  };
}

test("Node and Python correlation reconstructs one tree and isolates missing context", async () => {
  const directory = await mkdtemp(join("/tmp", "trace-cross-runtime-"));
  const project = join(directory, "project");
  const storeDirectory = join(directory, "store");
  const script = join(project, "child.py");
  const store = new TraceStore({ directory: storeDirectory, maxFileBytes: 1024 * 1024, maxFiles: 4 });
  await (await import("node:fs/promises")).mkdir(project, { recursive: true });
  await writeFile(script, childScript, "utf8");
  try {
    const parent = nodeEvent("enter", 1, "node-parent");
    store.append(parent);
    await store.flush();
    const carrier = injectCorrelation({}, { executionId: parent.executionId, invocationId: parent.invocationId });
    await execFile("python3", [script], {
      env: { ...process.env, TRACE_PYTHON: join(root, "python"), TRACE_PROJECT: project, TRACE_STORE: storeDirectory, TRACE_SEQUENCE: "1", TRACE_CARRIER: carrier[CORRELATION_HEADER] },
    });
    store.append(nodeEvent("exit", 4, "node-parent"));
    await store.flush();
    await execFile("python3", [script], {
      env: { ...process.env, TRACE_PYTHON: join(root, "python"), TRACE_PROJECT: project, TRACE_STORE: storeDirectory, TRACE_SEQUENCE: "4" },
    });
    await store.flush();

    const records = [];
    for (const file of (await (await import("node:fs/promises")).readdir(storeDirectory)).filter((name) => name.endsWith(".jsonl")).sort()) {
      records.push(...(await readFile(join(storeDirectory, file), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse));
    }
    const attached = records.find((event) => event.function === "python_child" && event.executionId === "cross-execution");
    const orphan = records.find((event) => event.function === "python_child" && event.executionId !== "cross-execution");
    assert.equal(attached.parentInvocationId, "node-parent");
    assert.notEqual(orphan.parentInvocationId, "node-parent");
    assert.notEqual(orphan.executionId, attached.executionId);

    const { stdout } = await execFile(process.execPath, [join(root, "bin/trace.mjs"), "past", "node_parent", "--store", storeDirectory], { cwd: root });
    const query = JSON.parse(stdout);
    assert.equal(query.targetReached, true);
    assert.equal(query.root.function, "node_parent");
    assert.equal(query.root.children.some((child) => child.function === "python_child"), true);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
