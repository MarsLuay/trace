import { createContext, runWithContext } from "./context-node.mjs";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const HEADER_NAME = "x-trace-correlation";
const MAX_CONTEXT_BYTES = 1024;
const CONTEXT_KEYS = new Set(["executionId", "invocationId"]);

function validId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function normalizedContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !CONTEXT_KEYS.has(key))) return null;
  if (!validId(value.executionId) || !validId(value.invocationId)) return null;
  return { executionId: value.executionId, invocationId: value.invocationId };
}

function encode(value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > MAX_CONTEXT_BYTES) return null;
  return bytes.toString("base64url");
}

function decode(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CONTEXT_BYTES * 2) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (Object.keys(decoded).some((key) => !CONTEXT_KEYS.has(key))) return null;
    return normalizedContext(decoded);
  } catch {
    return null;
  }
}

/** Serialize only hidden execution correlation metadata for a supported transport. */
export function serializeCorrelationContext(context) {
  const normalized = normalizedContext(context);
  return normalized ? encode(normalized) : null;
}

/** Decode malformed or foreign transport metadata as absent rather than throwing. */
export function deserializeCorrelationContext(value) {
  return decode(value);
}

/** Return a carrier copy with internal correlation metadata, without mutating payloads. */
export function injectCorrelation(carrier = {}, context, { header = HEADER_NAME } = {}) {
  if (!carrier || typeof carrier !== "object" || Array.isArray(carrier)) throw new TypeError("carrier must be an object");
  if (typeof header !== "string" || header.length === 0) throw new TypeError("header must be non-empty");
  const encoded = serializeCorrelationContext(context);
  if (!encoded) return { ...carrier };
  return { ...carrier, [header]: encoded };
}

export function extractCorrelation(carrier = {}, { header = HEADER_NAME } = {}) {
  if (!carrier || typeof carrier !== "object" || Array.isArray(carrier)) return null;
  if (typeof header !== "string" || header.length === 0) return null;
  return deserializeCorrelationContext(carrier[header]);
}

/** Run a receiving boundary with the propagated invocation as the hidden active parent. */
export function runWithPropagatedContext(carrier, { header = HEADER_NAME } = {}, callback, ...args) {
  if (typeof callback !== "function") throw new TypeError("callback is required");
  const parent = extractCorrelation(carrier, { header });
  if (!parent) return callback(...args);
  return runWithContext({
    executionId: parent.executionId,
    invocationId: parent.invocationId,
    parentInvocationId: null,
  }, callback, ...args);
}

export const CORRELATION_HEADER = HEADER_NAME;
