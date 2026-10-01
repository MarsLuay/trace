# Execution graph reconstruction

`src/graph.mjs` consumes the v1 event contract and builds independent execution trees. It never combines roots from different `executionId` values. Nodes retain semantic identity and source/revision metadata, while serialized query results omit correlation identifiers and payload fields.

## Statuses

- `ok`: an explicit `exit` closed the invocation and no descendant is incomplete.
- `failed`: an explicit `fail` closed the invocation.
- `incomplete`: no completion event was observed, or a closed node contains a crash-truncated descendant. No success is fabricated.

## Queries

- `queryFunction(events, name)` selects the latest matching invocation and walks real parents until the first node in the target function's contiguous subsystem segment. A function nested under same-subsystem helpers roots at the outermost node in that segment.
- `querySubsystem(events, subsystem)` selects the latest node whose subsystem differs from its real parent (or has no parent). A leave/re-entry creates a new segment; descendants into other subsystems remain in the returned tree.
- `reconstructGraph(events)` exposes deterministic internal graph nodes for later CLI integration. `graphToJSON` returns a safe tree representation.

Events may be interleaved across independent executions. Each execution is validated separately, then roots and nodes are sorted by decimal sequence, execution ID, and invocation ID for deterministic output.
