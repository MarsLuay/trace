# AppMap Node reuse audit

Issue: #22  
Audited revision: `getappmap/appmap-node@4713c11e178c20c7449767683040e0621e63aeb5` (release 2.27.0, 2026-09-21)  
License: MIT subject to the Commons Clause in the upstream `LICENSE`.

This is an architecture audit, not a source import. No AppMap source is copied by this change.

## Component decisions

| Upstream component | Useful behavior | Decision for Trace | Destination |
| --- | --- | --- | --- |
| `src/hooks/instrument.ts` | AST traversal, function-form coverage, include/exclude checks, source-map-aware locations | **Adapt the algorithm, not the source.** The traversal and location approach fit the shared JS/TS transform, but the implementation is coupled to AppMap's registry, labels, global recorder, and Meriyah ESTree. It also does not provide the TypeScript/JSX parser contract Trace needs. | #8, #9, #10 |
| `src/transform.ts` | Hook selection, parse/transform/generate lifecycle, source-map lookup, transform failure fallback | **Adapt the lifecycle.** The hook seam and source-map lookup are useful, but the Trace transform must own one canonical instrumentation contract and must let Vite/esbuild/Babel/SWC adapters remain thin. AppMap's hook set and parser/generator choices are not a drop-in API. | #8, #12, #16 |
| `src/Recording.ts` | `.part` files, finalization, event patch-up, promise settlement, recording lifecycle | **Adapt the crash-tolerant finalization pattern only.** AppMap records arguments, return values, SQL, HTTP, metadata, and AppMap-specific event IDs; those semantics conflict with Trace's minimal/privacy-preserving event contract. The Trace recorder should use its own schema and bounded rotation. | #2, #3, #4 |
| `src/event.ts` | Small constructors for call/return/exception events and elapsed timing | **Reference for regression cases; do not copy constructors.** The AppMap event shape includes payload-bearing fields and a different parent model. Trace needs versioned `ENTER`/`EXIT`/`FAIL` records with language/runtime/source/build identity and no payloads by default. | #2 |
| `src/recorder.ts` | Wrapper around sync/async calls, promise rejection fix-up, active-recording lifecycle, process shutdown | **Adapt the control-flow requirements, not the implementation.** Promise settlement and original-error propagation are relevant, but Trace's context/recorder boundary must be language-neutral and fail open. Node context decisions are tracked separately in #25. | #4, #6, #7 |
| `src/registry.ts`, source-map utilities, and include/exclude configuration | Deterministic function metadata and project path filtering | **Use as design input and fixture source.** Trace should preserve the project-relative source/build identity requirements in #2 and the real-source index requirements in #31 without importing AppMap's package/label model. | #2, #9, #10, #31 |

## Technical conclusions

1. AppMap Node confirms that source transformation, function metadata, AsyncLocalStorage-oriented recording, source maps, and atomic partial-file cleanup are mature concerns rather than reasons to invent new behavior.
2. The direct event and recording models are not compatible with Trace's default privacy boundary because they intentionally support parameters, return values, HTTP/SQL payloads, and AppMap metadata. Reusing those files verbatim would violate #1.
3. The transform algorithm is the most valuable reusable idea, but it must be adapted behind Trace's parser-independent transform contract so TypeScript syntax and each host build adapter share one implementation.
4. If later work copies or creates derivative code from AppMap Node, the resulting package must retain the upstream MIT notice and Commons Clause condition. This audit does not introduce that obligation into Trace source because no source was copied.
5. Upstream-derived fixtures may be used where behavior is selected, but fixture data must be sanitized to the Trace schema and must not reintroduce payload capture.

## Follow-up boundary

The implementation issues remain the owners of their respective decisions: #2 owns the versioned event contract, #4 owns bounded persistence, #8 owns the canonical transform, #12/#16 own thin build adapters, and #31 owns source/revision indexing. No AppMap-specific global recorder, AppMap query API, or AppMap payload model should cross those boundaries.
