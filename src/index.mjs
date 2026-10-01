import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { createOwnership } from "./ownership.mjs";
import { createSubsystemClassifier } from "./subsystems.mjs";
import { transformSource } from "./transform.mjs";

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stable(value)).digest("hex").slice(0, 24);
}

function baseName(identity) {
  return identity.split("@")[0].split(".").at(-1).replace(/^get |^set /u, "");
}

function isEntry(file, functionIdentity) {
  if (file.entryPoints === true) return true;
  if (!Array.isArray(file.entryPoints)) return false;
  return file.entryPoints.some((entry) => entry === functionIdentity || entry === baseName(functionIdentity) || functionIdentity.startsWith(`${entry}@`));
}

export class SourceIndexError extends Error {
  constructor(fileName, cause) {
    super(`source index generation failed for ${fileName}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "SourceIndexError";
    this.fileName = fileName;
  }
}

export function buildSourceIndex(files, {
  ownership = createOwnership(),
  classifier = createSubsystemClassifier(),
  revision = null,
  buildId = null,
  sourceIndexId = null,
} = {}) {
  if (!Array.isArray(files)) throw new TypeError("files must be an array");
  const symbols = [];
  for (const file of files) {
    const classification = ownership.classify(file.projectPath ?? file.fileName);
    if (!classification.owned) continue;
    if (typeof file.source !== "string") throw new TypeError(`source is required for ${file.projectPath ?? file.fileName}`);
    try {
      const transformed = transformSource(file.source, {
        projectPath: classification.path,
        revision: file.revision ?? revision,
        buildId: file.buildId ?? buildId,
        sourceIndexId: file.sourceIndexId ?? sourceIndexId,
        runtime: file.runtime ?? "node",
      });
      for (const functionInfo of transformed.functions) {
        symbols.push({
          identity: functionInfo.name,
          functionName: functionInfo.name,
          projectPath: classification.path,
          line: functionInfo.line,
          column: functionInfo.column,
          language: file.language ?? "javascript",
          runtime: file.runtime ?? "node",
          layer: file.layer ?? null,
          packageName: file.packageName ?? "",
          entryPoint: isEntry(file, functionInfo.name),
          revision: file.revision ?? revision,
          buildId: file.buildId ?? buildId,
          sourceIndexId: file.sourceIndexId ?? sourceIndexId,
        });
      }
    } catch (error) {
      throw new SourceIndexError(file.projectPath ?? file.fileName, error);
    }
  }

  const classified = classifier.classifyAll(symbols);
  const assignmentByIdentity = new Map(classified.assignments.map((assignment) => [assignment.identity, assignment]));
  const entries = symbols.map((symbol) => {
    const assignment = assignmentByIdentity.get(symbol.identity);
    return {
      identity: symbol.identity,
      source: { projectPath: symbol.projectPath, line: symbol.line, column: symbol.column },
      subsystem: assignment?.subsystem ?? "unclassified",
      language: symbol.language,
      runtime: symbol.runtime,
      layer: symbol.layer,
      revision: symbol.revision,
      buildId: symbol.buildId,
      sourceIndexId: symbol.sourceIndexId,
      classification: {
        classifierId: classified.classifierId,
        version: classified.version,
        method: assignment?.reason ?? "unclassified",
        candidates: assignment?.candidates ?? [],
      },
      entryPoint: symbol.entryPoint,
    };
  }).sort((left, right) => left.identity.localeCompare(right.identity));
  const resolvedSourceIndexId = sourceIndexId ?? digest({ classifierId: classified.classifierId, entries: entries.map(({ identity, source, revision, buildId }) => ({ identity, source, revision, buildId })) });
  for (const entry of entries) if (entry.sourceIndexId === null) entry.sourceIndexId = resolvedSourceIndexId;
  return {
    schemaVersion: 1,
    sourceIndexId: resolvedSourceIndexId,
    revision,
    buildId,
    classifierId: classified.classifierId,
    classifierVersion: classified.version,
    functions: entries,
    subsystems: classified.subsystems,
  };
}

export function lookupFunction(index, target) {
  if (!index || !Array.isArray(index.functions)) throw new TypeError("valid source index is required");
  const exact = index.functions.filter((entry) => entry.identity === target || entry.identity === target.identity);
  if (exact.length === 1) return { status: "found", function: exact[0] };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact };
  const byName = index.functions.filter((entry) => baseName(entry.identity) === target || entry.identity.startsWith(`${target}@`) || entry.identity.includes(`.${target}@`));
  if (byName.length === 1) return { status: "found", function: byName[0] };
  if (byName.length > 1) return { status: "ambiguous", candidates: byName };
  return { status: "not-found", candidates: [] };
}

export function sourceDrift(index, recorded) {
  const current = {
    sourceIndexId: index?.sourceIndexId ?? null,
    revision: index?.revision ?? null,
    buildId: index?.buildId ?? null,
  };
  const historical = {
    sourceIndexId: recorded?.sourceIndexId ?? null,
    revision: recorded?.revision ?? null,
    buildId: recorded?.buildId ?? null,
  };
  const compared = Object.keys(current).filter((key) => current[key] !== null && historical[key] !== null);
  return {
    status: compared.length === 0 ? "unknown" : compared.some((key) => current[key] !== historical[key]) ? "drifted" : "same",
    current,
    recorded: historical,
  };
}

export async function saveSourceIndex(index, fileName) {
  await writeFile(fileName, `${JSON.stringify(index)}\n`, "utf8");
  return fileName;
}

export async function loadSourceIndex(fileName) {
  return JSON.parse(await readFile(fileName, "utf8"));
}
