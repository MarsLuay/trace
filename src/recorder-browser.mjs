const DEFAULT_ENDPOINT = "/api/trace/events";

/** Fail-open browser recorder for a server-owned TraceStore. */
export function createBrowserTraceRecorder({ endpoint = DEFAULT_ENDPOINT, fetcher = globalThis.fetch, headers = {} } = {}) {
  if (typeof endpoint !== "string" || endpoint.length === 0) throw new TypeError("endpoint is required");
  return Object.freeze({
    append(event) {
      if (typeof fetcher !== "function") return false;
      try {
        const result = fetcher(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(event),
          keepalive: true,
        });
        return Promise.resolve(result).then(() => true, () => false);
      } catch {
        return false;
      }
    },
  });
}
