import { test } from "node:test";
import assert from "node:assert/strict";
import { projectAcceptedResult } from "./orchestration/accepted-result.ts";
import { createAcceptedResultHandler, ExecutionSummaryRpc } from "./orchestration/execution-summary-rpc.ts";
import { sessionBindingKey } from "./orchestration/admission.ts";

const sessionID = "ses_result_parent_1";
const runID = "run-test-result-1";
const verified = (text = "WORKER_RESULT_262") => ({
  updatedAt: Date.now(),
  state: {
    phase: "completed", round: 1,
    contract: { runID, sessionID, maxRounds: 3 },
    evidence: { round: 1, resultSummary: text, deterministicChecks: [
      { name: "worker-session-outcome", status: "pass" },
      { name: "worker-final-response", status: "pass" },
      { name: "critic-session-outcome", status: "pass" },
    ] },
    lastVerdict: { nextAction: "accept", done: true },
  },
});

test("accepted result exposes exactly the bounded verified result to its parent", () => {
  assert.deepEqual(projectAcceptedResult(verified(), sessionID, runID), {
    available: true, text: "WORKER_RESULT_262",
  });
  assert.equal(projectAcceptedResult(verified("x".repeat(500)), sessionID, runID).text.length, 500);
});

test("result denies wrong parent, wrong run and unaccepted or unverifiable outcomes", () => {
  for (const r of [
    verified(),
    { ...verified(), state: { ...verified().state, phase: "failed" } },
    { ...verified(), state: { ...verified().state, lastVerdict: { nextAction: "repair-same", done: false } } },
    { ...verified(), state: { ...verified().state, evidence: { ...verified().state.evidence, deterministicChecks: [{ name: "critic-session-outcome", status: "fail" }] } } },
    verified(""),
    verified("x".repeat(501)),
  ]) {
    if (r.state.phase === "completed" && r.state.lastVerdict.nextAction === "accept" && r.state.evidence.resultSummary) {
      assert.deepEqual(projectAcceptedResult(r, "ses_other_parent", runID), { available: false });
      assert.deepEqual(projectAcceptedResult(r, sessionID, "run-other"), { available: false });
    } else assert.deepEqual(projectAcceptedResult(r, sessionID, runID), { available: false });
  }
});

test("RPC accepted-result lookup reads only binding and canonical run; never dispatches", async () => {
  const keys = [];
  const data = new Map([
    [sessionBindingKey(sessionID), { runID }],
    [`orchestration/run/${runID}`, verified()],
  ]);
  const handler = createAcceptedResultHandler({ storage: {
    get: async (key) => { keys.push(key); return data.get(key); },
    set: async () => assert.fail("result panel RPC cannot write state"),
  } });
  assert.deepEqual(await handler({ sessionID, runID }), {
    runID, result: { available: true, text: "WORKER_RESULT_262" },
  });
  assert.deepEqual(keys, [sessionBindingKey(sessionID), `orchestration/run/${runID}`]);
  assert.deepEqual(await handler({ sessionID, runID: "run-other" }), { result: { available: false } });
  assert.ok(ExecutionSummaryRpc.methods.getAcceptedResult);
});

test("RPC fails closed before reading invalid ids or exposing other session's run", async () => {
  let reads = 0;
  const handler = createAcceptedResultHandler({ storage: { get: async () => { reads++; return { runID }; } } });
  assert.deepEqual(await handler({ sessionID: "../invalid" }), { result: { available: false } });
  assert.deepEqual(await handler({ sessionID, runID: "bad/slash" }), { result: { available: false } });
  assert.equal(reads, 0);
  assert.deepEqual(await createAcceptedResultHandler({ storage: { get: async () => { throw Error("secret"); } } })({ sessionID }), { result: { available: false } });
});
