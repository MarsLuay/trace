const ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
let current = null;

function assertContextPart(value, name) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new TypeError(`${name} must be a bounded correlation identifier`);
}

export function createContext({ executionId, invocationId, parentInvocationId = null }) {
  assertContextPart(executionId, "executionId");
  assertContextPart(invocationId, "invocationId");
  if (parentInvocationId !== null) assertContextPart(parentInvocationId, "parentInvocationId");
  return Object.freeze({ executionId, invocationId, parentInvocationId });
}

export function activeContext() {
  return current;
}

/** Run synchronous browser work under a context. Bind promise/callback continuations explicitly. */
export function runWithContext(context, callback, ...args) {
  if (typeof callback !== "function") throw new TypeError("callback is required");
  const normalized = createContext(context);
  const previous = current;
  current = normalized;
  try {
    return callback(...args);
  } finally {
    current = previous;
  }
}

export function runChildInvocation({ executionId, invocationId }, callback, ...args) {
  const parent = activeContext();
  return runWithContext({
    executionId,
    invocationId,
    parentInvocationId: parent?.executionId === executionId ? parent.invocationId : null,
  }, callback, ...args);
}

/** Bind a callback or promise continuation so concurrent browser flows retain separate parents. */
export function bindContext(callback, context = activeContext()) {
  if (typeof callback !== "function") throw new TypeError("callback is required");
  if (!context) return callback;
  const bound = createContext(context);
  return function boundBrowserTraceContext(...args) {
    return runWithContext(bound, () => callback.apply(this, args));
  };
}
