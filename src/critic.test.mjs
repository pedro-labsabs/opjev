// RED — critic core (isolated verifier): testes antes da implementacao.
//
// O critic tenta FALSIFICAR o resultado do worker. Ele NUNCA implementa,
// NUNCA corrige, NUNCA aprova e NUNCA escolhe proxima acao. Retorna somente
// findings estruturados. Saida invalida => failure explicito (nunca
// aprovacao silenciosa). Nenhum chain-of-thought/reasoning entra no packet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CRITIC_LIMITS,
  buildCriticPrompt,
  parseCriticOutput,
  criticOutcomeCheck,
} from "./orchestration/critic.ts";

const INPUT = {
  objective: "Implementar o modulo de autenticacao",
  acceptanceCriteria: ["Login funciona", "Tokens expiram"],
  requiredEvidence: ["worker-session-outcome", "worker-final-response"],
  round: 1,
  maxRounds: 1,
  workerOutcome: "succeeded",
  resultSummary: "implementei tudo",
  deterministicChecks: [
    { name: "worker-session-outcome", status: "pass" },
    { name: "worker-final-response", status: "pass" },
  ],
};

describe("critic core: buildCriticPrompt (papel + bounded)", () => {
  it("deixa claro que e verifier/critic e tenta falsificar o worker", () => {
    const p = buildCriticPrompt(INPUT);
    assert.ok(p.includes("verifier"), "deve conter verifier");
    assert.ok(/falsif/i.test(p), "tenta falsificar o resultado do worker");
  });

  it("trata output do worker como DADO NAO CONFIAVEL (anti-injection)", () => {
    const p = buildCriticPrompt(INPUT);
    assert.ok(/UNTRUSTED/i.test(p), "aviso de dados nao confiaveis");
  });

  it("proibe modificar, corrigir, decidir accept/reject e pede SO findings", () => {
    const p = buildCriticPrompt(INPUT);
    assert.ok(/do not modify/i.test(p), "nao modifica nada");
    assert.ok(/do not implement fixes/i.test(p), "nao implementa correcoes");
    assert.ok(/do not decide/i.test(p), "nao decide accept/reject");
    assert.ok(p.includes("findings"), "pede findings");
    assert.ok(!/next.?action|"approved"|"done"/i.test(p), "critic nunca devolve approved/done/nextAction");
  });

  it("especifica o formato exato de resposta", () => {
    const p = buildCriticPrompt(INPUT);
    assert.ok(p.includes('"findings"'), "formato findings presente");
    assert.ok(p.includes("severity"), "severity presente");
    assert.ok(p.includes("critical"), "severity allowlist presente");
  });

  it("e bounded: criterio gigante nao explode o prompt", () => {
    const p = buildCriticPrompt({ ...INPUT, acceptanceCriteria: ["c".repeat(5000)] });
    assert.ok(p.length < 10000, `prompt bounded mesmo com criterio gigante (${p.length})`);
  });
});

describe("critic core: parseCriticOutput (estrito)", () => {
  it("parse ok com findings validos", () => {
    const r = parseCriticOutput(JSON.stringify({ findings: [{ severity: "critical", summary: "criterio X violado" }] }));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.findings.length, 1);
      assert.deepEqual(r.findings[0], { severity: "critical", summary: "criterio X violado" });
    }
  });

  it("findings vazio e valido (findings [] NAO e aprovacao automatica)", () => {
    const r = parseCriticOutput(JSON.stringify({ findings: [] }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.findings.length, 0);
  });

  it("JSON invalido -> failure explicito, nunca aprovacao silenciosa", () => {
    const r = parseCriticOutput("not json at all");
    assert.equal(r.ok, false);
  });

  it("output vazio -> failure (critic NAO respondeu)", () => {
    const r = parseCriticOutput("");
    assert.equal(r.ok, false);
  });

  it("JSOn de topo nao-objeto -> failure", () => {
    const r = parseCriticOutput("42");
    assert.equal(r.ok, false);
  });

  it("findings nao-array -> failure", () => {
    const r = parseCriticOutput(JSON.stringify({ findings: { severity: "minor", summary: "x" } }));
    assert.equal(r.ok, false);
  });

  it("severity fora do allowlist -> failure", () => {
    const r = parseCriticOutput(JSON.stringify({ findings: [{ severity: "fatal", summary: "x" }] }));
    assert.equal(r.ok, false);
  });

  it("finding sem summary -> failure", () => {
    const r = parseCriticOutput(JSON.stringify({ findings: [{ severity: "minor" }] }));
    assert.equal(r.ok, false);
  });

  it("chaves extras (reasoning/chain-of-thought) -> failure estrito", () => {
    const r = parseCriticOutput(JSON.stringify({ reasoning: "pensei muito", findings: [{ severity: "minor", summary: "ok" }] }));
    assert.equal(r.ok, false, "formato estrito: somente { findings }");
  });

  it("raw output acima do limite -> failure (nunca parse gigante)", () => {
    const r = parseCriticOutput("x".repeat(CRITIC_LIMITS.maxRawOutput + 1));
    assert.equal(r.ok, false);
  });

  it("summary bounded: truncado para o limite do kernel", () => {
    const r = parseCriticOutput(JSON.stringify({ findings: [{ severity: "important", summary: "z".repeat(5000) }] }));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(r.findings[0].summary.length <= CRITIC_LIMITS.findingSummary + 30, "summary bounded");
      assert.ok(r.findings[0].summary.startsWith("z".repeat(CRITIC_LIMITS.findingSummary - 1)), "prefixo preservado");
      assert.ok(r.findings[0].summary.includes("truncado pelo kernel"), "marcador deterministico de truncamento");
    }
  });

  it("findings acima do cap -> bounded (primeiros N)", () => {
    const findings = Array.from({ length: 200 }, (_, i) => ({ severity: "minor", summary: `f${i}` }));
    const r = parseCriticOutput(JSON.stringify({ findings }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.findings.length, CRITIC_LIMITS.maxFindings, "cap de findings");
  });

  it("resultado carrega APENAS findings (nunca reasoning bruto)", () => {
    const r = parseCriticOutput(JSON.stringify({ findings: [{ severity: "minor", summary: "ok" }] }));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(Object.keys(r).sort(), ["findings", "ok"], "resultado contem somente ok+findings");
      for (const f of r.findings) assert.deepEqual(Object.keys(f).sort(), ["severity", "summary"]);
    }
  });
});

describe("critic core: criticOutcomeCheck (check deterministico bounded)", () => {
  it("pass sem summary", () => {
    assert.deepEqual(criticOutcomeCheck("pass"), { name: "critic-session-outcome", status: "pass" });
  });

  it("fail com summary bounded", () => {
    const ck = criticOutcomeCheck("fail", "invalid-json");
    assert.equal(ck.name, "critic-session-outcome");
    assert.equal(ck.status, "fail");
    assert.equal(ck.summary, "invalid-json");
  });

  it("summary comprido e truncado", () => {
    const ck = criticOutcomeCheck("fail", "e".repeat(2000));
    assert.ok(ck.summary && ck.summary.length < 400, "summary bounded");
  });
});
