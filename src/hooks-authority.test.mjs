import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FREE_POOL } from "./config.ts";
import { registerSessionHooks } from "./hooks.ts";
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
    assert.equal(resourceFacts(m.storage).some((x) => x.kind === "throttle" && x.statusCode === 429), true);
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
      [0, "provider-error"],
      [200, "provider-error"],
      [600, "provider-error"],
      [-1, "provider-error"],
      [418, "provider-error"],
      [401, "401"],
      [403, "403"],
      [408, "408"],
      [429, "429"],
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
      if (errStatus >= 400 && errStatus <= 599) {
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
