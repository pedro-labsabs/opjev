import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentCatalog,
  primaryEligibleAgents,
  subagentEligibleAgents,
  resolvePrimaryAgent,
  checkDelegation,
  buildImplementerPermissionRules,
  MAX_AGENT_CATALOG,
  ORCHESTRATION_MAX_DEPTH,
  JEV_AGENT_ROLE,
} from "./orchestration/agent-catalog.ts";

const desc = (id, mode, extra = {}) => ({ id, name: id, mode, hidden: false, description: `${id} agent`, ...extra });

describe("agent catalog: discovery / normalization (ARC1-ARC3)", () => {
  it("ARC1: descoberta preserva IDs e modes reais do runtime", () => {
    const catalog = buildAgentCatalog([
      desc("build", "primary"),
      desc("plan", "primary"),
      desc("explore", "subagent"),
      desc("general", "subagent"),
    ]);
    assert.equal(catalog.entries.length, 4);
    assert.deepEqual(
      catalog.entries.map((e) => [e.id, e.mode]),
      [["build", "primary"], ["plan", "primary"], ["explore", "subagent"], ["general", "subagent"]],
    );
    assert.equal(catalog.source, "discovery");
  });

  it("ARC2: malformed e duplicatas — deterministico, sem duplicatas, sem invencao", () => {
    const catalog = buildAgentCatalog([
      "",
      "build",
      { id: "" },
      { name: "no-id" },
      { id: "  Build  ", mode: "primary" },
      { id: "build", mode: "primary" },
      { id: "BUILD", mode: "all" },
      { id: "weird", mode: "bogus" },
      { id: "nomode" },
      null,
      42,
    ]);
    assert.equal(catalog.entries.length, 1, "so uma entry valida e dedupada");
    assert.equal(catalog.entries[0].id, "Build", "primeiro ID canonico preservado (trimado, case original)");
    assert.equal(catalog.entries[0].mode, "primary");
  });

  it("ARC2b: cap bounded do catalogo", () => {
    assert.equal(MAX_AGENT_CATALOG, 64);
    const many = Array.from({ length: 70 }, (_, i) => desc(`agent-${i}`, "primary"));
    const catalog = buildAgentCatalog(many);
    assert.equal(catalog.entries.length, 64, "cap rigido");
    assert.equal(catalog.entries[0].id, "agent-0", "primeiros preservados em ordem");
  });

  it("ARC2c: hidden nao exclui do catalogo, mas exclui de primary", () => {
    const catalog = buildAgentCatalog([
      desc("build", "primary"),
      desc("compaction", "primary", { hidden: true }),
    ]);
    assert.equal(catalog.entries.length, 2, "hidden permanece auditavel no catalogo");
    assert.deepEqual(primaryEligibleAgents(catalog).map((e) => e.id), ["build"]);
  });

  it("ARC3: candidatos primary excluem subagent-only", () => {
    const catalog = buildAgentCatalog([
      desc("build", "primary"),
      desc("custom", "all"),
      desc("explore", "subagent"),
    ]);
    assert.deepEqual(primaryEligibleAgents(catalog).map((e) => e.id), ["build", "custom"]);
    assert.deepEqual(subagentEligibleAgents(catalog).map((e) => e.id), ["custom", "explore"]);
  });
});

describe("agent catalog: primary resolution (ARC4/ARC6)", () => {
  const catalog = () => buildAgentCatalog([desc("build", "primary"), desc("explore", "subagent")]);

  it("ARC4: subagent-only nunca resolve como primary", () => {
    // OrchestrationError.code e propriedade separada: valida via funcao.
    const isInvalidSelection = (err) => err && err.code === "invalid-selection";
    assert.throws(() => resolvePrimaryAgent(catalog(), "explore"), isInvalidSelection, "explore rejeitado como primary");
    try {
      resolvePrimaryAgent(catalog(), "explore");
      assert.fail("deveria ter lancado");
    } catch (err) {
      assert.ok(String(err.message).includes("explore"), "erro menciona o ID rejeitado");
    }
  });

  it("ARC6: agent inexistente rejeitado bounded", () => {
    const isInvalidSelection = (err) => err && err.code === "invalid-selection";
    assert.throws(() => resolvePrimaryAgent(catalog(), "ghost-agent"), isInvalidSelection, "ID desconhecido rejeitado");
  });

  it("primary valido resolve para o ID canonico (case-insensitive, sem mutar runtime)", () => {
    const entry = resolvePrimaryAgent(catalog(), "BUILD");
    assert.equal(entry.id, "build", "lookup case-insensitive retorna ID real");
    assert.equal(entry.mode, "primary");
  });
});

describe("agent catalog: delegation policy (ARC12-ARC14)", () => {
  const catalog = () => buildAgentCatalog([
    desc("build", "primary"),
    desc("explore", "subagent"),
    desc("general", "subagent"),
  ]);

  it("ARC12: orchestrator so delega para allowlist + mode subagent|all + conhecido", () => {
    const c = catalog();
    assert.equal(checkDelegation({ role: "orchestrator", targetId: "explore", catalog: c, allowlist: ["explore"] }).allowed, true);
    assert.equal(checkDelegation({ role: "orchestrator", targetId: "explore", catalog: c, allowlist: ["general"] }).allowed, false, "fora da allowlist");
    assert.equal(checkDelegation({ role: "orchestrator", targetId: "build", catalog: c, allowlist: ["build", "explore"] }).allowed, false, "primary nao e alvo de delegacao");
    assert.equal(checkDelegation({ role: "orchestrator", targetId: "ghost", catalog: c, allowlist: ["ghost"] }).allowed, false, "ID inventado nunca delega");
  });

  it("ARC13: depth 1 permitido, depth 2 rejeitado", () => {
    assert.equal(ORCHESTRATION_MAX_DEPTH, 1);
    const c = catalog();
    const base = { role: "orchestrator", targetId: "explore", catalog: c, allowlist: ["explore"] };
    assert.equal(checkDelegation({ ...base, depth: 0 }).allowed, true, "orchestrator -> leaf (depth 1) OK");
    assert.equal(checkDelegation({ ...base, depth: 1 }).allowed, false, "leaf nao delega (depth 2 proibido)");
  });

  it("ARC14: child (implementer leaf) e critic nunca delegam", () => {
    const c = catalog();
    assert.equal(checkDelegation({ role: "implementer", targetId: "explore", catalog: c, allowlist: ["explore"], depth: 1 }).allowed, false);
    assert.equal(checkDelegation({ role: "critic", targetId: "explore", catalog: c, allowlist: ["explore"], depth: 0 }).allowed, false);
  });

  it("implementer permission payload nega subagent spawn (ARC10 puro)", () => {
    assert.deepEqual(buildImplementerPermissionRules(), [{ action: "subagent", resource: "*", effect: "deny" }]);
  });

  it("metadata key de logical role separada de jev-role", () => {
    assert.equal(JEV_AGENT_ROLE, "jev-agent-role");
  });
});
