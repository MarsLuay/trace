import { existsSync as fileExists } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const DEFAULT_EXCLUSIONS = ["node_modules/**", "dist/**", "build/**", "coverage/**", "generated/**", "vendor/**"];
const CONFIG_FILE = ".trace/config.json";

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

async function filesUnder(root, depth = 0) {
  if (depth > 4) return [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || DEFAULT_EXCLUSIONS.some((pattern) => pattern.startsWith(`${entry.name}/`))) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path, depth + 1));
    else files.push(path);
  }
  return files;
}

function relativePath(root, path) {
  return relative(root, path).replaceAll("\\", "/") || ".";
}

function packageManager(root) {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  return "npm";
}

function existsSync(path) {
  return fileExists(path);
}

function candidatesFor(files, predicate) {
  return files.filter(predicate).sort();
}

function chooseUnique(candidates, label, reasons) {
  if (candidates.length <= 1) return candidates[0] ?? null;
  reasons.push({ code: "multiple-candidates", label, candidates });
  return null;
}

function sourceRoots(root, files) {
  const directories = new Set(files.map((file) => file.split("/")[0]).filter(Boolean));
  const candidates = [...directories].filter((name) => ["src", "app", "lib", "packages"].includes(name)).sort();
  if (candidates.length === 0) return { roots: [], ambiguous: [] };
  if (candidates.length === 1) return { roots: candidates, ambiguous: [] };
  return { roots: [], ambiguous: [{ code: "multiple-source-roots", candidates }] };
}

function detectMutationWrappers(root, sourceFiles, explicit = {}) {
  const wrappers = [];
  const ambiguous = [];
  const functionPattern = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gu;
  const mutating = /(\bfs\.(?:writeFile|writeFileSync|appendFile|appendFileSync|rm|rmSync|unlink|unlinkSync|mkdir|mkdirSync)\b|\b(?:child_process|exec|spawn|execFile)\s*\.?\s*(?:exec|spawn|execFile)?\s*\(|\b(?:insert|update|delete|remove)\s*\()/u;
  const readOnly = /(\bfs\.(?:readFile|readFileSync|stat|statSync)\b|\b(?:SELECT|SELECT\s+|read)\b)/iu;
  for (const file of sourceFiles) {
    const source = file.source;
    let match;
    while ((match = functionPattern.exec(source)) !== null) {
      const bodyStart = match.index + match[0].length;
      const bodyEnd = matchingBrace(source, bodyStart - 1);
      if (bodyEnd < 0) continue;
      const body = source.slice(bodyStart, bodyEnd);
      const name = match[1];
      const path = relativePath(root, file.path);
      if (explicit[name]) {
        wrappers.push({ name, file: path, classification: explicit[name], source: "explicit" });
        continue;
      }
      const hasMutation = mutating.test(body) || /\bfetch\s*\(/u.test(body);
      if (!hasMutation) continue;
      if (readOnly.test(body) || (/\bfetch\s*\(/u.test(body) && !/method\s*:\s*["'`](?:POST|PUT|PATCH|DELETE)/iu.test(body))) {
        ambiguous.push({ name, file: path, reason: "wrapper mixes or cannot classify read and mutation behavior" });
      } else {
        wrappers.push({ name, file: path, classification: "mutating", source: "static-sink" });
      }
    }
  }
  return { wrappers: wrappers.sort((left, right) => `${left.file}:${left.name}`.localeCompare(`${right.file}:${right.name}`)), ambiguous: ambiguous.sort((left, right) => `${left.file}:${left.name}`.localeCompare(`${right.file}:${right.name}`)) };
}

function matchingBrace(source, opening) {
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function detectAdapter(configFiles, packageJson, reasons) {
  const adapters = [];
  const scripts = Object.values(packageJson?.scripts ?? {}).join(" ");
  const vite = chooseUnique(configFiles.filter((file) => /^vite\.config\./u.test(file)), "Vite configuration", reasons);
  if (vite || /\bvite\b/u.test(scripts)) adapters.push({ adapter: "vite", config: vite });
  const ts = chooseUnique(configFiles.filter((file) => /^tsconfig(?:\.[^/]+)?\.json$/u.test(file)), "TypeScript configuration", reasons);
  if (ts || /\btsc\b/u.test(scripts) || packageJson?.devDependencies?.typescript || packageJson?.dependencies?.typescript) adapters.push({ adapter: "typescript", config: ts });
  const babel = chooseUnique(configFiles.filter((file) => file === ".babelrc" || /^babel\.config\./u.test(file)), "Babel configuration", reasons);
  if (babel || /\bbabel\b/u.test(scripts)) adapters.push({ adapter: "babel", config: babel });
  const swc = chooseUnique(configFiles.filter((file) => file === ".swcrc" || /^\.swcrc$/u.test(file)), "SWC configuration", reasons);
  if (swc || /\bswc\b/u.test(scripts)) adapters.push({ adapter: "swc", config: swc });
  const esbuild = chooseUnique(configFiles.filter((file) => /^esbuild\./u.test(file)), "esbuild configuration", reasons);
  if (esbuild || /\besbuild\b/u.test(scripts)) adapters.push({ adapter: "esbuild", config: esbuild });
  return adapters;
}

function vitePatch(content) {
  const importLine = 'import { createViteTracePlugin as __traceVitePlugin } from "@marsluay/trace/adapters";';
  if (content.includes("__traceVitePlugin")) return content;
  const plugins = /plugins\s*:\s*\[([^\]]*)\]/u.exec(content);
  if (!plugins) return null;
  const replacement = `plugins: [__traceVitePlugin(),${plugins[1]}]`;
  return `${importLine}\n${content.replace(plugins[0], replacement)}`;
}

export async function inspectProject(rootDirectory = process.cwd()) {
  const root = resolve(rootDirectory);
  const packageJson = await readJson(join(root, "package.json"));
  const allFiles = (await filesUnder(root)).map((path) => relativePath(root, path));
  const source = [];
  for (const file of allFiles.filter((name) => SOURCE_EXTENSIONS.has(extname(name)))) {
    try { source.push({ path: join(root, file), source: await readFile(join(root, file), "utf8") }); } catch { /* files may disappear during inspection */ }
  }
  const reasons = [];
  const configs = allFiles.filter((file) => /(?:vite\.config\.|tsconfig.*\.json$|babel\.config\.|\.babelrc$|\.swcrc$|esbuild\.)/u.test(file));
  const roots = sourceRoots(root, allFiles);
  reasons.push(...roots.ambiguous);
  const adapters = detectAdapter(configs.map((file) => file.split("/").at(-1)), packageJson, reasons);
  const existing = await readJson(join(root, CONFIG_FILE));
  const explicit = existing?.mutationWrappers?.filter((entry) => entry.source === "explicit").reduce((map, entry) => ({ ...map, [entry.name]: entry.classification }), {}) ?? {};
  const mutation = detectMutationWrappers(root, source, explicit);
  const languages = [];
  if (source.some((file) => [".ts", ".tsx"].includes(extname(file.path)))) languages.push("typescript");
  if (source.some((file) => [".js", ".jsx", ".mjs", ".cjs"].includes(extname(file.path)))) languages.push("javascript");
  if (await exists(join(root, "pyproject.toml"))) languages.push("python");
  if ((await filesUnder(root)).some((file) => file.endsWith(".rs"))) languages.push("rust");
  if ((await filesUnder(root)).some((file) => file.endsWith(".go"))) languages.push("go");
  return {
    root,
    packageManager: packageManager(root),
    languages: languages.sort(),
    sourceRoots: roots.roots,
    adapters,
    mutationWrappers: mutation.wrappers,
    ambiguousWrappers: mutation.ambiguous,
    reasons,
    existing,
  };
}

function generatedConfig(detection) {
  return {
    schemaVersion: 1,
    managedBy: "@marsluay/trace",
    packageManager: detection.packageManager,
    languages: detection.languages,
    sourceRoots: detection.sourceRoots,
    exclusions: DEFAULT_EXCLUSIONS,
    adapters: detection.adapters,
    mutationWrappers: detection.mutationWrappers,
    ambiguousWrappers: detection.ambiguousWrappers,
  };
}

export async function runInit({ root = process.cwd(), check = false } = {}) {
  const detection = await inspectProject(root);
  const relativeConfig = CONFIG_FILE;
  if (detection.reasons.length > 0 || detection.ambiguousWrappers.length > 0) {
    return {
      mode: "init",
      status: "ambiguous",
      root: ".",
      reasons: [...detection.reasons, ...detection.ambiguousWrappers.map((entry) => ({ code: "ambiguous-wrapper", ...entry }))],
      candidates: detection.reasons.flatMap((reason) => reason.candidates ?? []),
      changes: [],
    };
  }
  if (detection.sourceRoots.length === 0 && detection.languages.length === 0) {
    return { mode: "init", status: "unsupported", root: ".", reason: "no supported source or project configuration detected", changes: [] };
  }
  const config = generatedConfig(detection);
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const changes = [];
  const configPath = join(detection.root, relativeConfig);
  const existingText = await (async () => { try { return await readFile(configPath, "utf8"); } catch { return null; } })();
  if (existingText !== configText) changes.push({ path: relativeConfig, action: existingText === null ? "create" : "update" });

  for (const adapter of detection.adapters.filter((entry) => entry.adapter === "vite" && entry.config)) {
    const configPathAbsolute = join(detection.root, adapter.config);
    const original = await readFile(configPathAbsolute, "utf8");
    const patched = vitePatch(original);
    if (patched === null) return { mode: "init", status: "ambiguous", root: ".", reasons: [{ code: "vite-plugin-insertion", file: adapter.config, reason: "plugins array is not a deterministic insertion point" }], candidates: [adapter.config], changes: [] };
    if (patched !== original) changes.push({ path: adapter.config, action: "update" });
    adapter._patched = patched;
  }
  if (check) return { mode: "init", status: changes.length === 0 ? "unchanged" : "configured", root: ".", detection: { ...detection, existing: undefined }, changes, check: true };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, configText, "utf8");
  for (const adapter of detection.adapters.filter((entry) => entry._patched)) await writeFile(join(detection.root, adapter.config), adapter._patched, "utf8");
  return { mode: "init", status: changes.length === 0 ? "unchanged" : "configured", root: ".", changes, config: relativeConfig, adapters: config.adapters };
}
