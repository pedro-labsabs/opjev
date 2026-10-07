import { it } from "node:test";
import assert from "node:assert/strict";
import { classifyContextGroups } from "./context-management/deterministic-pruner.ts";
import { hashStableRef } from "./context-management/identity.ts";

const sessionRef = hashStableRef("s");
function group(index, { terminal = true, protection = "clear", fingerprint = String(index).padStart(64, "0"), tool = "read" } = {}) {
  const groupID = hashStableRef(`g${index}`);
  const common = { schema: 1, groupID, sessionRef, runRef: undefined, round: undefined, role: "user-session", tool, callRef: hashStableRef(`c${index}`), createdAt: index + 1, evidenceRoles: ["none"], protection, retention: "KEEP" };
  return { groupID, sessionRef, createdAt: index + 1, updatedAt: index + 1, call: { ...common, assetID: hashStableRef(`ca${index}`), source: "tool-call", fingerprint }, ...(terminal ? { terminal: { ...common, assetID: hashStableRef(`ta${index}`), source: "tool-result", fingerprint } } : {}) };
}
const protection = (groups, states = {}) => ({ groups: groups.map(({ groupID }) => ({ groupID, state: states[groupID] ?? "clear", reason: "test" })) });

it("keeps incomplete, protected, unknown, and newest eight groups", () => {
  const groups = Array.from({ length: 10 }, (_, index) => group(index));
  groups[0] = group(0, { terminal: false });
  const states = { [groups[1].groupID]: "protected", [groups[2].groupID]: "unknown" };
  const decisions = classifyContextGroups({ groups, protection: protection(groups, states) });
  assert.deepEqual(decisions.slice(0, 3).map(item => item.action), ["KEEP", "KEEP", "KEEP"]);
  assert.equal(decisions[0].reason, "incomplete-group");
  assert.equal(decisions[1].reason, "protected");
  assert.equal(decisions[2].reason, "unknown-protection");
  assert.ok(decisions.slice(2).every(item => item.action === "KEEP"));
});

it("does not infer deterministic equivalence or purity from tool name, matching output, or similarity", () => {
  const groups = [group(1, { fingerprint: "a".repeat(64) }), group(2, { fingerprint: "a".repeat(64) }), group(3, { tool: "read" })];
  const decisions = classifyContextGroups({ groups, protection: protection(groups), recentGroupIDs: [] });
  assert.ok(decisions.every(item => item.action === "KEEP"));
  assert.ok(decisions.every(item => item.source === "deterministic"));
});
