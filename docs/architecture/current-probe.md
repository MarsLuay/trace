# Current-code probe

`createCurrentProbe` executes supplied real indexed entry functions through the runtime hooks. A function target is resolved through the persisted source index, its subsystem entry points are selected, and the target is reported as naturally reached or not reached. Multiple valid entries return sorted candidates; direct target execution is explicit (`direct: true`). No fixture call graph is synthesized.

`EffectRegistry` is the fail-closed side-effect boundary. Registered wrappers record only bounded route/operation metadata and return a simulation result; unknown wrappers throw `ProbeBoundaryError` before the external call. Wrapper classifications can be supplied by the initialization layer. Probe results include the observed subsystem flow, stopping point, target state, and intercepted wrapper/category records without arbitrary arguments or return values.
