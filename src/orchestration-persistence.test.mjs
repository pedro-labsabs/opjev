import assert from "node:assert/strict";
import { test } from "node:test";
import { persistOrchestrationRun } from "./plugin-runtime.ts";

test("canonical run keeps bounded executor-decision provenance across checkpoints", async () => {
  const records = new Map();
  const ctx = { storage: {
    get: async key => records.get(key),
    set: async (key, value) => records.set(key, value),
  } };
  const state = { contract: { runID: "run-smoke" }, phase: "running", round: 1, history: [] };
  await persistOrchestrationRun(ctx, {
    kind: "worker-created",
    runID: "run-smoke",
    state,
    at: 1,
    selection: {
      agent: "build",
      model: "opencode/big-pickle",
      via: "jev",
      route: "fast-coding",
      confidence: 0.91,
      overridden: false,
      explanation: { prompt: "must not persist" },
      error: "must not persist",
    },
  });
  await persistOrchestrationRun(ctx, { kind: "verdict-applied", runID: "run-smoke", state, at: 2 });

  const saved = records.get("orchestration/run/run-smoke");
  assert.deepEqual(saved.selection, {
    agent: "build",
    model: "opencode/big-pickle",
    via: "jev",
    route: "fast-coding",
    confidence: 0.91,
    overridden: false,
  });
  assert.equal(saved.checkpoint, "verdict-applied");
  assert.equal(JSON.stringify(saved).includes("must not persist"), false);
});
