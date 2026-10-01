# Bounded trace storage

`TraceStore` keeps a bounded hot buffer and best-effort JSONL persistence. `append` validates the v1 event, records it in memory synchronously, then queues disk work. Disk failures are reported to an optional callback and resolve `false`; they never reject into the traced application. The hot buffer remains available when persistence is unavailable.

Persistence uses numbered `trace-*.jsonl` files. A file is rotated before the next complete record would exceed `maxFileBytes`, and files older than `maxFiles` are pruned. A record larger than the configured bound is skipped rather than violating the disk bound. Restart recovery discovers the newest existing file before appending, so a new store instance does not overwrite history.

`readPersistedEvents` parses complete lines independently. Invalid or truncated lines are skipped while earlier valid records remain usable. Historical source/revision/build/index values are returned unchanged. `sourceDrift` compares them with a caller-provided current source identity and returns `same`, `drifted`, or `unknown` without mutating the event.
