const DEFAULT_ENDPOINT = "/api/trace/events";

/** Fail-open browser recorder for a server-owned TraceStore. */
export function createBrowserTraceRecorder({
  endpoint = DEFAULT_ENDPOINT,
  fetcher = globalThis.fetch,
  headers = {},
  maxPendingEvents = 256,
  maxBatchEvents = 32,
  batchDelayMs = 10,
} = {}) {
  if (typeof endpoint !== "string" || endpoint.length === 0) throw new TypeError("endpoint is required");
  if (!Number.isInteger(maxPendingEvents) || maxPendingEvents < 1) throw new TypeError("maxPendingEvents must be a positive integer");
  if (!Number.isInteger(maxBatchEvents) || maxBatchEvents < 1) throw new TypeError("maxBatchEvents must be a positive integer");
  if (!Number.isFinite(batchDelayMs) || batchDelayMs < 0) throw new TypeError("batchDelayMs must be a non-negative number");

  let pendingCount = 0;
  let pending = [];
  let timer = null;
  let flushTask = null;
  let closed = false;

  function canAccept() {
    return !closed && typeof fetcher === "function" && pendingCount < maxPendingEvents;
  }

  function scheduleFlush() {
    if (closed || flushTask !== null) return;
    if (pending.length >= maxBatchEvents) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      void startFlush();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void startFlush();
    }, batchDelayMs);
  }

  function startFlush() {
    if (flushTask !== null) return flushTask;
    const batch = pending.splice(0, maxBatchEvents);
    if (batch.length === 0) return Promise.resolve();
    flushTask = (async () => {
      let accepted = false;
      try {
        const response = await fetcher(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: "{\"events\":[" + batch.map((item) => item.encodedEvent).join(",") + "]}",
          keepalive: true,
        });
        accepted = response?.ok !== false;
      } catch {
        accepted = false;
      }
      for (const item of batch) {
        item.resolve(accepted);
        pendingCount -= 1;
      }
    })().finally(() => {
      flushTask = null;
      if (pending.length > 0) scheduleFlush();
    });
    return flushTask;
  }

  async function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    while (flushTask !== null || pending.length > 0) {
      if (flushTask !== null) await flushTask;
      else await startFlush();
    }
  }

  async function close() {
    closed = true;
    await flush();
  }

  function append(event) {
    if (!canAccept()) return false;
    let encodedEvent;
    try {
      encodedEvent = JSON.stringify(event);
    } catch {
      return false;
    }
    if (encodedEvent === undefined) return false;
    pendingCount += 1;
    const result = new Promise((resolve) => {
      pending.push({ encodedEvent, resolve });
    });
    scheduleFlush();
    return result;
  }

  return Object.freeze({ append, canAccept, flush, close });
}
