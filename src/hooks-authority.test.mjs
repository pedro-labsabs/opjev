import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FREE_POOL } from "./config.ts";
import { registerSessionHooks } from "./hooks.ts";
import { latchQuotaLimit, QUOTA_ENFORCEMENT_KEY } from "./resource-governor/enforcement-state.ts";
import { evaluateResourceBudget } from "./resource-governor/runtime-policy.ts";
import { RESOURCE_LEDGER_KEY } from "./resource-governor/storage-sink.ts";
import { registerInternalToolSession } from "./orchestration/tool-authority.ts";
import { escalateAnswers, makeCtx, makeStorage, okJev, stubFetch } from "./harness.mjs";

const OPTIONS = {
  enableAutoRoute: false,
  jevTimeoutMs: 200,
  confidenceThreshold: 0.55,
  jevEndpoint: "https://opencode.ai/zen/v1/systemone",
  jevModel: "jev-1.13-free",
  apiKeyEnv: "OPENCODE_API_KEY",
};
const ROLES = ["worker", "critic", "orchestrator"];
let nextSession = 0;

function metadataFor(role) {
  return {
    "jev-router": "orchestration-internal",
    "jev-role": role,
    "jev-agent-role": role === "worker" ? "implementer" : role,
  };
}

async function setup({ get = undefined, role = undefined } = {}) {
  const storage = makeStorage();
  const m = makeCtx({
    models: FREE_POOL,
    storage,
    session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
  });
  const sessionID = `issue49-hook-${++nextSession}`;
  const metadata = role ? metadataFor(role) : undefined;
  if (role) registerInternalToolSession(sessionID, role);
  m.ctx.session.get = get ?? (async () => ({
    id: sessionID,
    agent: { id: "build" },
    model: { providerID: "opencode", id: "big-pickle" },
    metadata,
  }));
  await registerSessionHooks(m.ctx, OPTIONS, async () => "test-key");
  return { ...m, sessionID };
}

function providerEvent(sessionID, error = { type: "http_error", status: 503, message: "provider unavailable" }) {
  return {
    sessionID,
    model: { providerID: "opencode", id: "big-pickle" },
    error,
    attempt: 1,
    decision: {},
  };
}

function resourceFacts(storage) {
  return storage._map.get(RESOURCE_LEDGER_KEY)?.observations ?? [];
}

describe("global hooks respect internal control-plane authority", () => {
  for (const role of ROLES) {
    it(`${role} provider failures are observed but never retried or rerouted by session.retry`, async () => {
      const m = await setup({ role });
      const originalError = { type: "http_error", status: 503, message: "provider unavailable" };
      const event = providerEvent(m.sessionID, originalError);
      const stub = stubFetch(() => { throw new Error("internal retry must not query Jev"); });
      try {
        await m.hooks.session.retry(event);
        assert.deepEqual(event.decision, { retry: false });
        assert.equal(event.error, originalError, "original provider error remains observable");
        assert.equal(m.calls.switchModel.length, 0);
        assert.equal(stub.calls.length, 0);
        const facts = resourceFacts(m.storage);
        const providerFailure = facts.find((x) => x.kind === "provider-error");
        assert.ok(providerFailure, "provider-error observation recorded");
        assert.equal(providerFailure.role, role, "preserves exact role provenance instead of unknown");
        assert.equal(providerFailure.statusCode, 503, "preserves HTTP status code");
        assert.equal(providerFailure.errorCode, "503", "preserves sanitized allowlisted HTTP error code");
      } finally {
        stub.restore();
      }
    });

    it(`${role} tool failures retain factual accounting but cannot request or execute a model switch`, async () => {
      const m = await setup({ role });
      const originalError = { message: "tool not found" };
      const event = { sessionID: m.sessionID, tool: "shell", status: "error", error: originalError };
      const stub = stubFetch(({ body }) => {
        if (body?.questions?.action) {
          return okJev({
            action: { type: "choice", choice: "switch-model", confidence: 0.9 },
            keep_model: { type: "noul", noul: 0.1 },
          });
        }
        return okJev({ next_model: { type: "choice", choice: "opencode/mimo-v2.5-free" } });
      });
      try {
        await m.hooks.tool["execute.after"](event);
        assert.equal(event.error, originalError);
        assert.equal(m.calls.switchModel.length, 0);
        assert.equal(stub.calls.length, 0);
        assert.equal(m.storage._map.get(`tool-errors/${m.sessionID}/shell/tool_not_found`)?.count, 1);
      } finally {
        stub.restore();
      }
    });
  }

  it("internal throttle is recorded with statusCode but reserves no retry", async () => {
    const m = await setup({ role: "worker" });
    const event = providerEvent(m.sessionID, { type: "http_error", statusCode: 429, message: "rate limit" });
    await m.hooks.session.retry(event);
    assert.deepEqual(event.decision, { retry: false });
    assert.equal(m.storage._map.has("resource/throttle-retry/v1"), false);
    const facts = resourceFacts(m.storage);
    const throttleFact = facts.find((x) => x.kind === "throttle" && x.statusCode === 429);
    assert.ok(throttleFact, "throttle recorded with statusCode 429");
    assert.equal("errorCode" in throttleFact, false, "throttle should not synthesize errorCode from statusCode");
  });

  it("RED regression: error.code 429 and 529 (numeric and textual) are classified as throttle without inventing statusCode", async () => {
    for (const [codeVal, expectedKind] of [
      [429, "throttle"],
      [529, "throttle"],
      ["429", "throttle"],
      ["529", "throttle"],
      [" 429 ", "throttle"],
    ]) {
      const m = await setup({ role: "worker" });
      const event = providerEvent(m.sessionID, { code: codeVal, message: "provider error" });
      await m.hooks.session.retry(event);
      assert.deepEqual(event.decision, { retry: false });
      const facts = resourceFacts(m.storage);
      const fact = facts.find((x) => x.kind === expectedKind);
      assert.ok(fact, `error.code ${codeVal} should be recorded as kind=${expectedKind}`);
      assert.equal("statusCode" in fact, false, "statusCode should NOT be invented from error.code");
    }

    // External session throttle handling: error.code 429/529 gets throttle treatment with explicit budget, not generic provider escalation
    for (const codeVal of [429, "429", 529, "529"]) {
      const mExt = makeCtx({
        models: FREE_POOL,
        storage: makeStorage(),
        session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      });
      const extSessionID = `issue49-ext-throttle-${++nextSession}`;
      mExt.ctx.session.get = async () => ({
        id: extSessionID,
        agent: { id: "build" },
        model: { providerID: "opencode", id: "big-pickle" },
      });
      await registerSessionHooks(mExt.ctx, OPTIONS, async () => "test-key");
      const extEvent = {
        sessionID: extSessionID,
        model: { providerID: "opencode", id: "big-pickle" },
        error: { code: codeVal, message: "provider error" },
        attempt: 1,
        decision: {},
      };
      await mExt.hooks.session.retry(extEvent);
      assert.equal(extEvent.decision.retry, true, `external throttle retry granted for code ${codeVal}`);
      assert.equal(mExt.calls.switchModel.length, 0, "throttle does not trigger switchModel escalation");
      const facts = resourceFacts(mExt.storage);
      const throttleFact = facts.find((x) => x.kind === "throttle");
      assert.ok(throttleFact, `external error.code ${codeVal} recorded as throttle`);
      assert.equal("statusCode" in throttleFact, false, "statusCode not invented for external throttle");
    }

    // Adversarial inputs fail-closed (not throttle unless valid signal)
    const adversarialNonThrottle = [
      Symbol("throttle-sym"),
      { valueOf() { throw new Error("hostile valueOf"); } },
      { get code() { throw new Error("hostile getter"); } },
      { get status() { throw new Error("hostile getter"); } },
      { get message() { throw new Error("hostile getter"); } },
      { code: Symbol("sym") },
      { status: Symbol("sym") },
      null,
      undefined,
      {},
      { status: 401 },
      { status: 403 },
      { status: 418 },
      { status: 500 },
      { status: 503 },
    ];
    for (const bad of adversarialNonThrottle) {
      const m = await setup({ role: "worker" });
      const event = providerEvent(m.sessionID, bad);
      await assert.doesNotReject(async () => {
        await m.hooks.session.retry(event);
      });
      assert.deepEqual(event.decision, { retry: false });
      const facts = resourceFacts(m.storage);
      const fact = facts[facts.length - 1];
      assert.notEqual(fact?.kind, "throttle", "adversarial/non-throttle input must not be classified as throttle");
    }

    // Approved contract: object coercion never produces a provider-code signal.
    const mValueOf = await setup({ role: "worker" });
    let valueOfCalls = 0;
    const eventValueOf = providerEvent(mValueOf.sessionID, { code: { valueOf() { valueOfCalls++; return 429; } }, message: "provider error" });
    await mValueOf.hooks.session.retry(eventValueOf);
    assert.deepEqual(eventValueOf.decision, { retry: false });
    assert.equal(valueOfCalls, 0, "classifier must not invoke valueOf");
    const factsValueOf = resourceFacts(mValueOf.storage);
    assert.equal(factsValueOf.some((x) => x.kind === "throttle"), false, "object code cannot be classified as throttle");
    assert.equal(mValueOf.storage._map.has("resource/throttle-retry/v1"), false);
  });

  it("RED regression: canonical provider.quota wins over 429, 403, and absent HTTP status", async () => {
    for (const status of [429, 403, undefined]) {
      const storage = makeStorage();
      let roleLookups = 0;
      const m = makeCtx({ models: FREE_POOL, storage, session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } } });
      const sessionID = `issue49-canonical-quota-${++nextSession}`;
      m.ctx.session.get = async () => {
        roleLookups++;
        return { id: sessionID, agent: { id: "build" }, model: { providerID: "opencode", id: "big-pickle" } };
      };
      await registerSessionHooks(m.ctx, OPTIONS, async () => "test-key");
      const stub = stubFetch(() => { throw new Error("quota hard deny must not query Jev"); });
      try {
        const event = providerEvent(sessionID, {
          type: "provider.quota",
          message: "quota exceeded",
          ...(status !== undefined ? { status } : {}),
        });
        event.decision = { retry: true, delay: 5000 };
        await m.hooks.session.retry(event);
        assert.deepEqual(event.decision, { retry: false }, `provider.quota/status=${status} must deny retry`);
        assert.equal(roleLookups, 0, "quota latch occurs before external role lookup");
        assert.equal(storage._map.get("resource/enforcement/quota-latch/v1")?.signal, "quota-limit");
        assert.equal(storage._map.has("resource/throttle-retry/v1"), false);
        assert.equal(m.calls.switchModel.length, 0);
        assert.equal(stub.calls.length, 0);
        const quotaFact = resourceFacts(storage).find((item) => item.kind === "quota-limit");
        assert.ok(quotaFact, "canonical quota evidence is persisted best effort");
        assert.equal(quotaFact.errorCode, "quota-limit");
        assert.equal(JSON.stringify(quotaFact).includes("quota exceeded"), false);
      } finally { stub.restore(); }
    }
  });

  it("RED regression: canonical provider.rate-limit preserves bounded retry for all HTTP status provenance fields", async () => {
    for (const [httpFields, expectedStatus] of [
      [{ status: 429 }, 429], [{ status: 529 }, 529],
      [{ statusCode: 429 }, 429], [{ statusCode: 529 }, 529],
      [{ response: { status: 429 } }, 429], [{ response: { status: 529 } }, 529],
    ]) {
      const storage = makeStorage();
      const m = makeCtx({ models: FREE_POOL, storage, session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } } });
      const sessionID = `issue49-canonical-rate-limit-${++nextSession}`;
      m.ctx.session.get = async () => ({ id: sessionID, agent: { id: "build" }, model: { providerID: "opencode", id: "big-pickle" } });
      await registerSessionHooks(m.ctx, OPTIONS, async () => "test-key");
      const stub = stubFetch(() => { throw new Error("canonical throttle must not query Jev"); });
      try {
        const event = providerEvent(sessionID, { type: "provider.rate-limit", message: "rate limit", ...httpFields });
        await m.hooks.session.retry(event);
        assert.deepEqual(event.decision, { retry: true, delay: 5000 });
        assert.equal(storage._map.has("resource/enforcement/quota-latch/v1"), false);
        assert.equal(storage._map.get("resource/throttle-retry/v1")?.retries, 1);
        assert.equal(m.calls.switchModel.length, 0);
        assert.equal(stub.calls.length, 0);
        const throttle = resourceFacts(storage).find((item) => item.kind === "throttle");
        assert.ok(throttle);
        assert.equal(throttle.statusCode, expectedStatus);
        assert.equal("errorCode" in throttle, false);
      } finally { stub.restore(); }
    }
  });

  for (const type of [
    "provider.auth",
    "provider.invalid-request",
    "provider.content-filter",
    "provider.no-route",
    "provider.unsupported-operation",
  ]) {
    for (const status of [429, 529]) {
      it(`RED regression: ${type} with HTTP ${status} preserves host retry deny`, async () => {
        const storage = makeStorage();
        const m = makeCtx({ models: FREE_POOL, storage, session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } } });
        const sessionID = `issue49-non-retryable-${type}-${status}-${++nextSession}`;
        let roleLookups = 0;
        m.ctx.session.get = async () => {
          roleLookups++;
          return { id: sessionID, agent: { id: "build" }, model: { providerID: "opencode", id: "big-pickle" } };
        };
        await registerSessionHooks(m.ctx, OPTIONS, async () => "test-key");
        const stub = stubFetch(() => { throw new Error(`${type} must not query Jev`); });
        try {
          const event = providerEvent(sessionID, { type, message: "terminal provider error", status });
          event.decision = { retry: false };
          await m.hooks.session.retry(event);
          assert.deepEqual(event.decision, { retry: false }, `${type} must remain non-retryable despite HTTP ${status}`);
          assert.equal(storage._map.has("resource/throttle-retry/v1"), false, `${type} must not reserve throttle budget`);
          assert.equal(storage._map.has(QUOTA_ENFORCEMENT_KEY), false, `${type} must not fabricate a quota latch`);
          assert.equal(m.calls.switchModel.length, 0, `${type} must not switch models`);
          assert.equal(stub.calls.length, 0, `${type} must not query Jev`);
          assert.equal(roleLookups, 0, `${type} deny must precede role lookup and recovery work`);
          const evidence = resourceFacts(storage).find((item) => item.kind === "provider-error");
          assert.ok(evidence, `${type} retains bounded provider failure evidence`);
          assert.equal(evidence.statusCode, status);
          assert.equal(evidence.errorCode, String(status));
          assert.equal(JSON.stringify(evidence).includes("terminal provider error"), false);
        } finally { stub.restore(); }
      });
    }
  }

  for (const [type, message] of [
    ["provider.invalid-output", "not incomplete-stream"],
    ["provider.transport", "write failed"],
  ]) {
    for (const status of [429, 529, undefined]) {
      const statusLabel = status === undefined ? "no HTTP status" : `HTTP ${status}`;
      it(`RED regression: host retry:false for conditional ${type} with ${statusLabel} denies all recovery`, async () => {
        const m = await setup();
        let roleLookups = 0;
        m.ctx.session.get = async () => {
          roleLookups++;
          return { id: m.sessionID, agent: { id: "build" }, model: { providerID: "opencode", id: "big-pickle" } };
        };
        const stub = stubFetch(() => { throw new Error(`${type} with host retry:false must not query Jev`); });
        try {
          const error = { type, message, ...(status !== undefined ? { status } : {}) };
          const event = providerEvent(m.sessionID, error);
          event.decision = { retry: false };
          await m.hooks.session.retry(event);
          assert.deepEqual(event.decision, { retry: false }, "host denial must not be upgraded");
          assert.equal(stub.calls.length, 0, "denied conditional recovery must not query Jev");
          assert.equal(m.calls.switchModel.length, 0, "denied conditional recovery must not switch models");
          assert.equal(m.storage._map.has("resource/throttle-retry/v1"), false, "denied conditional recovery must not reserve throttle budget");
          assert.equal(roleLookups, 0, "host denial is honored before role/recovery lookup");
        } finally { stub.restore(); }
      });
    }

    for (const status of [429, 529]) {
      it(`host retry:true keeps bounded throttle recovery for conditional ${type} with HTTP ${status}`, async () => {
        const m = await setup();
        const stub = stubFetch(() => { throw new Error("throttle recovery must not query Jev"); });
        try {
          const event = providerEvent(m.sessionID, { type, message, status });
          event.decision = { retry: true };
          await m.hooks.session.retry(event);
          assert.deepEqual(event.decision, { retry: true, delay: 5000 });
          assert.equal(m.storage._map.get("resource/throttle-retry/v1")?.retries, 1, "authorized throttle uses the existing reservation");
          assert.equal(m.calls.switchModel.length, 0);
          assert.equal(stub.calls.length, 0);
        } finally { stub.restore(); }
      });
    }

    it(`host retry:true keeps existing Jev-governed provider recovery for conditional ${type} without status`, async () => {
      const m = await setup();
      const stub = stubFetch(() => okJev(escalateAnswers("opencode/mimo-v2.5-free")));
      try {
        const event = providerEvent(m.sessionID, { type, message });
        event.decision = { retry: true };
        await m.hooks.session.retry(event);
        assert.deepEqual(event.decision, { retry: true, delay: 1000 });
        assert.ok(stub.calls.length > 0, "authorized ordinary provider recovery remains Jev-governed");
        assert.equal(m.calls.switchModel.length, 1, "existing authorized model switch remains available");
        assert.equal(m.storage._map.has("resource/throttle-retry/v1"), false, "no HTTP status means no throttle reservation");
      } finally { stub.restore(); }
    });
  }

  it("retry fails closed without reservation when quota-state storage reads fail", async () => {
    const storage = makeStorage();
    const get = storage.get;
    storage.get = async (key) => {
      if (key === QUOTA_ENFORCEMENT_KEY) throw new Error("quota state unreadable");
      return get(key);
    };
    const m = makeCtx({ models: FREE_POOL, storage, session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } } });
    const sessionID = `issue49-quota-state-read-failure-${++nextSession}`;
    m.ctx.session.get = async () => ({ id: sessionID, agent: { id: "build" }, model: { providerID: "opencode", id: "big-pickle" } });
    await registerSessionHooks(m.ctx, OPTIONS, async () => "test-key");
    const stub = stubFetch(() => { throw new Error("unreadable quota state must deny before Jev"); });
    try {
      const event = providerEvent(sessionID, { type: "provider.rate-limit", message: "rate limit", status: 429 });
      await m.hooks.session.retry(event);
      assert.deepEqual(event.decision, { retry: false });
      assert.equal(storage._map.has("resource/throttle-retry/v1"), false);
      assert.equal(m.calls.switchModel.length, 0);
      assert.equal(stub.calls.length, 0);
    } finally { stub.restore(); }
  });

  it("retry fails closed without reservation when resource-ledger storage reads fail", async () => {
    const storage = makeStorage();
    const get = storage.get;
    storage.get = async (key) => {
      if (key === RESOURCE_LEDGER_KEY) throw new Error("resource ledger unreadable");
      return get(key);
    };
    const m = makeCtx({ models: FREE_POOL, storage, session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } } });
    const sessionID = `issue49-ledger-read-failure-${++nextSession}`;
    m.ctx.session.get = async () => ({ id: sessionID, agent: { id: "build" }, model: { providerID: "opencode", id: "big-pickle" } });
    await registerSessionHooks(m.ctx, OPTIONS, async () => "test-key");
    const stub = stubFetch(() => { throw new Error("unreadable resource ledger must deny before Jev"); });
    try {
      const event = providerEvent(sessionID, { type: "provider.rate-limit", message: "rate limit", status: 429 });
      await m.hooks.session.retry(event);
      assert.deepEqual(event.decision, { retry: false });
      assert.equal(storage._map.has("resource/throttle-retry/v1"), false);
      assert.equal(m.calls.switchModel.length, 0);
      assert.equal(stub.calls.length, 0);
    } finally { stub.restore(); }
  });

  it("RED regression: quota latch storage failure retains emergency deny in the retry hook", async () => {
    const storage = makeStorage();
    const set = storage.set;
    storage.set = async (key, value) => {
      if (key === "resource/enforcement/quota-latch/v1") throw new Error("quota state unavailable");
      await set(key, value);
    };
    const m = makeCtx({ models: FREE_POOL, storage, session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } } });
    const sessionID = `issue49-quota-storage-failure-${++nextSession}`;
    let roleLookups = 0;
    m.ctx.session.get = async () => {
      roleLookups++;
      return { id: sessionID, agent: { id: "build" }, model: { providerID: "opencode", id: "big-pickle" } };
    };
    await registerSessionHooks(m.ctx, OPTIONS, async () => "test-key");
    const stub = stubFetch(() => { throw new Error("quota storage failure must not query Jev"); });
    try {
      const event = providerEvent(sessionID, { type: "provider.quota", message: "quota exceeded", status: 429 });
      await m.hooks.session.retry(event);
      assert.deepEqual(event.decision, { retry: false });
      assert.equal(roleLookups, 0);
      assert.equal(storage._map.has("resource/enforcement/quota-latch/v1"), false, "durable write is genuinely unavailable");
      const budget = await evaluateResourceBudget(storage, { stage: "provider-retry", maxRounds: 1, round: 1 });
      assert.equal(budget.allowed, false, "emergency latch survives the failed durable write");
      assert.equal(resourceFacts(storage).some((item) => item.kind === "quota-limit"), true);
      assert.equal(stub.calls.length, 0);
    } finally { stub.restore(); }
  });

  it("RED regression: failed throttle reservation explicitly denies retry without switching", async () => {
    const storage = makeStorage();
    const set = storage.set;
    storage.set = async (key, value) => {
      if (key === "resource/throttle-retry/v1") throw new Error("throttle reservation unavailable");
      await set(key, value);
    };
    const m = makeCtx({ models: FREE_POOL, storage, session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } } });
    const sessionID = `issue49-throttle-storage-failure-${++nextSession}`;
    m.ctx.session.get = async () => ({ id: sessionID, agent: { id: "build" }, model: { providerID: "opencode", id: "big-pickle" } });
    await registerSessionHooks(m.ctx, OPTIONS, async () => "test-key");
    const stub = stubFetch(() => { throw new Error("failed reservation must not query Jev"); });
    try {
      const event = providerEvent(sessionID, { type: "provider.rate-limit", message: "rate limit", status: 429 });
      await m.hooks.session.retry(event);
      assert.deepEqual(event.decision, { retry: false });
      assert.equal(storage._map.has("resource/throttle-retry/v1"), false);
      assert.equal(storage._map.has("resource/enforcement/quota-latch/v1"), false);
      assert.equal(m.calls.switchModel.length, 0);
      assert.equal(stub.calls.length, 0);
      assert.equal(resourceFacts(storage).some((item) => item.kind === "throttle"), true);
    } finally { stub.restore(); }
  });

  it("RED regression: readable canonical quota survives a throwing unrelated getter", async () => {
    const storage = makeStorage();
    const m = makeCtx({ models: FREE_POOL, storage, session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } } });
    const sessionID = `issue49-partial-quota-${++nextSession}`;
    m.ctx.session.get = async () => ({ id: sessionID, agent: { id: "build" }, model: { providerID: "opencode", id: "big-pickle" } });
    await registerSessionHooks(m.ctx, OPTIONS, async () => "test-key");
    const stub = stubFetch(() => { throw new Error("quota hard deny must not query Jev"); });
    try {
      const event = providerEvent(sessionID, {
        get name() { throw new Error("hostile unrelated getter"); },
        type: "provider.quota",
        message: "quota exceeded",
        status: 429,
      });
      await m.hooks.session.retry(event);
      assert.deepEqual(event.decision, { retry: false });
      assert.equal(storage._map.get("resource/enforcement/quota-latch/v1")?.signal, "quota-limit");
      assert.equal(storage._map.has("resource/throttle-retry/v1"), false);
      assert.equal(resourceFacts(storage).some((item) => item.kind === "quota-limit"), true);
      assert.equal(stub.calls.length, 0);
    } finally { stub.restore(); }
  });

  it("RED regression: status 503 plus provider code 429 is ambiguous and cannot recover", async () => {
    const storage = makeStorage();
    const m = makeCtx({ models: FREE_POOL, storage, session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } } });
    const sessionID = `issue49-status-code-conflict-${++nextSession}`;
    m.ctx.session.get = async () => ({ id: sessionID, agent: { id: "build" }, model: { providerID: "opencode", id: "big-pickle" } });
    await registerSessionHooks(m.ctx, OPTIONS, async () => "test-key");
    const stub = stubFetch(() => { throw new Error("ambiguous error must not query Jev"); });
    try {
      const event = providerEvent(sessionID, { status: 503, code: 429, message: "server unavailable" });
      await m.hooks.session.retry(event);
      assert.deepEqual(event.decision, { retry: false });
      assert.equal(storage._map.has("resource/throttle-retry/v1"), false);
      assert.equal(m.calls.switchModel.length, 0);
      assert.equal(stub.calls.length, 0);
      const observation = resourceFacts(storage).find((item) => item.kind === "unknown");
      assert.ok(observation);
      assert.equal(observation.statusCode, 503);
      assert.equal("errorCode" in observation, false);
    } finally { stub.restore(); }
  });

  it("RED regression: hostile provider code coercion is not called or authorized for external recovery", async () => {
    const storage = makeStorage();
    const m = makeCtx({ models: FREE_POOL, storage, session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } } });
    const sessionID = `issue49-valueof-code-${++nextSession}`;
    m.ctx.session.get = async () => ({ id: sessionID, agent: { id: "build" }, model: { providerID: "opencode", id: "big-pickle" } });
    await registerSessionHooks(m.ctx, OPTIONS, async () => "test-key");
    let calls = 0;
    const stub = stubFetch(() => { throw new Error("object code must not query Jev"); });
    try {
      const event = providerEvent(sessionID, { code: { valueOf() { calls++; return 429; } }, message: "provider failure" });
      await m.hooks.session.retry(event);
      assert.deepEqual(event.decision, { retry: false });
      assert.equal(calls, 0);
      assert.equal(storage._map.has("resource/throttle-retry/v1"), false);
      assert.equal(stub.calls.length, 0);
    } finally { stub.restore(); }
  });

  it("RED regression: Symbol provider code makes an otherwise throttled external payload fail closed", async () => {
    const storage = makeStorage();
    const m = makeCtx({ models: FREE_POOL, storage, session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } } });
    const sessionID = `issue49-symbol-provider-code-${++nextSession}`;
    m.ctx.session.get = async () => ({ id: sessionID, agent: { id: "build" }, model: { providerID: "opencode", id: "big-pickle" } });
    await registerSessionHooks(m.ctx, OPTIONS, async () => "test-key");
    const stub = stubFetch(() => { throw new Error("incomplete provider code must not query Jev"); });
    try {
      const event = providerEvent(sessionID, { type: "provider.rate-limit", message: "rate limit", status: 429, code: Symbol("429") });
      await m.hooks.session.retry(event);
      assert.deepEqual(event.decision, { retry: false });
      assert.equal(storage._map.has("resource/throttle-retry/v1"), false);
      assert.equal(m.calls.switchModel.length, 0);
      assert.equal(stub.calls.length, 0);
      const observation = resourceFacts(storage).find((item) => item.kind === "unknown");
      assert.ok(observation);
      assert.equal(observation.statusCode, 429);
      assert.equal("errorCode" in observation, false);
    } finally { stub.restore(); }
  });

  it("adversarial status inputs do not throw in retry hook and record safe fallback", async () => {
    const adversarial = [
      Symbol("untrusted"),
      { valueOf() { throw new Error("hostile valueOf"); } },
      " 403 ",
      "403abc",
      null,
      undefined,
      0,
      200,
      600,
      -1,
      418.5,
    ];
    for (const bad of adversarial) {
      const m = await setup({ role: "worker" });
      const event = providerEvent(m.sessionID, { status: bad, message: "adversarial error input" });
      // Must not throw exception
      await assert.doesNotReject(async () => {
        await m.hooks.session.retry(event);
      });
      assert.deepEqual(event.decision, { retry: false }, "worker role always fails closed");
      const facts = resourceFacts(m.storage);
      const fact = facts[facts.length - 1];
      assert.ok(fact, "fact recorded");
      assert.equal("statusCode" in fact, false, "invalid status should not be recorded as statusCode");
      if (bad === null || bad === undefined) {
        assert.equal(fact.errorCode, "provider-error", "absent HTTP status remains a complete generic provider error");
      } else {
        assert.equal(fact.kind, "unknown", "malformed HTTP status must remain an incomplete observation");
        assert.equal("errorCode" in fact, false, "incomplete input must not be projected as provider-error");
      }
    }

    // Also test external session with quota latched: instrumentation error must not alter fail-closed decision
    const storage = makeStorage();
    await latchQuotaLimit(storage, Date.now());
    const mExt = makeCtx({
      models: FREE_POOL,
      storage,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
    });
    const extSessionID = `issue49-ext-failclosed-${++nextSession}`;
    mExt.ctx.session.get = async () => ({
      id: extSessionID,
      agent: { id: "build" },
      model: { providerID: "opencode", id: "big-pickle" },
    });
    await registerSessionHooks(mExt.ctx, OPTIONS, async () => "test-key");
    const extEvent = {
      sessionID: extSessionID,
      model: { providerID: "opencode", id: "big-pickle" },
      error: { status: { valueOf() { throw new Error("hostile"); } }, message: "adversarial" },
      attempt: 1,
      decision: {},
    };
    await assert.doesNotReject(async () => {
      await mExt.hooks.session.retry(extEvent);
    });
    assert.deepEqual(extEvent.decision, { retry: false }, "latched quota fails closed regardless of error status");
  });

  for (const [label, get] of [
    ["lookup throws", async () => { throw new Error("session state unavailable"); }],
    ["lookup returns no session", async () => undefined],
    ["role metadata is ambiguous", async () => ({ metadata: { "jev-role": "worker" } })],
    ["lookup never resolves", async () => await new Promise(() => {})],
  ]) {
    it(`${label} fails closed for provider recovery and tool switches`, async () => {
      const m = await setup({ get });
      const stub = stubFetch(() => { throw new Error("unavailable role must not query Jev"); });
      try {
        const provider = providerEvent(m.sessionID);
        const start = Date.now();
        await m.hooks.session.retry(provider);
        assert.deepEqual(provider.decision, { retry: false });
        assert.ok(Date.now() - start < 1000, "role lookup is independently bounded");
        const toolError = { message: "tool not found" };
        await m.hooks.tool["execute.after"]({ sessionID: m.sessionID, tool: "shell", status: "error", error: toolError });
        assert.equal(m.calls.switchModel.length, 0);
        assert.equal(stub.calls.length, 0);
        assert.equal(m.storage._map.get(`tool-errors/${m.sessionID}/shell/tool_not_found`)?.count, 1);
      } finally {
        stub.restore();
      }
    });
  }

  it("RED regression: HTTP status extraction in retry hook rejects null, 200, 600, negative and non-integer", async () => {
    for (const errStatus of [
      null, undefined, "", 0, 200, 600, -1, 418.5, "401", " 403 ", Symbol("untrusted"),
      { valueOf() { throw new Error("hostile valueOf"); } }, 418, 401, 403, 408, 500, 503,
    ]) {
      const m = await setup({ role: "worker" });
      const originalError = { status: errStatus, message: "simulated provider failure" };
      const event = providerEvent(m.sessionID, originalError);
      await m.hooks.session.retry(event);
      const facts = resourceFacts(m.storage);
      const fact = facts[facts.length - 1];
      assert.ok(fact, "fact recorded");
      if (typeof errStatus === "number" && Number.isInteger(errStatus) && errStatus >= 400 && errStatus <= 599) {
        assert.equal(fact.statusCode, errStatus, "expected valid status");
        assert.equal(fact.errorCode, errStatus === 418 ? "provider-error" : String(errStatus), "HTTP status provenance remains bounded");
      } else {
        assert.equal("statusCode" in fact, false, "statusCode should not be recorded for invalid status");
        if (errStatus === null || errStatus === undefined) {
          assert.equal(fact.errorCode, "provider-error");
        } else {
          assert.equal(fact.kind, "unknown");
          assert.equal("errorCode" in fact, false);
        }
      }
    }
  });

  it("RED regression: role lookup failure or ambiguity marks role unknown, never worker/critic", async () => {
    const m = await setup({ get: async () => ({ metadata: { "jev-role": "ambiguous" } }) });
    const originalError = { status: 503, message: "unavailable" };
    const event = providerEvent(m.sessionID, originalError);
    await m.hooks.session.retry(event);
    const facts = resourceFacts(m.storage);
    const fact = facts.find(x => x.kind === "provider-error");
    assert.ok(fact);
    assert.equal(fact.role, "unknown");
  });

  it("quota latch still trips before internal role lookup", async () => {
    let lookups = 0;
    const m = await setup({ role: "worker", get: async () => { lookups += 1; throw new Error("unavailable"); } });
    const event = providerEvent(m.sessionID, { name: "FreeUsageLimitError", message: "free usage exhausted" });
    await m.hooks.session.retry(event);
    assert.deepEqual(event.decision, { retry: false });
    assert.equal(lookups, 0);
    assert.equal(m.storage._map.get("resource/enforcement/quota-latch/v1")?.signal, "quota-limit");
    assert.equal(resourceFacts(m.storage).some((x) => x.kind === "quota-limit"), true);
  });
});
