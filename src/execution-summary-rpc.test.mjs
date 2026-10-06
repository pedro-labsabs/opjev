import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ExecutionSummaryRpc,
  createExecutionSummaryHandler,
} from "./orchestration/execution-summary-rpc.ts";
import { sessionBindingKey } from "./orchestration/admission.ts";

const SESSION_ID = "ses_summary_1";
const RUN_ID = "run-summary-1";

function runningRecord() {
  return {
    updatedAt: Date.now(),
    state: {
      phase: "running",
      round: 1,
      contract: { maxRounds: 3 },
      executor: { agent: "builder", model: "free-model" },
      history: [],
    },
  };
}

test("active summary RPC reads only the current session binding and bounded run projection", async () => {
  const records = new Map([
    [sessionBindingKey(SESSION_ID), { runID: RUN_ID, phase: "running" }],
    [`orchestration/run/${RUN_ID}`, runningRecord()],
  ]);
  const reads = [];
  const storage = {
    async get(key) {
      reads.push(key);
      return records.get(key);
    },
    async set() {
      assert.fail("summary query must never write storage");
    },
  };

  const result = await createExecutionSummaryHandler({ storage })({ sessionID: SESSION_ID });

  assert.equal(result.summary.available, true);
  assert.equal(result.summary.taskState, "running");
  assert.equal(result.summary.route, "builder / free-model");
  assert.equal(result.runID, RUN_ID);
  assert.deepEqual(reads, [sessionBindingKey(SESSION_ID), `orchestration/run/${RUN_ID}`]);
  assert.deepEqual(Object.keys(ExecutionSummaryRpc.methods), ["getActiveSummary"]);
  assert.equal(ExecutionSummaryRpc.methods.getActiveSummary.input.properties.sessionID.pattern, "^[A-Za-z0-9._:-]+$");
});

test("active summary RPC fails closed for missing or malformed bindings", async () => {
  const results = [
    await createExecutionSummaryHandler({ storage: { get: async () => undefined } })({ sessionID: SESSION_ID }),
    await createExecutionSummaryHandler({ storage: { get: async () => ({ runID: "../other" }) } })({ sessionID: SESSION_ID }),
  ];
  assert.deepEqual(results, [{ summary: { available: false } }, { summary: { available: false } }]);
});

test("terminal summary lookup only returns the run still bound to the requested session", async () => {
  const records = new Map([
    [sessionBindingKey(SESSION_ID), { runID: RUN_ID }],
    [`orchestration/run/${RUN_ID}`, runningRecord()],
  ]);
  const handler = createExecutionSummaryHandler({ storage: { get: async (key) => records.get(key) } });
  const result = await handler({ sessionID: SESSION_ID, runID: "run-other" });
  assert.deepEqual(result, { summary: { available: false } });
});

test("active summary RPC rejects unsafe identifiers before constructing storage keys", async () => {
  let reads = 0;
  const result = await createExecutionSummaryHandler({
    storage: { get: async () => { reads += 1; return undefined; } },
  })({ sessionID: "ses/../../other" });
  assert.deepEqual(result, { summary: { available: false } });
  assert.equal(reads, 0);
});

test("active summary RPC returns unavailable when storage fails", async () => {
  const result = await createExecutionSummaryHandler({
    storage: { get: async () => { throw new Error("storage unavailable"); } },
  })({ sessionID: SESSION_ID });
  assert.deepEqual(result, { summary: { available: false } });
});
