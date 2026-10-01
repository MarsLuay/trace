import { createTraceHooks } from "./hooks.mjs";
import { lookupFunction } from "./index.mjs";
import { queryFunction, querySubsystem } from "./graph.mjs";

const SAFE_DETAIL_KEYS = new Set(["route", "operation", "child", "category", "boundary"]);

function safeDetails(details) {
  if (!details || typeof details !== "object") return {};
  return Object.fromEntries(Object.entries(details).filter(([key, value]) => SAFE_DETAIL_KEYS.has(key) && ["string", "number", "boolean"].includes(typeof value)).slice(0, 8));
}

function eventMetadata(entry) {
  return {
    function: entry.identity,
    subsystem: entry.subsystem,
    language: entry.language,
    runtime: entry.runtime,
    source: {
      ...entry.source,
      revision: entry.revision ?? null,
      buildId: entry.buildId ?? null,
      sourceIndexId: entry.sourceIndexId ?? null,
    },
  };
}

export class ProbeBoundaryError extends Error {
  constructor(boundary, cause = "unclassified external effect") {
    super(`current-code probe refused unsafe boundary ${boundary}: ${cause}`);
    this.name = "ProbeBoundaryError";
    this.boundary = boundary;
  }
}

export class EffectRegistry {
  #boundaries = new Map();
  #records = [];

  register({ name, category, simulate = () => undefined } = {}) {
    if (typeof name !== "string" || name.length === 0 || typeof category !== "string" || category.length === 0) {
      throw new TypeError("boundary name and category are required");
    }
    if (typeof simulate !== "function") throw new TypeError("simulate must be a function");
    this.#boundaries.set(name, { name, category, simulate });
    return this;
  }

  registerMany(classifications = {}) {
    for (const [name, category] of Object.entries(classifications)) this.register({ name, category });
    return this;
  }

  intercept(name, details = {}) {
    const boundary = this.#boundaries.get(name);
    if (!boundary) throw new ProbeBoundaryError(name);
    const record = { wrapper: boundary.name, effect: boundary.category, intercepted: true, details: safeDetails(details) };
    this.#records.push(record);
    return boundary.simulate(record.details);
  }

  records() {
    return structuredClone(this.#records);
  }
}

export function createCurrentProbe({ index, store = null, events = [], boundaries = null, wrapperClassifications = {} } = {}) {
  if (!index || !Array.isArray(index.functions)) throw new TypeError("source index is required");
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  const observed = events;
  const registry = boundaries ?? new EffectRegistry();
  registry.registerMany(wrapperClassifications);
  const recorder = {
    append(event) {
      observed.push(event);
      return store?.append?.(event) ?? true;
    },
  };
  const hooks = createTraceHooks({ store: recorder, idPrefix: "current" });

  function metadataFor(identity) {
    const result = lookupFunction(index, identity);
    if (result.status !== "found") throw new TypeError(`cannot instrument unresolved function ${identity}`);
    return eventMetadata(result.function);
  }

  function wrap(identity, functionValue) {
    if (typeof functionValue !== "function") throw new TypeError("functionValue must be a function");
    return hooks.wrap(functionValue, metadataFor(identity));
  }

  async function current(target, { entryFunctions = {}, input, selectedEntry = null, direct = false } = {}) {
    observed.splice(0, observed.length);
    const resolved = lookupFunction(index, target);
    if (resolved.status !== "found") return { status: resolved.status, target: target, candidates: resolved.candidates ?? [] };
    const targetEntry = resolved.function;
    const entries = index.functions
      .filter((entry) => entry.subsystem === targetEntry.subsystem && entry.entryPoint)
      .sort((left, right) => left.identity.localeCompare(right.identity));
    if (direct) {
      const directFunction = entryFunctions[targetEntry.identity];
      if (typeof directFunction !== "function") return { status: "direct-entry-required", target: targetEntry.identity, candidates: [targetEntry.identity] };
      const selected = await wrap(targetEntry.identity, directFunction)(input);
      return resultFor(targetEntry, selected, true);
    }
    const available = entries.filter((entry) => typeof entryFunctions[entry.identity] === "function");
    let selected;
    if (selectedEntry !== null) selected = available.find((entry) => entry.identity === selectedEntry);
    else if (available.length === 1) selected = available[0];
    if (!selected) {
      return {
        status: available.length > 1 ? "entry-candidates" : "entry-unavailable",
        target: targetEntry.identity,
        subsystem: targetEntry.subsystem,
        candidates: available.map((entry) => entry.identity),
      };
    }
    let output;
    let error = null;
    try {
      output = await wrap(selected.identity, entryFunctions[selected.identity])(input);
    } catch (caught) {
      error = { name: caught?.name ?? "Error" };
    }
    return resultFor(targetEntry, output, false, selected.identity, error);
  }

  function resultFor(targetEntry, output, direct, selectedEntry = null, error = null) {
    const targetReached = observed.some((event) => event.event === "enter" && event.function === targetEntry.identity);
    const flow = observed.length > 0 ? querySubsystem(observed, targetEntry.subsystem).root : null;
    return {
      status: error ? "failed" : "completed",
      target: targetEntry.identity,
      subsystem: targetEntry.subsystem,
      selectedEntry,
      direct,
      targetReached,
      stoppingPoint: observed.filter((event) => event.event === "enter").at(-1)?.function ?? null,
      error,
      intercepted: registry.records(),
      flow,
      output: output === undefined ? undefined : { observed: true },
    };
  }

  return Object.freeze({ events: observed, hooks, wrap, boundary: (name, details) => registry.intercept(name, details), boundaries: registry, current });
}
