# Real source index

`buildSourceIndex` parses actual project source through the shared transform and records deterministic function identities, project-relative source locations, subsystem/classifier metadata, language/runtime/layer, revision/build identity, and real entry-point flags. It applies the ownership boundary before parsing, so dependency and generated files never enter the index.

The persisted index contains no source text or absolute paths. `lookupFunction` gives exact identity matches precedence and returns structured ambiguity candidates for non-unique names. `sourceDrift` compares recorded and current revision/index/build identities without relabeling historical functions. `saveSourceIndex` and `loadSourceIndex` persist the machine-readable index for stopped or crashed consumers.
