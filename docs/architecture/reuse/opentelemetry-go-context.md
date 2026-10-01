# OpenTelemetry Go context and propagation reuse audit

Issue: #28  
Audited revision: `open-telemetry/opentelemetry-go@80f84f580d0720878671546af5e08bb8cadb4658` (2026-10-01).  
Relevant source is Apache-2.0.

This audit does not copy upstream source.

## Decisions

| Surface | Decision | Trace boundary |
| --- | --- | --- |
| `propagation.TextMapCarrier` and `TextMapPropagator` | **Reuse the interface shape or depend on the package in the Go adapter.** The small `Get`/`Set`/`Keys` contract fits HTTP/RPC carriers and keeps transport details out of the common event model. | #14/#21 |
| `propagation.TraceContext` | **Adapt validation rules and carrier fixtures, not span context.** W3C version, ID, flag, and malformed-header handling are useful; Trace should carry only a compact internal execution context. | Go adapter |
| `context.Context` integration | **Use native Go context propagation.** Parent context should be explicit in function/transport boundaries rather than global mutable state. | Go adapter |
| `ValuesGetter` and composite propagator | **Reference for multi-valued headers and composition.** Trace may compose only explicitly enabled propagation concerns and must bound accepted values. | #14 |

## Technical conclusions

1. A Go adapter should use `context.Context` plus the maintained OpenTelemetry propagation package when its Go version/module policy permits. This avoids a homegrown carrier and W3C parser.
2. Trace should not persist Go `SpanContext`, tracestate, sampling flags, or arbitrary carrier keys. Its internal context must be a bounded, versioned value mapped to the common schema.
3. Invalid, unsupported, oversized, or missing carriers must return the existing context without application-visible errors. Injection must be opt-in at declared transport boundaries.
4. The adapter must preserve context immutability and avoid mutating caller-owned carriers except through the explicit setter contract. Multiple values and deterministic `Fields` behavior need fixtures.
5. If direct adaptation is required, retain Apache-2.0 attribution/SPDX/NOTICE material and record this revision. Dependency reuse is preferred.

## Required fixtures

- nested `context.WithValue`/transport contexts remain isolated across goroutines;
- valid and invalid trace-context headers round-trip without payload leakage;
- version 00 extra fields, unsupported versions, invalid IDs/flags, and malformed tracestate are handled safely;
- `http.Header` and map carriers preserve only declared propagation fields;
- extraction failure returns the original context identity.

No upstream source is included in this commit.
