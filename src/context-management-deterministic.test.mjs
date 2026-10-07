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
const protection = (groups, states = {}) => ({ role: "user-session", groups: groups.map(({ groupID }) => ({ groupID, state: states[groupID] ?? "clear", reason: "test" })) });

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

it("keeps every unsupported deterministic table relation in shadow", () => {
  const exactDuplicateA = group(10, { fingerprint: "a".repeat(64) });
  const exactDuplicateB = group(11, { fingerprint: "a".repeat(64) });
  exactDuplicateA.terminal.fingerprint = "b".repeat(64);
  exactDuplicateB.terminal.fingerprint = "b".repeat(64);

  const repeatedOutputA = group(12, { fingerprint: "c".repeat(64) });
  const repeatedOutputB = group(13, { fingerprint: "d".repeat(64) });
  repeatedOutputA.terminal.fingerprint = repeatedOutputB.terminal.fingerprint;

  const supersededA = group(14);
  const supersededB = group(15);
  supersededA.call.supersededBy = supersededB.call.assetID;

  const listing = group(16, { tool: "list" });
  const childRead = group(17, { tool: "read" });
  const beforeWrite = group(18, { tool: "read" });
  const write = group(19, { tool: "write" });
  const afterWrite = group(20, { tool: "read" });
  const largeResult = group(21);
  largeResult.terminal.payloadBytes = 1_000_000;
  const failedCheck = group(22, { tool: "check" });
  failedCheck.terminal.source = "tool-failure";
  const laterCheck = group(23, { tool: "check" });
  const malformed = group(24);
  malformed.terminal.callRef = hashStableRef("different-call");

  const cases = [
    ["exact duplicate, same inputs/results", [exactDuplicateA, exactDuplicateB], "relation-unproven"],
    ["same output from distinct calls", [repeatedOutputA, repeatedOutputB], "relation-unproven"],
    ["superseded asset without a verified adapter", [supersededA, supersededB], "relation-unproven"],
    ["directory listing followed by child read", [listing, childRead], "relation-unproven"],
    ["read around an intervening write", [beforeWrite, write, afterWrite], "relation-unproven"],
    ["large result without an identity-preserving adapter", [largeResult], "relation-unproven"],
    ["failure followed by a successful check", [failedCheck, laterCheck], "relation-unproven"],
    ["malformed call/result linkage", [malformed], "malformed-group"],
  ];
  for (const [name, groups, reason] of cases) {
    const decisions = classifyContextGroups({ groups, protection: protection(groups), recentGroupIDs: [] });
    assert.ok(decisions.every(item => item.action === "KEEP" && item.reason === reason), `${name} must remain ${reason}/KEEP: ${JSON.stringify(decisions)}`);
  }
});
