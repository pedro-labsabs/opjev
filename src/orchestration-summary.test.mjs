import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EXECUTION_SUMMARY_MAX_AGE_MS, summarizeExecutionRun } from "./orchestration/summary.ts";

describe("execution summary", () => {
  it("projects current task, route, progress, and bounded recovery events", () => {
    const result = summarizeExecutionRun({
      updatedAt: 1000,
      state: {
        phase: "executing",
        round: 2,
        contract: { maxRounds: 4 },
        executor: { agent: "build-agent", model: "free-model" },
        history: [
          { round: 1, verdict: { nextAction: "repair-same" } },
          { round: 2, verdict: { nextAction: "switch-model" } },
          { round: 3, verdict: { nextAction: "ignore-this" } },
        ],
      },
    }, 1000);

    assert.equal(result.available, true);
    assert.equal(result.taskState, "executing");
    assert.equal(result.route, "build-agent / free-model");
    assert.equal(result.round, 2);
    assert.equal(result.maxRounds, 4);
    assert.equal(result.progress, "Round 2 of 4");
    assert.deepEqual(result.recoveryEvents, ["Round 1: repair-same", "Round 2: switch-model"]);
  });

  it("includes resume and stop recovery events when present", () => {
    const result = summarizeExecutionRun({
      updatedAt: 1000,
      state: { phase: "executing", history: [
        { humanDecision: { action: "resume" } },
        { humanDecision: { action: "stop" } },
      ] },
    }, 1000);
    assert.deepEqual(result.recoveryEvents, ["Execution resumed after human review", "Stopped by human decision"]);
  });

  it("distinguishes completed, failed, and exhausted-limit outcomes", () => {
    const summarize = (state) => summarizeExecutionRun({ updatedAt: 1000, state }, 1000);

    const completed = summarize({ phase: "completed" });
    const failed = summarize({ phase: "failed", lastError: "worker crashed" });
    const limited = summarize({
      phase: "awaiting-human",
      round: 4,
      contract: { maxRounds: 4 },
      pendingHuman: { reason: "Review the final attempt" },
    });

    assert.equal(completed.outcome, "completed");
    assert.equal(completed.taskState, "completed");
    assert.equal(completed.detail, undefined);

    assert.equal(failed.outcome, "failed");
    assert.equal(failed.taskState, "failed");
    assert.equal(failed.detail, "worker crashed");
    assert.notEqual(failed.outcome, completed.outcome);

    assert.equal(limited.outcome, "limit-reached");
    assert.equal(limited.taskState, "awaiting-human");
    assert.equal(limited.progress, "Round 4 of 4");
    assert.equal(limited.detail, "Round limit reached; awaiting human review");
    assert.notEqual(limited.outcome, failed.outcome);
  });

  it("gracefully reports missing, malformed, stale, and changing state as unavailable", () => {
    const summarize = (record, now = 1000) => {
      assert.doesNotThrow(() => summarizeExecutionRun(record, now));
      return summarizeExecutionRun(record, now);
    };
    assert.deepEqual(summarize(undefined), { available: false });
    assert.deepEqual(summarize({ updatedAt: 1000, state: null }), { available: false });
    assert.deepEqual(summarize({ updatedAt: 1000, state: { phase: "  " } }), { available: false });
    assert.deepEqual(summarize({ updatedAt: 0, state: { phase: "executing" } }, EXECUTION_SUMMARY_MAX_AGE_MS + 1), { available: false });
    assert.deepEqual(summarize({ updatedAt: 1001, state: { phase: "executing" } }, 1000), { available: false });

    const changing = { updatedAt: 1000, get state() { throw new Error("state disappeared"); } };
    assert.deepEqual(summarize(changing), { available: false });
  });

  it("does not label a non-exhausted human-review state as limit reached", () => {
    const result = summarizeExecutionRun({
      updatedAt: 1000,
      state: { phase: "awaiting-human", round: 2, contract: { maxRounds: 4 } },
    }, 1000);
    assert.equal(result.outcome, undefined);
  });
});
