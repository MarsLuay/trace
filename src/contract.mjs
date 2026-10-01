const EVENT_KEYS = new Set([
  "schemaVersion",
  "eventId",
  "executionId",
  "invocationId",
  "parentInvocationId",
  "sequence",
  "emittedAt",
  "event",
  "function",
  "subsystem",
  "language",
  "runtime",
  "source",
]);

const SOURCE_KEYS = new Set([
  "projectPath",
  "line",
  "column",
  "revision",
  "buildId",
  "sourceIndexId",
]);

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const SEQUENCE_PATTERN = /^[0-9]{1,40}$/u;
const TIMESTAMP_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;
const SENSITIVE_KEY_PATTERN = /^(?:arg|args|argument|arguments|kwarg|kwargs|prompt|prompts|transcript|credential|credentials|password|secret|token|authorization|cookie|toolpayload|modeloutput|returnvalue|returnvalues)$/u;
const SEMANTIC_KEYS = ["function", "subsystem", "language", "runtime", "source"];

export const TRACE_SCHEMA_VERSION = 1;

export class TraceContractError extends TypeError {
  constructor(issues) {
    const normalized = issues.map((issue) => ({
      path: issue.path || "$",
      message: issue.message,
    }));
    super(normalized.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "TraceContractError";
    this.issues = normalized;
  }
}

function issue(path, message) {
  return { path, message };
}

function object(value, path, issues) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(issue(path, "must be an object"));
    return false;
  }
  return true;
}

function exactKeys(value, allowed, path, issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(issue(`${path}.${key}`, "unknown field"));
  }
}

function required(value, keys, path, issues) {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) issues.push(issue(`${path}.${key}`, "is required"));
  }
}

function boundedString(value, path, issues, { pattern, max = 512 } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    issues.push(issue(path, `must be a non-empty string of at most ${max} characters`));
    return false;
  }
  if (pattern && !pattern.test(value)) issues.push(issue(path, "has an invalid format"));
  return true;
}

function nullableString(value, path, issues) {
  if (value !== null) boundedString(value, path, issues, { max: 512 });
}

function findSensitiveKeys(value, path, issues) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSensitiveKeys(item, `${path}[${index}]`, issues));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[\s_-]/gu, "");
    if (SENSITIVE_KEY_PATTERN.test(normalized)) {
      issues.push(issue(`${path}.${key}`, "sensitive payload fields are outside the contract"));
    }
    findSensitiveKeys(child, `${path}.${key}`, issues);
  }
}

function validateSource(source, issues) {
  const path = "$.source";
  if (!object(source, path, issues)) return;
  exactKeys(source, SOURCE_KEYS, path, issues);
  required(source, [...SOURCE_KEYS], path, issues);

  if (typeof source.projectPath !== "string" || source.projectPath.length === 0) {
    issues.push(issue(`${path}.projectPath`, "must be a project-relative path"));
  } else if (
    source.projectPath.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(source.projectPath) ||
    source.projectPath.split(/[\\/]/u).some((segment) => segment === "..")
  ) {
    issues.push(issue(`${path}.projectPath`, "must not be absolute or escape the project"));
  }

  for (const key of ["line", "column"]) {
    const value = source[key];
    if (value !== null && (!Number.isInteger(value) || value < 1)) {
      issues.push(issue(`${path}.${key}`, "must be a positive integer or null"));
    }
  }
  for (const key of ["revision", "buildId", "sourceIndexId"]) {
    if (source[key] !== null) nullableString(source[key], `${path}.${key}`, issues);
  }
}

function validateEventInternal(event) {
  const issues = [];
  findSensitiveKeys(event, "$", issues);
  if (!object(event, "$", issues)) return issues;

  exactKeys(event, EVENT_KEYS, "$", issues);
  required(event, [...EVENT_KEYS], "$", issues);
  if (event.schemaVersion !== TRACE_SCHEMA_VERSION) {
    issues.push(issue("$.schemaVersion", `must be ${TRACE_SCHEMA_VERSION}`));
  }
  for (const key of ["eventId", "executionId", "invocationId"]) {
    boundedString(event[key], `$.${key}`, issues, { pattern: ID_PATTERN, max: 256 });
  }
  if (event.parentInvocationId !== null) {
    boundedString(event.parentInvocationId, "$.parentInvocationId", issues, {
      pattern: ID_PATTERN,
      max: 256,
    });
  }
  boundedString(event.sequence, "$.sequence", issues, {
    pattern: SEQUENCE_PATTERN,
    max: 40,
  });
  if (
    typeof event.emittedAt !== "string" ||
    !TIMESTAMP_PATTERN.test(event.emittedAt) ||
    Number.isNaN(Date.parse(event.emittedAt))
  ) {
    issues.push(issue("$.emittedAt", "must be a valid UTC timestamp"));
  }
  if (!["enter", "exit", "fail"].includes(event.event)) {
    issues.push(issue("$.event", "must be enter, exit, or fail"));
  }
  for (const key of SEMANTIC_KEYS.slice(0, 4)) {
    boundedString(event[key], `$.${key}`, issues, { max: 512 });
  }
  validateSource(event.source, issues);
  return issues;
}

export function validateEvent(event) {
  const issues = validateEventInternal(event);
  if (issues.length > 0) throw new TraceContractError(issues);
  return event;
}

function sameSemanticIdentity(left, right) {
  return SEMANTIC_KEYS.every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

/**
 * Validate a sequence of events from one execution. Open invocations are allowed by default so
 * crash-truncated prefixes remain readable; pass allowIncomplete:false for a complete recording.
 */
export function validateTrace(events, { allowIncomplete = true } = {}) {
  const issues = [];
  if (!Array.isArray(events) || events.length === 0) {
    throw new TraceContractError([issue("$", "must be a non-empty event array")]);
  }

  const seenEventIds = new Set();
  const active = new Map();
  let executionId;
  let previousSequence = null;

  events.forEach((event, index) => {
    const path = `$[${index}]`;
    issues.push(...validateEventInternal(event).map((entry) => ({
      ...entry,
      path: entry.path === "$" ? path : `${path}${entry.path.slice(1)}`,
    })));
    if (!event || typeof event !== "object" || Array.isArray(event)) return;

    if (executionId === undefined) executionId = event.executionId;
    else if (event.executionId !== executionId) {
      issues.push(issue(`${path}.executionId`, "all events must belong to one execution"));
    }
    if (seenEventIds.has(event.eventId)) issues.push(issue(`${path}.eventId`, "must be unique"));
    seenEventIds.add(event.eventId);

    if (SEQUENCE_PATTERN.test(event.sequence)) {
      const sequence = BigInt(event.sequence);
      if (previousSequence !== null && sequence <= previousSequence) {
        issues.push(issue(`${path}.sequence`, "must increase strictly"));
      }
      previousSequence = sequence;
    }

    if (event.event === "enter") {
      if (active.has(event.invocationId)) {
        issues.push(issue(`${path}.invocationId`, "cannot enter the same invocation twice"));
      }
      if (event.parentInvocationId !== null && !active.has(event.parentInvocationId)) {
        issues.push(issue(`${path}.parentInvocationId`, "must reference an active invocation"));
      }
      active.set(event.invocationId, event);
      return;
    }

    const entry = active.get(event.invocationId);
    if (!entry) {
      issues.push(issue(`${path}.invocationId`, "exit/fail must match an active enter"));
      return;
    }
    if (event.parentInvocationId !== entry.parentInvocationId) {
      issues.push(issue(`${path}.parentInvocationId`, "must match the enter event"));
    }
    if (!sameSemanticIdentity(event, entry)) {
      issues.push(issue(path, "exit/fail identity must match its enter event"));
    }
    active.delete(event.invocationId);
  });

  if (!allowIncomplete && active.size > 0) {
    issues.push(issue("$", "recording has incomplete invocations"));
  }
  if (issues.length > 0) throw new TraceContractError(issues);
  return events;
}
