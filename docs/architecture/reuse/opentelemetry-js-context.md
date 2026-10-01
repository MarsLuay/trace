# OpenTelemetry JS context and propagation reuse audit

Issue: #25  
Audited revision: `open-telemetry/opentelemetry-js@672b1d216e8b2299d16d7e2dfd184da4bf448cb4` (2026-09-30).  
Relevant packages are Apache-2.0: `@opentelemetry/context-async-hooks` and `@opentelemetry/core`.

This audit does not copy upstream source.

## Decisions

| Surface | Decision | Trace boundary |
| --- | --- | --- |
| `AsyncLocalStorageContextManager` | **Prefer dependency reuse in the Node adapter.** Its `run`/`active`/`bind` behavior and EventEmitter listener patching cover context inheritance that Trace should not independently reimplement. | Node runtime adapter after #6/#14 |
| `W3CTraceContextPropagator` | **Adapt the carrier protocol, not span semantics.** The validation rules for version/trace ID/parent ID/flags and tolerant extract behavior are useful for transport fixtures. Trace should propagate a compact internal execution context, not expose spans, sampling, baggage, or exporter state. | #14/#21 |
| `TextMapGetter`/`TextMapSetter` and composite propagators | **Reuse the interface shape or depend on the API package.** Transport adapters should accept generic carriers and avoid HTTP/IPC-specific assumptions in the core. | #14 |
| Context manager tests | **Reuse as regression scenarios.** Required cases include nested async tasks, invalid carriers, EventEmitter callbacks, bind/removeListener behavior, and concurrent flows. | #6/#14 |

## Technical conclusions

1. The Node adapter should depend on `@opentelemetry/api` and use the maintained `@opentelemetry/context-async-hooks` implementation where the supported Node range matches Trace. This is preferable to copying a context manager and preserves upstream fixes.
2. If a supported-version mismatch prevents dependency use, adapt only the minimal `AsyncLocalStorage`/carrier surface and retain Apache-2.0 copyright and SPDX notices in the derived files.
3. Trace correlation is not OpenTelemetry tracing. The public event schema remains Trace-owned and language-neutral; OTel span IDs, sampling flags, baggage, exporters, and semantic conventions must not leak into persisted Trace records.
4. Transport propagation should fail closed on malformed or oversized/untrusted carriers and preserve the current context when extraction fails. Injection must be bounded and must never include prompts, arguments, credentials, or arbitrary application payloads.
5. EventEmitter binding deserves explicit ownership: the adapter must preserve listener removal and avoid double wrapping. It should not patch global emitters as a side effect of enabling Trace.

## Required fixtures

- nested `AsyncLocalStorage` runs and concurrent promises do not cross parent IDs;
- bound functions and EventEmitter listeners retain their originating execution context;
- listener removal removes the bound wrapper;
- valid, future-compatible, malformed, and oversized propagation carriers;
- inject/extract round trips across HTTP/RPC-like maps without span/exporter data.

No upstream source is included in this commit, so no copied-code notice is added yet. Any future derivative adaptation must carry Apache-2.0 attribution and NOTICE obligations.
