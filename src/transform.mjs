import { resolveFunctionName } from "./naming.mjs";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const CONTROL = new Set(["if", "for", "while", "switch", "catch", "with"]);

function token(value, start, end, line, type = "punct") {
  return { value, start, end, line, type };
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) {
      if (character === "\n") line += 1;
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) throw new SyntaxError("unterminated block comment");
      const text = source.slice(index, end + 2);
      line += (text.match(/\n/g) ?? []).length;
      index = end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      if (source[index - 1] !== quote) throw new SyntaxError("unterminated string or template");
      tokens.push(token(source.slice(start, index), start, index, line, "literal"));
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/u.test(source[index])) index += 1;
      tokens.push(token(source.slice(start, index), start, index, line, "identifier"));
      continue;
    }
    if (/[0-9]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9._]/u.test(source[index])) index += 1;
      tokens.push(token(source.slice(start, index), start, index, line, "literal"));
      continue;
    }
    const multi = ["===", "!==", ">>>", "**=", "=>", "...", "?.", "??", "&&", "||", "==", "!=", "<=", ">=", "++", "--", "**", "+=", "-=", "*=", "/="]
      .find((value) => source.startsWith(value, index));
    const value = multi ?? character;
    tokens.push(token(value, index, index + value.length, line));
    index += value.length;
  }
  return tokens;
}

function pairDelimiters(tokens) {
  const pairs = new Map();
  const stack = [];
  const opening = new Set(["(", "[", "{"]);
  const closing = new Map([["}", "{"], ["]", "["], [")", "("]]);
  tokens.forEach((current, index) => {
    if (opening.has(current.value)) stack.push([current.value, index]);
    else if (closing.has(current.value)) {
      const expected = closing.get(current.value);
      const open = stack.pop();
      if (!open || open[0] !== expected) throw new SyntaxError(`unbalanced delimiter at ${current.start}`);
      pairs.set(open[1], index);
      pairs.set(index, open[1]);
    }
  });
  if (stack.length > 0) throw new SyntaxError("unbalanced delimiter");
  return pairs;
}

function previous(tokens, index) {
  return index > 0 ? tokens[index - 1] : null;
}

function isDeclaration(tokens, index) {
  const prior = previous(tokens, index);
  return !prior || [";", "}", "export", "default"].includes(prior.value);
}

function matchingParameter(tokens, pairs, index) {
  const current = tokens[index];
  if (current?.value === ")") return pairs.get(index);
  if (current?.type === "identifier") return index;
  return null;
}

function expressionEnd(tokens, pairs, arrowIndex) {
  let depth = 0;
  for (let index = arrowIndex + 1; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (["(", "[", "{"].includes(value)) depth += 1;
    else if ([")", "]", "}"].includes(value)) {
      if (depth === 0) return index;
      depth -= 1;
    } else if (depth === 0 && [",", ";"].includes(value)) {
      return index - 1;
    }
  }
  return tokens.length - 1;
}

function location(source, offset) {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function methodInfo(tokens, openIndex) {
  const name = previous(tokens, openIndex);
  if (!name || name.type !== "identifier" || CONTROL.has(name.value)) return null;
  const beforeName = previous(tokens, openIndex - 1);
  const beforeBeforeName = previous(tokens, openIndex - 2);
  const isAccessor = beforeName && ["get", "set"].includes(beforeName.value);
  const isAsync = beforeName?.value === "async" || beforeBeforeName?.value === "async";
  const isGenerator = beforeName?.value === "*";
  return {
    name: name.value,
    accessor: isAccessor ? beforeName.value : null,
    isAccessor,
    isAsync,
    isGenerator,
  };
}

function collectOperations(source) {
  const tokens = tokenize(source);
  const pairs = pairDelimiters(tokens);
  const operations = [];
  const functionParameterOpens = new Set();

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "function") continue;
    let startIndex = index;
    if (previous(tokens, index)?.value === "async") startIndex = index - 1;
    let cursor = index + 1;
    let isGenerator = false;
    if (tokens[cursor]?.value === "*") {
      isGenerator = true;
      cursor += 1;
    }
    const nameToken = tokens[cursor]?.type === "identifier" ? tokens[cursor] : null;
    if (nameToken) cursor += 1;
    const openIndex = cursor;
    const closeIndex = pairs.get(openIndex);
    const bodyIndex = closeIndex === undefined ? undefined : closeIndex + 1;
    const endIndex = bodyIndex === undefined ? undefined : pairs.get(bodyIndex);
    if (tokens[openIndex]?.value !== "(" || tokens[bodyIndex]?.value !== "{" || endIndex === undefined) {
      throw new SyntaxError(`unsupported function form at ${tokens[index].start}`);
    }
    functionParameterOpens.add(openIndex);
    const declaration = isDeclaration(tokens, startIndex);
    const name = nameToken?.value ?? "anonymous";
    const range = {
      kind: declaration ? "function-declaration" : "function-expression",
      start: tokens[startIndex].start,
      end: tokens[endIndex].end,
      bodyStart: tokens[bodyIndex].start,
      bodyEnd: tokens[endIndex].end,
      bodyInnerStart: tokens[bodyIndex].end,
      bodyInnerEnd: tokens[endIndex].start,
      headerStart: tokens[startIndex].start,
      headerEnd: tokens[bodyIndex].start,
      name,
      line: tokens[startIndex].line,
      paramsStart: tokens[openIndex].start,
      paramsEnd: tokens[closeIndex].end,
      isGenerator,
      isAsync: startIndex !== index,
    };
    operations.push(range);
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "(") continue;
    if (functionParameterOpens.has(index)) continue;
    const closeIndex = pairs.get(index);
    const bodyIndex = closeIndex === undefined ? undefined : closeIndex + 1;
    if (tokens[bodyIndex]?.value !== "{" || closeIndex === undefined || bodyIndex === undefined) continue;
    const info = methodInfo(tokens, index);
    if (!info) continue;
    if (previous(tokens, index)?.value === "function") continue;
    const bodyEndIndex = pairs.get(bodyIndex);
    if (bodyEndIndex === undefined) throw new SyntaxError(`unbalanced method at ${tokens[index].start}`);
    const op = {
      kind: "method",
      start: tokens[index].start,
      end: tokens[bodyEndIndex].end,
      bodyStart: tokens[bodyIndex].start,
      bodyEnd: tokens[bodyEndIndex].end,
      bodyInnerStart: tokens[bodyIndex].end,
      bodyInnerEnd: tokens[bodyEndIndex].start,
      headerStart: tokens[index].start,
      headerEnd: tokens[bodyIndex].start,
      name: info.name,
      accessor: info.accessor,
      line: tokens[index].line,
      paramsStart: tokens[index].start,
      paramsEnd: tokens[closeIndex].end,
      isGenerator: info.isGenerator,
      isAsync: info.isAsync,
    };
    operations.push(op);
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "=>") continue;
    const parameterIndex = index - 1;
    const openIndex = tokens[parameterIndex]?.value === ")" ? pairs.get(parameterIndex) : parameterIndex;
    const parameterStart = tokens[openIndex]?.start;
    if (parameterStart === undefined) throw new SyntaxError(`unsupported arrow parameters at ${tokens[index].start}`);
    const bodyIndex = index + 1;
    const isBlock = tokens[bodyIndex]?.value === "{";
    const endIndex = isBlock ? pairs.get(bodyIndex) : expressionEnd(tokens, pairs, index);
    if (endIndex === undefined) throw new SyntaxError(`unbalanced arrow body at ${tokens[index].start}`);
    const bodyStart = isBlock ? tokens[bodyIndex].start : tokens[index].end;
    const bodyEnd = tokens[endIndex].end;
    let name = "anonymous";
    const equal = previous(tokens, openIndex);
    if (equal?.value === "=") {
      const variable = previous(tokens, openIndex - 1);
      if (variable?.type === "identifier") name = variable.value;
    }
    operations.push({
      kind: isBlock ? "arrow-block" : "arrow-expression",
      start: tokens[openIndex - 1]?.value === "async" ? tokens[openIndex - 1].start : parameterStart,
      end: bodyEnd,
      bodyStart,
      bodyEnd,
      bodyInnerStart: isBlock ? tokens[bodyIndex].end : bodyStart,
      bodyInnerEnd: isBlock ? tokens[endIndex].start : bodyEnd,
      headerStart: parameterStart,
      headerEnd: bodyStart,
      name,
      line: tokens[index].line,
      paramsStart: parameterStart,
      paramsEnd: tokens[parameterIndex].end,
      isGenerator: false,
      isAsync: tokens[openIndex - 1]?.value === "async" || tokens[parameterIndex - 1]?.value === "async",
    });
  }

  const classRanges = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "class") continue;
    const nameToken = tokens[index + 1]?.type === "identifier" ? tokens[index + 1] : null;
    let bodyIndex = index + 1;
    while (tokens[bodyIndex] && tokens[bodyIndex].value !== "{") bodyIndex += 1;
    const bodyEndIndex = pairs.get(bodyIndex);
    if (tokens[bodyIndex]?.value === "{" && bodyEndIndex !== undefined) {
      classRanges.push({ name: nameToken?.value ?? "class", start: tokens[bodyIndex].start, end: tokens[bodyEndIndex].end });
    }
  }
  for (const operation of operations) {
    const owner = classRanges.find((range) => operation.kind === "method" && operation.start > range.start && operation.end <= range.end);
    if (owner) operation.className = owner.name;
  }
  return operations;
}

function makeMetadata(operation, options) {
  const source = {
    projectPath: options.projectPath,
    line: operation.line,
    column: operation.column,
    revision: options.revision ?? null,
    buildId: options.buildId ?? null,
    sourceIndexId: options.sourceIndexId ?? null,
  };
  const functionName = resolveFunctionName({
    name: operation.name,
    className: operation.className ?? null,
    accessor: operation.accessor ?? null,
    projectPath: options.projectPath,
    line: operation.line,
    column: operation.column,
  });
  return {
    function: functionName,
    subsystem: options.subsystemForFunction?.({ functionName, source, operation }) ?? options.subsystem,
    language: "javascript",
    runtime: options.runtime,
    source,
  };
}

function operationChildren(operations, parent, start, end) {
  return operations
    .filter((candidate) => candidate !== parent && candidate.start >= start && candidate.end <= end)
    .filter((candidate) => !operations.some((other) => other !== parent && other !== candidate && other.start >= start && other.end <= end && other.start <= candidate.start && other.end >= candidate.end))
    .sort((left, right) => left.start - right.start || right.end - left.end);
}

export function transformSource(source, {
  projectPath,
  revision = null,
  buildId = null,
  sourceIndexId = null,
  subsystem = "project",
  subsystemForFunction = null,
  runtime = "node",
  hooksIdentifier = "__traceHooks",
  shouldInstrument = () => true,
} = {}) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  if (typeof projectPath !== "string" || projectPath.length === 0 || projectPath.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(projectPath) || projectPath.split(/[\\/]/u).includes("..")) {
    throw new TypeError("projectPath must be a project-relative path");
  }
  if (typeof hooksIdentifier !== "string" || !IDENTIFIER.test(hooksIdentifier)) throw new TypeError("hooksIdentifier must be an identifier");
  if (shouldInstrument === false) return { code: source, map: null, functions: [] };
  const operations = collectOperations(source).map((operation) => {
    const point = location(source, operation.start);
    return { ...operation, column: point.column };
  }).filter((operation) => shouldInstrument(makeMetadata(operation, { projectPath, revision, buildId, sourceIndexId, subsystem, subsystemForFunction, runtime })));
  const metadataFor = (operation) => JSON.stringify(makeMetadata(operation, { projectPath, revision, buildId, sourceIndexId, subsystem, subsystemForFunction, runtime }));

  function renderRange(start, end, parent = null) {
    const children = operationChildren(operations, parent, start, end);
    let cursor = start;
    let result = "";
    for (const operation of children) {
      if (operation.start < cursor) continue;
      result += source.slice(cursor, operation.start);
      result += renderOperation(operation);
      cursor = operation.end;
    }
    return result + source.slice(cursor, end);
  }

  function renderInner(operation) {
    return renderRange(operation.bodyInnerStart, operation.bodyInnerEnd, operation);
  }

  function renderOperation(operation) {
    const metadata = metadataFor(operation);
    if (operation.kind === "function-declaration") {
      const header = source.slice(operation.headerStart, operation.headerEnd).trim();
      const inner = `${header} {${renderInner(operation)}}`;
      return `return ${hooksIdentifier}.invoke(${inner}, ${metadata}, this, arguments);`;
    }
    if (operation.kind === "method") {
      const params = source.slice(operation.paramsStart, operation.paramsEnd);
      const functionHeader = `${operation.isAsync ? "async " : ""}function${operation.isGenerator ? "*" : ""} ${operation.name}${params}`;
      const inner = `${functionHeader} {${renderInner(operation)}}`;
      return `{ return ${hooksIdentifier}.invoke(${inner}, ${metadata}, this, arguments); }`;
    }
    const inner = renderRange(operation.start, operation.end, operation);
    return `${hooksIdentifier}.wrap(${inner}, ${metadata})`;
  }

  const topLevel = operations.filter((operation) => !operations.some((other) => other !== operation && other.start <= operation.start && other.end >= operation.end));
  let cursor = 0;
  let code = "";
  for (const operation of topLevel.sort((left, right) => left.start - right.start)) {
    if (operation.start < cursor) continue;
    code += source.slice(cursor, operation.start);
    if (operation.kind === "function-declaration") {
      code += source.slice(operation.start, operation.bodyInnerStart);
      code += renderOperation(operation);
      code += source.slice(operation.bodyInnerEnd, operation.bodyEnd);
    } else if (operation.kind === "method") {
      code += source.slice(operation.start, operation.bodyStart);
      code += renderOperation(operation);
    } else {
      code += renderOperation(operation);
    }
    cursor = operation.end;
  }
  code += source.slice(cursor);
  const functions = operations.map((operation) => ({
    name: resolveFunctionName({
      name: operation.name,
      className: operation.className ?? null,
      accessor: operation.accessor ?? null,
      projectPath,
      line: operation.line,
      column: operation.column,
    }),
    kind: operation.kind,
    line: operation.line,
    column: operation.column,
  }));
  return {
    code,
    map: {
      version: 3,
      file: projectPath,
      sources: [projectPath],
      names: functions.map(({ name }) => name),
      mappings: "",
      x_traceLocations: functions,
    },
    functions,
  };
}
