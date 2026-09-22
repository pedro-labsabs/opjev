// Testes puros do admission layer automatico (#13).
// Nenhum ctx/rede: observam determinismo, bounds e formato do datapath de
// admissao (contract, runID, trampoline, perguntas SystemOne, resolucao de
// modo com confidence guard e fail-closed).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  admissionRecordKey,
  autoAdmissionRunID,
  bindingStatusFromPhase,
  buildAdmissionQuestions,
  buildAdmissionState,
  buildAutomaticExecutionContract,
  buildAutomaticTrampolinePrompt,
  resolveAdmissionMode,
  sessionBindingKey,
} from "./orchestration/admission.ts";
import { CONTRACT_LIMITS, OrchestrationError, validateExecutionContract } from "./orchestration/types.ts";

const THRESHOLD = 0.55;

const BASE_INPUT = {
  sessionID: "s-abc",
  messageID: "m-1",
  objective: "refatorar o dispatcher para suportar admissao bounded",
  maxRounds: 3,
};

describe("ADM: buildAutomaticExecutionContract (deterministico e bounded)", () => {
  it("ADM1: mesmo input => contrato identico (determinismo, sem random)", () => {
    const a = buildAutomaticExecutionContract(BASE_INPUT);
    const b = buildAutomaticExecutionContract(BASE_INPUT);
    assert.deepEqual(a, b);
    const json = JSON.stringify(a);
    assert.ok(!json.includes("Math"), "contrato nao depende de Math.random");
    assert.ok(!json.includes("Date"), "contrato nao depende de Date.now (puro)");
  });

  it("ADM2: runID deterministico por (sessionID, messageID); muda com o turno real", () => {
    const a = buildAutomaticExecutionContract(BASE_INPUT);
    const b = buildAutomaticExecutionContract(BASE_INPUT);
    assert.equal(a.runID, b.runID);
    const sameTextNewTurn = buildAutomaticExecutionContract({
      ...BASE_INPUT,
      messageID: "m-2", // mesmo texto, NOVO messageID (novo turno)
    });
    assert.notEqual(a.runID, sameTextNewTurn.runID, "novo turno (novo messageID) => novo runID");
    assert.equal(autoAdmissionRunID("s-abc", "m-1"), a.runID, "runID deriva diretamente de autoAdmissionRunID");
  });

  it("ADM3: objective estritamente bounded pelo limite do kernel (<=2000)", () => {
    const big = "x".repeat(5000);
    const c = buildAutomaticExecutionContract({ ...BASE_INPUT, objective: big });
    assert.ok(c.objective.length <= CONTRACT_LIMITS.objective, `objective bounded (got ${c.objective.length})`);
    assert.ok(c.objective.endsWith("[truncado]") || c.objective.endsWith("…"), "marca de truncamento visivel");
    // Contrato deve continuar VALIDO pelo kernel apos o bound (sem estourar).
    assert.doesNotThrow(() => validateExecutionContract(c), "contract bounded passa no kernel");
  });

  it("ADM4: contrato padrao passa validateExecutionContract", () => {
    const c = buildAutomaticExecutionContract(BASE_INPUT);
    assert.doesNotThrow(() => validateExecutionContract(c));
    assert.ok(Array.isArray(c.acceptanceCriteria) && c.acceptanceCriteria.length >= 1);
    assert.ok(Array.isArray(c.constraints) && c.constraints.length >= 1);
    assert.ok(Array.isArray(c.requiredEvidence) && c.requiredEvidence.length >= 1);
    assert.equal(c.maxRounds, 3);
  });

  it("ADM5: maxRounds invalido => erro deterministico (sem clamp silencioso)", () => {
    for (const bad of [0, 101, 1.5, "3", NaN, -1]) {
      assert.throws(
        () => buildAutomaticExecutionContract({ ...BASE_INPUT, maxRounds: bad }),
        (e) => e instanceof OrchestrationError && e.code === "invalid-max-rounds",
      );
    }
    // Limites exatos sao aceitos.
    assert.equal(buildAutomaticExecutionContract({ ...BASE_INPUT, maxRounds: 1 }).maxRounds, 1);
    assert.equal(buildAutomaticExecutionContract({ ...BASE_INPUT, maxRounds: 100 }).maxRounds, 100);
  });

  it("ADM15: runID sanitizado, deterministico e capped em 200 chars", () => {
    const weird = "sessão com espaços/e-speciais!?";
    const rid = autoAdmissionRunID(weird, "msg/ç" + "z".repeat(400));
    assert.ok(rid.length <= 200, `runID capped (got ${rid.length})`);
    assert.ok(/^auto-[A-Za-z0-9._-]+$/.test(rid), "sem caracteres perigosos em chaves de storage");
    assert.equal(autoAdmissionRunID(weird, "msg/ç" + "z".repeat(400)), rid, "deterministico");
    assert.equal(autoAdmissionRunID("", ""), "auto-anon-anon", "ausencia de ids => identidade anonima estavel");
  });
});

describe("ADM: buildAutomaticTrampolinePrompt (trampoline unico)", () => {
  it("ADM7: launcher embute contrato JSON parseavel + texto original + seam explicito, exatamente uma vez", () => {
    const contract = buildAutomaticExecutionContract(BASE_INPUT);
    const launcher = buildAutomaticTrampolinePrompt({ objective: BASE_INPUT.objective, contract });
    assert.ok(launcher.includes(BASE_INPUT.objective), "texto original entra como dado (nao como instrucao direta)");
    assert.ok(launcher.includes("tools.jev.orchestrate_once"), "seam explicito nomeado");
    assert.equal(launcher.split("tools.jev.orchestrate_once").length - 1, 1, "seam mencionado EXATAMENTE uma vez");
    const json = launcher.slice(launcher.indexOf("{") , launcher.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json);
    assert.equal(parsed.runID, contract.runID, "JSON do contrato parseavel e identico");
    assert.equal(parsed.objective, contract.objective);
    // Determinismo da launcher.
    const again = buildAutomaticTrampolinePrompt({ objective: BASE_INPUT.objective, contract });
    assert.equal(again, launcher, "launcher deterministico (mesma string)");
  });
});

describe("ADM: buildAdmissionState + buildAdmissionQuestions (decideGeneric-compatible)", () => {
  it("ADM12: estado bounded e enxuto (nunca history/conversa)", () => {
    const big = "y".repeat(4000);
    const state = buildAdmissionState({ text: big, agent: "build", model: "opencode/big-pickle", routed: true, route: "fast-coding", trivial: false });
    assert.ok(typeof state === "object" && state !== null);
    const s = state;
    assert.ok(s.intent.text.length <= 1200, "intent bounded");
    assert.ok(s.intent.text.includes("[truncado]"), "marca de truncamento");
    assert.equal(s.intent.length, 4000);
    assert.equal(s.intent.trivial, false);
    assert.equal(s.intent.routed, true);
    assert.equal(s.intent.route, "fast-coding");
    assert.equal(s.session.agent, "build");
    assert.equal(s.session.model, "opencode/big-pickle");
    assert.deepEqual(Object.keys(s), ["intent", "session"], "estado minimo (intent + session)");
  });

  it("ADM11: perguntas de admissao no formato SystemOne (1 choice normal|route|orchestrate)", () => {
    const q = buildAdmissionQuestions();
    assert.deepEqual(Object.keys(q), ["admission"]);
    const admission = q.admission;
    assert.equal(admission.type, "choice");
    assert.ok(typeof admission.instructions === "string" && admission.instructions.trim().length > 0);
    assert.deepEqual(Object.keys(admission.criteria).sort(), ["normal", "orchestrate", "route"]);
    for (const v of Object.values(admission.criteria)) {
      assert.ok(typeof v === "string" && v.trim().length > 0, "criterios nao vazios");
    }
  });
});

describe("ADM: resolveAdmissionMode (confidence guard + fail-closed)", () => {
  it("ADM8: orchestrate com confianca alta => orchestrate via jev", () => {
    const r = resolveAdmissionMode({ choice: "orchestrate", confidence: 0.9, confidenceThreshold: THRESHOLD, fallbackRoute: true });
    assert.deepEqual(r, { mode: "orchestrate", via: "jev", confidence: 0.9 });
  });

  it("ADM9: orchestrate com confianca abaixo do threshold => fail-closed (route se fallbackRoute, senao normal)", () => {
    const low = resolveAdmissionMode({ choice: "orchestrate", confidence: 0.3, confidenceThreshold: THRESHOLD, fallbackRoute: true });
    assert.equal(low.mode, "route");
    assert.equal(low.via, "fallback");
    assert.match(low.reason, /confianca/);
    const noAutoRoute = resolveAdmissionMode({ choice: "orchestrate", confidence: 0.3, confidenceThreshold: THRESHOLD, fallbackRoute: false });
    assert.equal(noAutoRoute.mode, "normal");
    assert.equal(noAutoRoute.via, "fallback");
  });

  it("ADM10: escolhas validas + ausencia/invalida", () => {
    assert.equal(resolveAdmissionMode({ choice: "route", confidence: 0.8, confidenceThreshold: THRESHOLD, fallbackRoute: true }).mode, "route");
    assert.equal(resolveAdmissionMode({ choice: "normal", confidence: 0.8, confidenceThreshold: THRESHOLD, fallbackRoute: true }).mode, "normal");
    const missing = resolveAdmissionMode({ choice: undefined, confidenceThreshold: THRESHOLD, fallbackRoute: true });
    assert.equal(missing.mode, "route");
    assert.equal(missing.via, "fallback");
    assert.ok(missing.reason, "razao da fallback presente");
    const invalid = resolveAdmissionMode({ choice: "hack", confidence: 1, confidenceThreshold: THRESHOLD, fallbackRoute: false });
    assert.equal(invalid.mode, "normal");
    assert.equal(invalid.via, "fallback");
  });
});

describe("ADM: chaves de storage + status de binding (contrato de persistencia)", () => {
  it("ADM14: chaves seguem o layout exigido (session binding + admission records)", () => {
    assert.equal(sessionBindingKey("s1"), "orchestration/session/s1");
    assert.equal(admissionRecordKey("s1", "m1"), "orchestration/admission/s1/m1");
  });

  it("ADM13: bindingStatusFromPhase mapeia fases terminais e de pausa", () => {
    assert.equal(bindingStatusFromPhase("completed"), "completed");
    assert.equal(bindingStatusFromPhase("stopped"), "stopped");
    assert.equal(bindingStatusFromPhase("failed"), "failed");
    assert.equal(bindingStatusFromPhase("awaiting-human"), "awaiting-human");
    assert.equal(bindingStatusFromPhase("running"), "running");
    assert.equal(bindingStatusFromPhase("ready"), "running");
    assert.equal(bindingStatusFromPhase(undefined), "running");
  });
});