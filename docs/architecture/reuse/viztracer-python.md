# VizTracer Python recording reuse audit

Issue: #29  
Audited revision: `gaogaotiantian/viztracer@75a662d64b414f85c968ba369a72cd43632c6832` (2026-09-26).  
License: Apache-2.0 (`NOTICE.txt` and source headers also apply).

This audit does not copy upstream source.

## Component decisions

| Upstream surface | Useful behavior | Decision for Trace |
| --- | --- | --- |
| `src/viztracer/modules/snaptrace.c/.h` | Native event collection, circular buffer indices, thread-local metadata, Python-version-specific monitoring/profile hooks, low-overhead storage | **Reference performance/retention design; do not copy into the first adapter.** The C extension records Chrome trace events, arguments, return values, thread/process metadata, and sampling/profiling details. Trace needs language-neutral ENTER/EXIT/FAIL records and fail-open persistence. A later native optimization can adapt the ring-buffer design with a narrow schema. |
| `VizTracer` configuration and `include_files`/`exclude_files` | Bounded entry count, include/exclude file controls, async/multiprocess options, configurable output | **Adapt configuration and negative tests.** Trace ownership is source-index based and persistence is its own append-only format; user payload logging stays disabled and cannot be re-enabled by an accidental passthrough option. |
| `patch.py` subprocess/multiprocessing hooks | Process startup propagation, fork/spawn cleanup, avoiding tracer self-instrumentation | **Reference for an explicit process adapter.** Do not monkey-patch process creation globally in the core. Process boundaries must use #14's bounded correlation envelope and an opt-in transport integration. |
| report/build/JSON code | Crash/shutdown lifecycle and bounded serialization scenarios | **Reference fixtures only.** VizTracer's report is a Chrome trace document and cannot be Trace's public query format. |
| VizTracer tests | Circular rollover, async/thread/process behavior, exception and shutdown cases | **Adapt regression cases** to the common Trace event model and fail-open recorder contract. |

## Technical conclusions

1. VizTracer is the strongest reference for high-volume Python collection and circular retention, but not a direct implementation source for the minimal function-call contract.
2. The initial Python adapter should use the language/runtime mechanism selected by #18/#27 and feed the shared recorder; it should not add a native extension before a measured bottleneck exists.
3. Ring-buffer overflow must drop/prune bounded trace data and emit bounded diagnostics rather than raise into the consumer. An incomplete final record must be recoverable after restart.
4. Process and thread correlation are separate from recording retention. Use explicit adapters and preserve parent relationships through the common context envelope.
5. Apache-2.0 attribution is required for any derivative native code or copied utility. No upstream source is included here, so the audit adds no copied-code notice.

## Required fixtures

- ring-buffer rollover retains a bounded complete suffix and reports truncation;
- sync/async exception paths preserve original exceptions;
- threads and asyncio tasks do not merge execution trees;
- child processes receive context only when the explicit adapter is enabled;
- shutdown and crash leave a readable final prefix without arbitrary payloads;
- recorder pressure never breaks application execution.
