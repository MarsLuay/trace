# AppMap Python reuse audit

Issue: #23  
Audited revision: `getappmap/appmap-python@352c573a68aedf99cb1b16eae92b4337aab30d05` (release 3.0.1, 2026-07-10)  
License: MIT subject to the Commons Clause in the upstream `LICENSE`.

This is an architecture audit. No AppMap Python source is copied by this change.

## Component decisions

| Upstream component | Useful behavior | Decision for Trace | Destination |
| --- | --- | --- | --- |
| `_appmap/instrument.py` | Re-entrancy guard, shallow-call handling, sync/exception wrapping, preservation of original exceptions | **Adapt control-flow requirements only.** The wrapper catches `BaseException`, records return/failure, and rethrows, which matches Trace's semantic invariant. Its event construction records parameters/return values and its recorder-limit exceptions intentionally alter control flow, so the implementation cannot be imported unchanged. | Python adapter after #2/#4 |
| `_appmap/importer.py` | Import-time module/class/function discovery, qualified names, property handling, idempotent wrapping markers | **Adapt the discovery model.** The module/class/function and property inventory is useful for exhaustive ownership filtering. Trace should use project-relative source/revision identity and an explicit adapter contract rather than AppMap's filter chain, `wrapt`, or package labels. | Python adapter and #31 |
| `_appmap/recorder.py` | Per-thread/shared recorder selection, event IDs, locking, event/time bounds | **Adapt bounded-recorder tests and locking lessons; do not copy the recorder.** Trace requires task-aware context, bounded hot storage, append-only persistence, and fail-open write errors. AppMap's `AppMapLimitExceeded` is an application-visible exception and conflicts with Trace's fail-open behavior. | #2/#4 and Python adapter |
| `_appmap/recording.py` | JSON recording lifecycle, finalization and metadata | **Reference only for lifecycle fixtures.** AppMap recording intentionally serializes arguments, return values, exception details, and framework metadata outside Trace's default privacy contract. | #2/#4 |
| `_appmap/event.py` | Call/return/exception event construction and source/function metadata | **Reject direct reuse for technical/schema reasons.** It models AppMap payload-bearing events and IDs, not the versioned minimal ENTER/EXIT/FAIL contract. Use only as a source of negative and exception-propagation cases. | #2 |
| `_appmap/configuration.py`, filters, and importer tests | Include/exclude/package selection and deterministic tests | **Adapt test scenarios, not configuration code.** Trace's configuration must be language-neutral at the boundary and use project-relative ownership/source-index identities. | #2/#10/#31 |

## Technical conclusions

1. AppMap Python is a useful reference for import-time function discovery, properties, re-entrancy, and preserving arbitrary `BaseException` behavior.
2. It is not a safe direct recorder owner for Trace: parameters, return values, exception details, framework metadata, and AppMap-specific event IDs violate the minimal default data contract.
3. The Python adapter should use the shared Trace event/context contract and make recorder failures invisible to the application. Limit/retention conditions must drop or prune trace data rather than raise AppMap-specific exceptions into application code.
4. Import-time wrapping is appropriate for a Python adapter, but ownership must be decided from the real source index and must skip Trace itself, generated output, dependencies, and vendored code. Wrapper markers should be adapter-private and idempotent.
5. The async/task and process propagation mechanism must be selected with #27 and the cross-language contract (#14/#21), not copied from AppMap's thread-local recorder state.

## License handling

No upstream source is included in this commit. If later work copies or derives from AppMap Python, it must retain the AppLand MIT notice and Commons Clause condition in the resulting distribution and record the upstream revision in the package notices. This decision is technical, not an attempt to avoid the upstream license.
