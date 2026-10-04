// Provider visibility and local authorization are tested independently.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCriticProviderPermissions,
  buildOrchestratorProviderPermissions,
} from "./orchestration/readonly-policy.ts";
import { enforceInternalToolAuthority } from "./orchestration/tool-authority.ts";

const INTERNAL = "orchestration-internal";
const criticCtx = {
  session: {
    get: async () => ({ metadata: {
      "jev-router": INTERNAL,
      "jev-role": "critic",
      "jev-agent-role": "critic",
    } }),
  },
};

describe("critic/orchestrator provider visibility with local read-only authority", () => {
  it("advertises a compatible provider toolset for both roles", () => {
    for (const rules of [buildCriticProviderPermissions(), buildOrchestratorProviderPermissions()]) {
      assert.ok(rules.some((r) => r.action === "*" && r.resource === "*" && r.effect === "allow"));
      assert.ok(!rules.some((r) => r.effect === "ask"));
    }
  });

  it("locally hard-denies mutating and execution tools before invocation", async () => {
    for (const tool of ["bash", "edit", "write", "task", "execute", "question", "webfetch", "websearch"]) {
      let executorInvocations = 0;
      await assert.rejects((async () => {
        await enforceInternalToolAuthority(criticCtx, { sessionID: "critic", tool });
        executorInvocations += 1;
      })(), /OPJEV_INTERNAL_TOOL_DENIED/);
      assert.equal(executorInvocations, 0, `${tool}: zero executor invocation`);
    }
  });

  it("allows only read/glob/grep for critic", async () => {
    for (const tool of ["read", "glob", "grep"]) {
      await assert.doesNotReject(enforceInternalToolAuthority(criticCtx, { sessionID: "critic", tool }));
    }
  });

  it("keeps secret and external-directory restrictions in the local permission rules", () => {
    const rules = buildCriticProviderPermissions();
    for (const [action, resource] of [
      ["read", "*.env"],
      ["read", "*.env.*"],
      ["external_directory", "*"],
    ]) {
      assert.ok(rules.some((r) => r.action === action && r.resource === resource && r.effect === "deny"));
    }
  });

  it("returns stable, identical compatibility rules for critic and orchestrator", () => {
    assert.deepEqual(buildCriticProviderPermissions(), buildCriticProviderPermissions());
    assert.deepEqual(buildOrchestratorProviderPermissions(), buildOrchestratorProviderPermissions());
    assert.deepEqual(buildCriticProviderPermissions(), buildOrchestratorProviderPermissions());
  });

  it("preserves the runtime rule shape and valid effects", () => {
    for (const rule of buildCriticProviderPermissions()) {
      assert.deepEqual(Object.keys(rule).sort(), ["action", "effect", "resource"]);
      assert.ok(["allow", "deny"].includes(rule.effect));
    }
  });
});
