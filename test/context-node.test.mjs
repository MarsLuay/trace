import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  activeContext,
  bindContext,
  createContext,
  runChildInvocation,
  runWithContext,
} from "../src/context-node.mjs";

const root = createContext({ executionId: "exec-node", invocationId: "root" });

test("nested sync and async invocations retain their parent context", async () => {
  assert.equal(activeContext(), null);
  await runWithContext(root, async () => {
    assert.deepEqual(activeContext(), root);
    await delay(1);
    const child = await runChildInvocation({ executionId: "exec-node", invocationId: "child" }, async () => {
      assert.deepEqual(activeContext(), {
        executionId: "exec-node",
        invocationId: "child",
        parentInvocationId: "root",
      });
      await delay(1);
      return activeContext();
    });
    assert.equal(child.parentInvocationId, "root");
    assert.deepEqual(activeContext(), root);
  });
  assert.equal(activeContext(), null);
});

test("concurrent flows remain isolated", async () => {
  const result = await runWithContext(root, async () =>
    Promise.all(
      ["left", "right"].map((invocationId, index) =>
        runChildInvocation({ executionId: "exec-node", invocationId }, async () => {
          await delay(index === 0 ? 3 : 1);
          const before = activeContext();
          await delay(index === 0 ? 1 : 3);
          return { before, after: activeContext() };
        }),
      ),
    ),
  );
  assert.deepEqual(result.map(({ before }) => before.invocationId), ["left", "right"]);
  assert.deepEqual(result.map(({ after }) => after.invocationId), ["left", "right"]);
  assert.deepEqual(result.map(({ before }) => before.parentInvocationId), ["root", "root"]);
});

test("rejected operations keep failure context and restore their parent", async () => {
  await runWithContext(root, async () => {
    const failure = new Error("expected");
    await assert.rejects(
      runChildInvocation({ executionId: "exec-node", invocationId: "failing" }, async () => {
        await delay(1);
        assert.equal(activeContext().invocationId, "failing");
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.deepEqual(activeContext(), root);
  });
});

test("bound callbacks preserve this and the selected hidden context", async () => {
  const receiver = {
    value: 42,
    read() {
      return { value: this.value, context: activeContext() };
    },
  };
  const result = await runWithContext(root, () =>
    new Promise((resolve) => setImmediate(bindContext(function resolveValue() {
      resolve(receiver.read.call(receiver));
    }))),
  );
  assert.equal(result.value, 42);
  assert.deepEqual(result.context, root);
});
