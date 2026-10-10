import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PROVIDER_COMPATIBILITY_PERMISSIONS,
  enforceInternalToolAuthority,
  fenceInternalToolSession,
  registerInternalToolSession,
  resolveInternalToolRole,
} from "./orchestration/tool-authority.ts";
import { makeWorkerRuntime } from "./plugin-runtime.ts";
import { buildCriticProviderPermissions, buildOrchestratorProviderPermissions } from "./orchestration/readonly-policy.ts";

const INTERNAL = "orchestration-internal";

function sessionInfo(role, agentRole = role) {
  return {
    metadata: {
      "jev-router": INTERNAL,
      "jev-role": role,
      "jev-agent-role": agentRole,
    },
  };
}

async function simulateToolCall(ctx, sessionID, tool) {
  let executorCalls = 0;
  await enforceInternalToolAuthority(ctx, { sessionID, tool });
  executorCalls += 1;
  return executorCalls;
}

describe("separação entre tool visibility e local authority", () => {
  it("mantém tools provider-facing visíveis por uma regra de compatibilidade explícita", () => {
    assert.deepEqual(PROVIDER_COMPATIBILITY_PERMISSIONS, [
      { action: "*", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "deny" },
      { action: "read", resource: "*.env.*", effect: "deny" },
      { action: "external_directory", resource: "*", effect: "deny" },
    ]);
    assert.deepEqual(buildCriticProviderPermissions(), PROVIDER_COMPATIBILITY_PERMISSIONS);
    assert.deepEqual(buildOrchestratorProviderPermissions(), PROVIDER_COMPATIBILITY_PERMISSIONS);
  });

  it("nega shell/edit/write/subagent/execute do critic antes da invocação do executor", async () => {
    const ctx = { session: { get: async () => sessionInfo("critic") } };
    for (const tool of ["bash", "edit", "write", "task", "subagent", "execute", "code"]) {
      let calls = 0;
      await assert.rejects(
        (async () => {
          await enforceInternalToolAuthority(ctx, { sessionID: "critic-1", tool });
          calls += 1;
        })(),
        /local read-only authority/,
        `${tool} deve ser negada antes de side effect`,
      );
      assert.equal(calls, 0, `${tool}: executor real nunca invocado`);
    }
  });

  it("permite ao critic apenas read/glob/grep e falha fechada para tools desconhecidas", async () => {
    const ctx = { session: { get: async () => sessionInfo("critic") } };
    for (const tool of ["read", "glob", "grep"]) {
      await assert.doesNotReject(enforceInternalToolAuthority(ctx, { sessionID: "critic-1", tool }));
    }
    await assert.rejects(
      enforceInternalToolAuthority(ctx, { sessionID: "critic-1", tool: "mcp:mutable-write" }),
      /local read-only authority/,
    );
  });

  it("aplica a mesma boundary ao orchestrator", async () => {
    const ctx = { session: { get: async () => sessionInfo("orchestrator") } };
    assert.equal(await simulateToolCall(ctx, "orch-1", "grep"), 1);
    for (const tool of ["bash", "edit", "write", "task", "subagent", "execute", "code", "question", "webfetch"]) {
      await assert.rejects(simulateToolCall(ctx, "orch-1", tool), /local read-only authority/);
    }
  });
  it("requires a valid control-plane binding before creating a worker session", async () => {
    let createCalls = 0;
    const runtime = makeWorkerRuntime({ session: { create: async () => {
      createCalls += 1;
      return { id: `unbound-create-${Date.now()}` };
    } } });
    await assert.rejects(runtime.createWorker({
      agent: "build",
      model: { providerID: "opencode", id: "big-pickle" },
      metadata: {},
    }), /binding/i);
    assert.equal(createCalls, 0);
  });

  it("advances a reused worker only to the next same-model round", async () => {
    const sessionID = `repair-binding-${Date.now()}`;
    const model = { providerID: "opencode", id: "big-pickle" };
    const prompts = [];
    const ctx = {
      session: {
        create: async () => ({ id: sessionID }),
        prompt: async (input) => prompts.push(input),
        get: async () => ({ ...sessionInfo("worker", "implementer"), model }),
      },
    };
    const runtime = makeWorkerRuntime(ctx);
    const binding = { runID: "repair-binding-run", round: 1, model: "opencode/big-pickle" };
    await runtime.createWorker({
      agent: "build",
      model,
      binding,
      metadata: {},
    });
    await runtime.prompt({ sessionID, text: "round one", binding, metadata: {} });
    await runtime.prompt({
      sessionID,
      text: "round two",
      binding: { ...binding, round: 2 },
      metadata: {},
    });
    assert.equal(prompts.length, 2);
    await assert.rejects(runtime.prompt({
      sessionID,
      text: "unauthorized switch",
      binding: { ...binding, round: 3, model: "opencode/mimo-v2.5-free" },
      metadata: {},
    }), /binding transition/i);
    assert.equal(prompts.length, 2);
    await assert.rejects(enforceInternalToolAuthority(ctx, { sessionID, tool: "bash" }), /fenced/i);
  });


  it("worker tools require a control-plane model binding and an exact runtime model", async () => {
    const sessionID = `bound-worker-${Date.now()}`;
    registerInternalToolSession(sessionID, "worker", {
      runID: "run-model-bound",
      round: 1,
      model: "opencode/big-pickle",
    });
    const ctx = { session: { get: async () => ({
      ...sessionInfo("worker", "implementer"),
      model: { providerID: "opencode", id: "big-pickle" },
    }) } };
    await assert.doesNotReject(enforceInternalToolAuthority(ctx, { sessionID, tool: "edit" }));
  });

  it("denies and fences a worker whose runtime model diverges from its contract", async () => {
    const sessionID = `divergent-worker-${Date.now()}`;
    registerInternalToolSession(sessionID, "worker", {
      runID: "run-model-divergent",
      round: 1,
      model: "opencode/big-pickle",
    });
    let model = { providerID: "opencode", id: "mimo-v2.5-free" };
    const ctx = { session: { get: async () => ({ ...sessionInfo("worker", "implementer"), model }) } };
    await assert.rejects(enforceInternalToolAuthority(ctx, { sessionID, tool: "bash" }), /model/i);
    model = { providerID: "opencode", id: "big-pickle" };
    await assert.rejects(enforceInternalToolAuthority(ctx, { sessionID, tool: "bash" }), /fenced/i);
  });

  it("denies and fences a worker with a missing or ambiguous model contract", async () => {
    const missing = `missing-contract-${Date.now()}`;
    registerInternalToolSession(missing, "worker");
    const missingCtx = { session: { get: async () => ({
      ...sessionInfo("worker", "implementer"),
      model: { providerID: "opencode", id: "big-pickle" },
    }) } };
    await assert.rejects(enforceInternalToolAuthority(missingCtx, { sessionID: missing, tool: "edit" }), /contract|model/i);

    const ambiguous = `ambiguous-model-${Date.now()}`;
    registerInternalToolSession(ambiguous, "worker", {
      runID: "run-model-ambiguous",
      round: 1,
      model: "opencode/big-pickle",
    });
    const ambiguousCtx = { session: { get: async () => ({
      ...sessionInfo("worker", "implementer"),
      model: { providerID: "opencode" },
    }) } };
    await assert.rejects(enforceInternalToolAuthority(ambiguousCtx, { sessionID: ambiguous, tool: "edit" }), /model/i);
  });
  it("bounds a non-settling runtime model lookup and fences the worker", async () => {
    const sessionID = `hung-model-lookup-${Date.now()}`;
    registerInternalToolSession(sessionID, "worker", {
      runID: "hung-model-lookup-run",
      round: 1,
      model: "opencode/big-pickle",
    });
    const ctx = { session: { get: async () => await new Promise(() => {}) } };
    const start = Date.now();
    await assert.rejects(enforceInternalToolAuthority(ctx, { sessionID, tool: "bash" }), /session state unavailable/);
    assert.ok(Date.now() - start < 1000);
    const readable = { session: { get: async () => ({
      ...sessionInfo("worker", "implementer"),
      model: { providerID: "opencode", id: "big-pickle" },
    }) } };
    await assert.rejects(enforceInternalToolAuthority(readable, { sessionID, tool: "bash" }), /fenced/i);
  });


  it("does not grant worker authority from unregistered session metadata", async () => {
    const ctx = { session: { get: async () => ({
      ...sessionInfo("worker", "implementer"),
      model: { providerID: "opencode", id: "big-pickle" },
    }) } };
    await assert.rejects(enforceInternalToolAuthority(ctx, { sessionID: "unregistered-worker", tool: "bash" }), /role|contract|authority/i);
  });

  it("accepts Jev-authorized model changes only in a newly bound worker session", async () => {
    const roundOne = `switch-round-1-${Date.now()}`;
    const roundTwo = `switch-round-2-${Date.now()}`;
    registerInternalToolSession(roundOne, "worker", {
      runID: "run-governed-switch",
      round: 1,
      model: "opencode/big-pickle",
    });
    registerInternalToolSession(roundTwo, "worker", {
      runID: "run-governed-switch",
      round: 2,
      model: "opencode/mimo-v2.5-free",
    });
    const ctxFor = (model) => ({ session: { get: async () => ({
      ...sessionInfo("worker", "implementer"),
      model,
    }) } });
    await assert.doesNotReject(enforceInternalToolAuthority(ctxFor({ providerID: "opencode", id: "big-pickle" }), {
      sessionID: roundOne, tool: "bash",
    }));
    await assert.doesNotReject(enforceInternalToolAuthority(ctxFor({ providerID: "opencode", id: "mimo-v2.5-free" }), {
      sessionID: roundTwo, tool: "bash",
    }));
  });

  it("blocks a tool on observed A→B→A before the model returns to A", async () => {
    const sessionID = `a-b-a-worker-${Date.now()}`;
    registerInternalToolSession(sessionID, "worker", {
      runID: "run-a-b-a",
      round: 1,
      model: "opencode/big-pickle",
    });
    let model = { providerID: "opencode", id: "big-pickle" };
    const ctx = { session: { get: async () => ({ ...sessionInfo("worker", "implementer"), model }) } };
    await assert.doesNotReject(enforceInternalToolAuthority(ctx, { sessionID, tool: "bash" }));
    model = { providerID: "opencode", id: "mimo-v2.5-free" };
    await assert.rejects(enforceInternalToolAuthority(ctx, { sessionID, tool: "bash" }), /model/i);
    model = { providerID: "opencode", id: "big-pickle" };
    await assert.rejects(enforceInternalToolAuthority(ctx, { sessionID, tool: "bash" }), /fenced/i);
  });

  it("nega sem side effect quando metadata confiável é parcial ou estado não pode ser lido", async () => {
    const partial = { session: { get: async () => ({ metadata: { "jev-role": "critic" } }) } };
    await assert.rejects(simulateToolCall(partial, "ambiguous-1", "read"), /role metadata/);
    const unreadable = { session: { get: async () => { throw new Error("storage unavailable"); } } };
    await assert.rejects(simulateToolCall(unreadable, "unreadable-1", "read"), /session state unavailable/);
  });

  it("não altera authority: sessions externas passam sem receber role claim do tool input", async () => {
    const ctx = { session: { get: async () => ({ metadata: { "jev-agent-role": "critic" } }) } };
    assert.equal(resolveInternalToolRole({}), "external");
    // O estado contraditório é ambiguo e deve fechar, nunca confiar no event/tool claim.
    await assert.rejects(enforceInternalToolAuthority(ctx, {
      sessionID: "external-1",
      tool: "read",
      metadata: { "jev-router": INTERNAL, "jev-role": "critic" },
    }), /role metadata/);
  });

  it("falha fechada se metadata de uma sessão interna registrada desaparece", async () => {
    const sessionID = `registered-critic-${Date.now()}`;
    registerInternalToolSession(sessionID, "critic");
    assert.equal(resolveInternalToolRole(undefined, sessionID), "ambiguous");
    const ctx = { session: { get: async () => ({ metadata: undefined }) } };
    await assert.rejects(
      enforceInternalToolAuthority(ctx, { sessionID, tool: "read" }),
      /role metadata ambiguous/,
    );
  });

  it("não confunde uma sessão externa sem metadata opcional com role interno", async () => {
    const ctx = { session: { get: async () => ({ id: "plain-session" }) } };
    assert.equal(await simulateToolCall(ctx, "plain-session", "edit"), 1);
  });

  it("fences a worker before a non-settling runtime interrupt so no later tool runs", async () => {
    const sessionID = `fenced-worker-${Date.now()}`;
    const ctx = {
      session: {
        create: async () => ({ id: sessionID }),
        get: async () => ({ ...sessionInfo("worker", "implementer"), model: { providerID: "opencode", id: "big-pickle" } }),
        interrupt: async () => await new Promise(() => {}),
      },
    };
    const runtime = makeWorkerRuntime(ctx);
    await runtime.createWorker({
      agent: "build",
      model: { providerID: "opencode", id: "big-pickle" },
      binding: { runID: "fenced-worker-run", round: 1, model: "opencode/big-pickle" },
      metadata: {},
    });
    void runtime.interrupt({ sessionID });

    let toolSideEffects = 0;
    await assert.rejects(
      (async () => {
        await enforceInternalToolAuthority(ctx, { sessionID, tool: "edit" });
        toolSideEffects += 1;
      })(),
      /interrupt|fenced/i,
    );
    assert.equal(toolSideEffects, 0);
  });
  it("revoca uma autorização cujo metadata lookup termina depois do fencing", async () => {
    const sessionID = `fenced-during-get-${Date.now()}`;
    registerInternalToolSession(sessionID, "worker");
    let finishGet;
    let getStarted;
    const started = new Promise(resolve => { getStarted = resolve; });
    const ctx = {
      session: {
        get: async () => {
          getStarted();
          return await new Promise(resolve => { finishGet = resolve; });
        },
      },
    };
    const authorization = enforceInternalToolAuthority(ctx, { sessionID, tool: "edit" });
    await started;
    fenceInternalToolSession(sessionID);
    finishGet(sessionInfo("worker", "implementer"));

    await assert.rejects(authorization, /session fenced/);
  });

  it("recusa reutilizar um ID de sessão já fenced", async () => {
    const sessionID = `reused-fenced-${Date.now()}`;
    let createCalls = 0;
    const ctx = {
      session: {
        create: async () => {
          createCalls += 1;
          return { id: sessionID };
        },
        get: async () => sessionInfo("worker", "implementer"),
        interrupt: async () => ({ interrupted: false }),
      },
    };
    const runtime = makeWorkerRuntime(ctx);
    const input = {
      agent: "build",
      model: { providerID: "opencode", id: "big-pickle" },
      binding: { runID: "reused-fenced-run", round: 1, model: "opencode/big-pickle" },
      metadata: {},
    };
    await runtime.createWorker(input);
    assert.equal(await runtime.interrupt({ sessionID }), false);

    await assert.rejects(runtime.createWorker(input), /fenced|reuse/i);
    assert.equal(createCalls, 2);
  });


  it("reports interruption only when the OpenCode response confirms it", async () => {
    let response;
    let sequence = 0;
    const ctx = {
      session: {
        create: async () => ({ id: `interrupt-confirm-${Date.now()}-${++sequence}` }),
        get: async () => sessionInfo("worker", "implementer"),
        interrupt: async () => response,
      },
    };
    const expected = [
      [{ interrupted: true }, true],
      [{ interrupted: false }, false],
      [undefined, false],
      [{ interrupted: "true" }, false],
    ];

    for (const [apiResponse, confirmed] of expected) {
      response = apiResponse;
      const runtime = makeWorkerRuntime(ctx);
      const { sessionID } = await runtime.createWorker({
        agent: "build",
        model: { providerID: "opencode", id: "big-pickle" },
        binding: { runID: "interrupt-confirmation-run", round: 1, model: "opencode/big-pickle" },
        metadata: {},
      });
      assert.equal(await runtime.interrupt({ sessionID }), confirmed);
    }
  });
  it("does not let internal-registry saturation disable tools for external TUI sessions", async () => {
    for (let index = 0; index < 5000; index += 1) {
      const sessionID = `saturation-${Date.now()}-${index}`;
      try {
        registerInternalToolSession(sessionID, "worker");
      } catch (error) {
        assert.match(String(error), /saturat/i);
        break;
      }
      fenceInternalToolSession(sessionID);
      fenceInternalToolSession(sessionID);
    }
    const ctx = { session: { get: async ({ sessionID }) => sessionID === "external-after-saturation"
      ? { metadata: {} }
      : sessionInfo("worker", "implementer") } };

    await assert.doesNotReject(enforceInternalToolAuthority(ctx, {
      sessionID: "external-after-saturation",
      tool: "edit",
    }));
    await assert.rejects(enforceInternalToolAuthority(ctx, {
      sessionID: "internal-after-saturation",
      tool: "edit",
    }), /fenced|saturat/i);
  });
});
