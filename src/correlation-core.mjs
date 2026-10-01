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

function encodeBase64Url(value) {
  if (typeof TextEncoder !== "function" || typeof btoa !== "function") return null;
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > MAX_CONTEXT_BYTES) return null;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value) {
  if (typeof TextDecoder !== "function" || typeof atob !== "function") return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CONTEXT_BYTES * 2) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function serializeCorrelationContext(context) {
  const normalized = normalizedContext(context);
  if (!normalized) return null;
  return encodeBase64Url(JSON.stringify(normalized));
}

export function deserializeCorrelationContext(value) {
  const decoded = decodeBase64Url(value);
  if (!decoded) return null;
  try {
    return normalizedContext(JSON.parse(decoded));
  } catch {
    return null;
  }
}

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

export const CORRELATION_HEADER = HEADER_NAME;
