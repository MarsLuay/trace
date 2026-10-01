import { TraceContractError, validateTrace } from "./contract.mjs";

function graphError(message) {
  return new TraceContractError([{ path: "$", message }]);
}

function nodeKey(executionId, invocationId) {
  return `${executionId}\u0000${invocationId}`;
}

function sequenceValue(value) {
  return BigInt(value);
}

function compareNodes(left, right) {
  const leftSequence = sequenceValue(left.startedSequence);
  const rightSequence = sequenceValue(right.startedSequence);
  if (leftSequence < rightSequence) return -1;
  if (leftSequence > rightSequence) return 1;
  const execution = left.executionId.localeCompare(right.executionId);
  if (execution !== 0) return execution;
  return left.invocationId.localeCompare(right.invocationId);
}

function semanticIdentity(event) {
  return {
    function: event.function,
    subsystem: event.subsystem,
    language: event.language,
    runtime: event.runtime,
    source: structuredClone(event.source),
  };
}

function makeNode(event) {
  return {
    executionId: event.executionId,
    invocationId: event.invocationId,
    parentInvocationId: event.parentInvocationId,
    ...semanticIdentity(event),
    status: "incomplete",
    startedSequence: event.sequence,
    endedSequence: null,
    children: [],
    _parent: null,
  };
}

function serializeNode(node) {
  return {
    function: node.function,
    subsystem: node.subsystem,
    language: node.language,
    runtime: node.runtime,
    source: structuredClone(node.source),
    status: node.status,
    complete: node.status === "ok" || node.status === "failed",
    startedSequence: node.startedSequence,
    endedSequence: node.endedSequence,
    children: node.children.slice().sort(compareNodes).map(serializeNode),
  };
}

function markIncompleteDescendants(node) {
  for (const child of node.children) markIncompleteDescendants(child);
  if (node.status === "ok" && node.children.some((child) => child.status === "incomplete")) {
    node.status = "incomplete";
    node.endedSequence = null;
  }
}

function subsystemEntry(node) {
  return node._parent === null || node._parent.subsystem !== node.subsystem;
}

function buildExecution(events, executionId) {
  validateTrace(events);
  const nodes = new Map();
  const roots = [];

  for (const event of events.slice().sort((left, right) => sequenceValue(left.sequence) < sequenceValue(right.sequence) ? -1 : 1)) {
    const key = nodeKey(executionId, event.invocationId);
    if (event.event === "enter") {
      if (nodes.has(key)) throw graphError(`duplicate invocation ${event.invocationId}`);
      const node = makeNode(event);
      if (event.parentInvocationId === null) {
        roots.push(node);
      } else {
        const parent = nodes.get(nodeKey(executionId, event.parentInvocationId));
        if (!parent) throw graphError(`missing parent ${event.parentInvocationId}`);
        node._parent = parent;
        parent.children.push(node);
      }
      nodes.set(key, node);
      continue;
    }

    const node = nodes.get(key);
    if (!node) throw graphError(`completion without enter for ${event.invocationId}`);
    node.endedSequence = event.sequence;
    node.status = event.event === "fail" ? "failed" : "ok";
  }

  roots.forEach(markIncompleteDescendants);
  return {
    executionId,
    roots: roots.sort(compareNodes),
    nodes: [...nodes.values()].sort(compareNodes),
  };
}

/** Reconstruct independent execution trees without merging their roots. */
export function reconstructGraph(events) {
  if (!Array.isArray(events) || events.length === 0) throw graphError("events must be a non-empty array");
  const byExecution = new Map();
  for (const event of events) {
    if (!event || typeof event !== "object") throw graphError("events must contain objects");
    const group = byExecution.get(event.executionId) ?? [];
    group.push(event);
    byExecution.set(event.executionId, group);
  }
  const executions = [...byExecution.keys()]
    .sort()
    .map((executionId) => buildExecution(byExecution.get(executionId), executionId));
  const roots = executions.flatMap((execution) => execution.roots).sort(compareNodes);
  const nodes = executions.flatMap((execution) => execution.nodes).sort(compareNodes);
  return { executions, roots, nodes };
}

function latest(nodes) {
  return nodes.slice().sort((left, right) => {
    const order = compareNodes(left, right);
    return order === 0 ? 0 : -order;
  })[0] ?? null;
}

/** Return the latest distinct contiguous segment that entered a subsystem. */
export function querySubsystem(events, subsystem) {
  if (typeof subsystem !== "string" || subsystem.length === 0) throw graphError("subsystem must be non-empty");
  const graph = reconstructGraph(events);
  const entries = graph.nodes.filter((node) => node.subsystem === subsystem && subsystemEntry(node));
  const root = latest(entries);
  return {
    subsystem,
    latest: true,
    root: root ? serializeNode(root) : null,
  };
}

/** Resolve a function to its actual contiguous subsystem-entry ancestor. */
export function queryFunction(events, functionName) {
  if (typeof functionName !== "string" || functionName.length === 0) throw graphError("functionName must be non-empty");
  const graph = reconstructGraph(events);
  const target = latest(graph.nodes.filter((node) => node.function === functionName));
  if (!target) return { function: functionName, targetReached: false, root: null, target: null };

  let root = target;
  while (root._parent !== null && root._parent.subsystem === target.subsystem) root = root._parent;
  return {
    function: functionName,
    targetReached: true,
    subsystem: target.subsystem,
    root: serializeNode(root),
    target: serializeNode(target),
  };
}

export function graphToJSON(graph) {
  return { roots: graph.roots.map(serializeNode) };
}
