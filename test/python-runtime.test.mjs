import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { join } from "node:path";
import test from "node:test";

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL("..", import.meta.url));

const pythonFixture = `
import asyncio
import os
import sys
from pathlib import Path
sys.path.insert(0, os.environ["TRACE_PYTHON"])
from trace_runtime import TraceRuntime

project = Path(os.environ["TRACE_PROJECT"])
runtime = TraceRuntime(directory=os.environ["TRACE_STORE"], project_root=project, subsystem="python-fixture")

def automatic_child(value):
    return value + 1

def automatic_parent():
    return automatic_child(1)

def automatic_failure():
    raise RuntimeError("private exception text")

@runtime.trace
async def async_leaf(label):
    await asyncio.sleep(0)
    return label

@runtime.trace
async def async_flow(label):
    return await async_leaf(label)

@runtime.trace
async def async_root():
    return await asyncio.gather(async_flow("a"), async_flow("b"))

runtime.start()
assert automatic_parent() == 2
try:
    automatic_failure()
except RuntimeError:
    pass
asyncio.run(async_root())
vendor = project / "vendor" / "generated.py"
vendor.parent.mkdir(parents=True, exist_ok=True)
namespace = {}
exec(compile("def vendor_only(): return 1", str(vendor), "exec"), namespace)
assert namespace["vendor_only"]() == 1
runtime.stop()
print("python-fixture-complete")
`;

test("Python runtime emits shared events, isolates async flows, and is queryable by the CLI", async () => {
  const directory = await mkdtemp(join("/tmp", "trace-python-"));
  const project = join(directory, "project");
  const store = join(directory, "store");
  const script = join(project, "fixture.py");
  await mkdir(project, { recursive: true });
  await writeFile(script, pythonFixture, "utf8");
  try {
    const { stdout } = await execFile("python3", [script], {
      env: { ...process.env, TRACE_PYTHON: join(root, "python"), TRACE_PROJECT: project, TRACE_STORE: store },
      maxBuffer: 1024 * 1024,
    });
    assert.match(stdout, /python-fixture-complete/);
    const files = await import("node:fs/promises").then(({ readdir }) => readdir(store));
    const lines = [];
    for (const file of files.filter((name) => name.endsWith(".jsonl")).sort()) {
      lines.push(...(await readFile(join(store, file), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse));
    }
    assert.ok(lines.some((event) => event.function === "automatic_parent" && event.event === "enter"));
    assert.ok(lines.some((event) => event.function === "automatic_failure" && event.event === "fail"));
    assert.equal(lines.some((event) => event.function === "vendor_only"), false);
    const flows = lines.filter((event) => event.function === "async_flow" && event.event === "enter");
    assert.equal(flows.length, 2);
    assert.equal(new Set(flows.map((event) => event.invocationId)).size, 2);
    const leaves = lines.filter((event) => event.function === "async_leaf" && event.event === "enter");
    assert.deepEqual(new Set(leaves.map((event) => event.parentInvocationId)), new Set(flows.map((event) => event.invocationId)));

    const { stdout: queryOutput } = await execFile(process.execPath, [join(root, "bin/trace.mjs"), "past", "async_leaf", "--store", store], { cwd: root });
    const query = JSON.parse(queryOutput);
    assert.equal(query.mode, "past");
    assert.equal(query.targetReached, true);
    assert.equal(query.root.language, "python");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
