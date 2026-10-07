import { it } from "node:test";
import assert from "node:assert/strict";
import { hashStableRef } from "./context-management/identity.ts";
import { projectContextProtection } from "./context-management/protection.ts";

const sessionRef = hashStableRef("session-1");
const runRef = hashStableRef("run-1");
const callRef = hashStableRef("call-1");
const groupID = hashStableRef("group-1");
const group = (overrides = {}) => ({
  groupID, sessionRef, createdAt: 10, updatedAt: 10,
  call: { schema: 1, assetID: "b".repeat(64), groupID, sessionRef, runRef, round: 2, role: "worker", source: "tool-call", tool: "read", callRef, fingerprint: "e".repeat(64), createdAt: 10, evidenceRoles: ["none"], protection: "unknown", retention: "KEEP" },
  terminal: { schema: 1, assetID: "f".repeat(64), groupID, sessionRef, runRef, round: 2, role: "worker", source: "tool-result", tool: "read", callRef, fingerprint: "1".repeat(64), createdAt: 10, evidenceRoles: ["none"], protection: "unknown", retention: "KEEP" },
  ...overrides,
});
const metadata = { "jev-router": "orchestration-internal", "jev-role": "worker", "jev-run-id": "run-1", "jev-round": 2 };
const state = { contract: { runID: "run-1", objective: "x", acceptanceCriteria: ["x"], constraints: [], requiredEvidence: ["test"], maxRounds: 3 }, phase: "running", round: 2, history: [] };
const deps = (meta = metadata, checkpoint = { checkpoint: "worker-created", state, workerSessionID: "session-1", updatedAt: 20 }, isFingerprintCurrent = () => true) => ({
  getSessionMetadata: async () => meta,
  getRun: async () => checkpoint,
  isFingerprintCurrent,
});

it("projects worker round as protected when canonical state has evidence and no per-group provenance", async () => {
  const result = await projectContextProtection(deps(), "session-1", [group()]);
  assert.equal(result.groups[0].state, "protected");
  assert.equal(result.groups[0].reason, "worker-round-evidence");
  assert.equal(result.round, 2);
  assert.equal(result.checkpointIdentity, "run-1");
  const restored = await projectContextProtection(deps(metadata, undefined, () => false), "session-1", [group()]);
  assert.equal(restored.groups[0].state, "unknown");
});

it("keeps critic and orchestrator sessions protected without relying on worker linkage", async () => {
  for (const role of ["critic", "orchestrator"]) {
    const result = await projectContextProtection(deps({ ...metadata, "jev-role": role }), "session-1", [group()]);
    assert.equal(result.groups[0].state, "protected");
    assert.equal(result.groups[0].reason, "protected-role");
  }
});

it("marks complete verified non-orchestration groups clear and partial metadata unknown", async () => {
  const userGroup = group({
    call: { ...group().call, role: "user-session", runRef: undefined, round: undefined },
    terminal: { ...group().terminal, role: "user-session", runRef: undefined, round: undefined },
  });
  const result = await projectContextProtection(deps({}), "session-1", [userGroup]);
  assert.equal(result.groups[0].state, "clear");
  const partial = await projectContextProtection(deps({ "jev-run-id": "run-1" }), "session-1", [userGroup]);
  assert.equal(partial.groups[0].state, "unknown");
  const restored = await projectContextProtection(deps({}, undefined, () => false), "session-1", [userGroup]);
  assert.equal(restored.groups[0].state, "unknown");
  const incorrectlyLinked = {
    ...userGroup,
    call: { ...userGroup.call, runRef, round: 2 },
    terminal: { ...userGroup.terminal, runRef, round: 2 },
  };
  const linkedResult = await projectContextProtection(deps({}), "session-1", [incorrectlyLinked]);
  assert.equal(linkedResult.groups[0].state, "unknown");
});

it("returns unknown for lookup failure, absent metadata/checkpoint, stale or mismatched run and round", async () => {
  const cases = [
    { getSessionMetadata: async () => { throw new Error("offline"); }, getRun: async () => ({}) },
    deps(undefined, null),
    deps(metadata, { checkpoint: "worker-created", state, workerSessionID: "session-1", updatedAt: 1 }),
    deps(metadata, { checkpoint: "worker-created", state: { ...state, contract: { ...state.contract, runID: "other" } }, workerSessionID: "session-1", updatedAt: 20 }),
    deps(metadata, { checkpoint: "worker-created", state: { ...state, round: 1 }, workerSessionID: "session-1", updatedAt: 20 }),
    deps({ ...metadata, "jev-round": "2" }),
  ];
  for (const input of cases) {
    const result = await projectContextProtection(input, "session-1", [group()]);
    assert.equal(result.groups[0].state, "unknown");
  }
});

it("returns unknown for incomplete or fingerprint-unverifiable groups", async () => {
  const incomplete = { ...group(), terminal: undefined };
  const result = await projectContextProtection(deps(), "session-1", [incomplete]);
  assert.equal(result.groups[0].state, "unknown");
  assert.equal(result.groups[0].reason, "group-identity-unknown");
});
