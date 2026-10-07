import { it } from "node:test";
import assert from "node:assert/strict";
import { buildRequestProjectionPlan, applyProjectionPlan } from "./context-management/request-projection.ts";
import { hashStableRef } from "./context-management/identity.ts";

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

it("keeps unknown message shapes and human/assistant prose byte-equivalent", () => {
  const unknown = [{ role: "user", text: "human" }, { role: "assistant", text: "assistant" }];
  const before = JSON.stringify(unknown);
  const plan = buildRequestProjectionPlan({ sessionID: sid, messages: unknown, system: [], ledger: [group], protection });
  const result = applyProjectionPlan(plan, unknown, []);
  assert.equal(result.decisions[0].action, "KEEP");
  assert.equal(JSON.stringify(result.messages), before);
});
