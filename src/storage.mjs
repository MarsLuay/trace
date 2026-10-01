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
  #maxFileBytes;
  #maxFiles;
  #clock;
  #onError;
  #hot;
  #pendingEvents = 0;
  #nextFile = 0;
  #currentFile = null;
  #currentBytes = 0;
  #queue = Promise.resolve();

  constructor({
    directory,
    maxMemoryEvents = 1000,
    maxPendingEvents = maxMemoryEvents,
    maxFileBytes = 1024 * 1024,
    maxFiles = 8,
    onError = () => {},
  } = {}) {
    if (typeof directory !== "string" || directory.length === 0) throw storageError("directory is required");
    if (!Number.isInteger(maxPendingEvents) || maxPendingEvents < 1) throw storageError("maxPendingEvents must be a positive integer");
    if (!Number.isInteger(maxFileBytes) || maxFileBytes < 256) throw storageError("maxFileBytes must be at least 256");
    if (!Number.isInteger(maxFiles) || maxFiles < 1) throw storageError("maxFiles must be a positive integer");
    this.#directory = directory;
    this.#maxPendingEvents = maxPendingEvents;
    this.#maxFileBytes = maxFileBytes;
    this.#maxFiles = maxFiles;
    this.#onError = typeof onError === "function" ? onError : () => {};
    this.#hot = new HotBuffer(maxMemoryEvents);
  }

  get hotBuffer() {
    return this.#hot;
  }

  /** Add to memory synchronously; the bounded disk queue drops excess events and never rejects. */
  append(event) {
    try {
      validateEvent(event);
      this.#hot.append(event);
    } catch (error) {
      this.#report(error);
      return Promise.resolve(false);
    }

    if (this.#pendingEvents >= this.#maxPendingEvents) return Promise.resolve(false);
    this.#pendingEvents += 1;
    this.#queue = this.#queue
      .then(() => this.#persist(event))
      .catch((error) => {
        this.#report(error);
        return false;
      })
      .finally(() => {
        this.#pendingEvents -= 1;
      });
    return this.#queue;
  }

  async flush() {
    await this.#queue;
  }

  async close() {
    await this.flush();
  }

  async #persist(event) {
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > this.#maxFileBytes) {
      this.#report(storageError("event exceeds the configured persistence bound"));
      return false;
    }
    await mkdir(this.#directory, { recursive: true });
    if (this.#currentFile === null) {
      const existing = (await readdir(this.#directory)).filter(isTraceFile).sort(compareFiles);
      if (existing.length > 0) {
        this.#currentFile = join(this.#directory, existing[existing.length - 1]);
        this.#currentBytes = (await stat(this.#currentFile)).size;
        const lastContent = await readFile(this.#currentFile, "utf8");
        if (lastContent.length > 0 && !lastContent.endsWith("\n")) {
          // Never append to a crash-truncated line: preserve it and rotate first.
          this.#currentFile = null;
          this.#currentBytes = 0;
        }
        const lastNumber = Number(existing[existing.length - 1].slice(FILE_PREFIX.length, -FILE_SUFFIX.length));
        this.#nextFile = Number.isSafeInteger(lastNumber) ? lastNumber + 1 : existing.length;
      }
    }
    if (this.#currentFile === null || this.#currentBytes + bytes > this.#maxFileBytes) {
      this.#currentFile = join(this.#directory, fileName(this.#nextFile++));
      this.#currentBytes = 0;
    }
    await appendFile(this.#currentFile, line, "utf8");
    this.#currentBytes += bytes;
    await this.#prune();
    return true;
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
