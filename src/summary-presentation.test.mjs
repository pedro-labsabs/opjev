import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeExecutionNotice,
  composeExecutionNoticeFromLookup,
  deliverExecutionNoticeWithRetry,
  formatActiveExecutionSummary,
} from "./orchestration/summary-presentation.ts";

test("route retry then shown preserves the composed summary and refresh notice", async () => {
  const notice = "Orquestracao run-1: fase completed, rodada 1.";
  const displayNotice = composeExecutionNotice(notice, {
    available: true,
    taskState: "repairing",
    route: "builder / free-model",
    round: 1,
    maxRounds: 3,
    progress: "Round 1 of 3",
    recoveryEvents: ["Round 1: repair-same"],
  });
  const rendered = [];
  let refreshed;
  let attempt = 0;

  const outcome = await deliverExecutionNoticeWithRetry({
    displayNotice,
    render(message) {
      rendered.push(message);
      return ++attempt === 1 ? "retry" : "shown";
    },
    refresh(message) { refreshed = message; },
    deadline: 1000,
    now: () => 0,
    retryIntervalMs: 200,
    wait: async (ms) => assert.equal(ms, 200),
  });

  assert.equal(outcome, "shown");
  assert.deepEqual(rendered, [displayNotice, displayNotice]);
  assert.equal(refreshed, displayNotice);
  assert.match(refreshed, /Recovery: Round 1: repair-same/);
  assert.match(refreshed, /Orquestracao run-1/);
});

test("unavailable summary preserves the original notice through rendering and refresh", async () => {
  const notice = "Orquestracao run-2: fase failed, rodada 2. Erro: worker crashed";
  const displayNotice = composeExecutionNotice(notice, { available: false });
  let rendered;
  let refreshed;

  const outcome = await deliverExecutionNoticeWithRetry({
    displayNotice,
    render(message) { rendered = message; return "shown"; },
    refresh(message) { refreshed = message; },
    deadline: 1000,
    now: () => 0,
    retryIntervalMs: 200,
    wait: async () => {},
  });

  assert.equal(outcome, "shown");
  assert.equal(displayNotice, notice);
  assert.equal(rendered, notice);
  assert.equal(refreshed, notice);
});

test("terminal summary lookup requires the matching bound run and falls back on RPC failure", async () => {
  const notice = "Original terminal notice";
  const summary = {
    available: true,
    taskState: "completed",
    progress: "Round 1 of 2",
  };
  assert.equal(await composeExecutionNoticeFromLookup(notice, "run-1", async () => ({
    runID: "run-1",
    summary,
  })), "Task: completed\nRound 1 of 2\n\nOriginal terminal notice");
  assert.equal(await composeExecutionNoticeFromLookup(notice, "run-1", async () => ({
    runID: "run-2",
    summary,
  })), notice);
  assert.equal(await composeExecutionNoticeFromLookup(notice, "run-1", async () => {
    throw new Error("storage unavailable");
  }), notice);
});

test("composed notices stay within the TUI message bound while retaining the original notice", () => {
  const notice = "N".repeat(1900);
  const result = composeExecutionNotice(notice, {
    available: true,
    taskState: "repairing",
    route: "builder / free-model",
    round: 1,
    maxRounds: 3,
    recoveryEvents: ["R".repeat(120)],
  });
  assert.ok(result.length <= 2000);
  const originalPart = result.slice(result.lastIndexOf("\n\n") + 2);
  assert.ok(originalPart.length > 0);
  assert.ok(notice.startsWith(originalPart));
});

test("active summary text makes its canonical task phase visible", () => {
  const result = formatActiveExecutionSummary({
    available: true,
    taskState: "repairing",
    route: "builder / free-model",
    progress: "Round 2 of 4",
    recoveryEvents: ["Round 1: repair-same"],
  });
  assert.equal(result, "Task: repairing\nRoute: builder / free-model\nRound 2 of 4\nRecovery: Round 1: repair-same");
});
