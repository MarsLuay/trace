//! Minimal Rust runtime adapter for @marsluay/trace.
//!
//! The companion `trace_macro` attribute inserts a `TraceGuard` at function
//! entry. Guards record source/control-flow metadata only and are fail-open.

use std::cell::RefCell;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_FILES: usize = 8;
static RUNTIME: OnceLock<Mutex<Option<TraceConfig>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
thread_local! { static CONTEXT: RefCell<Option<TraceContext>> = const { RefCell::new(None) }; }

#[derive(Clone, Debug)]
pub struct TraceContext {
    pub execution_id: String,
    pub invocation_id: String,
}

#[derive(Clone, Debug)]
pub struct TraceConfig {
    pub directory: PathBuf,
    pub project_root: PathBuf,
    pub excluded: Vec<String>,
    pub subsystem: String,
    pub revision: Option<String>,
    pub build_id: Option<String>,
    pub source_index_id: Option<String>,
}

impl TraceConfig {
    pub fn new(directory: impl Into<PathBuf>, project_root: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
            project_root: project_root.into(),
            excluded: vec!["vendor/".into(), "generated/".into(), "build/".into(), "target/".into()],
            subsystem: "rust".into(),
            revision: None,
            build_id: None,
            source_index_id: None,
        }
    }
}

pub struct TraceRuntime;

impl TraceRuntime {
    pub fn install(config: TraceConfig) {
        let slot = RUNTIME.get_or_init(|| Mutex::new(None));
        if let Ok(mut current) = slot.lock() {
            *current = Some(config);
        }
    }

    pub fn clear() {
        if let Some(slot) = RUNTIME.get() {
            if let Ok(mut current) = slot.lock() {
                *current = None;
            }
        }
    }

    pub fn active_context() -> Option<TraceContext> {
        CONTEXT.with(|context| context.borrow().clone())
    }

    pub fn inject_context() -> Option<TraceContext> {
        Self::active_context()
    }

    pub fn run_with_context<T>(context: TraceContext, callback: impl FnOnce() -> T) -> T {
        CONTEXT.with(|current| {
            let previous = current.replace(Some(context));
            let result = callback();
            current.replace(previous);
            result
        })
    }
}

pub struct TraceGuard {
    config: Option<TraceConfig>,
    invocation: Option<Invocation>,
    previous: Option<TraceContext>,
}

#[derive(Clone)]
struct Invocation {
    execution_id: String,
    invocation_id: String,
    parent_invocation_id: Option<String>,
    project_path: String,
    line: u32,
    function: String,
    subsystem: String,
}

impl TraceGuard {
    pub fn enter(file: &str, line: u32, function: &str, subsystem: &str) -> Self {
        let config = RUNTIME.get().and_then(|slot| slot.lock().ok()).and_then(|current| current.clone());
        let Some(config) = config else { return Self::inactive(); };
        let Some(project_path) = owned_path(&config, file) else { return Self::inactive(); };
        let previous = TraceRuntime::active_context();
        let execution_id = previous.as_ref().map(|value| value.execution_id.clone()).unwrap_or_else(|| id("execution"));
        let invocation = Invocation {
            execution_id: execution_id.clone(),
            invocation_id: id("invocation"),
            parent_invocation_id: previous.as_ref().map(|value| value.invocation_id.clone()),
            project_path,
            line,
            function: function.to_string(),
            subsystem: if subsystem.is_empty() { config.subsystem.clone() } else { subsystem.to_string() },
        };
        CONTEXT.with(|current| {
            current.replace(Some(TraceContext { execution_id: execution_id.clone(), invocation_id: invocation.invocation_id.clone() }));
        });
        write_event(&config, &invocation, "enter");
        Self { config: Some(config), invocation: Some(invocation), previous }
    }

    fn inactive() -> Self {
        Self { config: None, invocation: None, previous: None }
    }
}

impl Drop for TraceGuard {
    fn drop(&mut self) {
        let Some(invocation) = self.invocation.take() else { return; };
        if let Some(config) = &self.config {
            write_event(config, &invocation, if std::thread::panicking() { "fail" } else { "exit" });
        }
        CONTEXT.with(|current| {
            current.replace(self.previous.take());
        });
    }
}

fn id(kind: &str) -> String {
    format!("rs-{}-{}", kind, NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

fn owned_path(config: &TraceConfig, file: &str) -> Option<String> {
    let root = config.project_root.canonicalize().ok()?;
    let path = Path::new(file).canonicalize().ok()?;
    let relative = path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    if !relative.ends_with(".rs") || config.excluded.iter().any(|pattern| relative.starts_with(pattern) || relative.contains(&format!("/{pattern}"))) {
        return None;
    }
    Some(relative)
}

fn escape(value: &str) -> String {
    value.chars().flat_map(|character| match character {
        '"' => "\\\"".chars().collect::<Vec<_>>(),
        '\\' => "\\\\".chars().collect::<Vec<_>>(),
        '\n' => "\\n".chars().collect::<Vec<_>>(),
        '\r' => "\\r".chars().collect::<Vec<_>>(),
        '\t' => "\\t".chars().collect::<Vec<_>>(),
        other => vec![other],
    }).collect()
}

fn optional_json(value: &Option<String>) -> String {
    value.as_ref().map(|item| format!("\"{}\"", escape(item))).unwrap_or_else(|| "null".into())
}

fn write_event(config: &TraceConfig, invocation: &Invocation, event: &str) {
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();
    let parent = invocation.parent_invocation_id.as_ref().map(|value| format!("\"{}\"", escape(value))).unwrap_or_else(|| "null".into());
    let timestamp = "2026-01-01T00:00:00.000Z";
    let record = format!(
        "{{\"schemaVersion\":1,\"eventId\":\"{}\",\"executionId\":\"{}\",\"invocationId\":\"{}\",\"parentInvocationId\":{},\"sequence\":\"{}\",\"emittedAt\":\"{}\",\"event\":\"{}\",\"function\":\"{}\",\"subsystem\":\"{}\",\"language\":\"rust\",\"runtime\":\"rust\",\"source\":{{\"projectPath\":\"{}\",\"line\":{},\"column\":1,\"revision\":{},\"buildId\":{},\"sourceIndexId\":{}}}}}\n",
        id("event"), escape(&invocation.execution_id), escape(&invocation.invocation_id), parent, sequence, timestamp, event,
        escape(&invocation.function), escape(&invocation.subsystem), escape(&invocation.project_path), invocation.line,
        optional_json(&config.revision), optional_json(&config.build_id), optional_json(&config.source_index_id),
    );
    let Ok(_guard) = RUNTIME.get_or_init(|| Mutex::new(None)).lock() else { return; };
    if record.len() as u64 > MAX_FILE_BYTES { return; }
    if fs::create_dir_all(&config.directory).is_err() { return; }
    let mut files: Vec<PathBuf> = fs::read_dir(&config.directory).ok().into_iter().flatten()
        .filter_map(|entry| entry.ok().map(|item| item.path()))
        .filter(|path| path.file_name().and_then(|name| name.to_str()).map(|name| name.starts_with("trace-") && name.ends_with(".jsonl")).unwrap_or(false))
        .collect();
    files.sort();
    let current = files.last().cloned().filter(|path| fs::metadata(path).map(|meta| meta.len() + record.len() as u64 <= MAX_FILE_BYTES).unwrap_or(false))
        .unwrap_or_else(|| config.directory.join(format!("trace-{:012}.jsonl", files.len())));
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&current) {
        let _ = file.write_all(record.as_bytes());
    }
    files.push(current);
    files.sort();
    while files.len() > MAX_FILES {
        if let Some(old) = files.first().cloned() { let _ = fs::remove_file(old); }
        files.remove(0);
    }
}
