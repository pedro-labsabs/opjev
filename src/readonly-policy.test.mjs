// RED — read-only permission policy para o critic session.
//
// Principio default-deny: o critic NUNCA recebe capacidade de mutar o
// workspace nem de escalar autorizacao. Formato exatamente o suportado por
// SessionCreateInput.permissions / Permission.Rule dos tipos instalados
// (@opencode/plugin 2.0.7): { action, resource, effect } com
// effect em allow|deny|ask. V2: shell (nao bash), subagent (nao task),
// edit (cobre write/patch).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCriticPermissionRules,
  CRITIC_DENIED_ACTIONS,
  CRITIC_ALLOWED_ACTIONS,
} from "./orchestration/readonly-policy.ts";

describe("critic read-only policy (runtime permission rules)", () => {
  it("toda superficie mutavel negada explicitamente (hard deny, nunca ask)", () => {
    const rules = buildCriticPermissionRules();
    const denies = rules.filter((r) => r.effect === "deny");
    for (const action of CRITIC_DENIED_ACTIONS) {
      assert.ok(
        denies.some((r) => r.action === action && r.resource === "*"),
        `deny ${action} *`,
      );
    }
  });

  it("capacidades de leitura permitidas ('read', 'glob', 'grep')", () => {
    const rules = buildCriticPermissionRules();
    for (const action of CRITIC_ALLOWED_ACTIONS) {
      assert.ok(
        rules.some((r) => r.action === action && r.effect === "allow"),
        `allow ${action}`,
      );
    }
  });

  it("nenhuma regra usa ask (critic nao consegue escalar autorizacao)", () => {
    for (const r of buildCriticPermissionRules()) {
      assert.notEqual(r.effect, "ask", `nenhuma regra em ask: ${JSON.stringify(r)}`);
    }
  });

  it("segredos (.env) nunca lidos mesmo com allow geral de read", () => {
    const rules = buildCriticPermissionRules();
    for (const pat of ["*.env", "*.env.*"]) {
      assert.ok(
        rules.some((r) => r.action === "read" && r.resource === pat && r.effect === "deny"),
        `deny read ${pat}`,
      );
    }
  });

  it("policy estavel entre chamadas (ordenacao preserva last-match-wins)", () => {
    assert.deepEqual(buildCriticPermissionRules(), buildCriticPermissionRules());
  });

  it("regras no formato exato {action, resource, effect} com effect valido", () => {
    for (const r of buildCriticPermissionRules()) {
      assert.equal(typeof r.action, "string");
      assert.equal(typeof r.resource, "string");
      assert.ok(["allow", "deny", "ask"].includes(r.effect), `effect valido: ${JSON.stringify(r)}`);
    }
  });
});