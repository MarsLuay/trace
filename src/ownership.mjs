const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/release/**",
  "**/vendor/**",
  "**/generated/**",
  "**/.git/**",
];

function normalizeSeparators(value) {
  return value.replaceAll("\\", "/").replaceAll(/\/+/gu, "/");
}

function normalizePath(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let normalized = normalizeSeparators(value.trim());
  const absolute = normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized);
  const drive = normalized.match(/^[A-Za-z]:/u)?.[0] ?? "";
  normalized = normalized.replace(/^\/+|\/+$/gu, "");
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return null;
  const path = parts.join("/");
  return { path: drive ? `${drive}/${path}` : path, absolute };
}

function canonicalRule(rule) {
  const normalized = normalizePath(rule);
  if (!normalized) throw new TypeError(`invalid ownership rule: ${rule}`);
  return normalized.path.replace(/\/$/u, "");
}

function globRegex(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "iu");
}

function matchesRule(path, rule) {
  const canonical = rule.replace(/^\.\//u, "");
  if (!/[?*]/u.test(canonical)) return path === canonical || path.startsWith(`${canonical}/`);
  const candidates = canonical.startsWith("**/") ? [canonical, canonical.slice(3)] : [canonical];
  return candidates.some((candidate) => globRegex(candidate).test(path));
}

function isUnderRoot(path, root) {
  const normalizedPath = path.toLocaleLowerCase("en-US");
  const normalizedRoot = root.toLocaleLowerCase("en-US").replace(/\/$/u, "");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function createOwnership({ projectRoot = null, include = ["src/**"], exclude = [] } = {}) {
  const root = projectRoot === null ? null : normalizePath(projectRoot);
  if (projectRoot !== null && !root) throw new TypeError("projectRoot must be a valid path");
  const includeRules = [...new Set(include.map(canonicalRule))];
  const excludeRules = [...new Set([...DEFAULT_EXCLUDES, ...exclude].map(canonicalRule))];
  const configuration = Object.freeze({
    projectRoot: root?.path ?? null,
    include: Object.freeze([...includeRules]),
    exclude: Object.freeze([...excludeRules]),
  });

  function relativePath(filePath) {
    const normalized = normalizePath(filePath);
    if (!normalized) return null;
    if (!root) return normalized.absolute ? null : normalized.path;
    if (normalized.absolute) {
      if (!isUnderRoot(normalized.path, root.path)) return null;
      return normalized.path.slice(root.path.length).replace(/^\//u, "");
    }
    return normalized.path;
  }

  function classify(filePath) {
    const normalizedPath = relativePath(filePath);
    if (normalizedPath === null || normalizedPath.length === 0) {
      return { owned: false, path: normalizedPath, reason: "outside-project-root" };
    }
    if (excludeRules.some((rule) => matchesRule(normalizedPath, rule))) {
      return { owned: false, path: normalizedPath, reason: "excluded" };
    }
    if (!includeRules.some((rule) => matchesRule(normalizedPath, rule))) {
      return { owned: false, path: normalizedPath, reason: "outside-owned-roots" };
    }
    return { owned: true, path: normalizedPath, reason: "owned" };
  }

  return Object.freeze({
    configuration,
    classify,
    isOwned: (filePath) => classify(filePath).owned,
    select: (filePaths) => filePaths.filter((filePath) => classify(filePath).owned),
  });
}

export function normalizeOwnershipPath(filePath) {
  return normalizePath(filePath)?.path ?? null;
}
