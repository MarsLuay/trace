import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { createOwnership } from "./ownership.mjs";
import { createSubsystemClassifier } from "./subsystems.mjs";
import { transformSource } from "./transform.mjs";

const SOURCE_EXTENSIONS = /\.(?:c?m?js|jsx|ts|tsx)$/iu;

export class TraceBuildError extends Error {
  constructor(adapter, fileName, cause) {
    super(`${adapter} instrumentation failed for ${fileName}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "TraceBuildError";
    this.adapter = adapter;
    this.fileName = fileName;
  }
}

function stripQuery(fileName) {
  return fileName.split("?", 1)[0];
}

function makeBuildOptions(options, fileName, adapter) {
  const ownership = options.ownership ?? createOwnership(options.ownershipConfig);
  const classification = ownership.classify(stripQuery(fileName));
  if (!classification.owned) return { ownership, classification, skipped: true };
  const classifier = options.subsystems ?? createSubsystemClassifier(options.subsystemConfig);
  const projectPath = classification.path;
  try {
    return {
      ownership,
      classification,
      projectPath,
      transform: transformSource,
      classifier,
      adapter,
      options,
    };
  } catch (error) {
    throw new TraceBuildError(adapter, fileName, error);
  }
}

export function transformBuildSource(source, { fileName, adapter = "build", ...options } = {}) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  if (typeof fileName !== "string" || fileName.length === 0) throw new TypeError("fileName is required");
  const build = makeBuildOptions(options, fileName, adapter);
  if (build.skipped) return { code: source, map: null, skipped: true, ownership: build.classification };
  try {
    const result = transformSource(source, {
      projectPath: build.projectPath,
      revision: options.revision,
      buildId: options.buildId,
      sourceIndexId: options.sourceIndexId,
      runtime: options.runtime ?? adapter,
      hooksIdentifier: options.hooksIdentifier,
      subsystem: options.subsystem ?? "unclassified",
      subsystemForFunction: ({ functionName, source: sourceIdentity }) => build.classifier.classifySymbol({
        projectPath: sourceIdentity.projectPath,
        functionName,
        runtime: options.runtime ?? adapter,
      }).subsystem,
    });
    return { ...result, skipped: false, ownership: build.classification, adapter };
  } catch (error) {
    throw new TraceBuildError(adapter, fileName, error);
  }
}

export function createViteTracePlugin(options = {}) {
  return {
    name: options.name ?? "trace-instrumentation",
    enforce: "post",
    transform(source, id) {
      const fileName = stripQuery(id);
      if (!SOURCE_EXTENSIONS.test(fileName) || fileName.endsWith(".d.ts")) return null;
      const result = transformBuildSource(source, { ...options, fileName, adapter: "vite" });
      if (result.skipped) return null;
      const code = typeof options.hooksPrelude === "string" && options.hooksPrelude.length > 0
        ? `${options.hooksPrelude}\n${result.code}`
        : result.code;
      return { code, map: result.map };
    },
  };
}

export function transformTypeScriptSource(source, options = {}) {
  return transformBuildSource(source, { ...options, adapter: "typescript" });
}

export function createTypeScriptTransformer({ typescript = null, ...options } = {}) {
  return (context) => (sourceFile) => {
    const fileName = sourceFile.fileName ?? sourceFile.path;
    const source = typeof sourceFile.getFullText === "function" ? sourceFile.getFullText() : sourceFile.text;
    const result = transformTypeScriptSource(source, { ...options, fileName });
    if (result.skipped || !typescript?.createSourceFile) return result.skipped ? sourceFile : { ...sourceFile, text: result.code, traceMap: result.map };
    return typescript.createSourceFile(fileName, result.code, sourceFile.languageVersion, true, sourceFile.scriptKind);
  };
}

export function transformBabelSource(source, options = {}) {
  return transformBuildSource(source, { ...options, adapter: "babel" });
}

export function createBabelTracePlugin(options = {}) {
  return function traceBabelPlugin(api = {}) {
    if (typeof api.assertVersion === "function" && options.babelVersion) api.assertVersion(options.babelVersion);
    return {
      name: options.name ?? "trace-babel-instrumentation",
      visitor: {
        Program(path, state) {
          const fileName = state?.filename ?? state?.file?.opts?.filename;
          const source = state?.file?.code;
          if (typeof fileName !== "string" || typeof source !== "string") return;
          const result = transformBabelSource(source, { ...options, fileName });
          if (state.file.metadata) state.file.metadata.trace = result;
          if (!result.skipped && typeof options.replaceProgram === "function") options.replaceProgram(path, result.code, state);
        },
      },
    };
  };
}

export function transformSwcSource(source, options = {}) {
  return transformBuildSource(source, { ...options, adapter: "swc" });
}

export function createSwcTracePlugin(options = {}) {
  return {
    name: options.name ?? "trace-swc-instrumentation",
    transform(source, fileName) {
      return transformSwcSource(source, { ...options, fileName });
    },
  };
}

function loaderFor(fileName) {
  const extension = extname(fileName).toLowerCase();
  return extension === ".ts" || extension === ".tsx" ? "ts" : extension === ".jsx" ? "jsx" : "js";
}

export function createEsbuildTracePlugin({ readFile: read = readFile, filter = SOURCE_EXTENSIONS, ...options } = {}) {
  return {
    name: options.name ?? "trace-esbuild-instrumentation",
    setup(build) {
      build.onLoad({ filter }, async (args) => {
        const source = await read(args.path, "utf8");
        const result = transformBuildSource(source, { ...options, fileName: args.path, adapter: "esbuild" });
        if (result.skipped) return { contents: source, loader: loaderFor(args.path) };
        return { contents: result.code, loader: loaderFor(args.path), sourcefile: args.path };
      });
    },
  };
}
