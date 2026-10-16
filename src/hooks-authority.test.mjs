import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FREE_POOL } from "./config.ts";
import { registerSessionHooks } from "./hooks.ts";
import { latchQuotaLimit } from "./resource-governor/enforcement-state.ts";
import { RESOURCE_LEDGER_KEY } from "./resource-governor/storage-sink.ts";
import { registerInternalToolSession } from "./orchestration/tool-authority.ts";
import { makeCtx, makeStorage, okJev, stubFetch } from "./harness.mjs";

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

    // Valid valueOf returning 429
    const mValueOf = await setup({ role: "worker" });
    const eventValueOf = providerEvent(mValueOf.sessionID, { code: { valueOf() { return 429; } }, message: "provider error" });
    await mValueOf.hooks.session.retry(eventValueOf);
    assert.deepEqual(eventValueOf.decision, { retry: false });
    const factsValueOf = resourceFacts(mValueOf.storage);
    const factValueOf = factsValueOf.find((x) => x.kind === "throttle");
    assert.ok(factValueOf, "object with valueOf() === 429 classified as throttle");
    assert.equal("statusCode" in factValueOf, false, "statusCode not invented from valueOf");
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
      assert.equal(fact.errorCode, "provider-error");
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
    for (const [errStatus, expectedCode] of [
      [null, "provider-error"],
      [undefined, "provider-error"],
      ["", "provider-error"],
      [0, "provider-error"],
      [200, "provider-error"],
      [600, "provider-error"],
      [-1, "provider-error"],
      [418.5, "provider-error"],
      ["401", "provider-error"],
      [" 403 ", "provider-error"],
      [Symbol("untrusted"), "provider-error"],
      [{ valueOf() { throw new Error("hostile valueOf"); } }, "provider-error"],
      [418, "provider-error"],
      [401, "401"],
      [403, "403"],
      [408, "408"],
      [500, "500"],
      [503, "503"],
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
      } else {
        assert.equal("statusCode" in fact, false, "statusCode should not be recorded for invalid status");
      }
      assert.equal(fact.errorCode, expectedCode, "expected errorCode match");
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
