import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageLedger, aggregateUsage, sanitizeObservation } from "./resource-governor/usage-ledger.ts";
import { estimateResourcePressure } from "./resource-governor/pressure-estimator.ts";
import { createBoundedStorageObservationSink, RESOURCE_LEDGER_KEY, RESOURCE_LEDGER_CAPACITY, RESOURCE_LEDGER_PENDING_LIMIT } from "./resource-governor/storage-sink.ts";
import { decideResourceBudget, RESOURCE_POLICY_WINDOW_MS } from "./resource-governor/budget-policy.ts";
import { evaluateResourceBudget } from "./resource-governor/runtime-policy.ts";
import { latchQuotaLimit, QUOTA_ENFORCEMENT_KEY, QUOTA_LATCH_TTL_MS } from "./resource-governor/enforcement-state.ts";
import { reserveThrottleRetry, THROTTLE_RETRY_BUDGET_KEY, MAX_THROTTLE_RETRIES_PER_WINDOW } from "./resource-governor/throttle-retry-budget.ts";

test("ledger has fixed retention, sanitizes payloads, and does not grow without bound", () => {
  const ledger = new UsageLedger({ capacity: 3 });
  for (let i = 0; i < 20; i++) ledger.append({ at: i, kind: "request", runID: `r${i}`, prompt: "secret", rawOutput: "huge" });
  assert.equal(ledger.size, 3);
  assert.deepEqual(ledger.snapshot().map(x => x.runID), ["r17", "r18", "r19"]);
  assert.equal(JSON.stringify(ledger.snapshot()).includes("secret"), false);
  assert.equal(JSON.stringify(ledger.snapshot()).includes("rawOutput"), false);
});

test("window aggregation excludes old facts and leaves unavailable measurements unknown", () => {
  const facts = [
    { at: 100, kind: "request", model: "opencode/m", tokens: { input: 10, output: 2 } },
    { at: 150, kind: "throttle", statusCode: 429 },
    { at: 1, kind: "request", tokens: { input: 500 } },
  ];
  const a = aggregateUsage(facts, { from: 100, to: 200 });
  assert.equal(a.requests, 1);
  assert.equal(a.tokens.input, 10);
  assert.equal(a.tokens.output, 2);
  assert.equal(a.tokens.reasoning, undefined);
  assert.equal(a.throttles, 1);
  assert.equal(a.quotaLimits, 0);
});

test("sanitizer only keeps factual scalar fields and observed token counters", () => {
  const x = sanitizeObservation({ at: 1, kind: "request", tokens: { input: 7, madeUp: 9 }, secret: "x", prompt: "p" });
  assert.deepEqual(x.tokens, { input: 7 });
  assert.equal("secret" in x, false);
  assert.equal("prompt" in x, false);
  assert.equal(sanitizeObservation({ at: 1, kind: "made-up-kind" }).kind, "unknown");
  assert.equal("at" in sanitizeObservation({ kind: "request" }), false);
  assert.equal("errorCode" in sanitizeObservation({ at: 1, kind: "provider-error", errorCode: "token=secret" }), false);
});

test("sanitizer preserves contract-sized run and session identities", () => {
  const runID = "r".repeat(200);
  const sessionID = "s".repeat(200);
  const exact = sanitizeObservation({ kind: "request", runID, sessionID });
  const over = sanitizeObservation({ kind: "request", runID: `${runID}x`, sessionID: `${sessionID}x` });

  assert.equal(exact.runID, runID);
  assert.equal(exact.sessionID, sessionID);
  assert.equal(over.runID, runID);
  assert.equal(over.sessionID, sessionID);
});

test("pressure dimensions keep provenance/confidence separate; quota is unknown without official limit evidence", () => {
  const empty = estimateResourcePressure(aggregateUsage([], { from: 0, to: 100 }));
  assert.equal(empty.quota.level, "unknown");
  assert.equal(empty.quota.confidence, "none");
  assert.equal("quotaRemainingPercent" in empty, false);
  assert.equal(empty.profile, "unknown");
  assert.equal([empty.quota, empty.rate, empty.context, empty.execution, empty.availability].every(x => x.level === "unknown" && x.confidence === "none"), true);
});

test("429, 529, and rate-limit evidence raise rate pressure without suggesting a model switch", () => {
  for (const statusCode of [429, 529]) {
    const a = aggregateUsage([{ at: 10, kind: "throttle", statusCode }], { from: 0, to: 20 });
    const p = estimateResourcePressure(a);
    assert.equal(p.rate.level, "moderate");
    assert.equal(p.rate.provenance[0], "observed-throttle");
    assert.equal("routing" in p, false);
  }
  const a = aggregateUsage([{ at: 10, kind: "throttle", signal: "rate-limit" }], { from: 0, to: 20 });
  assert.equal(estimateResourcePressure(a).rate.level, "moderate");
});

test("FreeUsageLimitError indicates quota pressure, distinct from provider availability", () => {
  const a = aggregateUsage([{ at: 10, kind: "quota-limit", errorCode: "FreeUsageLimitError", failureDomain: "quota" }], { from: 0, to: 20 });
  const p = estimateResourcePressure(a);
  assert.equal(p.quota.level, "critical");
  assert.equal(p.quota.confidence, "high");
  assert.equal(p.availability.level, "unknown");
});

test("retry storm is inferred deterministically, recovery follows window expiry", () => {
  const storm = Array.from({ length: 6 }, (_, i) => ({ at: 100 + i, kind: "retry", failureDomain: "provider" }));
  const pressured = estimateResourcePressure(aggregateUsage(storm, { from: 100, to: 200 }));
  assert.equal(pressured.execution.level, "high");
  assert.equal(pressured.execution.confidence, "medium");
  const recovered = estimateResourcePressure(aggregateUsage(storm, { from: 200, to: 300 }));
  assert.equal(recovered.execution.level, "unknown");
  assert.equal(recovered.profile, "unknown");
});

test("provider failures do not become capability findings", () => {
  const a = aggregateUsage([{ at: 5, kind: "provider-error", failureDomain: "provider" }], { from: 0, to: 10 });
  const p = estimateResourcePressure(a);
  assert.equal(p.availability.level, "moderate");
  assert.equal(p.execution.level, "unknown");
  assert.equal(p.availability.provenance.includes("provider-failure"), true);
});

test("context and operations profiles are deterministic observations only", () => {
  const context = aggregateUsage([{ at: 5, kind: "context-overflow", failureDomain: "context" }], { from: 0, to: 10 });
  assert.equal(estimateResourcePressure(context).context.level, "high");
  for (const [facts, profile] of [
    [[{ at: 1, kind: "throttle" }], "conservative"],
    [[{ at: 1, kind: "throttle" }, { at: 2, kind: "throttle" }, { at: 3, kind: "throttle" }], "scarce"],
    [[{ at: 1, kind: "quota-limit" }], "survival"],
  ]) assert.equal(estimateResourcePressure(aggregateUsage(facts, { from: 0, to: 10 })).profile, profile);
  assert.equal(estimateResourcePressure(aggregateUsage([{ at: 1, kind: "request" }], { from: 0, to: 10 })).profile, "unknown");
});

test("pressure outputs cannot silently create routing or budget authority", () => {
  const pressure = estimateResourcePressure(aggregateUsage([{ at: 2, kind: "throttle", statusCode: 429 }], { from: 0, to: 3 }));
  assert.equal(pressure.mode, "observation");
  assert.equal("model" in pressure, false);
  assert.equal("agent" in pressure, false);
  assert.equal("maxRounds" in pressure, false);
  assert.equal("nextAction" in pressure, false);
  assert.equal("routing" in pressure, false);
});

test("storage sink serializes concurrent writes and persists a bounded sanitized ring", async () => {
  const owner = {};
  const data = new Map();
  const storage = { get: async key => data.get(key), set: async (key, value) => { data.set(key, structuredClone(value)); } };
  const sink = createBoundedStorageObservationSink(owner, storage);
  for (let i = 0; i < RESOURCE_LEDGER_CAPACITY + 3; i++) await sink({
    at: i, kind: "request", runID: `r${i}`, prompt: "secret prompt", rawOutput: "x".repeat(100000),
  });
  const record = data.get(RESOURCE_LEDGER_KEY);
  assert.equal(record.capacity, RESOURCE_LEDGER_CAPACITY);
  assert.equal(record.observations.length, RESOURCE_LEDGER_CAPACITY);
  assert.equal(record.observations[0].runID, "r3");
  assert.equal(JSON.stringify(record).includes("secret prompt"), false);
  assert.equal(JSON.stringify(record).includes("rawOutput"), false);
  assert.ok(JSON.stringify(record).length < 1_000_000);
});

test("storage sink bounds pending writes during storage stalls", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const data = new Map();
  let first = true;
  const storage = {
    get: async key => { if (first) { first = false; await blocked; } return data.get(key); },
    set: async (key, value) => data.set(key, structuredClone(value)),
  };
  const sink = createBoundedStorageObservationSink({}, storage);
  const pending = Array.from({ length: RESOURCE_LEDGER_PENDING_LIMIT + 1 }, (_, i) => sink({ at: i, kind: "request" }));
  release();
  await Promise.all(pending);
  assert.equal(data.get(RESOURCE_LEDGER_KEY).observations.length, RESOURCE_LEDGER_PENDING_LIMIT);
});

test("budget policy is deterministic, preserves unknown, and never expands maxRounds", () => {
  const unknown = estimateResourcePressure(aggregateUsage([], { from: 0, to: 1 }));
  const a = decideResourceBudget({ pressure: unknown, maxRounds: 3, round: 1, stage: "new-round" });
  assert.deepEqual(a, decideResourceBudget({ pressure: unknown, maxRounds: 3, round: 1, stage: "new-round" }));
  assert.equal(a.allowed, true);
  assert.equal(a.effectiveMaxRounds, 3);
  assert.equal(a.reason.includes("normal"), false);
  const storm = estimateResourcePressure(aggregateUsage(Array.from({ length: 5 }, (_, i) => ({ at: i, kind: "retry" })), { from: 0, to: 10 }));
  const limited = decideResourceBudget({ pressure: storm, maxRounds: 2, round: 1, stage: "new-round" });
  assert.equal(limited.allowed, false);
  assert.ok(limited.effectiveMaxRounds <= 2);
  assert.equal(RESOURCE_POLICY_WINDOW_MS, 900000);
});

test("quota and throttle policy deny additional spending without route authority", () => {
  const quota = estimateResourcePressure(aggregateUsage([{ at: 1, kind: "quota-limit" }], { from: 0, to: 2 }));
  const denied = decideResourceBudget({ pressure: quota, hardQuotaLatch: true, maxRounds: 4, round: 1, stage: "jev-decision" });
  assert.equal(denied.allowed, false);
  assert.equal(decideResourceBudget({ pressure: quota, maxRounds: 4, round: 1, stage: "jev-decision" }).allowed, true, "observation alone is not the authoritative hard latch");
  assert.equal("model" in denied, false);
  const throttle = estimateResourcePressure(aggregateUsage(Array.from({ length: 3 }, (_, i) => ({ at: i, kind: "throttle" })), { from: 0, to: 4 }));
  assert.equal(decideResourceBudget({ pressure: throttle, maxRounds: 4, round: 1, stage: "switch" }).allowed, false);
  assert.equal(decideResourceBudget({ pressure: estimateResourcePressure(aggregateUsage([], { from: 0, to: 1 })), maxRounds: 4, round: 1, stage: "provider-retry" }).allowed, true);
});

test("moderate independent pressure lowers the effective round cap without choosing a switch", () => {
  const rate = estimateResourcePressure(aggregateUsage([{ at: 1, kind: "throttle" }], { from: 0, to: 2 }));
  const switchAllowed = decideResourceBudget({ pressure: rate, maxRounds: 5, round: 1, stage: "switch" });
  assert.equal(switchAllowed.allowed, true);
  assert.equal(switchAllowed.effectiveMaxRounds, 2);
  assert.equal(decideResourceBudget({ pressure: rate, maxRounds: 5, round: 2, stage: "switch" }).allowed, false);
  assert.equal(decideResourceBudget({ pressure: rate, maxRounds: 5, round: 3, stage: "new-round" }).allowed, false);
});

test("durable quota latch denies a later session even when the observation sink drops its ledger write", async () => {
  const now = 50_000;
  const storage = new Map();
  const state = {
    get: async key => storage.get(key),
    set: async (key, value) => { if (key !== RESOURCE_LEDGER_KEY) storage.set(key, structuredClone(value)); },
  };
  await latchQuotaLimit(state, now);
  const sink = createBoundedStorageObservationSink({}, state);
  await sink({ at: now, kind: "quota-limit", errorCode: "FreeUsageLimitError", failureDomain: "quota" });
  assert.equal(storage.has(RESOURCE_LEDGER_KEY), false, "best-effort factual write was dropped");
  assert.deepEqual(storage.get(QUOTA_ENFORCEMENT_KEY), {
    schema: 1, signal: "quota-limit", trippedAt: now, expiresAt: now + QUOTA_LATCH_TTL_MS,
  });
  const budget = await evaluateResourceBudget(state, { stage: "jev-decision", maxRounds: 3, round: 1 }, now + 1);
  assert.equal(budget.allowed, false);
  assert.equal(budget.basis.includes("quota-enforcement-latch"), true);
  assert.equal("model" in budget, false);
  const recovered = await evaluateResourceBudget(state, { stage: "jev-decision", maxRounds: 3, round: 1 }, now + QUOTA_LATCH_TTL_MS + 1);
  assert.equal(recovered.allowed, true, "local latch expires after the documented heuristic TTL");
});

test("throttle retries are bounded per policy window and reset only after expiry", async () => {
  const data = new Map();
  const storage = { get: async key => data.get(key), set: async (key, value) => data.set(key, structuredClone(value)) };
  const start = 1_000_000;
  assert.deepEqual(await reserveThrottleRetry(storage, start), { allowed: true, retries: 1 });
  assert.deepEqual(await reserveThrottleRetry(storage, start + 1), { allowed: true, retries: 2 });
  assert.deepEqual(await reserveThrottleRetry(storage, start + 2), { allowed: false, retries: MAX_THROTTLE_RETRIES_PER_WINDOW });
  assert.equal(data.get(THROTTLE_RETRY_BUDGET_KEY).retries, MAX_THROTTLE_RETRIES_PER_WINDOW);
  assert.deepEqual(await reserveThrottleRetry(storage, start + 900_000), { allowed: true, retries: 1 });
});

test("throttle retry budget fails closed on invalid state or storage failure", async () => {
  const invalid = { get: async () => ({ windowStart: 10, retries: 99 }), set: async () => {} };
  await assert.rejects(reserveThrottleRetry(invalid, 11), /invalid bounded throttle retry/);
  const failedWrite = { get: async () => undefined, set: async () => { throw new Error("write unavailable"); } };
  await assert.rejects(reserveThrottleRetry(failedWrite, 11), /write unavailable/);
  const failedRead = { get: async () => { throw new Error("read unavailable"); }, set: async () => {} };
  await assert.rejects(reserveThrottleRetry(failedRead, 11), /read unavailable/);
});

test("quota enforcement storage failures reject policy evaluation instead of granting budget", async () => {
  const badRead = { get: async () => { throw new Error("unavailable"); }, set: async () => {} };
  await assert.rejects(evaluateResourceBudget(badRead, { stage: "provider-retry", maxRounds: 1, round: 1 }));
  let emergencyWrites = 0;
  const badWrite = {
    get: async () => undefined,
    set: async () => { emergencyWrites += 1; throw new Error("write unavailable"); },
  };
  const syntheticNow = 1_000;
  await assert.rejects(latchQuotaLimit(badWrite, syntheticNow));
  assert.equal(emergencyWrites, 1);
  const denied = await evaluateResourceBudget(badWrite, { stage: "provider-retry", maxRounds: 1, round: 1 }, syntheticNow + 1);
  assert.equal(denied.allowed, false, "failed durable write retains an in-process hard deny");
});
