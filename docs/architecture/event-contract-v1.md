# Trace event contract v1

The contract is deliberately independent of language, runtime, process, and transport. `schema/trace-event-v1.schema.json` is the wire-level shape; `src/contract.mjs` adds cross-event graph validation.

## Event fields

- `schemaVersion`: numeric schema version (`1` for this contract).
- `eventId`, `executionId`, `invocationId`, `parentInvocationId`: correlation identifiers. They are implementation metadata, not user-facing payload and must never be supplied from arguments or prompts.
- `sequence`: decimal string assigned by the recorder. A string avoids integer precision differences between languages.
- `emittedAt`: UTC timestamp.
- `event`: `enter`, `exit`, or `fail`.
- `function`, `subsystem`, `language`, `runtime`: public semantic identity.
- `source`: project-relative path, optional line/column, and revision/build/source-index identity. Historical records retain these values even when the current checkout changes.

The schema has no extension/payload escape hatch. Arguments, prompts, transcripts, credentials, tool payloads, model output, return values, and similarly sensitive fields are rejected by the runtime validator.

## Graph rules

1. All events in one validated sequence share an `executionId`.
2. `enter` creates an `invocationId`; its parent is null or an invocation that is currently active.
3. `exit` and `fail` close exactly one active invocation and repeat its semantic identity.
4. Sequence values increase strictly. Concurrent branches may interleave; they are correlated by invocation IDs rather than a single process-local stack.
5. A crash-truncated prefix may contain open invocations. Consumers requiring a complete recording can call `validateTrace(events, { allowIncomplete: false })`.
6. Source paths are project-relative and cannot escape through `..`; revision/build/source-index values identify the producer without depending on the current checkout.

## Versioning

Readers must reject unknown schema versions rather than guessing. A later version may add fields only through a new schema version and must keep old persisted v1 records readable. The v1 shape is intentionally closed so accidental payload capture fails validation.
