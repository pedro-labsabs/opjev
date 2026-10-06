import { test } from "node:test";
import assert from "node:assert/strict";
import { createActiveSummaryPoller } from "./orchestration/active-summary-poller.ts";
import { createExecutionSummaryHandler } from "./orchestration/execution-summary-rpc.ts";
import { sessionBindingKey } from "./orchestration/admission.ts";

function fakeScheduler() {
  const intervals = new Map();
  const timeouts = new Map();
  let nextID = 0;
  return {
    intervals,
    timeouts,
    setInterval(fn, ms) {
      const id = ++nextID;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, ms) {
      const id = ++nextID;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("active summary polling renders changed recovery before terminal and deduplicates snapshots", async () => {
  const scheduler = fakeScheduler();
  const shown = [];
  const sessionID = "ses_summary_1";
  const runID = "run-summary-1";
  const records = new Map([
    [sessionBindingKey(sessionID), { runID, phase: "running" }],
    [`orchestration/run/${runID}`, {
      updatedAt: Date.now(),
      state: { phase: "running", round: 1, contract: { maxRounds: 3 }, executor: { agent: "builder", model: "free-model" }, history: [] },
    }],
  ]);
  const getActiveSummary = createExecutionSummaryHandler({ storage: { get: async (key) => records.get(key) } });
  let route = "ses_summary_1";
  const poller = createActiveSummaryPoller({
    async getSummary(id) { return (await getActiveSummary({ sessionID: id })).summary; },
    currentSessionID: () => route,
    present: (sessionID, summary) => shown.push({ sessionID, summary }),
    scheduler,
  });

  poller.start(route);
  await tick();
  assert.equal(shown[0].summary.taskState, "running");
  assert.equal([...scheduler.intervals.values()][0].ms, 1500);

  records.set(`orchestration/run/${runID}`, {
    updatedAt: Date.now(),
    state: {
      phase: "repairing",
      round: 1,
      contract: { maxRounds: 3 },
      executor: { agent: "builder", model: "free-model" },
      history: [{ round: 1, verdict: { nextAction: "repair-same" } }],
    },
  });
  [...scheduler.intervals.values()][0].fn();
  await tick();
  assert.equal(shown[1].summary.taskState, "repairing");
  assert.deepEqual(shown[1].summary.recoveryEvents, ["Round 1: repair-same"]);

  [...scheduler.intervals.values()][0].fn();
  await tick();
  assert.equal(shown.length, 2, "unchanged snapshot is not presented again");

  records.set(`orchestration/run/${runID}`, {
    updatedAt: Date.now(),
    state: { phase: "completed", round: 1, contract: { maxRounds: 3 }, history: [] },
  });
  [...scheduler.intervals.values()][0].fn();
  await tick();
  assert.equal(shown.length, 2, "terminal result stays on the existing result-delivery path");
  assert.equal(scheduler.intervals.size, 0, "polling stops after terminal phase");
});

test("active summary polling is bounded and stops when the current route changes", async () => {
  const scheduler = fakeScheduler();
  let route = "ses_summary_1";
  const poller = createActiveSummaryPoller({
    async getSummary() { return { available: true, taskState: "running" }; },
    currentSessionID: () => route,
    present() { assert.fail("must not present into a different route"); },
    scheduler,
  });
  poller.start("ses_summary_1");
  await tick();
  assert.equal([...scheduler.timeouts.values()][0].ms, 300_000);
  route = "ses_other";
  [...scheduler.intervals.values()][0].fn();
  await tick();
  assert.equal(scheduler.intervals.size, 0);
  assert.equal(scheduler.timeouts.size, 0);
});

test("active summary polling stops at its maximum lifetime", async () => {
  const scheduler = fakeScheduler();
  const poller = createActiveSummaryPoller({
    async getSummary() { return { available: false }; },
    currentSessionID: () => "ses_summary_1",
    present() { assert.fail("unavailable state must not be presented"); },
    scheduler,
  });
  poller.start("ses_summary_1");
  await tick();
  [...scheduler.timeouts.values()][0].fn();
  assert.equal(scheduler.intervals.size, 0);
  assert.equal(scheduler.timeouts.size, 0);
});
