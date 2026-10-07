import { it } from "node:test";
import assert from "node:assert/strict";

import { resolveOptions } from "./config.ts";
import { ContextLedger } from "./context-management/ledger.ts";
import { observeContextRequest, observeToolAfter, resolveContextManagementStage } from "./context-management/observer.ts";
import { CONTEXT_LEDGER_KEY } from "./context-management/types.ts";
import { CONTEXT_METRICS_KEY, recordContextMetrics } from "./context-management/metrics.ts";
import { makeStorage } from "./harness.mjs";

const rawCanaries = ["HUMAN-CANARY-8e8d", "INPUT-CANARY-1bc3", "RESULT-CANARY-b119", "ERROR-CANARY-99f4", "sk-test-context-secret-74c2"];

function fixture({ metadata = {}, storage = makeStorage(), now = () => 2_000 } = {}) {
  const session = { id: "session-high-entropy-981d", metadata };
  return {
    storage,
    now,
    owner: {},
    getSession: async () => session,
    ledger: () => {
      const ledger = new ContextLedger({ now });
      const stored = storage._map.get(CONTEXT_LEDGER_KEY);
      if (stored?.schema === 1) ledger.replace(stored.groups);
      return ledger.snapshot();
    },
  };
}

function event(overrides = {}) {
  return {
    tool: "tools.shell",
    sessionID: "session-high-entropy-981d",
    agent: "build",
    messageID: "message-high-entropy-4812",
    id: "call-high-entropy-8801",
    input: { command: rawCanaries[1] },
    status: "completed",
    result: { output: rawCanaries[2] },
    ...overrides,
  };
}

it("resolves missing, invalid, and unimplemented stages to observe; disabled is explicit", () => {
  assert.equal(resolveContextManagementStage(undefined), "observe");
  assert.equal(resolveContextManagementStage("not-a-stage"), "observe");
  assert.equal(resolveContextManagementStage("deterministic-shadow"), "observe");
  assert.equal(resolveContextManagementStage("disabled"), "disabled");
  assert.equal(resolveOptions({}).contextManagementStage, "observe");
  assert.equal(resolveOptions({ contextManagementStage: "disabled" }).contextManagementStage, "disabled");
});

it("stores bounded pairs for completed and failed calls without persisting canaries", async () => {
  const deps = fixture();
  await observeToolAfter(event(), deps);
  await observeToolAfter(event({
    id: "call-high-entropy-error-7702",
    messageID: "message-high-entropy-error-5013",
    input: { query: "safe-shaped input" },
    status: "error",
    error: { name: "ToolError", message: `${rawCanaries[3]} ${rawCanaries[4]}` },
    result: undefined,
  }), deps);

  const groups = deps.ledger();
  assert.equal(groups.length, 2);
  assert.ok(groups.every((x) => x.terminal));
  assert.deepEqual(groups.map((x) => x.terminal.source).sort(), ["tool-failure", "tool-result"]);
  const persisted = JSON.stringify([
    deps.storage._map.get(CONTEXT_LEDGER_KEY),
    deps.storage._map.get(CONTEXT_METRICS_KEY),
  ]);
  for (const canary of rawCanaries) assert.equal(persisted.includes(canary), false);
  assert.ok(persisted.includes("fingerprint" ) === false); // positional asset records carry HMACs without field names
});

it("classifies user and validated internal roles, and leaves malformed metadata unknown", async () => {
  const cases = [
    [{}, "user-session"],
    [{ "jev-router": "orchestration-internal", "jev-role": "worker", "jev-run-id": "run-high-entropy-1", "jev-round": 3 }, "worker"],
    [{ "jev-router": "orchestration-internal", "jev-role": "critic" }, "critic"],
    [{ "jev-router": "orchestration-internal", "jev-role": "orchestrator" }, "orchestrator"],
    [{ "jev-router": "orchestration-internal", "jev-role": "workerish" }, "unknown"],
  ];
  for (const [metadata, expectedRole] of cases) {
    const deps = fixture({ metadata });
    await observeToolAfter(event(), deps);
    assert.equal(deps.ledger()[0]?.call.role, expectedRole);
    assert.equal(deps.ledger()[0]?.call.retention, "KEEP");
  }
});

it("upserts duplicate terminal deliveries and rejects missing identity", async () => {
  const deps = fixture();
  await observeToolAfter(event(), deps);
  await observeToolAfter(event(), deps);
  assert.equal(deps.ledger().length, 1);
  assert.equal(deps.storage._map.get(CONTEXT_METRICS_KEY).tool.duplicateDeliveries, 1);
  await observeToolAfter(event({ id: "" }), deps);
  assert.equal(deps.ledger().length, 1);
  assert.equal(deps.storage._map.get(CONTEXT_METRICS_KEY).tool.identityLoss, 1);
});

it("records request bytes and paired tool-part coverage without changing the request", async () => {
  const deps = fixture();
  await observeToolAfter(event(), deps);
  const request = {
    sessionID: "session-high-entropy-981d",
    agent: "build",
    model: { providerID: "opencode", id: "test" },
    system: [{ type: "text", text: "system" }],
    messages: [
      { role: "assistant", content: [{ type: "tool-call", id: "call-high-entropy-8801", name: "shell", input: { command: rawCanaries[1] } }] },
      { role: "tool", content: [{ type: "tool-result", id: "call-high-entropy-8801", name: "shell", result: { type: "text", value: rawCanaries[2] } }] },
      { role: "user", content: [{ type: "text", text: rawCanaries[0] }] },
    ],
    tools: {},
    options: {},
  };
  const before = structuredClone(request);
  await observeContextRequest(request, deps);
  assert.deepEqual(request, before);
  const metrics = deps.storage._map.get(CONTEXT_METRICS_KEY);
  assert.equal(metrics.context.pairedGroups, 1);
  assert.ok(metrics.context.estimatedRequestBytes > 0);
  const persisted = JSON.stringify(metrics);
  for (const canary of rawCanaries) assert.equal(persisted.includes(canary), false);
});

it("treats storage and session lookup failures as lost observations", async () => {
  const failedStorage = {
    async get() { throw new Error("storage offline"); },
    async set() { throw new Error("storage offline"); },
  };
  await assert.doesNotReject(observeToolAfter(event(), fixture({ storage: failedStorage })));
  const unavailable = fixture();
  unavailable.getSession = async () => { throw new Error("session unavailable"); };
  await assert.doesNotReject(observeToolAfter(event(), unavailable));
  assert.equal(unavailable.ledger().length, 1);
  assert.equal(unavailable.ledger()[0].call.role, "unknown");
  assert.equal(unavailable.ledger()[0].call.protection, "unknown");
});
it("bounds pending metrics writes, drops overflow, drains, and accepts later observations", async () => {
  let releaseGet;
  const blockedGet = new Promise((resolve) => { releaseGet = resolve; });
  let blockStorage = true;
  let gets = 0;
  let sets = 0;
  const storage = {
    async get(key) {
      assert.equal(key, CONTEXT_METRICS_KEY);
      gets++;
      if (blockStorage) await blockedGet;
      return storage.persisted;
    },
    async set(key, value) {
      assert.equal(key, CONTEXT_METRICS_KEY);
      sets++;
      storage.persisted = value;
    },
  };
  const submissions = Array.from({ length: 300 }, (_, index) =>
    recordContextMetrics(storage, { tool: { completed: 1 } }, 2_000 + index));
  await new Promise((resolve) => setImmediate(resolve));
  const overflowSettled = await Promise.race([
    Promise.all(submissions.slice(128)).then((results) => results),
    new Promise((resolve) => setImmediate(() => resolve("still-pending"))),
  ]);
  blockStorage = false;
  releaseGet();
  const results = await Promise.all(submissions);
  assert.deepEqual(overflowSettled, Array(172).fill(false));
  assert.equal(results.filter(Boolean).length, 128);
  assert.equal(results.filter((result) => !result).length, 172);
  assert.equal(gets, 128);
  assert.equal(sets, 128);
  assert.deepEqual(Object.keys(storage.persisted).sort(), ["context", "schema", "tool", "updatedAt", "windowStartedAt"]);
  assert.equal(storage.persisted.tool.completed, 128);
  const persisted = JSON.stringify(storage.persisted);
  for (const canary of rawCanaries) assert.equal(persisted.includes(canary), false);
  assert.equal(await recordContextMetrics(storage, { tool: { completed: 1 } }, 2_400), true);
  assert.equal(gets, 129);
  assert.equal(sets, 129);
});
