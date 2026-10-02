import { appendFile, mkdir, readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { TraceContractError, validateEvent } from "./contract.mjs";

const FILE_PREFIX = "trace-";
const FILE_SUFFIX = ".jsonl";
const SOURCE_FIELDS = ["revision", "buildId", "sourceIndexId"];

function storageError(message) {
  return new TraceContractError([{ path: "$", message }]);
}

function clone(value) {
  return structuredClone(value);
}

function fileName(counter) {
  return `${FILE_PREFIX}${String(counter).padStart(12, "0")}${FILE_SUFFIX}`;
}

function isTraceFile(name) {
  return name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX);
}

function compareFiles(left, right) {
  return left.localeCompare(right, "en", { numeric: true });
}

export class HotBuffer {
  #maxEvents;
  #events = [];

  constructor(maxEvents = 1000) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw storageError("maxEvents must be a positive integer");
    this.#maxEvents = maxEvents;
  }

  append(event) {
    this.#events.push(clone(event));
    if (this.#events.length > this.#maxEvents) this.#events.splice(0, this.#events.length - this.#maxEvents);
  }

  events() {
    return clone(this.#events);
  }

  get size() {
    return this.#events.length;
  }
}

export class TraceStore {
  #directory;
  #maxPendingEvents;
  #maxBatchEvents;
  #batchDelayMs;
  #maxFileBytes;
  #maxFiles;
  #onError;
  #hot;
  #pendingEvents = 0;
  #pending = [];
  #flushTimer = null;
  #flushTask = null;
  #closed = false;
  #initialized = false;
  #pruneAfterWrite = false;
  #nextFile = 0;
  #currentFile = null;
  #currentBytes = 0;

  constructor({
    directory,
    maxMemoryEvents = 1000,
    maxPendingEvents = maxMemoryEvents,
    maxBatchEvents = 64,
    batchDelayMs = 10,
    maxFileBytes = 1024 * 1024,
    maxFiles = 8,
    onError = () => {},
  } = {}) {
    if (typeof directory !== "string" || directory.length === 0) throw storageError("directory is required");
    if (!Number.isInteger(maxPendingEvents) || maxPendingEvents < 1) throw storageError("maxPendingEvents must be a positive integer");
    if (!Number.isInteger(maxBatchEvents) || maxBatchEvents < 1) throw storageError("maxBatchEvents must be a positive integer");
    if (!Number.isFinite(batchDelayMs) || batchDelayMs < 0) throw storageError("batchDelayMs must be a non-negative number");
    if (!Number.isInteger(maxFileBytes) || maxFileBytes < 256) throw storageError("maxFileBytes must be at least 256");
    if (!Number.isInteger(maxFiles) || maxFiles < 1) throw storageError("maxFiles must be a positive integer");
    this.#directory = directory;
    this.#maxPendingEvents = maxPendingEvents;
    this.#maxBatchEvents = maxBatchEvents;
    this.#batchDelayMs = batchDelayMs;
    this.#maxFileBytes = maxFileBytes;
    this.#maxFiles = maxFiles;
    this.#onError = typeof onError === "function" ? onError : () => {};
    this.#hot = new HotBuffer(maxMemoryEvents);
  }

  get hotBuffer() {
    return this.#hot;
  }

  /** Synchronous capacity check for callers that can avoid creating event data. */
  canAccept(count = 1) {
    return Number.isInteger(count)
      && count > 0
      && !this.#closed
      && this.#pendingEvents + count <= this.#maxPendingEvents;
  }

  /** Queue one event and resolve after its batch reaches disk. */
  append(event) {
    return this.appendBatch([event]).then((accepted) => accepted === 1);
  }

  /** Queue a bounded event batch and resolve with the number persisted. */
  appendBatch(events) {
    if (!Array.isArray(events)) return Promise.resolve(0);
    const items = [];
    for (const event of events) {
      if (!this.canAccept()) break;
      let snapshot;
      try {
        validateEvent(event);
        snapshot = clone(event);
        this.#hot.append(snapshot);
      } catch (error) {
        this.#report(error);
        continue;
      }
      this.#pendingEvents += 1;
      items.push({
        event: snapshot,
        settle: null,
      });
      items[items.length - 1].result = new Promise((resolve) => {
        items[items.length - 1].settle = resolve;
      });
      this.#pending.push(items[items.length - 1]);
    }
    if (items.length === 0) return Promise.resolve(0);
    this.#scheduleFlush();
    return Promise.all(items.map((item) => item.result)).then((results) => results.filter(Boolean).length);
  }

  async flush() {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    while (this.#flushTask !== null || this.#pending.length > 0) {
      if (this.#flushTask !== null) {
        await this.#flushTask;
      } else {
        await this.#startFlush();
      }
    }
  }

  async close() {
    this.#closed = true;
    await this.flush();
  }

  #scheduleFlush() {
    if (this.#flushTask !== null) return;
    if (this.#pending.length >= this.#maxBatchEvents) {
      if (this.#flushTimer !== null) {
        clearTimeout(this.#flushTimer);
        this.#flushTimer = null;
      }
      void this.#startFlush();
      return;
    }
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#startFlush();
    }, this.#batchDelayMs);
  }

  #startFlush() {
    if (this.#flushTask !== null) return this.#flushTask;
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    const batch = this.#pending.splice(0, this.#maxBatchEvents);
    if (batch.length === 0) return Promise.resolve();
    this.#flushTask = this.#persistBatch(batch)
      .then((results) => {
        for (let index = 0; index < batch.length; index += 1) {
          batch[index].settle(results[index] === true);
          this.#pendingEvents -= 1;
        }
      })
      .catch((error) => {
        this.#report(error);
        for (const item of batch) {
          item.settle(false);
          this.#pendingEvents -= 1;
        }
      })
      .finally(() => {
        this.#flushTask = null;
        if (this.#pending.length > 0) this.#scheduleFlush();
      });
    return this.#flushTask;
  }

  async #initialize() {
    if (this.#initialized) return;
    await mkdir(this.#directory, { recursive: true });
    const existing = (await readdir(this.#directory)).filter(isTraceFile).sort(compareFiles);
    this.#initialized = true;
    if (existing.length === 0) return;

    const last = existing[existing.length - 1];
    this.#currentFile = join(this.#directory, last);
    this.#currentBytes = (await stat(this.#currentFile)).size;
    const lastContent = await readFile(this.#currentFile, "utf8");
    const lastNumber = Number(last.slice(FILE_PREFIX.length, -FILE_SUFFIX.length));
    this.#nextFile = Number.isSafeInteger(lastNumber) ? lastNumber + 1 : existing.length;
    if (lastContent.length > 0 && !lastContent.endsWith("\n")) {
      // Preserve crash-truncated data and start a clean file before appending.
      this.#currentFile = null;
      this.#currentBytes = 0;
      this.#pruneAfterWrite = true;
    }
  }

  async #persistBatch(items) {
    const results = new Array(items.length).fill(false);
    await this.#initialize();
    let chunk = [];
    let chunkBytes = 0;

    const writeChunk = async () => {
      if (chunk.length === 0) return;
      const file = this.#currentFile ?? this.#newFile();
      await appendFile(file, chunk.map((entry) => entry.line).join(""), "utf8");
      this.#currentBytes += chunkBytes;
      for (const entry of chunk) results[entry.index] = true;
      chunk = [];
      chunkBytes = 0;
      if (this.#pruneAfterWrite) {
        await this.#prune();
        this.#pruneAfterWrite = false;
      }
    };

    for (let index = 0; index < items.length; index += 1) {
      const line = JSON.stringify(items[index].event) + "\n";
      const bytes = Buffer.byteLength(line);
      if (bytes > this.#maxFileBytes) {
        this.#report(storageError("event exceeds the configured persistence bound"));
        continue;
      }
      if (this.#currentFile === null) this.#newFile();
      if (this.#currentBytes + chunkBytes + bytes > this.#maxFileBytes) {
        await writeChunk();
        this.#newFile();
      }
      chunk.push({ index, line });
      chunkBytes += bytes;
    }
    await writeChunk();
    return results;
  }

  #newFile() {
    const isRotation = this.#currentFile !== null || this.#pruneAfterWrite;
    this.#currentFile = join(this.#directory, fileName(this.#nextFile++));
    this.#currentBytes = 0;
    this.#pruneAfterWrite = isRotation;
    return this.#currentFile;
  }

  async #prune() {
    const names = (await readdir(this.#directory)).filter(isTraceFile).sort(compareFiles);
    const excess = names.length - this.#maxFiles;
    for (const name of excess > 0 ? names.slice(0, excess) : []) {
      await unlink(join(this.#directory, name));
    }
  }

  #report(error) {
    try {
      this.#onError(error);
    } catch {
      // Error reporting is also fail-open.
    }
  }
}

export async function readPersistedEvents(directory) {
  let names;
  try {
    names = (await readdir(directory)).filter(isTraceFile).sort(compareFiles);
  } catch (error) {
    if (error?.code === "ENOENT") return { events: [], skippedRecords: 0 };
    throw error;
  }
  const events = [];
  let skippedRecords = 0;
  for (const name of names) {
    const content = await readFile(join(directory, name), "utf8");
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const event = JSON.parse(line);
        validateEvent(event);
        events.push(event);
      } catch {
        // A malformed or incomplete record cannot invalidate earlier complete records.
        skippedRecords += 1;
      }
    }
  }
  return { events, skippedRecords };
}

export function sourceDrift(event, currentSource) {
  validateEvent(event);
  if (currentSource === null || typeof currentSource !== "object") {
    return { status: "unknown", recorded: clone(event.source), current: null };
  }
  const compared = SOURCE_FIELDS.filter(
    (field) => event.source[field] !== null && currentSource[field] !== null && currentSource[field] !== undefined,
  );
  const drifted = compared.some((field) => event.source[field] !== currentSource[field]);
  return {
    status: compared.length === 0 ? "unknown" : drifted ? "drifted" : "same",
    recorded: clone(event.source),
    current: clone(currentSource),
  };
}

export async function removeStoreDirectory(directory) {
  await rm(directory, { recursive: true, force: true });
}
