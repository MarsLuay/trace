# @marsluay/trace

Privacy-preserving execution tracing for JavaScript and TypeScript applications.
Trace records keep correlation, source identity, and control-flow metadata; they do not capture arguments, prompts, results, or credentials.

## Install

```sh
npm install @marsluay/trace
```

The `trace` executable is the public query interface. It emits JSON by default:

```sh
trace past 'src/chat.mjs#start' --store .trace --index .trace/source-index.json
trace current 'src/chat.mjs#start' --index .trace/source-index.json --runner ./trace-runner.mjs
```

Use `--format tree` for a human-readable tree. Correlation identifiers are omitted from normal output.

## Entry points

- `@marsluay/trace`: event contract
- `@marsluay/trace/context/node` and `@marsluay/trace/context/browser`: runtime context adapters
- `@marsluay/trace/context/correlation` and `@marsluay/trace/context/correlation-browser`: hidden boundary propagation
- `@marsluay/trace/hooks` and `@marsluay/trace/hooks/browser`: fail-open tracing hooks
- `@marsluay/trace/transform`: shared JavaScript/TypeScript transform
- `@marsluay/trace/adapters`: Vite, TypeScript, Babel, SWC, and esbuild adapters
- `@marsluay/trace/index`, `@marsluay/trace/storage`, and `@marsluay/trace/probe`: source indexes, bounded persistence, and probes

The Python runtime adapter is distributed at `python/trace_runtime.py`. It uses `sys.settrace` for owned synchronous functions and `contextvars`-aware `TraceRuntime.trace` boundaries for async functions. Python writes the same bounded `trace-*.jsonl` records consumed by the CLI.

The Rust adapter is distributed under `rust/`: `trace_runtime.rs` provides the bounded JSONL runtime and `trace_macro` provides the `#[trace]` attribute. Build those crates with Cargo and install a `TraceConfig` before calling instrumented functions. The guard is automatic at each annotated function boundary and excludes vendor/generated paths.

Consumer subsystem and ownership configuration stays in the consuming application and is not read from package-private files.

## License

MIT. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
