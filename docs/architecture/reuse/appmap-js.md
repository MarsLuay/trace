# AppMap JS schema and trace-model reuse audit

Issue: #24  
Audited revision: `getappmap/appmap-js@015ef2075721ce219cde6d5e0b3bb9a56ba0f10b` (release 3.204.0, 2026-09-19).

AppMap JS is a monorepo with package-level licenses. `@appland/appmap-validate` is MIT; `@appland/models` and several other packages are Commons Clause + MIT. This audit does not copy source.

## Component decisions

| Package/component | Useful behavior | Decision for Trace |
| --- | --- | --- |
| `packages/validate` (`@appland/appmap-validate`) | AJV-backed version selection, structured validation errors, schema fixtures, CLI validation | **Adapt the validation/versioning approach.** The package is MIT and technically useful for a versioned JSON contract, but its AppMap schemas accept payload-bearing event variants that Trace must reject by default. Use a Trace-owned schema and sensitive-field tests rather than importing AppMap schemas unchanged. |
| `packages/models/src/event.js` | Flat event representation with non-enumerable parent/children links, linked return events, source/code-object accessors | **Adapt the separation of serialized data from derived graph links.** The model is tightly coupled to AppMap call/return, HTTP, SQL, parameters, labels, and payload fields. It cannot be the Trace public event model. |
| `packages/models/src/appMapBuilder/eventStack.js` | Incremental stack reconstruction, parent linking, malformed/unmatched return handling | **Adapt the algorithm and negative cases.** Trace needs deterministic handling of incomplete records and concurrent execution IDs, but must not silently discard events or infer a parent from names when correlation metadata is missing. |
| `packages/models/src/appMapBuilder/index.js` | Normalization, event updates, balancing incomplete calls, chunk transforms, bounded pruning | **Use as fixture inspiration; implement independently.** Trace's crash recovery and retention rules should be explicit in #3/#4, and synthetic return events must not hide an actually incomplete execution. |
| `packages/models/src/codeObject*` and `eventInfo.js` | Stable code-object/source identity and derived lookup metadata | **Adapt the identity requirements into #31.** The AppMap identity model includes framework-specific fields and class maps; Trace needs project-relative source identity, build/revision identity, language, runtime, and deterministic ambiguity results. |
| `packages/cli` query/serialization code | CLI argument/result plumbing and JSON serialization patterns | **Reference only.** The AppMap CLI is a broad product surface and its query model assumes AppMap documents. Trace's CLI-only public surface belongs to #5 and must not import an AppMap query API. |

## Technical conclusions

1. The best reusable boundary is a schema-validation pattern plus a graph-builder algorithm, not the AppMap model itself.
2. Trace should version its own compact event schema and use strict validation to reject arguments, prompts, credentials, tool payloads, model output, arbitrary return values, and unknown sensitive extensions by default.
3. Parent/child links should be derived from explicit execution/correlation identifiers. AppMap's stack repair behavior is useful for tests but must not become heuristic cross-task parent inference.
4. Persisted records need a forward-compatible envelope and structured malformed-record diagnostics; AppMap's event-update/balancing mechanisms are not sufficient for crash semantics required by #1.
5. The MIT validator package can be used as a dependency or narrow adaptation if its transitive/license and bundle costs are acceptable. Any use of Commons Clause + MIT model code requires package-level attribution and the upstream restriction in distribution metadata; this audit does not introduce that obligation.

## Follow-up ownership

- #2 owns the Trace schema and privacy boundary.
- #3 owns execution-tree reconstruction and incomplete/concurrent records.
- #4 owns bounded persistence and retention.
- #5 owns the JSON CLI surface.
- #31 owns real source/build identity and historical drift.
