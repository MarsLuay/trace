# OpenTelemetry Python context and propagation reuse audit

Issue: #27  
Audited revision: `open-telemetry/opentelemetry-python@583ddd5cb5453f43c81a3863297716e2b767e2f5` (2026-10-01).  
Relevant source is Apache-2.0.

This audit does not copy upstream source.

## Decisions

| Surface | Decision | Trace boundary |
| --- | --- | --- |
| `ContextVarsRuntimeContext` | **Prefer dependency reuse for the Python adapter.** `ContextVar` attach/get/detach tokens provide the task-local parent behavior Trace needs without a new global/thread-local implementation. | Python runtime adapter |
| `TextMapPropagator`, getter/setter, and composite interfaces | **Reuse the interface shape or depend on the OpenTelemetry API package.** They make carrier choice transport-specific while keeping extraction/injection small. | #14/#21 |
| `TraceContextTextMapPropagator` | **Adapt validation and carrier behavior, not span objects.** Its W3C parsing rules and tolerant invalid-input behavior are useful; Trace should carry only a bounded internal execution context. | #14 |
| Context/propagation tests | **Adapt regression scenarios.** Cover nested async tasks, invalid/zero IDs, version handling, multi-valued headers, and injection/extraction round trips. | Python adapter |

## Technical conclusions

1. Python runtime tracing should use `contextvars` through the maintained OpenTelemetry API when supported, with a small Trace context value containing execution ID, parent ID, and bounded propagation version.
2. Trace must not serialize OpenTelemetry `SpanContext`, tracestate, baggage, sampling decisions, exporters, or arbitrary carrier values into persisted events.
3. Extraction should preserve the current context for malformed, missing, unsupported-version, or oversized carriers. Injection should be opt-in to supported transport adapters and should never carry user/application payloads.
4. The Python adapter must keep context attach/detach scoped and exception-safe so context cannot leak across tasks. Thread/process handoff belongs to explicit transport adapters, not implicit global state.
5. Dependency reuse is preferable to copying. If a supported-version mismatch requires a narrow derivative adaptation, retain Apache-2.0 copyright/SPDX/NOTICE material and record the exact upstream revision.

## Required fixtures

- nested `ContextVar` attach/detach restores the previous parent after exceptions;
- concurrent asyncio tasks retain separate execution trees;
- invalid, zero, unsupported-version, and oversized carriers are ignored safely;
- valid carriers round-trip through an HTTP/RPC-like map;
- no propagation field can contain prompts, arguments, credentials, or arbitrary application data.

No upstream source is included in this commit.
