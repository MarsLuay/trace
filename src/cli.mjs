import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { queryFunction, querySubsystem } from "./graph.mjs";
import { loadSourceIndex, lookupFunction, sourceDrift as indexSourceDrift } from "./index.mjs";
import { createCurrentProbe } from "./probe.mjs";
import { runInit } from "./init.mjs";
import { readPersistedEvents, sourceDrift as eventSourceDrift } from "./storage.mjs";

export class TraceCliError extends Error {
  constructor(message) {
    super(message);
    this.name = "TraceCliError";
  }
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new TraceCliError(`${option} requires a value`);
  return value;
}

export function parseCliArgs(argv) {
  const [mode, ...afterMode] = argv;
  if (mode === "init") {
    const options = { mode, root: process.cwd(), check: false, format: "json" };
    for (let index = 0; index < afterMode.length; index += 1) {
      const token = afterMode[index];
      if (token === "--root") {
        options.root = optionValue(afterMode, index, "--root");
        index += 1;
      } else if (token === "--check") options.check = true;
      else if (token === "--format") {
        options.format = optionValue(afterMode, index, "--format");
        index += 1;
      } else throw new TraceCliError(`unknown option ${token}`);
    }
    if (!["json", "tree"].includes(options.format)) throw new TraceCliError("--format must be json or tree");
    return options;
  }
  const [target, ...rest] = afterMode;
  if (!["past", "current"].includes(mode)) throw new TraceCliError("usage: trace past|current <subsystem|function> [options]");
  if (!target || target.startsWith("--")) throw new TraceCliError("a subsystem or function target is required");

  const options = { mode, target, store: ".trace", index: null, runner: null, format: "json", direct: false, selectedEntry: null };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--store") { options.store = optionValue(rest, index, "--store"); index += 1; }
    else if (token === "--index") { options.index = optionValue(rest, index, "--index"); index += 1; }
    else if (token === "--runner") { options.runner = optionValue(rest, index, "--runner"); index += 1; }
    else if (token === "--format") { options.format = optionValue(rest, index, "--format"); index += 1; }
    else if (token === "--entry") { options.selectedEntry = optionValue(rest, index, "--entry"); index += 1; }
    else if (token === "--direct") options.direct = true;
    else throw new TraceCliError(`unknown option ${token}`);
  }
  if (!["json", "tree"].includes(options.format)) throw new TraceCliError("--format must be json or tree");
  if (mode === "current" && !options.index) throw new TraceCliError("trace current requires --index");
  if (mode === "current" && !options.runner) throw new TraceCliError("trace current requires --runner");
  if (mode === "past" && options.direct) throw new TraceCliError("--direct is only valid for trace current");
  return options;
}

function queryPast(events, target) {
  if (events.length === 0) {
    return {
      queryKind: "unknown",
      target,
      latest: false,
      root: null,
    };
  }
  const isFunction = events.some((event) => event.function === target);
  const isSubsystem = events.some((event) => event.subsystem === target);
  if (isFunction) return { queryKind: "function", ...queryFunction(events, target) };
  if (isSubsystem) return { queryKind: "subsystem", ...querySubsystem(events, target) };
  return { queryKind: "function", ...queryFunction(events, target) };
}

async function runPast(options) {
  const persisted = await readPersistedEvents(resolve(options.store));
  const result = queryPast(persisted.events, options.target);
  const root = result.root ?? null;
  let drift = { status: "unknown", recorded: root?.source ?? null, current: null };
  if (options.index && root?.source) {
    const index = await loadSourceIndex(resolve(options.index));
    drift = indexSourceDrift(index, root.source);
  } else if (root?.source) {
    drift = eventSourceDrift({
      schemaVersion: 1,
      eventId: "cli",
      executionId: "cli",
      invocationId: "cli",
      parentInvocationId: null,
      sequence: "1",
      emittedAt: "2026-01-01T00:00:00Z",
      event: "enter",
      function: root.function,
      subsystem: root.subsystem,
      language: root.language,
      runtime: root.runtime,
      source: root.source,
    }, null);
  }
  return {
    mode: "past",
    target: options.target,
    queryKind: result.queryKind,
    latest: result.latest ?? false,
    root,
    ...(result.target ? { resolvedTarget: result.target } : {}),
    ...(result.subsystem ? { subsystem: result.subsystem } : {}),
    targetReached: result.targetReached ?? null,
    sourceDrift: drift,
    persistedEventCount: persisted.events.length,
    skippedRecords: persisted.skippedRecords,
  };
}

function runnerDefinition(module) {
  const definition = module.default && typeof module.default === "object" ? module.default : module;
  const entryFunctions = definition.entryFunctions;
  if (!entryFunctions || typeof entryFunctions !== "object" || Array.isArray(entryFunctions)) {
    throw new TraceCliError("current runner must export an entryFunctions object");
  }
  for (const [identity, value] of Object.entries(entryFunctions)) {
    if (typeof value !== "function") throw new TraceCliError(`current runner entry ${identity} is not a function`);
  }
  return {
    entryFunctions,
    input: definition.input,
    wrapperClassifications: definition.wrapperClassifications ?? {},
  };
}

async function runCurrent(options) {
  const index = await loadSourceIndex(resolve(options.index));
  const resolved = lookupFunction(index, options.target);
  const runnerModule = await import(pathToFileURL(resolve(options.runner)).href);
  const runner = runnerDefinition(runnerModule);
  const probe = createCurrentProbe({ index, wrapperClassifications: runner.wrapperClassifications });
  const result = await probe.current(options.target, {
    entryFunctions: runner.entryFunctions,
    input: runner.input,
    selectedEntry: options.selectedEntry,
    direct: options.direct,
  });
  return {
    mode: "current",
    target: options.target,
    resolution: resolved.status,
    ...result,
  };
}

function treeLines(node, prefix = "") {
  if (!node) return [];
  const lines = [`${prefix}${node.function} ${node.status}`];
  node.children.forEach((child, index) => {
    const last = index === node.children.length - 1;
    lines.push(...treeLines(child, `${prefix}${last ? "└─ " : "├─ "}`));
  });
  return lines;
}

export function formatResult(result, format = "json") {
  if (format === "json") return `${JSON.stringify(result)}\n`;
  const root = result.root ?? result.flow ?? null;
  if (!root) return `${result.mode}: no observed execution\n`;
  return `${treeLines(root).join("\n")}\n`;
}

export async function runCli(argv) {
  const options = parseCliArgs(argv);
  const result = options.mode === "init" ? await runInit(options) : options.mode === "past" ? await runPast(options) : await runCurrent(options);
  return { result, format: options.format };
}
