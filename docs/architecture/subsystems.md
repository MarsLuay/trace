# Deterministic subsystem classification

`createSubsystemClassifier` keeps subsystem policy outside the event and graph cores. Classification precedence is explicit function, exact file, most-specific path rule, package rule, feature-token inference, then `unclassified`.

Inference tokenizes project-relative paths, modules, classes, and function names with fixed weights and a configurable stop-word set. Evidence is corpus-wide, thresholded, and normalized, so repeated identities converge across runtime/layer roots without a fixed subsystem-count ceiling. Ties return sorted candidates and `unclassified`; they never select an arbitrary name. The classifier ID hashes version and effective configuration for persisted lookup reproducibility.

Classifications retain runtime and layer metadata separately. `classifyAll` returns deterministic function-to-subsystem assignments and real indexed entry points. `entryCandidates` selects a sole entry or returns deterministic candidates when multiple real entries exist; it never creates a synthetic root.
