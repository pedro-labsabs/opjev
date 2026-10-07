import { it } from "node:test";
import assert from "node:assert/strict";
import { buildRequestProjectionPlan, applyProjectionPlan } from "./context-management/request-projection.ts";
import { hashStableRef } from "./context-management/identity.ts";
import { registerContextManagementHooks } from "./context-management/runtime-hooks.ts";
import { CONTEXT_LEDGER_KEY } from "./context-management/types.ts";
import { CONTEXT_METRICS_KEY } from "./context-management/metrics.ts";
import { fingerprintContextPayload } from "./context-management/observer.ts";

const sid = "session-1";
const sessionRef = hashStableRef(sid);
const callID = "call-1";
const groupID = hashStableRef(`${sid}\u0000${callID}`);
const group = {
  groupID, sessionRef, createdAt: 1, updatedAt: 2,
  call: { schema: 1, assetID: hashStableRef("callasset"), groupID, sessionRef, role: "user-session", source: "tool-call", tool: "read", callRef: hashStableRef(callID), fingerprint: "a".repeat(64), createdAt: 1, evidenceRoles: ["none"], protection: "clear", retention: "KEEP" },
  terminal: { schema: 1, assetID: hashStableRef("resultasset"), groupID, sessionRef, role: "user-session", source: "tool-result", tool: "read", callRef: hashStableRef(callID), fingerprint: "b".repeat(64), createdAt: 2, evidenceRoles: ["none"], protection: "clear", retention: "KEEP" },
};
const protection = { role: "user-session", groups: [{ groupID, state: "clear", reason: "test" }] };
const messages = [
  { id: "human-1", role: "user", content: [{ type: "text", text: "literal human bytes\n" }] },
  { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "ordinary prose" }, { type: "tool-call", id: callID, name: "read", input: { path: "x" } }] },
  { id: "tool-1", role: "tool", content: [{ type: "tool-result", id: callID, name: "read", result: { type: "text", value: "result" } }] },
];

it("leaves the full request byte-identical in deterministic shadow", () => {
  const beforeMessages = JSON.stringify(messages);
  const system = [{ type: "text", text: "system" }];
  const beforeSystem = JSON.stringify(system);
  const plan = buildRequestProjectionPlan({ sessionID: sid, messages, system, ledger: [group], protection });
  const applied = applyProjectionPlan(plan, messages, system);
  assert.equal(applied.valid, true);
  assert.strictEqual(applied.messages, messages);
  assert.equal(JSON.stringify(applied.messages), beforeMessages);
  assert.equal(JSON.stringify(system), beforeSystem);
  assert.equal(applied.decisions[0].action, "KEEP");
});

it("invalidates stale or unpaired requests without rewriting messages", () => {
  const plan = buildRequestProjectionPlan({ sessionID: sid, messages, system: [], ledger: [group], protection });
  const changed = structuredClone(messages);
  changed[1].content[0].text = "concurrent mutation";
  const stale = applyProjectionPlan(plan, changed, []);
  assert.equal(stale.valid, false);
  assert.strictEqual(stale.messages, changed);
  const unpaired = buildRequestProjectionPlan({ sessionID: sid, messages: messages.slice(0, 2), system: [], ledger: [group], protection });
  assert.equal(unpaired.decisions[0].action, "KEEP");
  assert.equal(unpaired.decisions[0].reason, "request-pair-mismatch");
});
it("invalidates planning when another hook changes the request during async lookup", () => {
  const beforeLookup = buildRequestProjectionPlan({ sessionID: sid, messages, system: [], ledger: [group], protection });
  const changed = structuredClone(messages);
  changed[0].content[0].text = "changed while protection state was loaded";
  const afterLookup = buildRequestProjectionPlan({
    sessionID: sid, messages: changed, system: [], ledger: [group], protection,
    requestFingerprintAtStart: beforeLookup.requestFingerprint,
  });
  const result = applyProjectionPlan(afterLookup, changed, []);
  assert.equal(result.valid, false);
  assert.equal(result.decisions[0].action, "KEEP");
  assert.equal(result.decisions[0].reason, "request-payload-mismatch");
});
it("fails closed when request payloads or tool identities differ from persisted fingerprints", () => {
  const callFingerprint = fingerprintContextPayload(messages[1].content[1].input);
  const resultFingerprint = fingerprintContextPayload(messages[2].content[0].result.value);
  assert.ok(callFingerprint && resultFingerprint);
  const currentGroup = {
    ...group,
    call: { ...group.call, fingerprint: callFingerprint },
    terminal: { ...group.terminal, fingerprint: resultFingerprint },
  };
  const matching = buildRequestProjectionPlan({ sessionID: sid, messages, system: [], ledger: [currentGroup], protection });
  assert.equal(matching.decisions[0].reason, "recent-group");

  const changedInput = structuredClone(messages);
  changedInput[1].content[1].input = { path: "changed" };
  const inputPlan = buildRequestProjectionPlan({ sessionID: sid, messages: changedInput, system: [], ledger: [currentGroup], protection });
  assert.equal(inputPlan.decisions[0].action, "KEEP");
  assert.equal(inputPlan.decisions[0].reason, "request-payload-mismatch");

  const changedResult = structuredClone(messages);
  changedResult[2].content[0].result.value = "changed";
  const resultPlan = buildRequestProjectionPlan({ sessionID: sid, messages: changedResult, system: [], ledger: [currentGroup], protection });
  assert.equal(resultPlan.decisions[0].action, "KEEP");
  assert.equal(resultPlan.decisions[0].reason, "request-payload-mismatch");

  const changedTool = structuredClone(messages);
  changedTool[1].content[1].name = "shell";
  const toolPlan = buildRequestProjectionPlan({ sessionID: sid, messages: changedTool, system: [], ledger: [currentGroup], protection });
  assert.equal(toolPlan.decisions[0].action, "KEEP");
  assert.equal(toolPlan.decisions[0].reason, "request-payload-mismatch");
});
it("fails closed when another plugin mutates the request during earlier hook awaits", async () => {
  const values = new Map([[CONTEXT_LEDGER_KEY, { schema: 1, groups: [group] }]]);
  let contextHook;
  let announceRead;
  let releaseRead;
  const readStarted = new Promise(resolve => { announceRead = resolve; });
  const blockedRead = new Promise(resolve => { releaseRead = resolve; });
  let firstLedgerRead = true;
  const storage = {
    async get(key) {
      if (key === CONTEXT_LEDGER_KEY && firstLedgerRead) {
        firstLedgerRead = false;
        announceRead();
        await blockedRead;
      }
      return values.get(key);
    },
    async set(key, value) { values.set(key, value); },
  };
  const ctx = {
    storage,
    session: {
      async get() { return { metadata: {} }; },
      async hook(name, callback) { if (name === "context") contextHook = callback; },
    },
    tool: { async hook() {} },
  };
  await registerContextManagementHooks(ctx, { contextManagementStage: "deterministic-shadow" });
  const event = { sessionID: sid, messages: structuredClone(messages), system: [] };
  const running = contextHook(event);
  await readStarted;
  event.messages[0].content[0].text = "concurrent plugin mutation";
  releaseRead();
  await running;
  const metrics = values.get(CONTEXT_METRICS_KEY);
  assert.equal(metrics.context.invalidatedPlans, 1);
  assert.equal(metrics.context.plannedGroups, 0);
});

it("invalidates the plan if another plugin mutates during metrics persistence", async () => {
  const now = Date.now();
  const runtimeGroup = structuredClone(group);
  runtimeGroup.createdAt = now;
  runtimeGroup.updatedAt = now;
  runtimeGroup.call.createdAt = now;
  runtimeGroup.terminal.createdAt = now;
  const values = new Map([[CONTEXT_LEDGER_KEY, { schema: 1, groups: [runtimeGroup] }]]);
  let contextHook;
  let announceWrite;
  let releaseWrite;
  const writeStarted = new Promise(resolve => { announceWrite = resolve; });
  const blockedWrite = new Promise(resolve => { releaseWrite = resolve; });
  const storage = {
    async get(key) { return values.get(key); },
    async set(key, value) {
      if (key === CONTEXT_METRICS_KEY && value?.context?.plannedGroups > 0) {
        announceWrite();
        await blockedWrite;
      }
      values.set(key, value);
    },
  };
  const ctx = {
    storage,
    session: {
      async get() { return { metadata: {} }; },
      async hook(name, callback) { if (name === "context") contextHook = callback; },
    },
    tool: { async hook() {} },
  };
  await registerContextManagementHooks(ctx, { contextManagementStage: "deterministic-shadow" });
  const event = { sessionID: sid, messages: structuredClone(messages), system: [] };
  const running = contextHook(event);
  await writeStarted;
  event.messages[0].content[0].text = "concurrent mutation during metrics write";
  releaseWrite();
  await running;
  const metrics = values.get(CONTEXT_METRICS_KEY);
  assert.equal(metrics.context.plannedGroups, 1);
  assert.equal(metrics.context.proposedKeep, 1);
});
it("keeps unknown message shapes and human/assistant prose byte-equivalent", () => {
  const unknown = [{ role: "user", text: "human" }, { role: "assistant", text: "assistant" }];
  const before = JSON.stringify(unknown);
  const plan = buildRequestProjectionPlan({ sessionID: sid, messages: unknown, system: [], ledger: [group], protection });
  const result = applyProjectionPlan(plan, unknown, []);
  assert.equal(result.decisions[0].action, "KEEP");
  assert.equal(JSON.stringify(result.messages), before);
});
