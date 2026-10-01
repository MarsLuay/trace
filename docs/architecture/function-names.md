# Deterministic function identities

`resolveFunctionName` derives a stable trace identity from a project-relative source path and one-based source location. Named functions become identities such as `load@src/module.js:12:1`; anonymous callbacks use `callback@...`; class methods are qualified (`Service.method@...`) and accessors retain their kind.

The transform uses these identities in the event contract and in its trace-location index. Identically named functions at different source locations therefore remain distinguishable, while rebuilding unchanged source produces the same names. Absolute paths are rejected by the transform and never enter the identity.
