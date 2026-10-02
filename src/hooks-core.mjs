function defaultClock() {
  return new Date().toISOString();
}

function isPromiseLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}

function requireStore(store) {
  if (!store || typeof store.append !== "function") throw new TypeError("store.append is required");
  return store;
}

/** Runtime-neutral tracing hooks. Context behavior is supplied by the runtime adapter. */
export function createTraceHooksWithContext({
  store,
  contextRuntime,
  clock = defaultClock,
  idPrefix = "trace",
  enabled = true,
  subsystems,
} = {}) {
  if (!contextRuntime || typeof contextRuntime.activeContext !== "function" || typeof contextRuntime.createContext !== "function" || typeof contextRuntime.runWithContext !== "function") {
    throw new TypeError("contextRuntime must provide activeContext, createContext, and runWithContext");
  }
  const recorder = requireStore(store);
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
  let recordingEnabled = enabled;
  let selectedSubsystems = normalizeSubsystems(subsystems);
  let nextId = 0;
  let nextSequence = 0n;
  const correlationId = (kind) => idPrefix + "-" + kind + "-" + ++nextId;
  const sequence = () => (++nextSequence).toString();

  function canRecord(metadata) {
    if (!recordingEnabled) return false;
    try {
      if (selectedSubsystems !== null && !selectedSubsystems.has(metadata?.subsystem)) return false;
      return typeof recorder.canAccept !== "function" || recorder.canAccept() !== false;
    } catch {
      return false;
    }
  }

  function configure(settings = {}) {
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
      throw new TypeError("settings must be an object");
    }
    if (Object.hasOwn(settings, "enabled")) {
      if (typeof settings.enabled !== "boolean") throw new TypeError("enabled must be a boolean");
      recordingEnabled = settings.enabled;
    }
    if (Object.hasOwn(settings, "subsystems")) selectedSubsystems = normalizeSubsystems(settings.subsystems);
  }

  function emit(event, metadata, context) {
    if (!canRecord(metadata)) return;
    try {
      const record = {
        schemaVersion: 1,
        eventId: correlationId("event"),
        executionId: context.executionId,
        invocationId: context.invocationId,
        parentInvocationId: context.parentInvocationId,
        sequence: sequence(),
        emittedAt: clock(),
        event,
        function: metadata.function,
        subsystem: metadata.subsystem,
        language: metadata.language,
        runtime: metadata.runtime,
        source: structuredClone(metadata.source),
      };
      const result = recorder.append(record);
      if (isPromiseLike(result)) Promise.resolve(result).catch(() => {});
    } catch {
      // Instrumentation must never change application behavior when recording fails.
    }
  }

  function wrap(functionValue, metadata) {
    if (typeof functionValue !== "function") throw new TypeError("functionValue must be a function");
    return function tracedFunction(...args) {
      if (!canRecord(metadata)) return functionValue.apply(this, args);
      const parent = contextRuntime.activeContext();
      const executionId = parent?.executionId ?? correlationId("execution");
      const invocationId = correlationId("invocation");
      const context = contextRuntime.createContext({
        executionId,
        invocationId,
        parentInvocationId: parent?.executionId === executionId ? parent.invocationId : null,
      });
      emit("enter", metadata, context);

      return contextRuntime.runWithContext(context, () => {
        try {
          const result = functionValue.apply(this, args);
          if (isPromiseLike(result)) {
            return Promise.resolve(result).then(
              (value) => {
                emit("exit", metadata, context);
                return value;
              },
              (error) => {
                emit("fail", metadata, context);
                throw error;
              },
            );
          }
          emit("exit", metadata, context);
          return result;
        } catch (error) {
          emit("fail", metadata, context);
          throw error;
        }
      });
    };
  }

  function trace(functionValue, metadata, ...args) {
    if (typeof functionValue !== "function") throw new TypeError("functionValue must be a function");
    if (!canRecord(metadata)) return functionValue(...args);
    return wrap(functionValue, metadata)(...args);
  }

  function invoke(functionValue, metadata, receiver, argsLike) {
    if (typeof functionValue !== "function") throw new TypeError("functionValue must be a function");
    if (!canRecord(metadata)) return functionValue.apply(receiver, argsLike);
    return wrap(functionValue, metadata).apply(receiver, Array.from(argsLike));
  }

  return Object.freeze({ wrap, trace, invoke, configure });
}

function normalizeSubsystems(subsystems) {
  if (subsystems === undefined || subsystems === null) return null;
  if (!Array.isArray(subsystems) || subsystems.some((subsystem) => typeof subsystem !== "string" || subsystem.length === 0)) {
    throw new TypeError("subsystems must be an array of non-empty strings");
  }
  return new Set(subsystems);
}
