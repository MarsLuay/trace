# JavaScript/TypeScript source transform

`transformSource` is the shared lexical/structural transform for JavaScript and TypeScript-compatible syntax. It recognizes function declarations and expressions, async functions, class/object methods, accessors, arrows, callbacks, and nested closures while ignoring comments and literals. The transform does not decide project ownership: callers pass `shouldInstrument` from the ownership layer and can leave generated or third-party files unchanged.

Declarations and methods retain their original headers and delegate their original body through `hooks.invoke`, preserving `this`, `arguments`, return values, and thrown errors. Function expressions and arrows become `hooks.wrap` expressions. Nested operations are rendered from the original source ranges so instrumentation is not duplicated across build adapters.

Every generated hook receives a minimal metadata object with a project-relative source path and original line/column. The returned source map includes the original source plus `x_traceLocations`, an equivalent location index for historical trace lookup; no payload values are added. The transform never captures arguments or return values.
