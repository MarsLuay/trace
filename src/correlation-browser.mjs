import { activeContext, runWithContext } from "./context-browser.mjs";
import {
  CORRELATION_HEADER,
  deserializeCorrelationContext,
  extractCorrelation,
  injectCorrelation,
  serializeCorrelationContext,
} from "./correlation-core.mjs";

export function runWithPropagatedContext(carrier, { header = CORRELATION_HEADER } = {}, callback, ...args) {
  if (typeof callback !== "function") throw new TypeError("callback is required");
  const parent = extractCorrelation(carrier, { header });
  if (!parent) return callback(...args);
  return runWithContext({
    executionId: parent.executionId,
    invocationId: parent.invocationId,
    parentInvocationId: null,
  }, callback, ...args);
}

export { activeContext, CORRELATION_HEADER, deserializeCorrelationContext, extractCorrelation, injectCorrelation, serializeCorrelationContext };
