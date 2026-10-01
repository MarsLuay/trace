import assert from "node:assert/strict";
import test from "node:test";

import { createSubsystemClassifier } from "../src/subsystems.mjs";

const symbols = [
  { projectPath: "src/ui/browserToggle.ts", moduleName: "browserToggle", functionName: "toggle", runtime: "browser", layer: "ui", entryPoint: true },
  { projectPath: "src/electron/browserBackend.ts", moduleName: "browserBackend", functionName: "open", runtime: "electron-main", layer: "backend" },
  { projectPath: "src/chat/conversation.ts", moduleName: "conversation", functionName: "sendMessage", runtime: "node", layer: "server" },
  { projectPath: "src/chat/message.ts", moduleName: "message", functionName: "parseMessage", runtime: "node", layer: "server" },
  { projectPath: "src/weak/ax.ts", moduleName: "ax", functionName: "run", runtime: "node" },
];

test("rules take strict precedence over deterministic feature inference", () => {
  const classifier = createSubsystemClassifier({
    functionRules: { toggle: "chat" },
    fileRules: { "src/electron/browserBackend.ts": "providers" },
    pathRules: [
      { pattern: "src/**", subsystem: "generic" },
      { pattern: "src/chat/**", subsystem: "chat" },
    ],
    packageRules: { workspace: "workspace" },
  });
  const result = classifier.classifyAll(symbols.map((symbol) => ({ ...symbol, packageName: "workspace" })));
  const byPath = new Map(result.assignments.map((assignment) => [assignment.projectPath, assignment]));
  assert.equal(byPath.get("src/ui/browserToggle.ts").subsystem, "chat");
  assert.equal(byPath.get("src/electron/browserBackend.ts").subsystem, "providers");
  assert.equal(byPath.get("src/chat/conversation.ts").subsystem, "chat");
  assert.equal(byPath.get("src/weak/ax.ts").subsystem, "generic");
});

test("feature identities converge across runtime and layer roots without a count ceiling", () => {
  const classifier = createSubsystemClassifier({ evidenceThreshold: 2 });
  const result = classifier.classifyAll(symbols);
  const browser = result.assignments.filter(({ subsystem }) => subsystem === "browser");
  assert.equal(browser.length, 2);
  assert.equal(browser[0].runtime === browser[1].runtime, false);
  assert.ok(result.count >= 2);
  assert.equal(result.assignments.find(({ projectPath }) => projectPath === "src/weak/ax.ts").subsystem, "unclassified");

  const many = Array.from({ length: 24 }, (_, index) => ({
    projectPath: `features/feature${index}.ts`,
    moduleName: `feature${index}`,
    functionName: `runFeature${index}`,
  }));
  const manyResult = classifier.classifyAll(many);
  assert.ok(manyResult.count > 20);
});

test("classification identity, assignments, and canonical names are reproducible", () => {
  const classifier = createSubsystemClassifier({ version: "classifier-test-v2", stopWords: ["browser", "toggle"] });
  const first = classifier.classifyAll(symbols);
  const second = classifier.classifyAll(structuredClone(symbols));
  assert.equal(first.classifierId, second.classifierId);
  assert.deepEqual(first.assignments, second.assignments);
  assert.deepEqual(first.subsystems, second.subsystems);
  assert.equal(first.assignments.find(({ projectPath }) => projectPath === "src/ui/browserToggle.ts").subsystem, "unclassified");
});

test("ambiguous evidence is returned as deterministic candidates", () => {
  const classifier = createSubsystemClassifier({ evidenceThreshold: 2 });
  const result = classifier.classifyAll([
    { projectPath: "src/one/alphaBeta.ts", moduleName: "alphaBeta", functionName: "run" },
    { projectPath: "src/two/alphaBeta.ts", moduleName: "alphaBeta", functionName: "run" },
  ]);
  const assignments = result.assignments;
  assert.equal(assignments[0].subsystem, "unclassified");
  assert.deepEqual(assignments[0].candidates, ["alpha", "beta"]);
});

test("entry points remain real indexed symbols and ambiguity is explicit", () => {
  const classifier = createSubsystemClassifier({ pathRules: [{ pattern: "src/chat/**", subsystem: "chat" }] });
  const result = classifier.classifyAll([
    { projectPath: "src/chat/a.ts", functionName: "startA", entryPoint: true },
    { projectPath: "src/chat/b.ts", functionName: "startB", entryPoint: true },
  ]);
  const subsystem = result.assignments[0].subsystem;
  const entries = classifier.entryCandidates(result, subsystem);
  assert.equal(entries.status, "candidates");
  assert.deepEqual(entries.candidates, [result.assignments[0].identity, result.assignments[1].identity]);
});
