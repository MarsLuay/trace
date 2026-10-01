import { activeContext, createContext, runWithContext } from "./context-browser.mjs";
import { createTraceHooksWithContext } from "./hooks-core.mjs";

export function createBrowserTraceHooks(options = {}) {
  return createTraceHooksWithContext({
    ...options,
    contextRuntime: { activeContext, createContext, runWithContext },
  });
}

export { createTraceHooksWithContext };
