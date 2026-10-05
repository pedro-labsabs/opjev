import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PROVIDER_COMPATIBILITY_PERMISSIONS,
  enforceInternalToolAuthority,
  registerInternalToolSession,
  resolveInternalToolRole,
} from "./orchestration/tool-authority.ts";
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

  it("não transfere read-only ao worker, cuja permission payload segue independente", async () => {
    const ctx = { session: { get: async () => sessionInfo("worker", "implementer") } };
    assert.equal(resolveInternalToolRole(sessionInfo("worker", "implementer").metadata), "worker");
    assert.equal(await simulateToolCall(ctx, "worker-1", "edit"), 1);
    assert.equal(await simulateToolCall(ctx, "worker-1", "bash"), 1);
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
});
