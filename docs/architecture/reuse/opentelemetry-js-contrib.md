# OpenTelemetry JS contrib instrumentation reuse audit

Issue: #26  
Audited revision: `open-telemetry/opentelemetry-js-contrib@7b3e8453abffc552a55430e5d11e195754e1ee14` (2026-10-01).  
Relevant upstream packages are Apache-2.0.

This audit does not copy upstream source.

## Decisions

| Upstream surface | Useful behavior | Decision for Trace |
| --- | --- | --- |
| `InstrumentationBase` and `InstrumentationNodeModuleDefinition` used by contrib packages | Package/version gating, module lifecycle, enable/disable, patch/unpatch ownership | **Prefer dependency reuse for optional runtime/module adapters.** These mechanisms belong to runtime patching, not the canonical AST transform. A Trace adapter may use the framework when it must instrument a loaded dependency or host lifecycle. |
| `isWrapped`, `_wrap`, and `_unwrap` patterns in `instrumentation-express` and `instrumentation-fs` | Idempotence, restoring originals, handling multiple module versions | **Adopt the invariants; use the framework rather than copying helpers.** Every runtime patch must detect an existing wrapper, avoid double wrapping, and restore the exact original on disable. |
| Express layer and filesystem instrumentation examples | Representative module patch points, version checks, ignored-path configuration, async callback handling | **Reference and fixture source only.** Trace must not inherit span attributes, HTTP/FS semantic conventions, or broad dependency instrumentation by default. |
| Contrib tests | Regression cases for reloads, unsupported versions, teardown, wrappers, and listener behavior | **Adapt scenarios to Trace events.** Add focused tests in the runtime-adapter issue rather than importing upstream test code wholesale. |

## Technical conclusions

1. The shared Trace AST transform remains the owner of project-function instrumentation. OpenTelemetry contrib's module patching framework is an optional runtime integration seam, not a second tracing implementation.
2. Runtime adapters should depend on `@opentelemetry/instrumentation` only where module patching is required. They must emit Trace events through the shared recorder and must not create spans or exporters.
3. Patch lifecycle must be transactional: unsupported versions and partial failures leave the original module untouched; `disable` restores the original; repeated enable/reload does not stack wrappers.
4. Trace should not automatically instrument every dependency module merely because an OTel instrumentation exists. Include/exclude and project ownership rules remain authoritative.
5. If direct source adaptation becomes necessary, retain Apache-2.0 SPDX/copyright/NOTICE material and record the exact upstream revision. Dependency reuse is preferred and avoids a local fork.

## Required fixtures

- enable twice and reload a module without double wrapping;
- disable after a successful patch restores identity and behavior;
- unsupported module version remains untouched;
- one patch failure rolls back without leaving partial wrappers;
- callbacks and promises preserve the current Trace context;
- include/exclude rules prevent dependency and generated-source instrumentation.

No upstream source is included in this commit.
