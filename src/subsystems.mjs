import { createHash } from "node:crypto";

const DEFAULT_STOP_WORDS = [
  "src", "lib", "server", "ui", "electron", "node", "shared", "core", "utils", "util", "manager", "service",
  "client", "backend", "frontend", "worker", "queue", "handler", "runtime", "index", "module", "common", "main",
  "default", "base", "abstract", "controller", "factory", "helper", "helpers", "types", "type", "get", "set", "run", "open", "send", "parse", "toggle", "js", "ts", "jsx", "tsx",
];

function normalizePath(value) {
  return typeof value === "string" ? value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+/gu, "/") : "";
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function ruleRegex(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (pattern[index] === "*") expression += "[^/]*";
    else expression += pattern[index].replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${expression}$`, "iu");
}

function matches(path, pattern) {
  const normalized = normalizePath(pattern);
  if (!/[?*]/u.test(normalized)) return path === normalized || path.startsWith(`${normalized}/`);
  const candidates = normalized.startsWith("**/") ? [normalized, normalized.slice(3)] : [normalized];
  return candidates.some((candidate) => ruleRegex(candidate).test(path));
}

function tokens(value, stopWords) {
  const expanded = String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/[^A-Za-z0-9]+/gu, " ")
    .toLocaleLowerCase("en-US");
  return expanded.split(/\s+/u).filter((token) => token.length >= 3 && !stopWords.has(token));
}

function functionKey(symbol) {
  return symbol.identity ?? symbol.functionName ?? symbol.function ?? `${symbol.projectPath ?? ""}:${symbol.line ?? ""}:${symbol.column ?? ""}`;
}

function normalizeSymbol(symbol) {
  return {
    ...symbol,
    projectPath: normalizePath(symbol.projectPath ?? symbol.source?.projectPath),
    functionName: symbol.functionName ?? symbol.function ?? symbol.name ?? "",
    moduleName: symbol.moduleName ?? "",
    className: symbol.className ?? "",
    packageName: symbol.packageName ?? "",
    runtime: symbol.runtime ?? null,
    layer: symbol.layer ?? null,
    identity: functionKey(symbol),
  };
}

function chooseExplicit(candidates) {
  const unique = [...new Set(candidates.filter(Boolean))].sort();
  return unique.length === 1 ? { subsystem: unique[0], candidates: unique } : unique.length > 1 ? { subsystem: "unclassified", candidates: unique } : null;
}

export function createSubsystemClassifier({
  version = "subsystem-v1",
  stopWords = [],
  evidenceThreshold = 2,
  functionRules = {},
  fileRules = {},
  pathRules = [],
  packageRules = {},
  fallback = "unclassified",
} = {}) {
  if (!Number.isInteger(evidenceThreshold) || evidenceThreshold < 1) throw new TypeError("evidenceThreshold must be a positive integer");
  const stops = new Set([...DEFAULT_STOP_WORDS, ...stopWords].map((word) => String(word).toLocaleLowerCase("en-US")));
  const exactFunctions = new Map(Object.entries(functionRules));
  const exactFiles = new Map(Object.entries(fileRules).map(([path, subsystem]) => [normalizePath(path), subsystem]));
  const pathEntries = pathRules.map((rule, index) => ({ ...rule, pattern: normalizePath(rule.pattern), index, specificity: rule.specificity ?? rule.pattern.replace(/[*?]/gu, "").length }));
  const packageEntries = new Map(Object.entries(packageRules));
  const effectiveConfiguration = { version, evidenceThreshold, stopWords: [...stops].sort(), functionRules, fileRules, pathRules, packageRules, fallback };
  const classifierId = createHash("sha256").update(stable(effectiveConfiguration)).digest("hex").slice(0, 16);

  function explicitClassification(symbol) {
    const key = functionKey(symbol);
    const functionResult = chooseExplicit([exactFunctions.get(key), exactFunctions.get(symbol.functionName)]);
    if (functionResult) return { ...functionResult, reason: "explicit-function" };
    const fileResult = chooseExplicit([exactFiles.get(symbol.projectPath)]);
    if (fileResult) return { ...fileResult, reason: "exact-file" };
    const matchingPaths = pathEntries.filter((rule) => matches(symbol.projectPath, rule.pattern));
    if (matchingPaths.length > 0) {
      const strongest = Math.max(...matchingPaths.map((rule) => rule.specificity));
      const pathResult = chooseExplicit(matchingPaths.filter((rule) => rule.specificity === strongest).map((rule) => rule.subsystem));
      if (pathResult) return { ...pathResult, reason: "path-rule" };
    }
    const packageResult = chooseExplicit([packageEntries.get(symbol.packageName)]);
    if (packageResult) return { ...packageResult, reason: "package-rule" };
    return null;
  }

  function localTokens(symbol) {
    const values = [
      [symbol.projectPath, 1],
      [symbol.moduleName, 2],
      [symbol.className, 2],
      [symbol.functionName, 3],
    ];
    const result = new Map();
    for (const [value, weight] of values) {
      for (const valueToken of tokens(value, stops)) result.set(valueToken, (result.get(valueToken) ?? 0) + weight);
    }
    return result;
  }

  function infer(symbol, evidence) {
    const local = localTokens(symbol);
    const viable = [...local.entries()]
      .map(([name, localScore]) => ({ name, score: localScore * (evidence.get(name) ?? 0) }))
      .filter(({ name, score }) => (evidence.get(name) ?? 0) >= evidenceThreshold && score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
    if (viable.length === 0) return { subsystem: fallback, candidates: [], reason: "insufficient-evidence" };
    const strongest = viable.filter(({ score }) => score === viable[0].score).map(({ name }) => name).sort();
    if (strongest.length > 1) return { subsystem: fallback, candidates: strongest, reason: "ambiguous-evidence" };
    return { subsystem: strongest[0], candidates: strongest, reason: "feature-inference" };
  }

  function classifySymbol(symbol, corpus = [symbol]) {
    const normalized = normalizeSymbol(symbol);
    const normalizedCorpus = corpus.map(normalizeSymbol);
    const evidence = new Map();
    for (const candidate of normalizedCorpus) {
      for (const [name, score] of localTokens(candidate)) evidence.set(name, (evidence.get(name) ?? 0) + score);
    }
    return {
      identity: functionKey(normalized),
      projectPath: normalized.projectPath,
      functionName: normalized.functionName,
      runtime: normalized.runtime,
      layer: normalized.layer,
      ... (explicitClassification(normalized) ?? infer(normalized, evidence)),
    };
  }

  function classifyAll(symbols) {
    const normalized = symbols.map(normalizeSymbol);
    const evidence = new Map();
    for (const symbol of normalized) {
      for (const [name, score] of localTokens(symbol)) evidence.set(name, (evidence.get(name) ?? 0) + score);
    }
    const assignments = normalized.map((symbol) => ({ ...classifySymbol(symbol, normalized), ...infer(symbol, evidence), ...explicitClassification(symbol) }));
    const sorted = assignments.sort((left, right) => left.identity.localeCompare(right.identity));
    const subsystems = {};
    for (const assignment of sorted) {
      if (assignment.subsystem === fallback) continue;
      if (!subsystems[assignment.subsystem]) subsystems[assignment.subsystem] = { name: assignment.subsystem, members: [], entryPoints: [] };
      subsystems[assignment.subsystem].members.push(assignment.identity);
      const symbol = normalized.find((candidate) => functionKey(candidate) === assignment.identity);
      if (symbol?.entryPoint === true || symbol?.entryPoints) {
        const entries = symbol.entryPoints === true ? [assignment.identity] : Array.isArray(symbol.entryPoints) ? symbol.entryPoints : [assignment.identity];
        subsystems[assignment.subsystem].entryPoints.push(...entries);
      }
    }
    for (const subsystem of Object.values(subsystems)) {
      subsystem.members.sort();
      subsystem.entryPoints = [...new Set(subsystem.entryPoints)].sort();
    }
    return { classifierId, version, assignments: sorted, subsystems, count: Object.keys(subsystems).length };
  }

  function entryCandidates(result, subsystem, selectedEntry = null) {
    const entries = result.subsystems[subsystem]?.entryPoints ?? [];
    if (selectedEntry !== null && entries.includes(selectedEntry)) return { status: "selected", selected: selectedEntry, candidates: entries };
    if (entries.length === 1) return { status: "selected", selected: entries[0], candidates: entries };
    if (entries.length > 1) return { status: "candidates", candidates: entries };
    return { status: "none", candidates: [] };
  }

  return Object.freeze({ classifierId, version, configuration: effectiveConfiguration, classifySymbol, classifyAll, entryCandidates });
}
