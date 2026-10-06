import { it } from "node:test";
import assert from "node:assert/strict";

import {
  CONTEXT_ASSET_MAX_SERIALIZED_BYTES,
  CONTEXT_LEDGER_GROUP_CAPACITY,
  CONTEXT_LEDGER_KEY,
  CONTEXT_LEDGER_PENDING_LIMIT,
  CONTEXT_LEDGER_SESSION_CAPACITY,
  CONTEXT_LEDGER_TTL_MS,
  CONTEXT_RECENT_GROUPS,
  ContextLedger,
  serializeContextAsset,
  sanitizeContextAsset,
} from "./context-management/ledger.ts";
import { createContextAssetSink } from "./context-management/storage-sink.ts";
import { createPayloadFingerprintKey, fingerprintPayload, hashStableRef } from "./context-management/identity.ts";

const ref = (value) => hashStableRef(value);

function asset(overrides = {}) {
  return {
    schema: 1,
    assetID: ref("asset"),
    groupID: ref("group"),
    sessionRef: ref("session"),
    role: "user-session",
    source: "tool-call",
    tool: "shell",
    callRef: ref("call"),
    fingerprint: "a".repeat(64),
    createdAt: 1_000,
    evidenceRoles: ["none"],
    protection: "unknown",
    retention: "KEEP",
    ...overrides,
  };
}

function group(index, session = "session", at = 1_000, overrides = {}) {
  const sessionRef = ref(session);
  const groupID = ref(`group-${index}`);
  const callRef = ref(`call-${index}`);
  const call = asset({
    assetID: ref(`asset-call-${index}`), groupID, sessionRef, callRef,
    source: "tool-call", createdAt: at,
  });
  const terminal = asset({
    assetID: ref(`asset-result-${index}`), groupID, sessionRef, callRef,
    source: "tool-result", createdAt: at + 1,
  });
  return { groupID, sessionRef, call, terminal, createdAt: at, updatedAt: at + 1, ...overrides };
}

it("exports the fixed OBSERVE contract bounds and storage key", () => {
  assert.equal(CONTEXT_LEDGER_KEY, "context/asset-ledger/v1");
  assert.equal(CONTEXT_LEDGER_GROUP_CAPACITY, 2048);
  assert.equal(CONTEXT_LEDGER_SESSION_CAPACITY, 256);
  assert.equal(CONTEXT_LEDGER_TTL_MS, 86_400_000);
  assert.equal(CONTEXT_ASSET_MAX_SERIALIZED_BYTES, 512);
  assert.equal(CONTEXT_LEDGER_PENDING_LIMIT, 128);
  assert.equal(CONTEXT_RECENT_GROUPS, 8);
});

it("accepts only exact enums, bounded IDs, timestamps, and allowlisted asset fields", () => {
  assert.deepEqual(sanitizeContextAsset(asset()), asset());
  assert.equal(sanitizeContextAsset(asset({ schema: 2 })), undefined);
  assert.equal(sanitizeContextAsset(asset({ role: "jev" })), undefined);
  assert.equal(sanitizeContextAsset(asset({ source: "message" })), undefined);
  assert.equal(sanitizeContextAsset(asset({ retention: "drop" })), undefined);
  assert.equal(sanitizeContextAsset(asset({ protection: "maybe" })), undefined);
  assert.equal(sanitizeContextAsset(asset({ assetID: "abc" })), undefined);
  assert.equal(sanitizeContextAsset(asset({ evidenceRoles: Array(9).fill("none") })), undefined);
  assert.equal(sanitizeContextAsset(asset({ round: 0 })), undefined);
  assert.equal(sanitizeContextAsset(asset({ createdAt: -1 })), undefined);
  assert.equal(sanitizeContextAsset(asset({ arbitrary: "raw prompt" })), undefined);
  assert.equal(sanitizeContextAsset(asset({ tool: "x".repeat(81) })), undefined);
  assert.equal(sanitizeContextAsset(asset({ tool: "raw command text" })), undefined);
});

it("rejects an asset whose serialized metadata exceeds 512 bytes", () => {
  const minimal = {
    schema: 1,
    assetID: ref("minimal-asset"), groupID: ref("minimal-group"), sessionRef: ref("minimal-session"),
    role: "unknown", source: "tool-call", tool: "x", callRef: ref("minimal-call"), createdAt: 1,
    evidenceRoles: Array(8).fill("none"), protection: "unknown", retention: "KEEP",
  };
  assert.ok(Buffer.byteLength(JSON.stringify(serializeContextAsset(sanitizeContextAsset(minimal)))) <= CONTEXT_ASSET_MAX_SERIALIZED_BYTES);
  assert.equal(sanitizeContextAsset(minimal).evidenceRoles.length, 8);
  const value = asset();
  assert.ok(Buffer.byteLength(JSON.stringify(serializeContextAsset(sanitizeContextAsset(value)))) <= CONTEXT_ASSET_MAX_SERIALIZED_BYTES);
  const oversized = asset({
    entityRef: "f".repeat(64), runRef: "e".repeat(64), messageRef: "d".repeat(64), supersededBy: "c".repeat(64),
    lastReferencedAt: 2_000, round: 4, payloadBytes: 2_000_000, tool: "x".repeat(80),
    evidenceRoles: ["required-evidence", "deterministic-check", "evidence-packet", "critic-finding", "binding-decision", "required-evidence", "deterministic-check", "evidence-packet"],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(serializeContextAsset(oversized))) > CONTEXT_ASSET_MAX_SERIALIZED_BYTES);
  assert.equal(sanitizeContextAsset(oversized), undefined);
});

it("hashes stable references and fingerprints payloads with a process key", () => {
  assert.equal(ref("high-entropy-session-123"), ref("high-entropy-session-123"));
  assert.match(ref("high-entropy-session-123"), /^[a-f0-9]{64}$/);
  const key1 = createPayloadFingerprintKey();
  const key2 = createPayloadFingerprintKey();
  assert.notDeepEqual(key1, key2);
  assert.equal(fingerprintPayload({ value: "private canary" }, key1), fingerprintPayload({ value: "private canary" }, key1));
  assert.notEqual(fingerprintPayload({ value: "private canary" }, key1), fingerprintPayload({ value: "private canary" }, key2));
  assert.equal(fingerprintPayload(undefined, key1), undefined);
  assert.equal(fingerprintPayload({ circular: (() => { const x = {}; x.self = x; return x; })() }, key1), undefined);
  const serialized = JSON.stringify(asset({ fingerprint: fingerprintPayload("private canary", key1) }));
  assert.equal(serialized.includes("private canary"), false);
});

it("upserts groups idempotently and invalidates retention after a fingerprint change", () => {
  const ledger = new ContextLedger({ now: () => 2_000 });
  const first = group(1);
  ledger.upsertGroup(first);
  ledger.upsertGroup(first);
  assert.equal(ledger.snapshot().length, 1);
  assert.equal(ledger.snapshot()[0].call.retention, "KEEP");

  ledger.upsertGroup({ ...first, call: { ...first.call, retention: "DROP", protection: "clear" } });
  assert.equal(ledger.snapshot()[0].call.retention, "DROP");
  ledger.upsertGroup({ ...first, call: { ...first.call, fingerprint: "b".repeat(64), retention: "DROP", protection: "clear" } });
  const changed = ledger.snapshot()[0];
  assert.equal(changed.call.retention, "KEEP");
  assert.equal(changed.call.protection, "unknown");
  assert.equal(changed.terminal.retention, "KEEP");
  assert.equal(changed.terminal.protection, "unknown");
});

it("evicts oldest metadata at total, per-session, and TTL bounds", () => {
  const ledger = new ContextLedger({ now: () => 10_000 });
  for (let i = 0; i <= CONTEXT_LEDGER_GROUP_CAPACITY; i++) ledger.upsertGroup(group(i, `s-${i}`, i + 1));
  assert.equal(ledger.snapshot().length, CONTEXT_LEDGER_GROUP_CAPACITY);
  assert.equal(ledger.snapshot()[0].groupID, ref("group-1"));

  const perSession = new ContextLedger({ now: () => 10_000 });
  for (let i = 0; i <= CONTEXT_LEDGER_SESSION_CAPACITY; i++) perSession.upsertGroup(group(i, "same-session", i + 1));
  assert.equal(perSession.snapshot().length, CONTEXT_LEDGER_SESSION_CAPACITY);
  assert.equal(perSession.snapshot()[0].groupID, ref("group-1"));

  const now = 100_000_000;
  const ttl = new ContextLedger({ now: () => now });
  ttl.upsertGroup(group(1, "s", now - CONTEXT_LEDGER_TTL_MS));
  ttl.upsertGroup(group(2, "s", now - CONTEXT_LEDGER_TTL_MS + 1));
  assert.deepEqual(ttl.snapshot().map((x) => x.groupID), [ref("group-2")]);
});

it("drops observations when the bounded storage queue is full", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stored = new Map();
  const storage = {
    async get(key) { await gate; return stored.get(key); },
    async set(key, value) { stored.set(key, value); },
  };
  const sink = createContextAssetSink({}, storage, { now: () => 2_000 });
  const pending = Array.from({ length: CONTEXT_LEDGER_PENDING_LIMIT }, (_, i) => sink(group(i)));
  assert.equal(await sink(group(999)), false);
  release();
  assert.equal((await Promise.all(pending)).filter(Boolean).length, CONTEXT_LEDGER_PENDING_LIMIT);
  assert.equal(stored.get(CONTEXT_LEDGER_KEY).groups.length, CONTEXT_LEDGER_PENDING_LIMIT);
});

it("reports malformed groups as dropped observations", async () => {
  const sink = createContextAssetSink({}, { async get() { return undefined; }, async set() {} }, { now: () => 2_000 });
  assert.equal(await sink({}), false);
});
