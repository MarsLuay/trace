import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { join } from "node:path";
import test from "node:test";

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL("..", import.meta.url));

const rustFixture = (runtimePath, store, project) => `
use trace_macro::trace;
use trace_runtime::{TraceConfig, TraceRuntime};

#[path = "vendor/vendor.rs"]
mod vendor;

#[trace]
fn child() -> u32 { 4 }

#[trace]
fn parent() -> u32 { child() }

#[trace]
fn worker() -> u32 { child() }

fn main() {
    let mut config = TraceConfig::new("${store}", "${project}");
    config.subsystem = "rust-fixture".into();
    TraceRuntime::install(config);
    assert_eq!(parent(), 4);
    assert_eq!(std::thread::spawn(worker).join().unwrap(), 4);
    assert_eq!(vendor::vendor_only(), 7);
    TraceRuntime::clear();
}
`;

test("Rust macro/runtime emits shared events, isolates threads, excludes vendor code, and is CLI-queryable", async () => {
  const directory = await mkdtemp(join("/tmp", "trace-rust-"));
  const project = join(directory, "project");
  const macroTarget = join(directory, "macro-target");
  const runtimeTarget = join(directory, "runtime-target");
  const store = join(directory, "store");
  const main = join(project, "main.rs");
  const vendor = join(project, "vendor/vendor.rs");
  try {
    await mkdir(join(project, "vendor"), { recursive: true });
    await writeFile(main, rustFixture(join(root, "rust/trace_runtime.rs"), store, project), "utf8");
    await writeFile(vendor, `use trace_macro::trace;\n#[trace]\npub fn vendor_only() -> u32 { 7 }\n`, "utf8");
    await execFile("cargo", ["build", "--quiet", "--manifest-path", join(root, "rust/trace_macro/Cargo.toml"), "--target-dir", macroTarget]);
    await execFile("cargo", ["build", "--quiet", "--manifest-path", join(root, "rust/Cargo.toml"), "--target-dir", runtimeTarget]);
    const macroLibrary = join(macroTarget, "debug/libtrace_macro.dylib");
    const runtimeLibrary = join(runtimeTarget, "debug/libtrace_runtime.rlib");
    const binary = join(directory, "fixture");
    await execFile("rustc", [
      "--edition=2021", main, "-L", join(macroTarget, "debug"), "-L", join(runtimeTarget, "debug"),
      "--extern", `trace_macro=${macroLibrary}`, "--extern", `trace_runtime=${runtimeLibrary}`, "-o", binary,
    ]);
    await execFile(binary);

    const files = (await (await import("node:fs/promises")).readdir(store)).filter((name) => name.endsWith(".jsonl")).sort();
    const events = [];
    for (const file of files) events.push(...(await readFile(join(store, file), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse));
    assert.ok(events.some((event) => event.function === "parent" && event.event === "enter"));
    assert.equal(events.some((event) => event.function === "vendor_only"), false);
    assert.equal(new Set(events.filter((event) => event.function === "child" && event.event === "enter").map((event) => event.parentInvocationId)).size, 2);
    assert.equal(events.every((event) => event.source.projectPath.startsWith("vendor/") === false), true);

    const { stdout } = await execFile(process.execPath, [join(root, "bin/trace.mjs"), "past", "child", "--store", store], { cwd: root });
    const query = JSON.parse(stdout);
    assert.equal(query.mode, "past");
    assert.equal(query.targetReached, true);
    assert.equal(query.root.language, "rust");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
