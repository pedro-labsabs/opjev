import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EXECUTION_SUMMARY_MAX_AGE_MS, summarizeExecutionRun } from "./orchestration/summary.ts";

describe("execution summary", () => {
  const state = (phase, overrides = {}) => ({
    phase,
    round: 1,
    contract: { maxRounds: 4 },
    history: [],
    ...overrides,
  });

  it("projects current task, route, progress, and bounded recovery events", () => {
    const result = summarizeExecutionRun({
      updatedAt: 1000,
      state: state("running", {
        round: 2,
        contract: { maxRounds: 4 },
        executor: { agent: "build-agent", model: "free-model" },
        history: [
          { round: 1, verdict: { nextAction: "repair-same" } },
          { round: 2, verdict: { nextAction: "switch-model" } },
          { round: 3, verdict: { nextAction: "ignore-this" } },
        ],
      }),
    }, 1000);

    assert.equal(result.available, true);
    assert.equal(result.taskState, "running");
    assert.equal(result.route, "build-agent / free-model");
    assert.equal(result.round, 2);
    assert.equal(result.maxRounds, 4);
    assert.equal(result.progress, "Round 2 of 4");
    assert.deepEqual(result.recoveryEvents, ["Round 1: repair-same", "Round 2: switch-model"]);
  });

  it("includes resume and stop recovery events when present", () => {
    const result = summarizeExecutionRun({
      updatedAt: 1000,
      state: state("running", { history: [
        { humanDecision: { action: "resume" } },
        { humanDecision: { action: "stop" } },
      ] }),
    }, 1000);
    assert.deepEqual(result.recoveryEvents, ["Execution resumed after human review", "Stopped by human decision"]);
  });

  it("distinguishes completed, failed, and exhausted-limit outcomes", () => {
    const summarize = (state) => summarizeExecutionRun({ updatedAt: 1000, state }, 1000);

    const completed = summarize(state("completed"));
    const failed = summarize(state("failed", { lastError: "worker crashed" }));
    const limited = summarize(state("awaiting-human", {
      round: 4,
      pendingHuman: {
        requestID: "human:4:4:max-rounds",
        kind: "max-rounds",
        round: 4,
        reason: "Review the final attempt",
        requiredAuthority: "increase-budget-or-stop",
        currentMaxRounds: 4,
        minimumMaxRounds: 5,
      },
    }));

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
    assert.deepEqual(summarize({ updatedAt: 1000, state: state("  ") }), { available: false });
    assert.deepEqual(summarize({ updatedAt: 0, state: state("running") }, EXECUTION_SUMMARY_MAX_AGE_MS + 1), { available: false });
    assert.deepEqual(summarize({ updatedAt: 1001, state: state("running") }, 1000), { available: false });

    const changing = { updatedAt: 1000, get state() { throw new Error("state disappeared"); } };
    assert.deepEqual(summarize(changing), { available: false });
  });

  it("does not label a non-exhausted human-review state as limit reached", () => {
    const result = summarizeExecutionRun({
      updatedAt: 1000,
      state: state("awaiting-human", {
        round: 2,
        pendingHuman: {
          requestID: "human:2:1:jev-human",
          kind: "jev-human",
          round: 2,
          reason: "Review needed",
          requiredAuthority: "resume-or-stop",
          currentMaxRounds: 4,
          minimumMaxRounds: 3,
        },
      }),
    }, 1000);
    assert.equal(result.outcome, undefined);
  });

  it("keeps stopped distinct from failed", () => {
    const result = summarizeExecutionRun({ updatedAt: 1000, state: state("stopped") }, 1000);
    assert.equal(result.available, true);
    assert.equal(result.taskState, "stopped");
    assert.equal(result.outcome, "stopped");
    assert.equal(result.detail, "Execution safely stopped");
    assert.notEqual(result.outcome, "failed");
  });

  it("keeps a kernel failure visible when human notification left its request on the state", () => {
    const result = summarizeExecutionRun({ updatedAt: 1000, state: state("failed", {
      lastError: "human notification failed",
      pendingHuman: {
        requestID: "human:1:1:jev-human",
        kind: "jev-human",
        round: 1,
        reason: "Review needed",
        requiredAuthority: "resume-or-stop",
        currentMaxRounds: 4,
        minimumMaxRounds: 2,
      },
    }) }, 1000);
    assert.equal(result.available, true);
    assert.equal(result.outcome, "failed");
    assert.equal(result.detail, "human notification failed");
  });

  it("rejects unknown and invented persisted phases", () => {
    for (const phase of ["executing", "limit-reached", "unknown"]) {
      assert.deepEqual(
        summarizeExecutionRun({ updatedAt: 1000, state: state(phase) }, 1000),
        { available: false },
      );
    }
  });

  it("derives limit reached only from a matching exhausted max-rounds human request", () => {
    const exhausted = summarizeExecutionRun({
      updatedAt: 1000,
      state: state("awaiting-human", {
        round: 4,
        pendingHuman: {
          requestID: "human:4:4:max-rounds",
          kind: "max-rounds",
          round: 4,
          reason: "Budget exhausted",
          requiredAuthority: "increase-budget-or-stop",
          currentMaxRounds: 4,
          minimumMaxRounds: 5,
        },
      }),
    }, 1000);
    const forgedBudget = summarizeExecutionRun({
      updatedAt: 1000,
      state: state("awaiting-human", {
        round: 4,
        pendingHuman: {
          requestID: "human:4:4:jev-human",
          kind: "jev-human",
          round: 4,
          reason: "Human review",
          requiredAuthority: "resume-or-stop",
          currentMaxRounds: 4,
          minimumMaxRounds: 5,
        },
      }),
    }, 1000);
    assert.equal(exhausted.outcome, "limit-reached");
    assert.equal(forgedBudget.outcome, undefined);
  });
});
