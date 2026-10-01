# Node async execution context

`src/context-node.mjs` is the first runtime-specific adapter. It owns the Node `AsyncLocalStorage` dependency and exposes only the hidden correlation tuple required by instrumentation: execution ID, invocation ID, and parent invocation ID.

`runChildInvocation` derives the parent only when the active context belongs to the same execution. `bindContext` preserves callback `this` and listener context without exposing mutable store state. The adapter does not contain event schema, graph, persistence, or subsystem logic.

The tests cover nested `await`, independent concurrent promises, rejected operations, restoration after failure, callback binding, and no context leakage outside a run.
