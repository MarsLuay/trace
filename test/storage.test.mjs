import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HotBuffer, TraceStore, readPersistedEvents, removeStoreDirectory, sourceDrift } from "../src/storage.mjs";

const fixture = (name) => import(`./fixtures/${name}`, { with: { type: "json" } });

async function temporaryStore(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "trace-store-"));
  return { directory, store: new TraceStore({ directory, ...options }) };
}

test("hot storage is bounded and retains the newest events", async () => {
  const events = (await fixture("javascript-node.json")).default;
  const hot = new HotBuffer(2);
  events.forEach((event) => hot.append(event));
  assert.equal(hot.size, 2);
  assert.deepEqual(hot.events().map((event) => event.eventId), ["js-e3", "js-e4"]);
});

test("events survive restart and valid records before a partial final write remain readable", async () => {
  const events = (await fixture("javascript-node.json")).default;
  const { directory, store } = await temporaryStore({ maxFileBytes: 4096, maxFiles: 4 });
  try {
    await Promise.all(events.map((event) => store.append(event)));
    await store.flush();
    const persistedFile = (await readdir(directory)).find((name) => name.endsWith(".jsonl"));
    assert.ok(persistedFile);
    await writeFile(join(directory, "trace-999999999999.jsonl"), `${JSON.stringify(events[0])}\n{"schemaVersion":1`, "utf8");

    const recovered = await readPersistedEvents(directory);
    assert.equal(recovered.events.length, events.length + 1);
    assert.equal(recovered.skippedRecords, 1);

    const restarted = new TraceStore({ directory, maxFileBytes: 4096, maxFiles: 4 });
    const extra = { ...structuredClone(events[0]), eventId: "restart-event", sequence: "5" };
    assert.equal(await restarted.append(extra), true);
    await restarted.flush();
    const afterRestart = await readPersistedEvents(directory);
    assert.ok(afterRestart.events.some((event) => event.eventId === "restart-event"));
    assert.ok((await stat(join(directory, persistedFile))).size > 0);
  } finally {
    await removeStoreDirectory(directory);
  }
});

test("rotation and pruning keep disk retention bounded", async () => {
  const events = (await fixture("javascript-node.json")).default;
  const { directory, store } = await temporaryStore({ maxFileBytes: 1200, maxFiles: 2 });
  try {
    for (let index = 0; index < 12; index += 1) {
      const event = { ...structuredClone(events[index % events.length]), eventId: `retained-${index}` };
      await store.append(event);
    }
    await store.flush();
    const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
    assert.ok(files.length <= 2);
    const bytes = await Promise.all(files.map(async (name) => (await stat(join(directory, name))).size));
    assert.ok(bytes.every((size) => size <= 1200));
    assert.ok(bytes.reduce((sum, size) => sum + size, 0) <= 2400);
  } finally {
    await removeStoreDirectory(directory);
  }
});

test("retention pruning runs only when a new file is rotated into", async () => {
  const event = (await fixture("javascript-node.json")).default[0];
  const { directory } = await temporaryStore();
  const line = JSON.stringify(event) + "\n";
  const lineBytes = Buffer.byteLength(line);
  for (let index = 0; index < 3; index += 1) {
    await writeFile(join(directory, `trace-${String(index).padStart(12, "0")}.jsonl`), line, "utf8");
  }
  const store = new TraceStore({ directory, maxFileBytes: lineBytes * 3, maxFiles: 1 });
  try {
    await store.append(event);
    await store.append(event);
    assert.equal((await readdir(directory)).filter((name) => name.endsWith(".jsonl")).length, 3);
    await store.append(event);
    assert.equal((await readdir(directory)).filter((name) => name.endsWith(".jsonl")).length, 1);
  } finally {
    await removeStoreDirectory(directory);
  }
});

test("appendBatch persists a batch and backpressure is checked before validation", async () => {
  const events = (await fixture("javascript-node.json")).default;
  const { directory } = await temporaryStore();
  const store = new TraceStore({ directory, maxPendingEvents: 16, maxBatchEvents: 16, batchDelayMs: 60_000 });
  const errors = [];
  const pressured = new TraceStore({
    directory: join(directory, "pressure"),
    maxPendingEvents: 1,
    maxBatchEvents: 16,
    batchDelayMs: 60_000,
    onError: (error) => errors.push(error),
  });
  try {
    const batch = store.appendBatch(events);
    await store.flush();
    assert.equal(await batch, events.length);
    const pending = pressured.append(events[0]);
    assert.equal(pressured.canAccept(), false);
    assert.equal(pressured.canAccept(2), false);
    assert.equal(await pressured.append({ invalid: true }), false);
    assert.equal(errors.length, 0);
    await pressured.flush();
    assert.equal(await pending, true);
    assert.equal(pressured.canAccept(), true);
    const persisted = await readPersistedEvents(directory);
    assert.deepEqual(persisted.events.map((event) => event.eventId), events.map((event) => event.eventId));
  } finally {
    await store.close();
    await pressured.close();
    await removeStoreDirectory(directory);
  }
});

test("storage failures fail open without changing consumer behavior", async () => {
  const events = (await fixture("javascript-node.json")).default;
  const parent = await mkdtemp(join(tmpdir(), "trace-store-failure-"));
  const blockingPath = join(parent, "not-a-directory");
  await writeFile(blockingPath, "occupied", "utf8");
  const errors = [];
  const store = new TraceStore({ directory: join(blockingPath, "child"), onError: (error) => errors.push(error) });
  try {
    assert.equal(await store.append(events[0]), false);
    assert.equal(store.hotBuffer.size, 1);
    assert.ok(errors.length >= 1);

    const original = new Error("consumer failure");
    let observed;
    try {
      await store.append(events[1]);
      throw original;
    } catch (error) {
      observed = error;
    }
    assert.equal(observed, original);
  } finally {
    await removeStoreDirectory(parent);
  }
});

test("recorded source identity exposes drift without rewriting history", async () => {
  const event = (await fixture("javascript-node.json")).default[0];
  assert.equal(sourceDrift(event, event.source).status, "same");
  assert.equal(sourceDrift(event, { ...event.source, revision: "git:new" }).status, "drifted");
  assert.equal(sourceDrift(event, null).status, "unknown");
  assert.equal(event.source.revision, "git:abc123");
});
