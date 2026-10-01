# Project source ownership

`createOwnership` is the adapter-facing boundary for exhaustive instrumentation. Consumers configure project roots and owned include rules; default exclusions cover dependencies, build/release output, vendored code, generated paths, and `.git`. Explicit exclusions win over includes.

Classification normalizes slash direction, `.` segments, drive prefixes, and case for root matching. It returns only project-relative paths and a deterministic reason (`owned`, `excluded`, `outside-owned-roots`, or `outside-project-root`). Absolute paths outside the configured root are never treated as owned. The transform receives a metadata predicate, so ownership policy remains outside the transform core.
