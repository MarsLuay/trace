"""Privacy-preserving Python runtime adapter for @marsluay/trace.

The profiler records control-flow and source identity only. It never serializes
function arguments, return values, prompts, or exception text.
"""

from __future__ import annotations

import base64
import contextvars
import fnmatch
import functools
import inspect
import json
import os
from pathlib import Path
import sys
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Mapping


_ID_LIMIT = 256
_CONTEXT: contextvars.ContextVar[dict[str, str] | None] = contextvars.ContextVar("trace_context", default=None)


def _identifier(prefix: str) -> str:
    return f"py-{prefix}-{uuid.uuid4().hex}"


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _safe_id(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= _ID_LIMIT and all(
        character.isalnum() or character in "._:-" for character in value
    )


def serialize_correlation_context(context: Mapping[str, Any] | None) -> str | None:
    if not isinstance(context, Mapping) or set(context) != {"executionId", "invocationId"}:
        return None
    if not _safe_id(context["executionId"]) or not _safe_id(context["invocationId"]):
        return None
    raw = json.dumps({"executionId": context["executionId"], "invocationId": context["invocationId"]}, separators=(",", ":")).encode()
    if len(raw) > 1024:
        return None
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def deserialize_correlation_context(value: Any) -> dict[str, str] | None:
    if not isinstance(value, str) or not value or len(value) > 2048:
        return None
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        decoded = json.loads(raw.decode())
    except (ValueError, TypeError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(decoded, dict) or set(decoded) != {"executionId", "invocationId"}:
        return None
    if not _safe_id(decoded["executionId"]) or not _safe_id(decoded["invocationId"]):
        return None
    return {"executionId": decoded["executionId"], "invocationId": decoded["invocationId"]}


def inject_correlation(carrier: Mapping[str, Any] | None = None, context: Mapping[str, Any] | None = None, header: str = "x-trace-correlation") -> dict[str, Any]:
    if not isinstance(carrier, Mapping) or not isinstance(header, str) or not header:
        return dict(carrier) if isinstance(carrier, Mapping) else {}
    result = dict(carrier)
    encoded = serialize_correlation_context(context)
    if encoded:
        result[header] = encoded
    return result


def extract_correlation(carrier: Mapping[str, Any] | None, header: str = "x-trace-correlation") -> dict[str, str] | None:
    if not isinstance(carrier, Mapping) or not isinstance(header, str) or not header:
        return None
    return deserialize_correlation_context(carrier.get(header))


class _BoundedStore:
    def __init__(self, directory: str | os.PathLike[str], max_file_bytes: int, max_files: int) -> None:
        self.directory = Path(directory)
        self.max_file_bytes = max_file_bytes
        self.max_files = max_files
        self.lock = threading.Lock()
        self.counter = 0

    def append(self, event: dict[str, Any]) -> None:
        line = (json.dumps(event, separators=(",", ":")) + "\n").encode()
        if len(line) > self.max_file_bytes:
            return
        with self.lock:
            self.directory.mkdir(parents=True, exist_ok=True)
            files = sorted(self.directory.glob("trace-*.jsonl"))
            current = files[-1] if files else None
            if current is None or current.stat().st_size + len(line) > self.max_file_bytes:
                current = self.directory / f"trace-{self.counter:012d}.jsonl"
                self.counter += 1
            with current.open("ab") as stream:
                stream.write(line)
            files = sorted(self.directory.glob("trace-*.jsonl"))
            for old in files[:-self.max_files]:
                old.unlink(missing_ok=True)


class TraceRuntime:
    """Automatically profile owned Python functions into the shared JSONL store."""

    def __init__(
        self,
        directory: str | os.PathLike[str],
        project_root: str | os.PathLike[str] | None = None,
        owned_roots: tuple[str, ...] | list[str] | None = None,
        excluded: tuple[str, ...] | list[str] | None = None,
        subsystem: str = "python",
        revision: str | None = None,
        build_id: str | None = None,
        source_index_id: str | None = None,
        sequence_start: int = 0,
        execution_id: str | None = None,
        max_file_bytes: int = 1024 * 1024,
        max_files: int = 8,
    ) -> None:
        if not isinstance(subsystem, str) or not subsystem:
            raise TypeError("subsystem must be a non-empty string")
        if not isinstance(sequence_start, int) or sequence_start < 0:
            raise TypeError("sequence_start must be a non-negative integer")
        self.project_root = Path(project_root or os.getcwd()).resolve()
        roots = owned_roots or (".",)
        self.owned_roots = tuple((self.project_root / root).resolve() for root in roots)
        self.excluded = tuple(excluded or ("vendor/**", "generated/**", "build/**", "dist/**", "__pycache__/**"))
        self.subsystem = subsystem
        self.revision = revision
        self.build_id = build_id
        self.source_index_id = source_index_id
        self.store = _BoundedStore(directory, max_file_bytes, max_files)
        self.execution_id = execution_id or _identifier("execution")
        self.sequence = sequence_start
        self._frames: dict[int, tuple[dict[str, Any], contextvars.Token[dict[str, str] | None]]] = {}
        self._failed_frames: set[int] = set()
        self._decorated_codes: set[Any] = set()
        self._previous_profile: Callable[..., Any] | None = None
        self._lock = threading.Lock()

    @property
    def active_context(self) -> dict[str, str] | None:
        return _CONTEXT.get()

    def _owned_path(self, filename: str) -> str | None:
        if not filename or filename.startswith("<"):
            return None
        try:
            path = Path(filename).resolve()
        except (OSError, ValueError):
            return None
        relative = None
        for root in self.owned_roots:
            try:
                candidate = path.relative_to(root)
            except ValueError:
                continue
            relative = candidate.as_posix()
            break
        if relative is None or path.suffix.lower() != ".py":
            return None
        if any(fnmatch.fnmatch(relative, pattern) or fnmatch.fnmatch(relative, f"*/{pattern}") for pattern in self.excluded):
            return None
        return relative

    def _event(self, event: str, frame: Any, invocation: dict[str, Any]) -> None:
        with self._lock:
            self.sequence += 1
            sequence = str(self.sequence)
        source = {
            "projectPath": invocation["projectPath"],
            "line": invocation["line"],
            "column": 1,
            "revision": self.revision,
            "buildId": self.build_id,
            "sourceIndexId": self.source_index_id,
        }
        self.store.append({
            "schemaVersion": 1,
            "eventId": _identifier("event"),
            "executionId": invocation["executionId"],
            "invocationId": invocation["invocationId"],
            "parentInvocationId": invocation["parentInvocationId"],
            "sequence": sequence,
            "emittedAt": _timestamp(),
            "event": event,
            "function": invocation["function"],
            "subsystem": invocation["subsystem"],
            "language": "python",
            "runtime": "python",
            "source": source,
        })

    def _begin(self, frame: Any, project_path: str, function_name: str) -> None:
        parent = _CONTEXT.get()
        invocation = {
            "executionId": parent["executionId"] if parent else self.execution_id,
            "invocationId": _identifier("invocation"),
            "parentInvocationId": parent["invocationId"] if parent else None,
            "projectPath": project_path,
            "function": function_name,
            "subsystem": self.subsystem,
            "line": max(1, int(getattr(frame, "f_lineno", getattr(frame, "co_firstlineno", 1)))),
        }
        token = _CONTEXT.set({"executionId": invocation["executionId"], "invocationId": invocation["invocationId"]})
        self._frames[id(frame)] = (invocation, token)
        self._event("enter", frame, invocation)

    def _end(self, frame: Any, failed: bool = False) -> None:
        entry = self._frames.pop(id(frame), None)
        if entry is None:
            return
        invocation, token = entry
        self._event("fail" if failed else "exit", frame, invocation)
        _CONTEXT.reset(token)

    def _trace(self, frame: Any, event: str, arg: Any) -> Callable[..., Any] | None:
        frame_id = id(frame)
        if event == "call":
            if frame.f_code not in self._decorated_codes:
                path = self._owned_path(frame.f_code.co_filename)
                if path is not None:
                    self._begin(frame, path, frame.f_code.co_name)
            return self._trace
        if event == "exception" and frame_id in self._frames:
            self._failed_frames.add(frame_id)
        elif event == "line":
            self._failed_frames.discard(frame_id)
        elif event == "return" and frame_id in self._frames:
            self._end(frame, failed=frame_id in self._failed_frames)
            self._failed_frames.discard(frame_id)
        return self._trace

    def start(self) -> "TraceRuntime":
        if self._previous_profile is None:
            self._previous_profile = sys.gettrace()
            sys.settrace(self._trace)
        return self

    def stop(self) -> None:
        if self._previous_profile is not None:
            sys.settrace(self._previous_profile)
            self._previous_profile = None
            self._frames.clear()
            self._failed_frames.clear()

    def trace(self, function: Callable[..., Any]) -> Callable[..., Any]:
        """Trace a function explicitly; useful for async functions whose task resumes after await."""
        if not callable(function):
            raise TypeError("function must be callable")
        self._decorated_codes.add(function.__code__)
        path = self._owned_path(function.__code__.co_filename)
        if path is None:
            return function

        if inspect.iscoroutinefunction(function):
            @functools.wraps(function)
            async def traced_async(*args: Any, **kwargs: Any) -> Any:
                parent = _CONTEXT.get()
                invocation = {
                    "executionId": parent["executionId"] if parent else self.execution_id,
                    "invocationId": _identifier("invocation"),
                    "parentInvocationId": parent["invocationId"] if parent else None,
                    "projectPath": path,
                    "function": function.__name__,
                    "subsystem": self.subsystem,
                    "line": function.__code__.co_firstlineno,
                }
                token = _CONTEXT.set({"executionId": invocation["executionId"], "invocationId": invocation["invocationId"]})
                frame = inspect.currentframe()
                self._event("enter", frame or function, invocation)
                try:
                    result = await function(*args, **kwargs)
                except BaseException:
                    self._event("fail", frame or function, invocation)
                    raise
                else:
                    self._event("exit", frame or function, invocation)
                    return result
                finally:
                    _CONTEXT.reset(token)
            self._decorated_codes.add(traced_async.__code__)
            return traced_async

        @functools.wraps(function)
        def traced_sync(*args: Any, **kwargs: Any) -> Any:
            parent = _CONTEXT.get()
            invocation = {
                "executionId": parent["executionId"] if parent else self.execution_id,
                "invocationId": _identifier("invocation"),
                "parentInvocationId": parent["invocationId"] if parent else None,
                "projectPath": path,
                "function": function.__name__,
                "subsystem": self.subsystem,
                "line": function.__code__.co_firstlineno,
            }
            token = _CONTEXT.set({"executionId": invocation["executionId"], "invocationId": invocation["invocationId"]})
            frame = inspect.currentframe()
            self._event("enter", frame or function, invocation)
            try:
                result = function(*args, **kwargs)
            except BaseException:
                self._event("fail", frame or function, invocation)
                raise
            else:
                self._event("exit", frame or function, invocation)
                return result
            finally:
                _CONTEXT.reset(token)
        self._decorated_codes.add(traced_sync.__code__)
        return traced_sync

    async def run_with_propagated_context(self, carrier: Mapping[str, Any] | None, callback: Callable[..., Any], *args: Any, header: str = "x-trace-correlation", **kwargs: Any) -> Any:
        parent = extract_correlation(carrier, header)
        if not parent:
            return await callback(*args, **kwargs) if inspect.iscoroutinefunction(callback) else callback(*args, **kwargs)
        token = _CONTEXT.set(parent)
        try:
            return await callback(*args, **kwargs) if inspect.iscoroutinefunction(callback) else callback(*args, **kwargs)
        finally:
            _CONTEXT.reset(token)
