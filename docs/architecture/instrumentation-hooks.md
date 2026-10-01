# Internal instrumentation hooks

`src/hooks.mjs` is the runtime target for generated wrappers. `createTraceHooks({ store })` returns a `wrap` function that:

1. derives a hidden execution/invocation context from the Node adapter;
2. emits `enter` without arguments or return values;
3. invokes the original function with its original `this` and arguments;
4. emits `exit` after a synchronous or awaited success; or `fail` before rethrowing the exact original error.

Storage append errors are observed and discarded. They cannot change return values, rejection identity, ordering, or application recovery. The hook owns no graph/query logic and does not expose a public trace-query API.
