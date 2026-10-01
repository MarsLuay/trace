# Vite and TypeScript build adapters

`src/adapters.mjs` keeps build integration thin. `createViteTracePlugin` filters JavaScript/TypeScript modules, applies ownership, and returns the shared transform plus its trace-location map. `createTypeScriptTransformer` adapts compiler transformer source files, while `transformTypeScriptSource` is available to fixture/build wrappers that do not load the TypeScript package directly.

Both adapters use the same transform, ownership classifier, subsystem classifier, source identity, and runtime hook identifier. Non-owned modules are returned unchanged (or skipped by Vite). Instrumentation errors become `TraceBuildError` with adapter and file context; no partially transformed output is returned.
