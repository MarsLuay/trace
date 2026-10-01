# Pyroscope Rust reuse audit

Issue: #30  
Audited revision: `grafana/pyroscope-rs@e199a22cc85105a57dadc6a1429e593f36627b06` (2026-09-14).  
License: Apache-2.0.

This audit does not copy upstream source.

## Component decisions

| Upstream surface | Useful behavior | Decision for Trace |
| --- | --- | --- |
| `src/backend/*` | Backend abstraction, readiness lifecycle, report batching, synchronization | **Reference/adapt lifecycle patterns only.** These components serve sampling/profiling output and remote pprof export, not deterministic function ENTER/EXIT/FAIL events. |
| `src/session.rs` | Bounded channel to an upload thread, batching, compression, shutdown signaling, error logging | **Reference for optional asynchronous export and bounded queues.** Trace's default persistence is local and fail-open; it must not require a server, credentials, or network upload. |
| `src/pyroscope.rs` | Typed builder/configuration, backend startup/shutdown, timer/session ownership | **Reference for Rust API/lifecycle tests.** Do not import the profiler agent or its application/network configuration into the trace core. |
| timers and symbol/backtrace utilities | Native lifecycle, platform selection, low-overhead runtime concerns | **Use crate/dependency research only where exact tracing needs the same concern.** Sampling/backtrace output cannot replace source-indexed function instrumentation. |
| upstream tests | Session shutdown, backend failure, timer and concurrency scenarios | **Adapt failure/lifecycle cases** to Trace's recorder and context adapter without reusing profile fixtures. |

## Technical conclusions

1. Pyroscope Rust is not a direct implementation source for Trace's Rust adapter: it samples stacks and emits pprof profiles, while the parent issue requires deterministic function activation/order and explicit failure events.
2. The most useful reusable ideas are typed lifecycle states, bounded asynchronous channels, shutdown ownership, and failure-isolated export. These should be reimplemented only at the Trace boundary if the Rust adapter needs them.
3. Trace must not add sampling, pprof, remote upload, basic-auth, tenant IDs, or arbitrary profile labels to its common event model. External export, if ever added, is optional and must remain after local persistence.
4. Symbolization/backtrace infrastructure is relevant only for a native Rust adapter's source identity. It cannot silently substitute for build/source instrumentation or invent parent relationships.
5. Any direct source adaptation must retain Apache-2.0 attribution/SPDX/NOTICE material and record this revision. No upstream source is included in this commit.

## Required fixtures

- backend/startup failure does not break application execution;
- bounded producer queues apply deterministic drop/backpressure policy;
- shutdown drains only the permitted bounded suffix and leaves readable records;
- concurrent Rust tasks retain separate execution contexts;
- sampled/profile-like data is rejected by the exact Trace event validator;
- no network, credential, or pprof payload is required for local tracing.
