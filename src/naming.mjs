function cleanPart(value, fallback) {
  const text = typeof value === "string" && value.length > 0 ? value : fallback;
  return text.replace(/[\s@]+/gu, "_");
}

/** Produce a stable, project-relative function identity; no absolute path is accepted. */
export function resolveFunctionName({
  name = "anonymous",
  className = null,
  accessor = null,
  projectPath,
  line,
  column,
}) {
  const baseName = cleanPart(name === "anonymous" ? "callback" : name, "callback");
  const qualified = className ? `${cleanPart(className, "class")}.${accessor ? `${accessor} ` : ""}${baseName}` : baseName;
  return `${qualified}@${projectPath}:${line}:${column}`;
}
