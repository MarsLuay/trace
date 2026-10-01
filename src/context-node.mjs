import { AsyncLocalStorage } from "node:async_hooks";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const storage = new AsyncLocalStorage();

function assertContextPart(value, name) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a bounded correlation identifier`);
  }
}

export function createContext({ executionId, invocationId, parentInvocationId = null }) {
  assertContextPart(executionId, "executionId");
  assertContextPart(invocationId, "invocationId");
  if (parentInvocationId !== null) assertContextPart(parentInvocationId, "parentInvocationId");
  return Object.freeze({ executionId, invocationId, parentInvocationId });
}

export function activeContext() {
  return storage.getStore() ?? null;
}

export function runWithContext(context, callback, ...args) {
  if (!context || typeof context !== "object") throw new TypeError("context is required");
  if (typeof callback !== "function") throw new TypeError("callback is required");
  const normalized = createContext(context);
  return storage.run(normalized, callback, ...args);
}

export function runChildInvocation({ executionId, invocationId }, callback, ...args) {
  const parent = activeContext();
  return runWithContext(
    {
      executionId,
      invocationId,
      parentInvocationId: parent?.executionId === executionId ? parent.invocationId : null,
    },
    callback,
    ...args,
  );
}

/** Bind a callback without exposing or allowing mutation of the hidden correlation context. */
export function bindContext(callback, context = activeContext()) {
  if (typeof callback !== "function") throw new TypeError("callback is required");
  if (!context) return callback;
  const bound = createContext(context);
  return function boundTraceContext(...args) {
    return runWithContext(bound, () => callback.apply(this, args));
  };
}
