// Testes TDD do Orchestration Kernel v1 (control plane PURO).
// Nenhum destes testes toca hooks, session, storage nem o Jev HTTP:
// o kernel e deterministico e nao conhece ctx. O arquivo segue o padrao
// atual de testes (src/*.test.mjs, importando .ts diretamente).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OrchestrationError,
  validateExecutionContract,
  normalizeEvidencePacket,
  validateVerdict,
  FAILURE_CLASSES,
  NEXT_ACTIONS,
  isFailureClass,
  isNextAction,
  CONTRACT_LIMITS,
  EVIDENCE_LIMITS,
} from "./orchestration/types.ts";
import {
  buildRoundJudgementQuestions,
  buildRoundJudgementState,
  parseRoundVerdict,
} from "./orchestration/judgement.ts";
import {
  createRunState,
  transitionRun,
} from "./orchestration/state-machine.ts";

// ─────────────────────────── helpers ───────────────────────────

function contract(over = {}) {
  return {
    runID: "run-1",
    objective: "Implementar o modulo de auth",
    scope: { include: ["src/"], exclude: ["node_modules/"] },
    constraints: ["nao alterar o runtime ativo"],
    acceptanceCriteria: ["typecheck passa", "testes passam"],
    requiredEvidence: ["npm test", "npm run typecheck"],
    maxRounds: 3,
    ...over,
  };
}

function verdict(over = {}) {
  return {
    done: false,
    failureClass: "implementation",
    sameExecutorCanRepair: true,
    nextAction: "repair-same",
    confidence: 0.9,
    ...over,
  };
}

function evidence(over = {}) {
  return {
    round: 1,
    executor: { agent: "build", model: "opencode/big-pickle", sessionID: "s1" },
    outcome: "failed",
    deterministicChecks: [{ name: "typecheck", status: "fail", summary: "erro TS" }],
    criticFindings: [{ severity: "critical", summary: "contrato quebrado" }],
    artifacts: ["src/out.ts"],
    resultSummary: "rodada falhou no typecheck",
    ...over,
  };
}

function expectErr(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err?.name, "OrchestrationError", `esperava OrchestrationError, recebeu ${String(err)}`);
    assert.equal(err?.code, code, `esperava code=${code}, recebeu ${String(err?.code)}: ${String(err?.message)}`);
    return true;
  });
}

const choice = (c, confidence = 0.85) => ({ type: "choice", choice: c, probabilities: {}, confidence });
const noul = (v) => ({ type: "noul", noul: v });

const EXECUTOR = { agent: "build", model: "opencode/big-pickle", sessionID: "s1" };

// Estado logico ate a fase `planning`.
function planningState(c) {
  return createRunState(c);
}

// Estado logico ate a fase `ready` (contrato aceito).
function readyState(c) {
  return transitionRun(createRunState(c), { type: "CONTRACT_READY" }).state;
}

// Estado logico ate a fase `running`.
function runningState(c) {
  return transitionRun(readyState(c), { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
}

// Estado logico ate a fase `evaluating` (execucao terminou, sem evidence).
function evaluatingState(c, { outcome = "failed" } = {}) {
  return transitionRun(runningState(c), { type: "EXECUTION_FINISHED", outcome }).state;
}

// Estado logico ate a fase `evaluating` com evidence da rodada corrente.
function evaluateState(c, over = {}) {
  const s = evaluatingState(c);
  return transitionRun(s, { type: "EVIDENCE_READY", evidence: evidence({ round: s.round, ...over }) }).state;
}

// ────────────────────────── ExecutionContract ──────────────────────────

describe("ExecutionContract: validacao pura", () => {
  it("contrato vazio e rejeitado", () => {
    expectErr(() => validateExecutionContract({}), "invalid-contract");
  });

  it("maxRounds=0 e rejeitado", () => {
    expectErr(() => validateExecutionContract(contract({ maxRounds: 0 })), "invalid-contract");
  });

  it("maxRounds fracionario e rejeitado", () => {
    expectErr(() => validateExecutionContract(contract({ maxRounds: 1.5 })), "invalid-contract");
  });

  it("runID vazio e rejeitado", () => {
    expectErr(() => validateExecutionContract(contract({ runID: "   " })), "invalid-contract");
  });

  it("objective vazio e rejeitado", () => {
    expectErr(() => validateExecutionContract(contract({ objective: "" })), "invalid-contract");
  });

  it("sem acceptance criteria e rejeitado", () => {
    expectErr(() => validateExecutionContract(contract({ acceptanceCriteria: [] })), "invalid-contract");
  });

  it("criteria com string vazia e rejeitado", () => {
    expectErr(() => validateExecutionContract(contract({ acceptanceCriteria: ["ok", "  "] })), "invalid-contract");
  });

  it("campos desbounded sao rejeitados (objective gigante)", () => {
    expectErr(() => validateExecutionContract(contract({ objective: "x".repeat(5000) })), "invalid-contract");
  });

  it("contrato valido e aceito e constroi estado planning", () => {
    const c = contract();
    validateExecutionContract(c);
    const s = createRunState(c);
    assert.equal(s.phase, "planning");
    assert.equal(s.round, 1);
    assert.deepEqual(s.history, []);
  });

  it("createRunState valida o contrato (nao silencia invalido)", () => {
    expectErr(() => createRunState(contract({ maxRounds: 0 })), "invalid-contract");
  });
});

// ────────────────────── Jev judgement (SystemOne) ──────────────────────

describe("buildRoundJudgementQuestions: contrato SystemOne", () => {
  it("produz done/failure_class/same_executor_can_repair/next_action", () => {
    const q = buildRoundJudgementQuestions();
    assert.deepEqual(Object.keys(q).sort(), ["done", "failure_class", "next_action", "same_executor_can_repair"]);
  });

  it("todas as perguntas usam schema SystemOne valido (choice/noul + criteria obrigatorio)", () => {
    const q = buildRoundJudgementQuestions();
    for (const [k, v] of Object.entries(q)) {
      assert.ok(["choice", "noul"].includes(v.type), `${k}.type deve ser choice|noul`);
      assert.ok(typeof v.instructions === "string" && v.instructions.trim().length > 0, `${k}.instructions`);
      assert.ok(
        v.criteria && typeof v.criteria === "object" && !Array.isArray(v.criteria) && Object.keys(v.criteria).length > 0,
        `${k}.criteria deve ser objeto nao vazio`,
      );
      for (const desc of Object.values(v.criteria)) {
        assert.ok(typeof desc === "string" && desc.trim().length > 0, `${k}.criteria descricao vazia`);
      }
    }
    // done/same_executor_can_repair sao nouls com true/false
    assert.deepEqual(Object.keys(q.done.criteria).sort(), ["false", "true"]);
    assert.deepEqual(Object.keys(q.same_executor_can_repair.criteria).sort(), ["false", "true"]);
  });

  it("failure_class oferece exatamente as classes validas", () => {
    const q = buildRoundJudgementQuestions();
    assert.deepEqual(Object.keys(q.failure_class.criteria).sort(), [...FAILURE_CLASSES].sort());
  });

  it("next_action oferece exatamente as 8 acoes validas", () => {
    const q = buildRoundJudgementQuestions();
    assert.deepEqual(Object.keys(q.next_action.criteria).sort(), [...NEXT_ACTIONS].sort());
    assert.equal(Object.keys(q.next_action.criteria).length, 8);
  });

  it("descricoes ensinam a diferenca (todas distintas)", () => {
    const q = buildRoundJudgementQuestions();
    const na = Object.values(q.next_action.criteria);
    assert.equal(new Set(na).size, na.length, "descricoes de next_action devem ser distintas");
    const fc = Object.values(q.failure_class.criteria);
    assert.equal(new Set(fc).size, fc.length, "descricoes de failure_class devem ser distintas");
    // exemplos conceituais: repair-same menciona correcao; fresh-same menciona sessao limpa
    assert.match(q.next_action.criteria["repair-same"], /correction/i);
    assert.match(q.next_action.criteria["fresh-same"], /clean|fresh/i);
    assert.match(q.next_action.criteria["switch-model"], /model/i);
    assert.match(q.next_action.criteria["switch-agent"], /agent|special/i);
    assert.match(q.next_action.criteria.human, /human/i);
    assert.match(q.next_action.criteria.stop, /stop|utili|safe/i);
  });
});

// ─────────────────────────── parseRoundVerdict ───────────────────────────

describe("parseRoundVerdict: parsing estrito", () => {
  const validAnswers = () => ({
    done: noul(0.9),
    failure_class: choice("wrong-model"),
    same_executor_can_repair: noul(0.1),
    next_action: choice("switch-model", 0.87),
  });

  it("respostas validas produzem JevVerdict", () => {
    const v = parseRoundVerdict(validAnswers());
    assert.equal(v.done, true);
    assert.equal(v.failureClass, "wrong-model");
    assert.equal(v.sameExecutorCanRepair, false);
    assert.equal(v.nextAction, "switch-model");
    assert.equal(v.confidence, 0.87);
  });

  it("noul mapeia limiar booleano determinístico (>= 0.5 => true)", () => {
    assert.equal(parseRoundVerdict({ ...validAnswers(), done: noul(0.9), failure_class: choice("implementation"), next_action: choice("repair-same") }).done, true);
    assert.equal(parseRoundVerdict({ ...validAnswers(), done: noul(0.4), next_action: choice("stop") }).done, false);
    assert.equal(parseRoundVerdict(validAnswers()).done, true);
  });

  it("confianca ausente fica ausente no verdict", () => {
    const v = parseRoundVerdict({
      ...validAnswers(),
      next_action: { type: "choice", choice: "stop", probabilities: {} },
    });
    assert.equal(v.confidence, undefined);
  });

  it("pergunta ausente falha", () => {
    const a = validAnswers();
    delete a.next_action;
    expectErr(() => parseRoundVerdict(a), "invalid-answers");
  });

  it("action desconhecida falha", () => {
    expectErr(() => parseRoundVerdict({ ...validAnswers(), next_action: choice("backflip") }), "invalid-answers");
  });

  it("failure_class desconhecido falha", () => {
    expectErr(() => parseRoundVerdict({ ...validAnswers(), failure_class: choice("internet-down") }), "invalid-answers");
  });

  it("tipo de resposta errado falha (done como choice)", () => {
    expectErr(() => parseRoundVerdict({ ...validAnswers(), done: choice("yes") }), "invalid-answers");
  });

  it("tipo de resposta errado falha (next_action como noul)", () => {
    expectErr(() => parseRoundVerdict({ ...validAnswers(), next_action: noul(0.9) }), "invalid-answers");
  });

  it("valor invalido falha (noul fora de [0,1])", () => {
    expectErr(() => parseRoundVerdict({ ...validAnswers(), done: noul(5) }), "invalid-answers");
  });

  it("resposta estruturalmente incompleta falha (choice sem .choice)", () => {
    expectErr(
      () => parseRoundVerdict({ ...validAnswers(), next_action: { type: "choice", probabilities: {} } }),
      "invalid-answers",
    );
  });

  it("confidence fora de [0,1] falha", () => {
    expectErr(
      () => parseRoundVerdict({ ...validAnswers(), next_action: choice("stop", 1.7) }),
      "invalid-answers",
    );
  });

  it("answers nao-objeto falha", () => {
    expectErr(() => parseRoundVerdict(null), "invalid-answers");
  });

  it("resultado do parser e deterministico (repete o mesmo veredito)", () => {
    const a = validAnswers();
    assert.deepEqual(parseRoundVerdict(a), parseRoundVerdict(a));
  });
});

// ─────────────────────────── validateVerdict ───────────────────────────

describe("validateVerdict: invariantes do julgamento", () => {
  it("done=true + accept e valido", () => {
    validateVerdict({ done: true, failureClass: "none", sameExecutorCanRepair: false, nextAction: "accept", confidence: 0.9 });
  });

  it("done=false + repair-same e valido", () => {
    validateVerdict({ done: false, failureClass: "implementation", sameExecutorCanRepair: true, nextAction: "repair-same", confidence: 0.8 });
  });

  it("done=true + repair-same e invalido", () => {
    expectErr(() => validateVerdict({ done: true, failureClass: "implementation", sameExecutorCanRepair: true, nextAction: "repair-same" }), "invalid-verdict");
  });

  it("done=false + accept e invalido", () => {
    expectErr(() => validateVerdict({ done: false, failureClass: "reasoning", sameExecutorCanRepair: false, nextAction: "accept" }), "invalid-verdict");
  });

  it("done=true + switch-model e invalido", () => {
    expectErr(() => validateVerdict({ done: true, failureClass: "wrong-model", sameExecutorCanRepair: false, nextAction: "switch-model" }), "invalid-verdict");
  });

  it("failureClass=none + done=false e invalido", () => {
    expectErr(() => validateVerdict({ done: false, failureClass: "none", sameExecutorCanRepair: true, nextAction: "fresh-same" }), "invalid-verdict");
  });

  it("repair-same exige sameExecutorCanRepair=true", () => {
    expectErr(() => validateVerdict({ done: false, failureClass: "implementation", sameExecutorCanRepair: false, nextAction: "repair-same" }), "invalid-verdict");
  });

  it("confidence fora de [0,1] e invalido", () => {
    expectErr(() => validateVerdict({ done: true, failureClass: "none", sameExecutorCanRepair: false, nextAction: "accept", confidence: 1.4 }), "invalid-verdict");
  });

  it("verdict nao-objeto e invalido", () => {
    expectErr(() => validateVerdict(null), "invalid-verdict");
    expectErr(() => validateVerdict({ done: "yes", failureClass: "none", sameExecutorCanRepair: false, nextAction: "accept" }), "invalid-verdict");
  });

  it("nao faz auto-repair silencioso (erro determinístico)", () => {
    expectErr(() => validateVerdict({ done: true, failureClass: "none", sameExecutorCanRepair: false, nextAction: "repair-same" }), "invalid-verdict");
  });
});

// ─────────────────────────── normalizeEvidencePacket ───────────────────────────

describe("EvidencePacket: bounded/truncation", () => {
  it("trunca resultSummary e summaries longos", () => {
    const big = evidence({
      resultSummary: "x".repeat(5000),
      criticFindings: [{ severity: "critical", summary: "z".repeat(3000) }],
      deterministicChecks: [{ name: "typecheck".repeat(100), status: "fail", summary: "y".repeat(2000) }],
    });
    const norm = normalizeEvidencePacket(big);
    assert.ok(norm.resultSummary.length <= 600, `resultSummary bounded (got ${norm.resultSummary.length})`);
    assert.ok(norm.criticFindings[0].summary.length <= 450, "finding bounded");
    assert.ok(norm.deterministicChecks[0].name.length <= 250, "check name bounded");
    assert.ok(norm.deterministicChecks[0].summary.length <= 350, "check summary bounded");
  });

  it("corta arrays gigantes (deterministicChecks/findings/artifacts)", () => {
    const big = evidence({
      deterministicChecks: Array.from({ length: 150 }, (_, i) => ({ name: `c${i}`, status: "fail" })),
      criticFindings: Array.from({ length: 80 }, (_, i) => ({ severity: "minor", summary: `f${i}` })),
      artifacts: Array.from({ length: 120 }, (_, i) => `/tmp/a${i}`),
    });
    const norm = normalizeEvidencePacket(big);
    assert.equal(norm.deterministicChecks.length, 100);
    assert.equal(norm.criticFindings.length, 50);
    assert.equal(norm.artifacts.length, 50);
  });

  it("round invalido e rejeitado", () => {
    expectErr(() => normalizeEvidencePacket(evidence({ round: 0 })), "invalid-evidence");
    expectErr(() => normalizeEvidencePacket(evidence({ round: 1.5 })), "invalid-evidence");
  });

  it("outcome invalido e rejeitado", () => {
    expectErr(() => normalizeEvidencePacket(evidence({ outcome: "exploded" })), "invalid-evidence");
  });

  it("executor invalido e rejeitado (agent/model obrigatorios)", () => {
    expectErr(() => normalizeEvidencePacket(evidence({ executor: { model: "m", sessionID: "s" } })), "invalid-evidence");
  });

  it("status/severity invalidos sao rejeitados", () => {
    expectErr(() => normalizeEvidencePacket(evidence({ deterministicChecks: [{ name: "x", status: "maybe" }] })), "invalid-evidence");
    expectErr(() => normalizeEvidencePacket(evidence({ criticFindings: [{ severity: "fatal", summary: "x" }] })), "invalid-evidence");
  });

  it("nao muta o packet de entrada", () => {
    const src = evidence({ resultSummary: "ok" });
    const copy = structuredClone(src);
    normalizeEvidencePacket(src);
    assert.deepEqual(src, copy);
  });
});

// ─────────────────────── buildRoundJudgementState (estado do Jev) ───────────────────────

describe("buildRoundJudgementState: estado canonico e bounded para o Jev", () => {
  it("shape contem apenas fatos necessarios (sem conversa/prompts/raw outputs/chain-of-thought)", () => {
    const ev = normalizeEvidencePacket(evidence({ round: 1 }));
    const s = buildRoundJudgementState(contract(), ev);
    assert.deepEqual(Object.keys(s).sort(), [
      "acceptanceCriteria",
      "criticFindings",
      "deterministicChecks",
      "executor",
      "maxRounds",
      "objective",
      "outcome",
      "requiredEvidence",
      "resultSummary",
      "round",
    ]);
  });

  it("executor expoe apenas agent/model (nunca sessionID nem extras)", () => {
    const ev = normalizeEvidencePacket(
      evidence({ round: 1, executor: { agent: "build", model: "opencode/big-pickle", sessionID: "s99" } }),
    );
    const s = buildRoundJudgementState(contract(), ev);
    assert.deepEqual(s.executor, { agent: "build", model: "opencode/big-pickle" });
  });

  it("propaga round/maxRounds/outcome e os campos bounded do contrato+evidence", () => {
    const c = contract({ maxRounds: 5 });
    const ev = normalizeEvidencePacket(evidence({ round: 1, outcome: "interrupted", resultSummary: "rodada interrompida" }));
    const s = buildRoundJudgementState(c, ev);
    assert.equal(s.round, 1);
    assert.equal(s.maxRounds, 5);
    assert.equal(s.outcome, "interrupted");
    assert.equal(s.resultSummary, "rodada interrompida");
    assert.deepEqual(s.acceptanceCriteria, c.acceptanceCriteria);
    assert.deepEqual(s.requiredEvidence, c.requiredEvidence);
    assert.deepEqual(s.deterministicChecks, ev.deterministicChecks);
    assert.deepEqual(s.criticFindings, ev.criticFindings);
  });

  it("previousVerdict presente quando fornecido, ausente quando nao", () => {
    const ev = normalizeEvidencePacket(evidence({ round: 1 }));
    const prev = verdict({ done: false, failureClass: "implementation", sameExecutorCanRepair: true, nextAction: "repair-same" });
    const withPrev = buildRoundJudgementState(contract(), ev, prev);
    assert.deepEqual(withPrev.previousVerdict, prev);
    const withoutPrev = buildRoundJudgementState(contract(), ev);
    assert.ok(!("previousVerdict" in withoutPrev));
  });

  it("e bounded: trunca campos longos e corta arrays gigantes", () => {
    const bigContract = contract({
      objective: "x".repeat(50000),
      acceptanceCriteria: Array.from({ length: 200 }, (_, i) => `criteria ${i} `.repeat(100)),
      requiredEvidence: Array.from({ length: 300 }, (_, i) => `evidencia ${i}`.repeat(200)),
    });
    const bigEv = normalizeEvidencePacket(
      evidence({
        resultSummary: "y".repeat(50000),
        deterministicChecks: Array.from({ length: 500 }, (_, i) => ({ name: `check${i}`.repeat(50), status: "fail", summary: "z".repeat(900) })),
        criticFindings: Array.from({ length: 500 }, (_, i) => ({ severity: "minor", summary: `finding${i}`.repeat(80) })),
      }),
    );
    const s = buildRoundJudgementState(bigContract, bigEv);
    assert.ok(s.objective.length <= CONTRACT_LIMITS.objective + 30, `objective bounded (got ${s.objective.length})`);
    assert.ok(s.acceptanceCriteria.length <= CONTRACT_LIMITS.array, "acceptanceCriteria bounded");
    assert.ok(s.requiredEvidence.length <= CONTRACT_LIMITS.array, "requiredEvidence bounded");
    assert.ok(s.deterministicChecks.length <= EVIDENCE_LIMITS.checks, "deterministicChecks bounded");
    assert.ok(s.criticFindings.length <= EVIDENCE_LIMITS.findings, "criticFindings bounded");
    assert.ok(s.resultSummary.length <= EVIDENCE_LIMITS.resultSummary + 30, "resultSummary bounded");
    for (const ck of s.deterministicChecks) assert.ok(ck.name.length <= EVIDENCE_LIMITS.checkName + 30, "check name bounded");
    for (const f of s.criticFindings) assert.ok(f.summary.length <= EVIDENCE_LIMITS.finding + 30, "finding bounded");
  });

  it("deterministico: mesma entrada produz exatamente o mesmo state", () => {
    const c = contract();
    const ev = normalizeEvidencePacket(evidence({ round: 1 }));
    assert.deepEqual(buildRoundJudgementState(c, ev), buildRoundJudgementState(c, ev));
  });
});

// ─────────────────────────── state machine: happy path ───────────────────────────

describe("state machine: transicoes obrigatorias", () => {
  it("planning + CONTRACT_READY -> ready + dispatch(initial)", () => {
    const r = transitionRun(createRunState(contract()), { type: "CONTRACT_READY" });
    assert.equal(r.state.phase, "ready");
    assert.deepEqual(r.commands, [{ type: "dispatch", mode: "initial" }]);
    assert.equal(r.state.round, 1);
  });

  it("ready + EXECUTION_STARTED -> running (executor registrado)", () => {
    const r = transitionRun(readyState(contract()), { type: "EXECUTION_STARTED", executor: EXECUTOR });
    assert.equal(r.state.phase, "running");
    assert.deepEqual(r.commands, []);
    assert.deepEqual(r.state.executor, EXECUTOR);
  });

  it("running + EXECUTION_FINISHED -> evaluating + evaluate", () => {
    const r = transitionRun(runningState(contract()), { type: "EXECUTION_FINISHED", outcome: "succeeded" });
    assert.equal(r.state.phase, "evaluating");
    assert.deepEqual(r.commands, [{ type: "evaluate" }]);
  });

  it("evaluating + EVIDENCE_READY armazena evidence normalizada e segue evaluating", () => {
    const s = evaluatingState(contract());
    const r = transitionRun(s, { type: "EVIDENCE_READY", evidence: evidence({ round: s.round }) });
    assert.equal(r.state.phase, "evaluating");
    assert.deepEqual(r.commands, []);
    assert.equal(r.state.evidence.round, 1);
    assert.equal(r.state.evidence.executor.agent, "build");
  });

  it("ciclo completo planning->ready->running->evaluating->completed", () => {
    const c = contract();
    let s = createRunState(c);
    const step = (e) => { const r = transitionRun(s, e); s = r.state; return r; };
    const r1 = step({ type: "CONTRACT_READY" });
    assert.equal(s.phase, "ready");
    const r2 = step({ type: "EXECUTION_STARTED", executor: EXECUTOR });
    assert.equal(s.phase, "running");
    assert.deepEqual(r2.commands, []);
    const r3 = step({ type: "EXECUTION_FINISHED", outcome: "succeeded" });
    assert.equal(s.phase, "evaluating");
    assert.deepEqual(r3.commands, [{ type: "evaluate" }]);
    const r4 = step({ type: "EVIDENCE_READY", evidence: evidence({ round: 1, outcome: "succeeded" }) });
    assert.equal(s.evidence.outcome, "succeeded");
    assert.deepEqual(r4.commands, []);
    const r5 = step({ type: "VERDICT_RECEIVED", verdict: verdict({ done: true, failureClass: "none", sameExecutorCanRepair: false, nextAction: "accept", confidence: 0.95 }) });
    assert.equal(s.phase, "completed");
    assert.deepEqual(r5.commands, [{ type: "complete" }]);
    assert.equal(s.lastVerdict.nextAction, "accept");
    assert.equal(s.history.length, 1);
    assert.equal(s.history[0].round, 1);
    assert.equal(s.history[0].outcome, "succeeded");
    assert.equal(s.history[0].verdict.nextAction, "accept");
  });

  it("transitionRun e puro: nao muta o estado de entrada", () => {
    const s0 = createRunState(contract());
    const before = structuredClone(s0);
    transitionRun(s0, { type: "CONTRACT_READY" });
    assert.deepEqual(s0, before);
  });

  it("transicoes retornam estado novo (identidade diferente)", () => {
    const s0 = createRunState(contract());
    const r = transitionRun(s0, { type: "CONTRACT_READY" });
    assert.notEqual(r.state, s0);
  });
});

// ─────────────────────────── state machine: 8 next actions ───────────────────────────

describe("state machine: rotas de VERDICT_RECEIVED", () => {
  const V = {
    accept: verdict({ done: true, failureClass: "none", sameExecutorCanRepair: false, nextAction: "accept" }),
    "repair-same": verdict({ done: false, failureClass: "implementation", sameExecutorCanRepair: true, nextAction: "repair-same" }),
    "fresh-same": verdict({ done: false, failureClass: "reasoning", sameExecutorCanRepair: true, nextAction: "fresh-same" }),
    "switch-model": verdict({ done: false, failureClass: "wrong-model", sameExecutorCanRepair: false, nextAction: "switch-model" }),
    "switch-agent": verdict({ done: false, failureClass: "wrong-agent", sameExecutorCanRepair: false, nextAction: "switch-agent" }),
    replan: verdict({ done: false, failureClass: "bad-contract", sameExecutorCanRepair: false, nextAction: "replan" }),
    human: verdict({ done: false, failureClass: "environment", sameExecutorCanRepair: false, nextAction: "human" }),
    stop: verdict({ done: false, failureClass: "missing-context", sameExecutorCanRepair: false, nextAction: "stop" }),
  };

  it("accept -> completed + complete", () => {
    const r = transitionRun(evaluateState(contract()), { type: "VERDICT_RECEIVED", verdict: V.accept });
    assert.equal(r.state.phase, "completed");
    assert.deepEqual(r.commands, [{ type: "complete" }]);
  });

  it("repair-same -> repairing + repair-same (consome nova rodada, SEMPRE bounded)", () => {
    const r = transitionRun(evaluateState(contract({ maxRounds: 3 })), { type: "VERDICT_RECEIVED", verdict: V["repair-same"] });
    assert.equal(r.state.phase, "repairing");
    assert.deepEqual(r.commands, [{ type: "repair-same" }]);
    assert.equal(r.state.round, 2, "repair-same consome nova rodada (mesma sessao/executor)");
    assert.equal(r.state.executor.agent, "build", "mesmo executor mantido");
    assert.equal(r.state.executor.sessionID, "s1", "mesma sessao mantida");
  });

  it("fresh-same -> ready + rodada+1 + fresh-same (nova sessao)", () => {
    const r = transitionRun(evaluateState(contract()), { type: "VERDICT_RECEIVED", verdict: V["fresh-same"] });
    assert.equal(r.state.phase, "ready");
    assert.equal(r.state.round, 2);
    assert.deepEqual(r.commands, [{ type: "fresh-same" }], "fresh-same nao decide destinos");
    assert.equal(r.state.evidence, undefined, "evidence da rodada antiga limpa");
    assert.equal(r.state.executor.agent, "build", "mesmo agent (fresh-same)");
    assert.equal(r.state.executor.model, "opencode/big-pickle", "mesmo model (fresh-same)");
    assert.equal(r.state.executor.sessionID, undefined, "fresh-same descarta a sessionID antiga (nova sessao)");
    assert.deepEqual(r.state.executor, { agent: "build", model: "opencode/big-pickle" });
  });

  it("switch-model -> ready + rodada+1 + select-model (sem escolher modelo)", () => {
    const r = transitionRun(evaluateState(contract()), { type: "VERDICT_RECEIVED", verdict: V["switch-model"] });
    assert.equal(r.state.phase, "ready");
    assert.equal(r.state.round, 2);
    assert.deepEqual(r.commands, [{ type: "select-model" }]);
    assert.equal(r.state.executor, undefined, "executor limpo: destino sera escolhido pelo dispatcher");
    assert.equal(r.state.evidence, undefined);
  });

  it("switch-agent -> ready + rodada+1 + select-agent (sem escolher agente)", () => {
    const r = transitionRun(evaluateState(contract()), { type: "VERDICT_RECEIVED", verdict: V["switch-agent"] });
    assert.equal(r.state.phase, "ready");
    assert.equal(r.state.round, 2);
    assert.deepEqual(r.commands, [{ type: "select-agent" }]);
    assert.equal(r.state.executor, undefined);
  });

  it("replan -> planning + rodada+1 + replan", () => {
    const r = transitionRun(evaluateState(contract()), { type: "VERDICT_RECEIVED", verdict: V.replan });
    assert.equal(r.state.phase, "planning");
    assert.equal(r.state.round, 2);
    assert.deepEqual(r.commands, [{ type: "replan" }]);
  });

  it("human -> awaiting-human + request-human", () => {
    const r = transitionRun(evaluateState(contract()), { type: "VERDICT_RECEIVED", verdict: V.human });
    assert.equal(r.state.phase, "awaiting-human");
    assert.deepEqual(r.commands, [{ type: "request-human" }]);
  });

  it("stop -> stopped + stop", () => {
    const r = transitionRun(evaluateState(contract()), { type: "VERDICT_RECEIVED", verdict: V.stop });
    assert.equal(r.state.phase, "stopped");
    assert.deepEqual(r.commands, [{ type: "stop" }]);
  });

  it("muda de executor no ciclo repairing -> running (nova rodada)", () => {
    const c = contract({ maxRounds: 2 });
    const s = evaluateState(c);
    const repaired = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: V["repair-same"] }).state;
    assert.equal(repaired.round, 2, "repair-same agora consome rodada");
    const resumed = transitionRun(repaired, { type: "EXECUTION_STARTED", executor: { agent: "build", model: "opencode/big-pickle", sessionID: "s1" } });
    assert.equal(resumed.state.phase, "running");
    assert.equal(resumed.state.round, 2);
    assert.equal(resumed.state.executor.sessionID, "s1");
  });
});

// ─────────────────────────── bounded loop (maxRounds) ───────────────────────────

describe("bounded loop: maxRounds e enforcement real", () => {
  const FRESH = verdict({ done: false, failureClass: "reasoning", sameExecutorCanRepair: true, nextAction: "fresh-same" });

  it("nao ultrapassa maxRounds e escala para human quando novo ciclo excederia", () => {
    const c = contract({ maxRounds: 1 });
    const s = evaluateState(c);
    const r = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: FRESH });
    assert.equal(r.state.phase, "awaiting-human");
    assert.equal(r.state.round, 1, "round nunca excede maxRounds");
    assert.deepEqual(r.commands, [{ type: "request-human" }]);
  });

  it("roda exatamente maxRounds rodadas e depois para de despachar", () => {
    let s = evaluateState(contract({ maxRounds: 2 }));
    // round 1 -> fresh-same (ok, round 2)
    let r = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: FRESH });
    assert.equal(r.state.phase, "ready");
    assert.equal(r.state.round, 2);
    // executa round 2
    s = transitionRun(r.state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    s = transitionRun(s, { type: "EXECUTION_FINISHED", outcome: "failed" }).state;
    s = transitionRun(s, { type: "EVIDENCE_READY", evidence: evidence({ round: 2 }) }).state;
    // round 2 (maxRounds) quer fresh-same -> limite -> humano, NUNCA dispatch
    r = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: FRESH });
    assert.equal(r.state.phase, "awaiting-human");
    assert.equal(r.state.round, 2);
    assert.deepEqual(r.commands, [{ type: "request-human" }]);
    assert.ok(!r.commands.some((cmd) => cmd.type === "dispatch" || cmd.type === "fresh-same"), "sem outro dispatch apos o limite");
  });

  it("switch-model no limite tambem escala para humano (sem select-model)", () => {
    const c = contract({ maxRounds: 1 });
    const s = evaluateState(c);
    const r = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: verdict({ done: false, failureClass: "wrong-model", sameExecutorCanRepair: false, nextAction: "switch-model" }) });
    assert.equal(r.state.phase, "awaiting-human");
    assert.deepEqual(r.commands, [{ type: "request-human" }]);
  });

  it("accept no limite encerra normalmente (sem escalada)", () => {
    const c = contract({ maxRounds: 1 });
    const s = evaluateState(c, { outcome: "succeeded" });
    const r = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: verdict({ done: true, failureClass: "none", sameExecutorCanRepair: false, nextAction: "accept" }) });
    assert.equal(r.state.phase, "completed");
    assert.deepEqual(r.commands, [{ type: "complete" }]);
  });
});

// ─────────────────────── bounded repairs (repair-same) ───────────────────────

describe("bounded repairs: repair-same consome rodada (loop infinito impossivel)", () => {
  const REPAIR = verdict({ done: false, failureClass: "implementation", sameExecutorCanRepair: true, nextAction: "repair-same" });

  it("Caso A: maxRounds=1 e round1 repair-same -> awaiting-human + request-human (NUNCA repairing)", () => {
    const c = contract({ maxRounds: 1 });
    const s = evaluateState(c);
    const r = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: REPAIR });
    assert.equal(r.state.phase, "awaiting-human");
    assert.deepEqual(r.commands, [{ type: "request-human" }]);
    assert.equal(r.state.round, 1, "round nunca excede maxRounds");
    assert.ok(!r.commands.some((cmd) => cmd.type === "repair-same" || cmd.type === "dispatch"), "sem nova execucao apos o limite");
  });

  it("Caso B: maxRounds=2 -> round1 repair-same -> repairing round2; novo repair-same escala para humano", () => {
    const c = contract({ maxRounds: 2 });
    const s = evaluateState(c);
    const r = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: REPAIR });
    assert.equal(r.state.phase, "repairing");
    assert.equal(r.state.round, 2);
    assert.deepEqual(r.commands, [{ type: "repair-same" }]);
    // executa e julga o round 2; novo repair-same excederia maxRounds -> humano
    let s2 = transitionRun(r.state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    s2 = transitionRun(s2, { type: "EXECUTION_FINISHED", outcome: "failed" }).state;
    s2 = transitionRun(s2, { type: "EVIDENCE_READY", evidence: evidence({ round: 2, resultSummary: "round2 falhou" }) }).state;
    const r2 = transitionRun(s2, { type: "VERDICT_RECEIVED", verdict: REPAIR });
    assert.equal(r2.state.phase, "awaiting-human");
    assert.equal(r2.state.round, 2);
    assert.deepEqual(r2.commands, [{ type: "request-human" }]);
  });

  it("Caso C: repair-same preserva agent/model/sessionID apesar de incrementar round", () => {
    const c = contract({ maxRounds: 3 });
    const s = evaluateState(c);
    const r = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: REPAIR });
    assert.equal(r.state.round, 2);
    assert.equal(r.state.executor.agent, "build");
    assert.equal(r.state.executor.model, "opencode/big-pickle");
    assert.equal(r.state.executor.sessionID, "s1");
    // um ciclo completo de repair continua com a MESMA sessao
    let s2 = transitionRun(r.state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    s2 = transitionRun(s2, { type: "EXECUTION_FINISHED", outcome: "failed" }).state;
    s2 = transitionRun(s2, { type: "EVIDENCE_READY", evidence: evidence({ round: 2, resultSummary: "r2" }) }).state;
    const r2 = transitionRun(s2, { type: "VERDICT_RECEIVED", verdict: REPAIR });
    assert.equal(r2.state.round, 3, "segundo repair-same consome outra rodada");
    assert.equal(r2.state.executor.agent, "build");
    assert.equal(r2.state.executor.model, "opencode/big-pickle");
    assert.equal(r2.state.executor.sessionID, "s1");
  });

  it("sequencia infinita de repair-same e impossivel (maxRounds e teto real por estrategia)", () => {
    const c = contract({ maxRounds: 3 });
    let state = evaluateState(c);
    for (let i = 0; i < 10; i++) {
      const r = transitionRun(state, { type: "VERDICT_RECEIVED", verdict: REPAIR });
      if (r.state.phase === "awaiting-human") {
        assert.deepEqual(r.commands, [{ type: "request-human" }]);
        assert.equal(r.state.round, 3, "parou exatamente no limite");
        return;
      }
      assert.equal(r.state.phase, "repairing");
      assert.ok(r.state.round <= 3, `round ${r.state.round} nunca excede maxRounds`);
      state = transitionRun(r.state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
      state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "failed" }).state;
      state = transitionRun(state, { type: "EVIDENCE_READY", evidence: evidence({ round: state.round, resultSummary: `repair ${i}` }) }).state;
    }
    assert.fail("sequencia de repairs nao terminou em 3 rodadas");
  });

  it("EXECUTION_STARTED de repairing sem executor reutiliza executor da rodada", () => {
    const c = contract({ maxRounds: 3 });
    const s = evaluateState(c);
    const repaired = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: REPAIR }).state;
    const r = transitionRun(repaired, { type: "EXECUTION_STARTED" });
    assert.equal(r.state.phase, "running");
    assert.deepEqual(r.state.executor, EXECUTOR);
  });
});

// ─────────────────────── invariante round <= maxRounds ───────────────────────

describe("RED C: round <= contract.maxRounds em estados executaveis de fluxos validos", () => {
  const REPAIR = verdict({ done: false, failureClass: "implementation", sameExecutorCanRepair: true, nextAction: "repair-same" });
  const FRESH = verdict({ done: false, failureClass: "reasoning", sameExecutorCanRepair: true, nextAction: "fresh-same" });
  const SWITCH_MODEL = verdict({ done: false, failureClass: "wrong-model", sameExecutorCanRepair: false, nextAction: "switch-model" });
  const REPLAN = verdict({ done: false, failureClass: "bad-contract", sameExecutorCanRepair: false, nextAction: "replan" });

  const check = (s) => {
    assert.ok(s.round <= s.contract.maxRounds, `round ${s.round} <= maxRounds ${s.contract.maxRounds}`);
    return s;
  };

  it("ready/running/evaluating/repairing nunca violam round <= maxRounds", () => {
    const c = contract({ maxRounds: 3 });
    // planning -> ready (round 1)
    let s = check(readyState(c));
    s = check(transitionRun(s, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state);
    s = check(transitionRun(s, { type: "EXECUTION_FINISHED", outcome: "failed" }).state);
    s = check(transitionRun(s, { type: "EVIDENCE_READY", evidence: evidence({ round: 1 }) }).state);
    // repair-same: repairing round 2
    s = check(transitionRun(s, { type: "VERDICT_RECEIVED", verdict: REPAIR }).state);
    // executa/julga round 2
    s = check(transitionRun(s, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state);
    s = check(transitionRun(s, { type: "EXECUTION_FINISHED", outcome: "failed" }).state);
    s = check(transitionRun(s, { type: "EVIDENCE_READY", evidence: evidence({ round: 2 }) }).state);
    // fresh-same: ready round 3 (executor sem session antiga)
    s = check(transitionRun(s, { type: "VERDICT_RECEIVED", verdict: FRESH }).state);
    // executa/julga round 3 com nova sessao
    s = check(transitionRun(s, { type: "EXECUTION_STARTED", executor: { agent: "build", model: "opencode/big-pickle", sessionID: "nova" } }).state);
    s = check(transitionRun(s, { type: "EXECUTION_FINISHED", outcome: "failed" }).state);
    s = check(transitionRun(s, { type: "EVIDENCE_READY", evidence: evidence({ round: 3 }) }).state);
    // switch-model no round 3 excederia o limite -> awaiting-human (round 3 <= 3)
    s = check(transitionRun(s, { type: "VERDICT_RECEIVED", verdict: SWITCH_MODEL }).state);
    assert.equal(s.phase, "awaiting-human");
    assert.equal(s.round, 3);
  });

  it("apos replan com budget reduzido, round <= maxRounds continua valendo", () => {
    const c = contract({ maxRounds: 3 });
    let s = check(evaluateState(c));
    s = check(transitionRun(s, { type: "VERDICT_RECEIVED", verdict: REPLAN }).state); // planning round 2
    s = check(transitionRun(s, { type: "CONTRACT_READY", contract: contract({ maxRounds: 2 }) }).state); // ready round 2
    assert.equal(s.round, 2);
    assert.equal(s.contract.maxRounds, 2);
    s = check(transitionRun(s, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state);
    s = check(transitionRun(s, { type: "EXECUTION_FINISHED", outcome: "succeeded" }).state);
    assert.equal(s.phase, "evaluating");
  });

  it("switch-model/switch-agent limpos nunca iniciam execucao sem identidade", () => {
    const c = contract({ maxRounds: 3 });
    let s = check(evaluateState(c));
    s = check(transitionRun(s, { type: "VERDICT_RECEIVED", verdict: SWITCH_MODEL }).state);
    assert.equal(s.executor, undefined, "switch-model limpa executor");
    expectErr(() => transitionRun(s, { type: "EXECUTION_STARTED" }), "invalid-event");
  });
});

// ─────────────────────── EXECUTION_STARTED inequivoco ───────────────────────

describe("state machine: EXECUTION_STARTED exige identidade explicita em ready, reuso apenas em repairing", () => {
  const REPAIR = verdict({ done: false, failureClass: "implementation", sameExecutorCanRepair: true, nextAction: "repair-same" });
  const FRESH = verdict({ done: false, failureClass: "reasoning", sameExecutorCanRepair: true, nextAction: "fresh-same" });
  const SWITCH_MODEL = verdict({ done: false, failureClass: "wrong-model", sameExecutorCanRepair: false, nextAction: "switch-model" });

  it("ready + EXECUTION_STARTED sem executor -> invalid-event", () => {
    expectErr(() => transitionRun(readyState(contract()), { type: "EXECUTION_STARTED" }), "invalid-event");
  });

  it("fresh-same -> ready -> EXECUTION_STARTED sem executor -> invalid-event; com nova identidade -> running", () => {
    const c = contract();
    let s = transitionRun(evaluateState(c), { type: "VERDICT_RECEIVED", verdict: FRESH }).state; // ready round 2
    expectErr(() => transitionRun(s, { type: "EXECUTION_STARTED" }), "invalid-event");
    const r = transitionRun(s, { type: "EXECUTION_STARTED", executor: { agent: "build", model: "opencode/big-pickle", sessionID: "new-session" } });
    assert.equal(r.state.phase, "running");
    assert.deepEqual(r.state.executor, { agent: "build", model: "opencode/big-pickle", sessionID: "new-session" });
  });

  it("ready apos switch-model exige identidade explicita (executor foi limpo)", () => {
    let s = transitionRun(evaluateState(contract()), { type: "VERDICT_RECEIVED", verdict: SWITCH_MODEL }).state;
    assert.equal(s.executor, undefined);
    expectErr(() => transitionRun(s, { type: "EXECUTION_STARTED" }), "invalid-event");
    const r = transitionRun(s, { type: "EXECUTION_STARTED", executor: { agent: "build", model: "opencode/big-pickle", sessionID: "s2" } });
    assert.equal(r.state.phase, "running");
    assert.equal(r.state.executor.sessionID, "s2");
  });

  it("repairing + EXECUTION_STARTED sem executor preserva agent/model/sessionID exatos", () => {
    let s = evaluateState(contract({ maxRounds: 3 }));
    s = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: REPAIR }).state;
    const r = transitionRun(s, { type: "EXECUTION_STARTED" });
    assert.equal(r.state.phase, "running");
    assert.deepEqual(r.state.executor, { agent: "build", model: "opencode/big-pickle", sessionID: "s1" });
  });

  it("repairing sem executor valido no estado -> invalid-event (nunca running sem ExecutorRef)", () => {
    let s = evaluateState(contract({ maxRounds: 3 }));
    s = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: REPAIR }).state;
    const semExecutor = { ...s, executor: undefined };
    expectErr(() => transitionRun(semExecutor, { type: "EXECUTION_STARTED" }), "invalid-event");
    const semAgent = { ...s, executor: { model: "opencode/big-pickle" } };
    expectErr(() => transitionRun(semAgent, { type: "EXECUTION_STARTED" }), "invalid-event");
  });
});

// ─────────────────────── replan + contrato revisado ───────────────────────

describe("state machine: replan instala contrato revisado", () => {
  const REPLAN = verdict({ done: false, failureClass: "bad-contract", sameExecutorCanRepair: false, nextAction: "replan" });
  const ACCEPT = verdict({ done: true, failureClass: "none", sameExecutorCanRepair: false, nextAction: "accept" });

  it("replan -> planning + replan; CONTRACT_READY com revisedContract instala novo contrato e segue ready", () => {
    const c = contract({ maxRounds: 2 });
    const s = evaluateState(c);
    const r = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: REPLAN });
    assert.equal(r.state.phase, "planning");
    assert.equal(r.state.round, 2);
    assert.deepEqual(r.commands, [{ type: "replan" }]);
    assert.equal(r.state.evidence, undefined, "evidence da rodada julgada nao persiste para o replan");
    const revised = contract({ maxRounds: 2, objective: "Reimplementar auth com nova arquitetura" });
    const r2 = transitionRun(r.state, { type: "CONTRACT_READY", contract: revised });
    assert.equal(r2.state.phase, "ready");
    assert.deepEqual(r2.commands, [{ type: "dispatch", mode: "initial" }]);
    assert.equal(r2.state.round, 2, "replan nao reinicia o round");
    assert.equal(r2.state.contract.objective, "Reimplementar auth com nova arquitetura", "contrato revisado instalado");
    assert.equal(r2.state.contract.runID, "run-1", "runID preservado");
    validateExecutionContract(r2.state.contract); // contrato revisado foi validado
  });

  it("CONTRACT_READY sem contract usa o contrato que ja esta no estado", () => {
    const c = contract();
    const r = transitionRun(createRunState(c), { type: "CONTRACT_READY" });
    assert.equal(r.state.phase, "ready");
    assert.equal(r.state.contract.objective, c.objective);
    assert.equal(r.state.contract.runID, "run-1");
  });

  it("fluxo completo: replan -> novo contrato -> round 2 executa e completa", () => {
    const c = contract({ maxRounds: 2 });
    let s = transitionRun(evaluateState(c), { type: "VERDICT_RECEIVED", verdict: REPLAN }).state;
    const revised = contract({ maxRounds: 2, objective: "Reimplementar auth com nova arquitetura" });
    s = transitionRun(s, { type: "CONTRACT_READY", contract: revised }).state;
    assert.equal(s.phase, "ready");
    assert.equal(s.round, 2);
    s = transitionRun(s, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    s = transitionRun(s, { type: "EXECUTION_FINISHED", outcome: "succeeded" }).state;
    s = transitionRun(s, { type: "EVIDENCE_READY", evidence: evidence({ round: 2, outcome: "succeeded" }) }).state;
    const r = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: ACCEPT });
    assert.equal(r.state.phase, "completed");
    assert.equal(r.state.history.length, 2, "history registra round 1 e round 2");
    assert.equal(r.state.history[1].round, 2);
  });

  it("runID diferente no contrato revisado -> erro (invalid-contract)", () => {
    const s = transitionRun(evaluateState(contract({ maxRounds: 2 })), { type: "VERDICT_RECEIVED", verdict: REPLAN }).state;
    expectErr(
      () => transitionRun(s, { type: "CONTRACT_READY", contract: contract({ runID: "outro-run", maxRounds: 2 }) }),
      "invalid-contract",
    );
  });

  it("maxRounds aumentado no contrato revisado -> erro (invalid-contract)", () => {
    const s = transitionRun(evaluateState(contract({ maxRounds: 2 })), { type: "VERDICT_RECEIVED", verdict: REPLAN }).state;
    expectErr(
      () => transitionRun(s, { type: "CONTRACT_READY", contract: contract({ maxRounds: 3 }) }),
      "invalid-contract",
    );
  });

  it("RED B: reducao de maxRounds ate a rodada atual e permitida (revised.maxRounds >= state.round)", () => {
    const s = transitionRun(evaluateState(contract({ maxRounds: 3 })), { type: "VERDICT_RECEIVED", verdict: REPLAN }).state;
    assert.equal(s.round, 2, "replan levou o run para a rodada 2");
    const r = transitionRun(s, { type: "CONTRACT_READY", contract: contract({ maxRounds: 2 }) });
    assert.equal(r.state.phase, "ready");
    assert.equal(r.state.round, 2);
    assert.equal(r.state.contract.maxRounds, 2);
  });

  it("RED A: reducao abaixo da rodada atual e rejeitada (round=2, revised maxRounds=1 -> invalid-contract)", () => {
    const s = transitionRun(evaluateState(contract({ maxRounds: 3 })), { type: "VERDICT_RECEIVED", verdict: REPLAN }).state;
    assert.equal(s.round, 2);
    expectErr(
      () => transitionRun(s, { type: "CONTRACT_READY", contract: contract({ maxRounds: 1 }) }),
      "invalid-contract",
    );
  });

  it("mensagem de erro de budget cita current round e revised maxRounds", () => {
    const s = transitionRun(evaluateState(contract({ maxRounds: 3 })), { type: "VERDICT_RECEIVED", verdict: REPLAN }).state;
    assert.throws(
      () => transitionRun(s, { type: "CONTRACT_READY", contract: contract({ maxRounds: 1 }) }),
      (err) => {
        assert.equal(err?.name, "OrchestrationError");
        assert.equal(err?.code, "invalid-contract");
        assert.match(err?.message, /round 2/);
        assert.match(err?.message, /maxRounds 1/);
        return true;
      },
    );
  });

  it("contrato revisado estruturalmente invalido -> erro (invalid-contract)", () => {
    const s = transitionRun(evaluateState(contract({ maxRounds: 2 })), { type: "VERDICT_RECEIVED", verdict: REPLAN }).state;
    expectErr(
      () => transitionRun(s, { type: "CONTRACT_READY", contract: contract({ acceptanceCriteria: [] }) }),
      "invalid-contract",
    );
  });

  it("nao permite mutacao externa: RunState antigo permanece intacto apos replan", () => {
    const c = contract({ maxRounds: 2 });
    const s = evaluateState(c);
    const before = structuredClone(s);
    const r = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: REPLAN });
    assert.deepEqual(s, before, "transitionRun nao muta o estado de entrada");
    assert.equal(r.state.contract.objective, c.objective, "contrato antigo ainda vigora ate a revisao");
  });
});

// ─────────────────────── evidence deve corresponder a rodada ───────────────────────

describe("state machine: EvidencePacket deve pertencer a rodada atual", () => {
  // Leva o run ate evaluating do round 2 (maxRounds=3).
  function secondRoundEvaluating() {
    const c = contract({ maxRounds: 3 });
    const FRESH = verdict({ done: false, failureClass: "reasoning", sameExecutorCanRepair: true, nextAction: "fresh-same" });
    let s = evaluateState(c);
    s = transitionRun(s, { type: "VERDICT_RECEIVED", verdict: FRESH }).state; // ready round 2
    s = transitionRun(s, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    s = transitionRun(s, { type: "EXECUTION_FINISHED", outcome: "failed" }).state; // evaluating round 2
    assert.equal(s.round, 2);
    return s;
  }

  it("evidence da rodada passada (round 1) no round 2 -> invalid-evidence", () => {
    const s = secondRoundEvaluating();
    expectErr(() => transitionRun(s, { type: "EVIDENCE_READY", evidence: evidence({ round: 1 }) }), "invalid-evidence");
  });

  it("evidence da rodada futura (round 3) no round 2 -> invalid-evidence", () => {
    const s = secondRoundEvaluating();
    expectErr(() => transitionRun(s, { type: "EVIDENCE_READY", evidence: evidence({ round: 3 }) }), "invalid-evidence");
  });

  it("mensagem mostra expected round X e received round Y", () => {
    const s = secondRoundEvaluating();
    assert.throws(
      () => transitionRun(s, { type: "EVIDENCE_READY", evidence: evidence({ round: 1 }) }),
      (err) => {
        assert.equal(err?.name, "OrchestrationError");
        assert.match(err?.message, /expected round 2/);
        assert.match(err?.message, /received round 1/);
        return true;
      },
    );
  });

  it("evidence da rodada correta e aceita e mantem evaluating", () => {
    const s = secondRoundEvaluating();
    const r = transitionRun(s, { type: "EVIDENCE_READY", evidence: evidence({ round: 2 }) });
    assert.equal(r.state.phase, "evaluating");
    assert.equal(r.state.evidence.round, 2);
  });
});

// ─────────────────────── verdict exige evidence ───────────────────────

describe("state machine: verdict nunca julga no escuro (exige evidence da rodada)", () => {
  const REPAIR = verdict({ done: false, failureClass: "implementation", sameExecutorCanRepair: true, nextAction: "repair-same" });

  it("EXECUTION_FINISHED -> VERDICT_RECEIVED sem EVIDENCE_READY -> erro", () => {
    const s = evaluatingState(contract());
    expectErr(() => transitionRun(s, { type: "VERDICT_RECEIVED", verdict: REPAIR }), "invalid-evidence");
  });

  it("VERDICT_RECEIVED sem evidence em evaluating falha deterministicamente (qualquer action)", () => {
    const s = evaluatingState(contract());
    for (const over of [
      { done: true, failureClass: "none", sameExecutorCanRepair: false, nextAction: "accept" },
      { done: false, failureClass: "environment", sameExecutorCanRepair: false, nextAction: "human" },
    ]) {
      expectErr(() => transitionRun(s, { type: "VERDICT_RECEIVED", verdict: verdict(over) }), "invalid-evidence");
    }
  });

  it("fluxo correto: EXECUTION_FINISHED -> EVIDENCE_READY -> VERDICT_RECEIVED permitido", () => {
    const c = contract();
    let s = evaluatingState(c);
    s = transitionRun(s, { type: "EVIDENCE_READY", evidence: evidence({ round: 1 }) }).state;
    const r = transitionRun(s, {
      type: "VERDICT_RECEIVED",
      verdict: verdict({ done: true, failureClass: "none", sameExecutorCanRepair: false, nextAction: "accept" }),
    });
    assert.equal(r.state.phase, "completed");
  });
});

// ─────────────────────────── invalid transitions ───────────────────────────

describe("state machine: transicoes invalidas falham deterministicamente", () => {
  it("planning + EXECUTION_FINISHED falha", () => {
    expectErr(() => transitionRun(planningState(contract()), { type: "EXECUTION_FINISHED", outcome: "failed" }), "invalid-transition");
  });

  it("completed + VERDICT_RECEIVED falha", () => {
    const c = contract();
    const accepted = transitionRun(evaluateState(c), { type: "VERDICT_RECEIVED", verdict: verdict({ done: true, failureClass: "none", sameExecutorCanRepair: false, nextAction: "accept" }) }).state;
    expectErr(() => transitionRun(accepted, { type: "VERDICT_RECEIVED", verdict: verdict({ done: false, failureClass: "implementation", sameExecutorCanRepair: true, nextAction: "repair-same" }) }), "invalid-transition");
  });

  it("running + CONTRACT_READY falha", () => {
    expectErr(() => transitionRun(runningState(contract()), { type: "CONTRACT_READY" }), "invalid-transition");
  });

  it("evaluating + EXECUTION_STARTED falha", () => {
    expectErr(() => transitionRun(evaluatingState(contract()), { type: "EXECUTION_STARTED", executor: EXECUTOR }), "invalid-transition");
  });

  it("ready + EVIDENCE_READY falha", () => {
    expectErr(() => transitionRun(readyState(contract()), { type: "EVIDENCE_READY", evidence: evidence({ round: 1 }) }), "invalid-transition");
  });

  it("stopped + EXECUTION_STARTED falha (terminal)", () => {
    const stopped = transitionRun(evaluateState(contract()), { type: "VERDICT_RECEIVED", verdict: verdict({ done: false, failureClass: "missing-context", sameExecutorCanRepair: false, nextAction: "stop" }) }).state;
    expectErr(() => transitionRun(stopped, { type: "EXECUTION_STARTED", executor: EXECUTOR }), "invalid-transition");
  });

  it("failed + EVIDENCE_READY falha (terminal)", () => {
    const failed = transitionRun(readyState(contract()), { type: "COMMAND_FAILED", command: "dispatch", error: "boom" }).state;
    expectErr(() => transitionRun(failed, { type: "EVIDENCE_READY", evidence: evidence({ round: 1 }) }), "invalid-transition");
  });

  it("planning + COMMAND_FAILED falha (nenhum comando pendente)", () => {
    expectErr(() => transitionRun(planningState(contract()), { type: "COMMAND_FAILED", command: "dispatch" }), "invalid-transition");
  });

  it("VERDICT_RECEIVED com verdict inconsistente falha (invalid-verdict)", () => {
    expectErr(
      () =>
        transitionRun(evaluateState(contract()), {
          type: "VERDICT_RECEIVED",
          verdict: verdict({ done: true, failureClass: "implementation", sameExecutorCanRepair: true, nextAction: "repair-same" }),
        }),
      "invalid-verdict",
    );
  });

  it("EVIDENCE_READY com evidence malformada falha (invalid-evidence)", () => {
    expectErr(
      () => transitionRun(evaluatingState(contract()), { type: "EVIDENCE_READY", evidence: evidence({ round: 0 }) }),
      "invalid-evidence",
    );
  });

  it("EXECUTION_FINISHED com outcome invalido falha", () => {
    expectErr(() => transitionRun(runningState(contract()), { type: "EXECUTION_FINISHED", outcome: "meh" }), "invalid-event");
  });
});

// ─────────────────────────── COMMAND_FAILED ───────────────────────────

describe("state machine: COMMAND_FAILED (efeitos declarativos falhando)", () => {
  it("ready + COMMAND_FAILED -> failed, sem comandos", () => {
    const r = transitionRun(readyState(contract()), { type: "COMMAND_FAILED", command: "dispatch", error: "provider indisponivel" });
    assert.equal(r.state.phase, "failed");
    assert.deepEqual(r.commands, []);
    assert.ok(r.state.lastError && r.state.lastError.length < 450, "erro bounded");
    assert.match(r.state.lastError, /provider/);
  });

  it("evaluating + COMMAND_FAILED -> failed", () => {
    const r = transitionRun(evaluatingState(contract()), { type: "COMMAND_FAILED", command: "evaluate", error: "critic indisponivel" });
    assert.equal(r.state.phase, "failed");
  });

  it("awaiting-human + COMMAND_FAILED -> failed (falha de comunicacao humana)", () => {
    const ah = transitionRun(evaluateState(contract()), { type: "VERDICT_RECEIVED", verdict: verdict({ done: false, failureClass: "environment", sameExecutorCanRepair: false, nextAction: "human" }) }).state;
    const r = transitionRun(ah, { type: "COMMAND_FAILED", command: "request-human", error: "notificacao falhou" });
    assert.equal(r.state.phase, "failed");
  });

  it("erro muito longo e truncado (bounded)", () => {
    const r = transitionRun(readyState(contract()), { type: "COMMAND_FAILED", command: "dispatch", error: "e".repeat(5000) });
    assert.ok(r.state.lastError.length <= 450, `lastError bounded (got ${r.state.lastError.length})`);
  });
});

// ─────────────────────────── integridade de superfície ───────────────────────────

describe("o kernel nao conhece ctx nem runtime", () => {
  it("tipos/acoes auxiliares", () => {
    assert.ok(isFailureClass("wrong-model"));
    assert.ok(!isFailureClass("boom"));
    assert.ok(isNextAction("replan"));
    assert.ok(!isNextAction("retry"));
    assert.equal(FAILURE_CLASSES.length, 8);
    assert.equal(NEXT_ACTIONS.length, 8);
  });

  it("todas as 8 next actions tem transicao (percorridas acima)", () => {
    // garantia estrutural: NEXT_ACTIONS casa com os comandos do scheduler
    for (const action of NEXT_ACTIONS) {
      assert.ok(["accept", "repair-same", "fresh-same", "switch-model", "switch-agent", "replan", "human", "stop"].includes(action));
    }
  });
});