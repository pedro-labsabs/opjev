// Testes RED do Dispatcher do Orchestration Kernel v1.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createRunState,
  transitionRun,
} from "./orchestration/state-machine.ts";
import {
  buildRoundJudgementQuestions,
  buildRoundJudgementState,
  parseRoundVerdict,
} from "./orchestration/judgement.ts";
import {
  WORKER_TIMEOUT_MS,
  buildWorkerPrompt,
  extractFinalAssistantText,
  runOrchestrationOnce,
} from "./orchestration/dispatcher.ts";
import {
  isInternalWorkerSession,
  hasInternalPromptMarker,
  buildWorkerContextInstruction,
  buildDefaultContextInstruction,
} from "./worker-hooks.ts";
import { isFreeModel, FREE_POOL } from "./config.ts";
import pluginDefault from "../index.ts";
import {
  makeCtx,
  makeStorage,
  stubFetch,
  okJev,
  routeAnswers,
  choice,
  noul,
} from "./harness.mjs";

// ─────────────────────────── helpers ───────────────────────────

function contract(over = {}) {
  return {
    runID: "test-run-1",
    objective: "Implementar o modulo auth",
    scope: { include: [], exclude: [] },
    constraints: ["nao alterar o runtime"],
    acceptanceCriteria: ["typecheck passa"],
    requiredEvidence: ["worker-session-outcome", "worker-final-response"],
    maxRounds: 1,
    ...over,
  };
}

const EXECUTOR = { agent: "build", model: "opencode/big-pickle", sessionID: "s1" };

const ACCEPT_VERDICT = {
  done: true,
  failureClass: "none",
  sameExecutorCanRepair: false,
  nextAction: "accept",
};

const REPAIR_VERDICT = {
  done: false,
  failureClass: "implementation",
  sameExecutorCanRepair: true,
  nextAction: "repair-same",
};

// ─────────────────────────── A. Happy path ───────────────────────────

describe("dispatcher core: happy path (kernel state transitions)", () => {
  it("A1: contract -> CONTRACT_READY -> ready, round 1, dispatch(initial)", () => {
    const c = contract({ maxRounds: 1 });
    const rs = createRunState(c);
    const r = transitionRun(rs, { type: "CONTRACT_READY" });
    assert.equal(r.state.phase, "ready");
    assert.equal(r.state.round, 1);
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].type, "dispatch");
    assert.deepEqual(r.commands[0], { type: "dispatch", mode: "initial" });
  });

  it("A2: full happy path -> completed, round 1", () => {
    const c = contract({ maxRounds: 1 });
    let state = createRunState(c);
    // CONTRACT_READY
    let r = transitionRun(state, { type: "CONTRACT_READY" });
    state = r.state;
    assert.equal(state.phase, "ready");
    // EXECUTION_STARTED
    r = transitionRun(state, { type: "EXECUTION_STARTED", executor: EXECUTOR });
    state = r.state;
    assert.equal(state.phase, "running");
    assert.deepEqual(state.executor, EXECUTOR);
    // EXECUTION_FINISHED
    r = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "succeeded" });
    state = r.state;
    assert.equal(state.phase, "evaluating");
    // EVIDENCE_READY
    const ev = {
      round: 1,
      executor: { agent: "build", model: "opencode/big-pickle", sessionID: "s1" },
      outcome: "succeeded",
      deterministicChecks: [
        { name: "worker-session-outcome", status: "pass" },
        { name: "worker-final-response", status: "pass" },
      ],
      criticFindings: [],
      resultSummary: "OK",
    };
    r = transitionRun(state, { type: "EVIDENCE_READY", evidence: ev });
    state = r.state;
    assert.equal(state.phase, "evaluating");
    assert.ok(state.evidence !== undefined);
    // VERDICT_RECEIVED (accept)
    r = transitionRun(state, { type: "VERDICT_RECEIVED", verdict: ACCEPT_VERDICT });
    state = r.state;
    assert.equal(state.phase, "completed");
    assert.deepEqual(r.commands, [{ type: "complete" }]);
  });
});

// ─────────────────────────── B. Ordem dos efeitos ───────────────────────────

describe("dispatcher core: order of effects (declared)", () => {
  it("B1: dispatch(initial) e o primeiro comando emitido", () => {
    const c = contract();
    const r = transitionRun(createRunState(c), { type: "CONTRACT_READY" });
    assert.equal(r.commands[0]?.type, "dispatch");
  });

  it("B2: evaluate e emitido apos EXECUTION_FINISHED", () => {
    let state = transitionRun(createRunState(contract()), { type: "CONTRACT_READY" }).state;
    state = transitionRun(state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    const r = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "succeeded" });
    assert.deepEqual(r.commands, [{ type: "evaluate" }]);
  });

  it("B3: EVIDENCE_READY nao emite comandos", () => {
    let state = transitionRun(createRunState(contract()), { type: "CONTRACT_READY" }).state;
    state = transitionRun(state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "succeeded" }).state;
    const ev = {
      round: 1,
      executor: EXECUTOR,
      outcome: "succeeded",
      deterministicChecks: [{ name: "worker-session-outcome", status: "pass" }],
      criticFindings: [],
      resultSummary: "OK",
    };
    const r = transitionRun(state, { type: "EVIDENCE_READY", evidence: ev });
    assert.deepEqual(r.commands, []);
  });
});

// ─────────────────────────── C. Executor initial ───────────────────────────

describe("dispatcher core: executor initial (guardrails)", () => {
  it("C1: selection agent/model nao vazios", () => {
    const sel = { agent: "build", model: "opencode/big-pickle" };
    assert.ok(typeof sel.agent === "string" && sel.agent.length > 0);
    assert.ok(typeof sel.model === "string" && sel.model.length > 0);
    assert.ok(isFreeModel(sel.model));
  });

  it("C2: selection com modelo fora do FREE_POOL invalido", () => {
    assert.ok(!isFreeModel("openai/gpt-4o"));
  });

  it("C3: selection com agent vazio invalida", () => {
    const sel = { agent: "", model: "opencode/big-pickle" };
    assert.ok(!sel.agent.trim());
  });
});

// ─────────────────────────── D. evidence usa executor real ───────────────────────────

describe("dispatcher core: evidence usa executor real (não so selection)", () => {
  it("D1: view.model diferente de selection.model -> evidence carrega view.model", () => {
    // selection: M1; session.get: M2
    const selection = { agent: "build", model: "opencode/big-pickle" };
    const view = { agent: "build", model: "opencode/mimo-v2.5-free" };
    const agent = view.agent?.trim() || selection.agent;
    const model = view.model?.trim() || selection.model;
    assert.equal(model, "opencode/mimo-v2.5-free");
    assert.notEqual(model, selection.model);
  });

  it("D2: view.agent vazio -> fallback para selection.agent", () => {
    const selection = { agent: "build", model: "opencode/big-pickle" };
    const view = { agent: "", model: "opencode/mimo-v2.5-free" };
    const agent = view.agent?.trim() || selection.agent;
    assert.equal(agent, "build");
  });
});

// ─────────────────────────── E. final text extraction ───────────────────────────

describe("dispatcher core: extractFinalAssistantText", () => {
  it("E1: uma mensagem assistant com texto", () => {
    const msgs = [{ type: "assistant", content: [{ type: "text", text: "Hello" }] }];
    assert.equal(extractFinalAssistantText(msgs), "Hello");
  });

  it("E2: multiplos text parts", () => {
    const msgs = [{ type: "assistant", content: [{ type: "text", text: "Part1" }, { type: "text", text: "Part2" }] }];
    assert.equal(extractFinalAssistantText(msgs), "Part1\nPart2");
  });

  it("E3: reasoning ignorado", () => {
    const msgs = [{ type: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "Done" }] }];
    assert.equal(extractFinalAssistantText(msgs), "Done");
  });

  it("E4: tools ignoradas", () => {
    const msgs = [{ type: "assistant", content: [{ type: "tool", payload: { ok: true } }, { type: "text", text: "Ok" }] }];
    assert.equal(extractFinalAssistantText(msgs), "Ok");
  });

  it("E5: multiplos assistants -> ultimo relevante", () => {
    const msgs = [
      { type: "assistant", content: [{ type: "text", text: "first" }] },
      { type: "user", content: [{ type: "text", text: "continue" }] },
      { type: "assistant", content: [{ type: "text", text: "last" }] },
    ];
    assert.equal(extractFinalAssistantText(msgs), "last");
  });

  it("E6: sem texto final", () => {
    const msgs = [{ type: "assistant", content: [{ type: "reasoning", text: "thinking" }] }];
    assert.equal(extractFinalAssistantText(msgs), "");
  });

  it("E7: array vazio", () => {
    assert.equal(extractFinalAssistantText([]), "");
  });

  it("E8: mensagens com type !== assistant ignoradas", () => {
    const msgs = [
      { type: "user", content: [{ type: "text", text: "prompt" }] },
      { type: "system", content: [{ type: "text", text: "instrucao" }] },
    ];
    assert.equal(extractFinalAssistantText(msgs), "");
  });

  it("E9: texto longo truncado", () => {
    const long = "x".repeat(3000);
    const msgs = [{ type: "assistant", content: [{ type: "text", text: long }] }];
    const result = extractFinalAssistantText(msgs);
    assert.ok(result.length < 3000);
    assert.ok(result.includes("truncado"));
  });
});

// ─────────────────────────── F. failed worker ───────────────────────────

describe("dispatcher core: failed worker (evidence não local)", () => {
  it("F1: outcome failed -> deterministicChecks worker-session-outcome = fail", () => {
    const outcome = "failed";
    const finalText = "";
    const checks = [
      { name: "worker-session-outcome", status: outcome === "succeeded" ? "pass" : "fail" },
      { name: "worker-final-response", status: finalText.trim() ? "pass" : "fail" },
    ];
    assert.equal(checks[0].status, "fail");
    assert.equal(checks[1].status, "fail");
  });

  it("F2: com outcome failed mas texto presente -> worker-final-response = pass", () => {
    const outcome = "failed";
    const finalText = "partial result";
    const checks = [
      { name: "worker-session-outcome", status: outcome === "succeeded" ? "pass" : "fail" },
      { name: "worker-final-response", status: finalText.trim() ? "pass" : "fail" },
    ];
    assert.equal(checks[0].status, "fail");
    assert.equal(checks[1].status, "pass");
  });

  it("F3: evidence ainda passa ao Jev para decidir (nao local)", () => {
    const c = contract({ maxRounds: 2 });
    let state = transitionRun(createRunState(c), { type: "CONTRACT_READY" }).state;
    state = transitionRun(state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "failed" }).state;
    const ev = {
      round: 1,
      executor: EXECUTOR,
      outcome: "failed",
      deterministicChecks: [{ name: "worker-session-outcome", status: "fail" }],
      criticFindings: [],
      resultSummary: "failed",
    };
    state = transitionRun(state, { type: "EVIDENCE_READY", evidence: ev }).state;
    assert.equal(state.evidence.outcome, "failed");
    assert.equal(state.phase, "evaluating");
    // evidence existe e esta pronta para o Jev julgar
    assert.ok(state.evidence !== undefined);
    assert.ok(state.evidence.round === 1);
  });
});

// ─────────────────────────── G. non-accept verdict ───────────────────────────

describe("dispatcher core: non-accept verdict (sem segunda rodada)", () => {
  it("G1: repair-same -> phase repairing + pendingCommands = [repair-same]", () => {
    let state = transitionRun(createRunState(contract({ maxRounds: 2 })), { type: "CONTRACT_READY" }).state;
    state = transitionRun(state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "failed" }).state;
    const ev = {
      round: 1,
      executor: EXECUTOR,
      outcome: "failed",
      deterministicChecks: [{ name: "worker-session-outcome", status: "fail" }],
      criticFindings: [],
      resultSummary: "failed",
    };
    state = transitionRun(state, { type: "EVIDENCE_READY", evidence: ev }).state;
    const r = transitionRun(state, { type: "VERDICT_RECEIVED", verdict: REPAIR_VERDICT });
    assert.equal(r.state.phase, "repairing");
    assert.equal(r.state.round, 2);
    assert.deepEqual(r.commands, [{ type: "repair-same" }]);
  });

  it("G2: acceptance test fechado (reject) -> phase stopped", () => {
    const rejectVerdict = { done: false, failureClass: "environment", sameExecutorCanRepair: false, nextAction: "stop" };
    let state = transitionRun(createRunState(contract({ maxRounds: 2 })), { type: "CONTRACT_READY" }).state;
    state = transitionRun(state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "succeeded" }).state;
    const ev = {
      round: 1,
      executor: EXECUTOR,
      outcome: "succeeded",
      deterministicChecks: [{ name: "worker-session-outcome", status: "pass" }, { name: "worker-final-response", status: "pass" }],
      criticFindings: [],
      resultSummary: "OK",
    };
    state = transitionRun(state, { type: "EVIDENCE_READY", evidence: ev }).state;
    const r = transitionRun(state, { type: "VERDICT_RECEIVED", verdict: rejectVerdict });
    assert.equal(r.state.phase, "stopped");
    assert.deepEqual(r.commands, [{ type: "stop" }]);
  });

  it("G3: fresh-same -> phase ready, executor sem sessionID", () => {
    const freshVerdict = { done: false, failureClass: "reasoning", sameExecutorCanRepair: true, nextAction: "fresh-same" };
    let state = transitionRun(createRunState(contract({ maxRounds: 2 })), { type: "CONTRACT_READY" }).state;
    state = transitionRun(state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "failed" }).state;
    const ev = {
      round: 1,
      executor: EXECUTOR,
      outcome: "failed",
      deterministicChecks: [{ name: "worker-session-outcome", status: "fail" }],
      criticFindings: [],
      resultSummary: "failed",
    };
    state = transitionRun(state, { type: "EVIDENCE_READY", evidence: ev }).state;
    const r = transitionRun(state, { type: "VERDICT_RECEIVED", verdict: freshVerdict });
    assert.equal(r.state.phase, "ready");
    assert.equal(r.state.round, 2);
    assert.equal(r.state.executor?.sessionID, undefined);
    assert.equal(r.state.executor?.agent, "build");
    assert.equal(r.state.executor?.model, "opencode/big-pickle");
  });
});

// ─────────────────────────── H. timeout ───────────────────────────

describe("dispatcher core: timeout bounded", () => {
  it("H1: nao ha loop infinito (maxRounds impede)", () => {
    const c = contract({ maxRounds: 1 });
    const freshVerdict = { done: false, failureClass: "reasoning", sameExecutorCanRepair: true, nextAction: "fresh-same" };
    let state = transitionRun(createRunState(c), { type: "CONTRACT_READY" }).state;
    state = transitionRun(state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "failed" }).state;
    const ev = {
      round: 1,
      executor: EXECUTOR,
      outcome: "failed",
      deterministicChecks: [{ name: "worker-session-outcome", status: "fail" }],
      criticFindings: [],
      resultSummary: "failed",
    };
    state = transitionRun(state, { type: "EVIDENCE_READY", evidence: ev }).state;
    const r = transitionRun(state, { type: "VERDICT_RECEIVED", verdict: freshVerdict });
    // maxRounds = 1, round = 1 -> fresh-same excederia -> awaiting-human
    assert.equal(r.state.phase, "awaiting-human");
    assert.equal(r.state.round, 1);
    assert.deepEqual(r.commands, [{ type: "request-human" }]);
  });
});

// ─────────────────────────── I. buildWorkerPrompt ───────────────────────────

describe("dispatcher core: buildWorkerPrompt", () => {
  it("I1: inclui objective", () => {
    const c = contract();
    const prompt = buildWorkerPrompt(c);
    assert.ok(prompt.includes("Implementar o modulo auth"));
  });

  it("I2: inclui constraints", () => {
    const c = contract();
    const prompt = buildWorkerPrompt(c);
    assert.ok(prompt.includes("nao alterar o runtime"));
  });

  it("I3: inclui acceptanceCriteria", () => {
    const c = contract();
    const prompt = buildWorkerPrompt(c);
    assert.ok(prompt.includes("typecheck passa"));
  });

  it("I4: inclui requiredEvidence", () => {
    const c = contract();
    const prompt = buildWorkerPrompt(c);
    assert.ok(prompt.includes("worker-session-outcome"));
  });

  it("I5: inclui round/maxRounds quando fornecido", () => {
    const c = contract({ maxRounds: 3 });
    const prompt = buildWorkerPrompt(c, 2, 3);
    assert.ok(prompt.includes("2/3"));
  });

  it("I6: sem round quando omitido", () => {
    const c = contract();
    const prompt = buildWorkerPrompt(c);
    assert.ok(!prompt.includes("ROUND"));
  });

  it("I7: contem instrucao RULE", () => {
    const c = contract();
    const prompt = buildWorkerPrompt(c);
    assert.ok(prompt.includes("RULE:"));
    assert.ok(prompt.includes("judge"));
  });

  it("I8: nao contem decisoes internas do Jev", () => {
    const c = contract();
    const prompt = buildWorkerPrompt(c);
    assert.ok(!prompt.includes("repair-same"));
    assert.ok(!prompt.includes("fresh-same"));
    assert.ok(!prompt.includes("switch-model"));
  });

  it("I9: inclui scope include", () => {
    const c = contract({ scope: { include: ["src/"], exclude: [] } });
    const prompt = buildWorkerPrompt(c);
    assert.ok(prompt.includes("src/"));
  });

  it("I10: inclui scope exclude", () => {
    const c = contract({ scope: { include: [], exclude: ["node_modules/"] } });
    const prompt = buildWorkerPrompt(c);
    assert.ok(prompt.includes("node_modules/"));
  });
});

// ─────────────────────────── J. internal worker bypass ───────────────────────────

describe("dispatcher core: internal worker bypass (prompt hook)", () => {
  it("J1: isInternalWorkerSession -> true para metadata de orchestration", () => {
    const meta = { "jev-role": "worker", "jev-router": "orchestration-internal" };
    assert.equal(isInternalWorkerSession(meta), true);
  });

  it("J2: isInternalWorkerSession -> false para sessao normal", () => {
    const meta = { "jev-router": "routed", "jev-model": "opencode/big-pickle" };
    assert.equal(isInternalWorkerSession(meta), false);
  });

  it("J3: isInternalWorkerSession -> false para metadata vazia", () => {
    assert.equal(isInternalWorkerSession(undefined), false);
  });

  it("J4: isInternalWorkerSession -> false para jev-role != worker", () => {
    const meta = { "jev-role": "assistant", "jev-router": "orchestration-internal" };
    assert.equal(isInternalWorkerSession(meta), false);
  });

  it("J5: isInternalWorkerSession -> false sem jev-router marker", () => {
    const meta = { "jev-role": "worker" };
    assert.equal(isInternalWorkerSession(meta), false);
  });

  it("J6: hasInternalPromptMarker -> true para prompt metadata com orchestration-internal", () => {
    const pm = { "jev-router": "orchestration-internal", "jev-role": "worker" };
    assert.equal(hasInternalPromptMarker(pm), true);
  });

  it("J7: hasInternalPromptMarker -> false para prompt metadata normal", () => {
    const pm = { "jev-router": "routed" };
    assert.equal(hasInternalPromptMarker(pm), false);
  });

  it("J8: hasInternalPromptMarker -> false para undefined", () => {
    assert.equal(hasInternalPromptMarker(undefined), false);
  });
});

// ─────────────────────────── K. worker context ───────────────────────────

describe("dispatcher core: worker context instruction", () => {
  it("K1: worker nao recebe instrucao de consultar Jev em decision boundaries", () => {
    const instr = buildWorkerContextInstruction();
    assert.ok(instr.includes("ONLY the ExecutionContract"));
    assert.ok(!instr.includes("decision boundaries"));
    assert.ok(!instr.includes("new intent"));
  });

  it("K2: worker recebe instrucao de executar apenas o contrato", () => {
    const instr = buildWorkerContextInstruction();
    assert.ok(instr.includes("ExecutionContract"));
    assert.ok(instr.includes("evaluate"));
    assert.ok(!instr.includes("decision boundaries"));
  });

  it("K3: sessao normal continua com instrucao existente", () => {
    const instr = buildDefaultContextInstruction();
    assert.ok(instr.includes("decision boundaries"));
    assert.ok(instr.includes("The Jev"));
    assert.ok(instr.includes("decision boundaries"));
  });

  it("K4: sessao normal pode consultar Jev em decision boundaries", () => {
    const instr = buildDefaultContextInstruction();
    assert.ok(instr.includes("decision boundaries"));
    assert.ok(instr.includes("material failure"));
  });
});

// ─────────────────────────── L. evidence checks honestos ───────────────────────────

describe("dispatcher core: evidence checks honestos", () => {
  it("L1: worker-session-outcome basado no outcome real", () => {
    const outcome = "succeeded";
    const check = { name: "worker-session-outcome", status: outcome === "succeeded" ? "pass" : "fail" };
    assert.equal(check.status, "pass");
  });

  it("L2: worker-final-response basado no texto real", () => {
    const finalText = "ORCHESTRATION_WORKER_OK";
    const check = { name: "worker-final-response", status: finalText.trim() ? "pass" : "fail" };
    assert.equal(check.status, "pass");
  });

  it("L3: worker-session-outcome fail quando outcome != succeeded", () => {
    const outcome = "interrupted";
    const check = { name: "worker-session-outcome", status: outcome === "succeeded" ? "pass" : "fail" };
    assert.equal(check.status, "fail");
  });

  it("L4: worker-final-response fail quando vazio", () => {
    const finalText = "";
    const check = { name: "worker-final-response", status: finalText.trim() ? "pass" : "fail" };
    assert.equal(check.status, "fail");
  });

  it("L5: checks nao marcam pass para evidencia nao verificada", () => {
    const outcome = "failed";
    const finalText = "";
    const checks = [
      { name: "worker-session-outcome", status: outcome === "succeeded" ? "pass" : "fail" },
      { name: "worker-final-response", status: finalText.trim() ? "pass" : "fail" },
    ];
    assert.equal(checks[0].status, "fail");
    assert.equal(checks[1].status, "fail");
    // nenhum check esta marcado pass incorretamente
    assert.ok(!checks.some((c) => c.status === "pass"));
  });
});

// ─────────────────────────── M. guards deterministicos ───────────────────────────

describe("dispatcher core: guards deterministicos", () => {
  it("M1: EVIDENCE_READY com round errado -> invalid-evidence", () => {
    let state = transitionRun(createRunState(contract({ maxRounds: 2 })), { type: "CONTRACT_READY" }).state;
    state = transitionRun(state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "succeeded" }).state;
    const ev = {
      round: 2, // ERRADO: round atual e 1
      executor: EXECUTOR,
      outcome: "succeeded",
      deterministicChecks: [],
      criticFindings: [],
      resultSummary: "wrong round",
    };
    assert.throws(() => transitionRun(state, { type: "EVIDENCE_READY", evidence: ev }), (err) => {
      assert.equal(err.code, "invalid-evidence");
      assert.ok(err.message.includes("round 1"));
      assert.ok(err.message.includes("round 2"));
      return true;
    });
  });

  it("M2: VERDICT_RECEIVED sem evidence -> invalid-evidence", () => {
    let state = transitionRun(createRunState(contract({ maxRounds: 1 })), { type: "CONTRACT_READY" }).state;
    state = transitionRun(state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "succeeded" }).state;
    // sem EVIDENCE_READY
    assert.throws(() => transitionRun(state, { type: "VERDICT_RECEIVED", verdict: ACCEPT_VERDICT }), (err) => {
      assert.equal(err.code, "invalid-evidence");
      assert.ok(err.message.includes("EvidencePacket da rodada atual"));
      return true;
    });
  });

  it("M3: CONTRACT_READY com maxRounds < state.round -> invalid-contract", () => {
    const c = contract({ maxRounds: 3 });
    let state = transitionRun(createRunState(c), { type: "CONTRACT_READY" }).state;
    state = transitionRun(state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "failed" }).state;
    const ev = {
      round: 1,
      executor: EXECUTOR,
      outcome: "failed",
      deterministicChecks: [],
      criticFindings: [],
      resultSummary: "fail",
    };
    state = transitionRun(state, { type: "EVIDENCE_READY", evidence: ev }).state;
    const replanVerdict = { done: false, failureClass: "bad-contract", sameExecutorCanRepair: false, nextAction: "replan" };
    state = transitionRun(state, { type: "VERDICT_RECEIVED", verdict: replanVerdict }).state;
    // planning round 2
    assert.equal(state.phase, "planning");
    assert.equal(state.round, 2);
    // CONTRACT_READY com revised maxRounds=1 < round=2 -> invalid-contract
    const revised = contract({ runID: "test-run-1", maxRounds: 1 });
    assert.throws(() => transitionRun(state, { type: "CONTRACT_READY", contract: revised }), (err) => {
      assert.equal(err.code, "invalid-contract");
      assert.ok(err.message.includes("round 2"));
      assert.ok(err.message.includes("maxRounds 1"));
      return true;
    });
  });

  it("M4: EXECUTION_STARTED sem executor em ready -> invalid-event", () => {
    const state = transitionRun(createRunState(contract()), { type: "CONTRACT_READY" }).state;
    assert.throws(() => transitionRun(state, { type: "EXECUTION_STARTED" }), (err) => {
      assert.equal(err.code, "invalid-event");
      assert.ok(err.message.includes("executor"));
      return true;
    });
  });

  it("M5: EXECUTION_STARTED com model fora do FREE_POOL -> rejeitado pelo dispatcher", () => {
    const sel = { agent: "build", model: "openai/gpt-4o" };
    assert.ok(!isFreeModel(sel.model));
  });
});

// ─────────────────────────── MA. gate deterministico de evidencia (Blocker A) ───────────────────────────

describe("dispatcher core: gate deterministico (hard failure nunca vira completed via accept)", () => {
  function toEvaluatingWith(failChecks) {
    let state = transitionRun(createRunState(contract({ maxRounds: 1 })), { type: "CONTRACT_READY" }).state;
    state = transitionRun(state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: failChecks ? "failed" : "succeeded" }).state;
    const ev = {
      round: 1,
      executor: EXECUTOR,
      outcome: failChecks ? "failed" : "succeeded",
      deterministicChecks: failChecks
        ? [
            { name: "worker-session-outcome", status: "fail" },
            { name: "worker-final-response", status: "fail" },
          ]
        : [
            { name: "worker-session-outcome", status: "pass" },
            { name: "worker-final-response", status: "pass" },
          ],
      criticFindings: [],
      resultSummary: failChecks ? "worker sem resposta" : "OK",
    };
    return transitionRun(state, { type: "EVIDENCE_READY", evidence: ev }).state;
  }

  it("MA1: accept com hard failure (checks fail) -> rejeitado (verdict-rejected)", () => {
    const state = toEvaluatingWith(true);
    assert.throws(() => transitionRun(state, { type: "VERDICT_RECEIVED", verdict: ACCEPT_VERDICT }), (err) => {
      assert.equal(err.code, "verdict-rejected");
      assert.ok(err.message.includes("hard failure"));
      return true;
    });
    assert.equal(state.phase, "evaluating", "estado de origem nao muda (rejeicao sem mutacao)");
  });

  it("MA2: accept com evidence verde -> completed (gate nao bloqueia happy path)", () => {
    const state = toEvaluatingWith(false);
    const r = transitionRun(state, { type: "VERDICT_RECEIVED", verdict: ACCEPT_VERDICT });
    assert.equal(r.state.phase, "completed");
    assert.deepEqual(r.commands, [{ type: "complete" }]);
  });

  it("MA3: status unknown NAO conta como hard failure (accept permitido)", () => {
    let state = transitionRun(createRunState(contract({ maxRounds: 1 })), { type: "CONTRACT_READY" }).state;
    state = transitionRun(state, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
    state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "succeeded" }).state;
    const ev = {
      round: 1,
      executor: EXECUTOR,
      outcome: "succeeded",
      deterministicChecks: [{ name: "worker-final-response", status: "unknown" }],
      criticFindings: [],
      resultSummary: "sem texto final verificado",
    };
    state = transitionRun(state, { type: "EVIDENCE_READY", evidence: ev }).state;
    const r = transitionRun(state, { type: "VERDICT_RECEIVED", verdict: ACCEPT_VERDICT });
    assert.equal(r.state.phase, "completed");
  });
});

// ─────────────────────────── N. judgement flow ───────────────────────────

describe("dispatcher core: judgement flow", () => {
  it("N1: buildRoundJudgementQuestions retorna 4 perguntas", () => {
    const qs = buildRoundJudgementQuestions();
    assert.ok("done" in qs);
    assert.ok("failure_class" in qs);
    assert.ok("same_executor_can_repair" in qs);
    assert.ok("next_action" in qs);
  });

  it("N2: parseRoundVerdict com accept", () => {
    const answers = {
      done: { type: "noul", noul: 0.9 },
      failure_class: { type: "choice", choice: "none" },
      same_executor_can_repair: { type: "noul", noul: 1 },
      next_action: { type: "choice", choice: "accept", confidence: 0.95 },
    };
    const verdict = parseRoundVerdict(answers);
    assert.equal(verdict.done, true);
    assert.equal(verdict.failureClass, "none");
    assert.equal(verdict.nextAction, "accept");
    assert.equal(verdict.confidence, 0.95);
  });

  it("N3: parseRoundVerdict com repair-same", () => {
    const answers = {
      done: { type: "noul", noul: 0.1 },
      failure_class: { type: "choice", choice: "implementation" },
      same_executor_can_repair: { type: "noul", noul: 0.8 },
      next_action: { type: "choice", choice: "repair-same", confidence: 0.7 },
    };
    const verdict = parseRoundVerdict(answers);
    assert.equal(verdict.done, false);
    assert.equal(verdict.failureClass, "implementation");
    assert.equal(verdict.nextAction, "repair-same");
    assert.equal(verdict.sameExecutorCanRepair, true);
  });

  it("N4: buildRoundJudgementState contem executor corretamente", () => {
    const c = contract();
    const ev = {
      round: 1,
      executor: { agent: "build", model: "opencode/big-pickle" },
      outcome: "succeeded",
      deterministicChecks: [{ name: "worker-session-outcome", status: "pass" }],
      criticFindings: [],
      resultSummary: "OK",
    };
    const jState = buildRoundJudgementState(c, ev);
    assert.equal(jState.executor.agent, "build");
    assert.equal(jState.executor.model, "opencode/big-pickle");
    assert.equal(jState.round, 1);
  });
});

// ─────────────────────────── O. runOrchestrationOnce: happy path ───────────────────────────

const ALL_MODELS = [...FREE_POOL];
const PLUGIN_OPTS = {
  enableAutoRoute: true,
  jevTimeoutMs: 500,
  confidenceThreshold: 0.55,
  jevEndpoint: "https://opencode.ai/zen/v1/systemone",
  jevModel: "jev-1.13-free",
  apiKeyEnv: "OPENCODE_API_KEY",
};

async function bootCtx(over = {}) {
  const m = makeCtx(over);
  await pluginDefault.setup(m.ctx);
  return m;
}

function acceptAnswers(confidence = 0.95) {
  return {
    done: { type: "noul", noul: 0.9 },
    failure_class: { type: "choice", choice: "none" },
    same_executor_can_repair: { type: "noul", noul: 1 },
    next_action: { type: "choice", choice: "accept", confidence },
  };
}

function repairAnswers() {
  return {
    done: { type: "noul", noul: 0.1 },
    failure_class: { type: "choice", choice: "implementation" },
    same_executor_can_repair: { type: "noul", noul: 0.8 },
    next_action: { type: "choice", choice: "repair-same", confidence: 0.7 },
  };
}

/** Fake runtime + fake decisions que registram a ordem dos efeitos. */
function fakeDeps(over = {}) {
  const effects = [];
  const runtime = {
    createWorker: async (input) => {
      effects.push("create");
      if (over.createError) throw over.createError;
      return { sessionID: "w1" };
    },
    prompt: async () => { effects.push("prompt"); },
    wait: async () => {
      effects.push("wait");
      if (over.waitBlocks) return await new Promise(() => {});
    },
    get: async () => {
      effects.push("get");
      return over.view ?? { agent: "build", model: "opencode/big-pickle", outcome: "succeeded" };
    },
    context: async () => {
      effects.push("context");
      return over.messages ?? [{ type: "assistant", content: [{ type: "text", text: "ORCHESTRATION_WORKER_OK" }] }];
    },
    interrupt: async () => { effects.push("interrupt"); },
    ...over.runtime,
  };
  const decisions = {
    selectExecutor: async () => {
      effects.push("select");
      if (over.selectError) throw over.selectError;
      return over.selection ?? { agent: "build", model: "opencode/big-pickle", via: "jev", route: "fast-coding", confidence: 0.9 };
    },
    judgeRound: async () => {
      effects.push("judge");
      return over.judgeAnswers ?? acceptAnswers();
    },
    ...over.decisions,
  };
  return { runtime, decisions, effects };
}

describe("runOrchestrationOnce: dispatcher runtime real (fake runtime + fake Jev)", () => {
  it("O1: happy path -> completed, round 1, worker criado UMA vez, judge UMA vez", async () => {
    const t = fakeDeps();
    const result = await runOrchestrationOnce(contract(), {
      runtime: t.runtime,
      decisions: t.decisions,
      location: { directory: "/proj" },
    });
    assert.equal(result.phase, "completed");
    assert.equal(result.round, 1);
    assert.equal(result.worker.sessionID, "w1");
    assert.equal(result.worker.finalText, "ORCHESTRATION_WORKER_OK");
    assert.equal(result.selection.via, "jev");
    assert.equal(result.verdict.nextAction, "accept");
    assert.deepEqual(result.pendingCommands, []);
    assert.equal(t.effects.filter((e) => e === "create").length, 1, "uma unica worker session");
    assert.equal(t.effects.filter((e) => e === "judge").length, 1, "uma unica rodada de julgamento");
  });

  it("O2: ordem dos efeitos = select, create, prompt, wait, get, context, judge", async () => {
    const t = fakeDeps();
    await runOrchestrationOnce(contract(), { runtime: t.runtime, decisions: t.decisions });
    assert.deepEqual(t.effects, ["select", "create", "prompt", "wait", "get", "context", "judge"]);
  });

  it("O3: worker criado com agent/model/location/metadata da selecao", async () => {
    let created;
    const t = fakeDeps({
      runtime: {
        createWorker: async (input) => {
          created = input;
          return { sessionID: "w1" };
        },
      },
    });
    const result = await runOrchestrationOnce(contract(), {
      runtime: t.runtime,
      decisions: t.decisions,
      location: { directory: "/proj/sub" },
    });
    assert.equal(result.phase, "completed");
    assert.equal(created.agent, "build");
    assert.deepEqual(created.model, { providerID: "opencode", id: "big-pickle" });
    assert.deepEqual(created.location, { directory: "/proj/sub" });
    assert.equal(created.metadata["jev-orchestration"], true);
    assert.equal(created.metadata["jev-run-id"], "test-run-1");
    assert.equal(created.metadata["jev-round"], 1);
    assert.equal(created.metadata["jev-role"], "worker");
  });

  it("O4: evidence usa executor REAL da sessao (session.get devolve M2)", async () => {
    const t = fakeDeps({
      view: { agent: "build", model: "opencode/mimo-v2.5-free", outcome: "succeeded" },
    });
    const result = await runOrchestrationOnce(contract(), { runtime: t.runtime, decisions: t.decisions });
    assert.equal(result.selection.model, "opencode/big-pickle", "selecao original era M1");
    assert.equal(result.evidence.executor.model, "opencode/mimo-v2.5-free", "evidence carrega M2");
    assert.equal(result.worker.model, "opencode/mimo-v2.5-free");
    assert.equal(result.evidence.executor.agent, "build");
  });

  it("O5: checkpoint persistencia (worker-created, evidence-ready, verdict-applied)", async () => {
    const kinds = [];
    const persist = async ({ kind, runID, state, workerSessionID, at }) => {
      kinds.push({ kind, runID, phase: state.phase, workerSessionID, at });
    };
    const now = () => 12345;
    const t = fakeDeps();
    const result = await runOrchestrationOnce(contract(), {
      runtime: t.runtime,
      decisions: t.decisions,
      persist,
      now,
    });
    assert.equal(result.phase, "completed");
    assert.deepEqual(
      kinds.map((k) => k.kind),
      ["worker-created", "evidence-ready", "verdict-applied"],
    );
    assert.ok(kinds.every((k) => k.runID === "test-run-1" && k.at === 12345));
    assert.equal(kinds[0].workerSessionID, "w1");
  });

  it("O6: persistence falha nao corrompe a execucao (best-effort)", async () => {
    const t = fakeDeps();
    const result = await runOrchestrationOnce(contract(), {
      runtime: t.runtime,
      decisions: t.decisions,
      persist: async () => { throw new Error("storage down"); },
    });
    assert.equal(result.phase, "completed", "storage falha nao pode quebrar o kernel");
  });
});

describe("runOrchestrationOnce: failed worker / verdicts nao-accept / timeout / guards", () => {
  it("P1: worker failed -> evidence checks fail e ainda assim entregue ao Jev", async () => {
    let judgeSeen = null;
    const t = fakeDeps({
      view: { agent: "build", model: "opencode/big-pickle", outcome: "failed" },
      messages: [{ type: "assistant", content: [{ type: "reasoning", text: "pensou" }] }],
      decisions: {
        judgeRound: async (input) => {
          judgeSeen = input.state;
          return acceptAnswers();
        },
      },
    });
    const result = await runOrchestrationOnce(contract(), { runtime: t.runtime, decisions: t.decisions });
    assert.equal(result.evidence.outcome, "failed");
    assert.equal(result.evidence.deterministicChecks[0].name, "worker-session-outcome");
    assert.equal(result.evidence.deterministicChecks[0].status, "fail");
    assert.equal(result.evidence.deterministicChecks[1].name, "worker-final-response");
    assert.equal(result.evidence.deterministicChecks[1].status, "fail");
    assert.ok(judgeSeen !== null, "evidence entregue ao Jev (nenhuma rejeicao local)");
    // Gate deterministico (Blocker A): hard deterministic failure NUNCA e
    // aprovado por veredito accept. O Jev recebeu a evidencia e classificou,
    // mas o kernel rejeita a combinacao accept + deterministicChecks fail.
    assert.notEqual(result.phase, "completed");
    assert.equal(result.phase, "failed");
    assert.ok(result.error && result.error.includes("hard failure"), "erro bounded do gate deterministico");
  });

  it("P2: verdict repair-same -> phase repairing, pendingCommands=[repair-same], SEM segunda worker", async () => {
    const t = fakeDeps({ judgeAnswers: repairAnswers() });
    const result = await runOrchestrationOnce(contract({ maxRounds: 2 }), {
      runtime: t.runtime,
      decisions: t.decisions,
    });
    assert.equal(result.phase, "repairing");
    assert.deepEqual(result.pendingCommands, ["repair-same"]);
    assert.equal(result.verdict.nextAction, "repair-same");
    assert.equal(t.effects.filter((e) => e === "create").length, 1, "proxima rodada NAO executada neste slice");
  });

  it("P3: timeout do wait -> interrupt chamado, sem loop, resultado nao completed", async () => {
    const t = fakeDeps({ waitBlocks: true });
    const result = await runOrchestrationOnce(contract(), {
      runtime: t.runtime,
      decisions: t.decisions,
      workerTimeoutMs: 30,
    });
    assert.ok(t.effects.includes("interrupt"), "interrupt deve ser chamado best-effort");
    assert.notEqual(result.phase, "completed");
    assert.equal(result.round, 1);
    assert.ok(result.error && result.error.length > 0, "erro bounded presente");
    assert.equal(t.effects.filter((e) => e === "create").length, 1, "nenhum loop de nova sessao");
  });

  it("P4: createWorker falha -> phase failed, judge nunca chamado", async () => {
    const t = fakeDeps({ createError: new Error("session.create quebrou") });
    const result = await runOrchestrationOnce(contract(), { runtime: t.runtime, decisions: t.decisions });
    assert.equal(result.phase, "failed");
    assert.ok(result.error.includes("session.create"), "erro bounded preservado");
    assert.ok(!t.effects.includes("judge"));
  });

  it("P5: selecao com modelo fora do FREE_POOL falha ANTES de criar worker", async () => {
    const t = fakeDeps({
      selection: { agent: "build", model: "openai/gpt-4o", via: "jev", route: "fast-coding", confidence: 0.9 },
    });
    const result = await runOrchestrationOnce(contract(), { runtime: t.runtime, decisions: t.decisions });
    assert.equal(result.phase, "failed");
    assert.ok(result.error.includes("FREE_POOL"), "guardrail FREE_POOL na validacao");
    assert.ok(!t.effects.includes("create"), "worker NUNCA criado com modelo invalido");
  });

  it("P6: selecao com agent vazio falha antes de criar worker", async () => {
    const t = fakeDeps({
      selection: { agent: "", model: "opencode/big-pickle", via: "jev", route: "fast-coding", confidence: 0.9 },
    });
    const result = await runOrchestrationOnce(contract(), { runtime: t.runtime, decisions: t.decisions });
    assert.equal(result.phase, "failed");
    assert.ok(!t.effects.includes("create"));
  });

  it("P7: contrato invalido -> failed, nenhum efeito", async () => {
    const t = fakeDeps();
    const result = await runOrchestrationOnce(
      { runID: "x", objective: "", scope: {}, constraints: [], acceptanceCriteria: [], requiredEvidence: [], maxRounds: 1 },
      { runtime: t.runtime, decisions: t.decisions },
    );
    assert.equal(result.phase, "failed");
    assert.ok(result.error.includes("invalido") || result.error.includes("contract"));
    assert.equal(t.effects.length, 0);
  });
});

// ─────────────────────────── MR. gate deterministico no runtime (Blocker A) ───────────────────────────

describe("runOrchestrationOnce: gate deterministico de evidencia (Blocker A)", () => {
  it("MR1: worker failed + Jev accept -> NUNCA completed; evidence entregue ao Jev; erro bounded", async () => {
    let judgeSeen = null;
    const t = fakeDeps({
      view: { agent: "build", model: "opencode/big-pickle", outcome: "failed" },
      messages: [{ type: "assistant", content: [{ type: "reasoning", text: "pensou" }] }],
      decisions: {
        judgeRound: async (input) => {
          judgeSeen = input.state;
          return acceptAnswers();
        },
      },
    });
    const result = await runOrchestrationOnce(contract(), { runtime: t.runtime, decisions: t.decisions });
    assert.ok(judgeSeen !== null, "evidence negativa ainda chega ao Jev (nenhuma rejeicao local antes do julgamento)");
    assert.equal(result.evidence.outcome, "failed");
    assert.equal(result.evidence.deterministicChecks[0].status, "fail");
    assert.notEqual(result.phase, "completed", "hard failure + accept NAO pode fechar em completed");
    assert.equal(result.phase, "failed");
    assert.ok(result.error && result.error.includes("hard failure"), "erro bounded descritivo");
    assert.equal(t.effects.filter((e) => e === "create").length, 1, "uma unica session (sem loop)");
  });

  it("MR2: resposta final vazia + Jev accept -> NUNCA completed", async () => {
    const t = fakeDeps({
      messages: [{ type: "assistant", content: [{ type: "reasoning", text: "so raciocinio, sem texto final" }] }],
    });
    const result = await runOrchestrationOnce(contract(), { runtime: t.runtime, decisions: t.decisions });
    assert.equal(result.worker.finalText, "", "resposta final vazia");
    const finalCheck = result.evidence.deterministicChecks.find((ck) => ck.name === "worker-final-response");
    assert.equal(finalCheck.status, "fail");
    assert.notEqual(result.phase, "completed");
    assert.equal(result.phase, "failed");
  });

  it("MR3: evidence verde + Jev accept -> completed (happy path preservado)", async () => {
    const t = fakeDeps();
    const result = await runOrchestrationOnce(contract(), { runtime: t.runtime, decisions: t.decisions });
    assert.equal(result.evidence.deterministicChecks[0].status, "pass");
    assert.equal(result.evidence.deterministicChecks[1].status, "pass");
    assert.equal(result.phase, "completed");
    assert.deepEqual(result.pendingCommands, []);
  });
});

// ─────────────────────────── Q. tool orchestrate_once (schema + exec) ───────────────────────────

describe("tool orchestrate_once (schema, Code Mode, execucao real)", () => {
  it("Q1: ferramenta existe em tools.jev com namespace jev + codemode e NAO cria global jev_orchestrate_once", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const tool = m.tools.orchestrate_once;
    assert.ok(tool, "tool orchestrate_once deve existir");
    assert.equal(tool.options.namespace, "jev");
    assert.equal(tool.options.codemode, true);
    assert.equal(m.tools["jev_orchestrate_once"], undefined, "nunca tool global com underscore");
  });

  it("Q2: schema estrutural do contract (runID/objective/scope/constraints/criteria/evidence/maxRounds)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const input = m.tools.orchestrate_once.input;
    assert.deepEqual(input.required, ["contract"]);
    assert.equal(input.additionalProperties, false);
    const c = input.properties.contract;
    assert.ok(c.properties.runID && c.properties.objective, "runID/objective estruturais");
    assert.ok(c.properties.scope.properties.include && c.properties.scope.properties.exclude, "scope.include/exclude");
    assert.ok(c.properties.constraints && c.properties.acceptanceCriteria && c.properties.requiredEvidence);
    assert.equal(c.properties.maxRounds.type, "integer");
    assert.equal(c.properties.maxRounds.minimum, 1);
    assert.ok(c.required.includes("runID"));
    assert.ok(c.required.includes("acceptanceCriteria"));
    assert.equal(c.additionalProperties, false);
  });

  it("Q3: contrato invalido rejeitado LOCALMENTE (sem Jev, sem worker)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => { throw new Error("nao deveria alcancar o endpoint"); });
    try {
      const res = await m.tools.orchestrate_once.execute({
        contract: { runID: "x", objective: "o", scope: {}, constraints: [], acceptanceCriteria: [], requiredEvidence: [], maxRounds: 1 },
      });
      assert.ok(res.content.includes("invalido") || res.content.includes("invalid"), "erro local descritivo");
      assert.equal(stub.calls.length, 0, "nenhuma chamada ao Jev");
      assert.equal(m.workerCalls.create.length, 0, "nenhum worker criado");
    } finally {
      stub.restore();
    }
  });

  it("Q4: execucao real -> completed, selection.via=jev, resultado bounded sem contexto bruto", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle", confidence: 0.9 }));
      }
      return okJev(acceptAnswers());
    });
    try {
      const res = await m.tools.orchestrate_once.execute({
        contract: {
          runID: "tool-test-run",
          objective: "Respond exactly with ORCHESTRATION_WORKER_OK and nothing else.",
          scope: { include: [], exclude: [] },
          constraints: ["Do not modify files."],
          acceptanceCriteria: ["The worker final response is exactly ORCHESTRATION_WORKER_OK."],
          requiredEvidence: ["worker-session-outcome", "worker-final-response"],
          maxRounds: 1,
        },
      });
      const out = JSON.parse(res.content);
      assert.equal(out.phase, "completed");
      assert.equal(out.round, 1);
      assert.equal(out.selection.via, "jev");
      assert.ok(isFreeModel(out.selection.model));
      assert.equal(out.worker.finalText, "ORCHESTRATION_WORKER_OK");
      assert.equal(out.evidence.outcome, "succeeded");
      assert.equal(out.evidence.deterministicChecks[0].status, "pass");
      assert.equal(out.evidence.criticFindings.length, 0);
      assert.equal(out.verdict.nextAction, "accept");
      assert.deepEqual(out.pendingCommands, []);
      assert.equal(out.worker.messages, undefined, "context completo jamais no output");
      assert.equal(out.evidence.messages, undefined);
      assert.ok(!JSON.stringify(out).includes("wmsg-"), "mensagens nao vazam");
      // persistencia minima bounded
      const stored = m.storage._map.get("orchestration/run/tool-test-run");
      assert.ok(stored, "orchestration/run/<runID> persistido");
      assert.equal(stored.workerSessionID, out.worker.sessionID);
      assert.ok(stored.state && stored.state.contract, "RunState completo persistido em state");
      assert.ok(stored.updatedAt > 0);
      assert.equal(stored.state.phase, "completed");
    } finally {
      stub.restore();
    }
  });

  it("Q5: tool cria worker session REAL distinta (agent/model/location/metadata)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
      location: "/proj",
    });
    const stub = stubFetch(async ({ body }) => {
      if (body?.questions?.route) return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle", confidence: 0.9 }));
      return okJev(acceptAnswers());
    });
    try {
      const res = await m.tools.orchestrate_once.execute({
        contract: {
          runID: "tool-test-worker",
          objective: "Do it.",
          scope: { include: [], exclude: [] },
          constraints: [],
          acceptanceCriteria: ["done"],
          requiredEvidence: ["worker-session-outcome"],
          maxRounds: 1,
        },
      });
      const out = JSON.parse(res.content);
      assert.equal(m.workerCalls.create.length, 1);
      const created = m.workerCalls.create[0];
      assert.equal(created.agent, "build");
      assert.deepEqual(created.model, { providerID: "opencode", id: "big-pickle" });
      assert.deepEqual(created.location, { directory: "/proj" });
      assert.equal(created.metadata["jev-orchestration"], true);
      assert.equal(created.metadata["jev-role"], "worker");
      assert.equal(created.metadata["jev-run-id"], "tool-test-worker");
      const info = m.workerSessions.get(out.worker.sessionID);
      assert.ok(info, "sessao worker registrada no runtime");
      assert.equal(info.agent, "build");
      assert.equal(info.model.id, "big-pickle");
    } finally {
      stub.restore();
    }
  });
});

// ─────────────────────────── QB. guardrail pos-fallback (Blocker B) ───────────────────────────

describe("tool orchestrate_once: selecao pos-fallback nunca escapa do catalogo runtime (Blocker B)", () => {
  it("QB1: catalogo restrito + Jev indisponivel -> NENHUM worker com modelo fora do catalogo", async () => {
    const m = await bootCtx({
      models: ["opencode/nemotron-3.5-lightning-free"],
      agents: ["build", "plan"],
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => {
      throw new Error("network down");
    });
    try {
      const res = await m.tools.orchestrate_once.execute({
        contract: {
          runID: "blocker-qb1",
          objective: "Refatorar a arquitetura do sistema de autenticacao",
          scope: { include: [], exclude: [] },
          constraints: [],
          acceptanceCriteria: ["done"],
          requiredEvidence: ["worker-session-outcome", "worker-final-response"],
          maxRounds: 1,
        },
      });
      const out = JSON.parse(res.content);
      assert.equal(m.workerCalls.create.length, 0, "worker NUNCA criado com modelo fora do catalogo runtime");
      assert.equal(out.phase, "failed");
      assert.equal(out.worker, undefined, "sem worker no output");
      assert.ok(out.error && out.error.includes("elegivel"), "selecao rejeitada bounded antes do createWorker");
    } finally {
      stub.restore();
    }
  });

  it("QB2: agents reais sem build/plan + Jev indisponivel -> NENHUM worker com build/plan", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      agents: ["general"],
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => {
      throw new Error("network down");
    });
    try {
      const res = await m.tools.orchestrate_once.execute({
        contract: {
          runID: "blocker-qb2",
          objective: "Implementar o modulo de autenticacao",
          scope: { include: [], exclude: [] },
          constraints: [],
          acceptanceCriteria: ["done"],
          requiredEvidence: ["worker-session-outcome", "worker-final-response"],
          maxRounds: 1,
        },
      });
      const out = JSON.parse(res.content);
      assert.equal(m.workerCalls.create.length, 0, "worker NUNCA criado com agente inexistente no catalogo");
      assert.equal(out.phase, "failed");
      assert.ok(
        out.error && out.error.includes("agente selecionado") && out.error.includes("catalogo runtime"),
        "rejeicao bounded do agente antes do createWorker",
      );
    } finally {
      stub.restore();
    }
  });

  it("QB3: catalogo restrito + via=jev com modelo/agente elegiveis -> completed (guard nao over-block)", async () => {
    const m = await bootCtx({
      models: ["opencode/nemotron-3.5-lightning-free"],
      agents: ["build", "plan"],
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/nemotron-3.5-lightning-free", confidence: 0.9 }));
      }
      return okJev(acceptAnswers());
    });
    try {
      const res = await m.tools.orchestrate_once.execute({
        contract: {
          runID: "blocker-qb3",
          objective: "Implementar o modulo de autenticacao",
          scope: { include: [], exclude: [] },
          constraints: [],
          acceptanceCriteria: ["done"],
          requiredEvidence: ["worker-session-outcome", "worker-final-response"],
          maxRounds: 1,
        },
      });
      const out = JSON.parse(res.content);
      assert.equal(out.phase, "completed");
      assert.equal(out.selection.model, "opencode/nemotron-3.5-lightning-free");
      assert.equal(m.workerCalls.create.length, 1);
      assert.deepEqual(m.workerCalls.create[0].model, { providerID: "opencode", id: "nemotron-3.5-lightning-free" });
    } finally {
      stub.restore();
    }
  });
});

// ─────────────────────────── R. prompt hook: bypass do worker interno ───────────────────────────

describe("prompt hook: worker interno NAO sofre auto-routing recursivo", () => {
  it("R1: prompt com metadata de worker interno -> sem decideRoute, sem switch, marcado orchestration-internal", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => { throw new Error("nao deveria chamar o Jev"); });
    try {
      const ev = {
        sessionID: "w1",
        messageID: "m1",
        prompt: { text: "execute contrato", metadata: { "jev-router": "orchestration-internal", "jev-role": "worker" } },
        metadata: {},
        delivery: {},
      };
      await m.hooks.session.prompt(ev);
      assert.equal(ev.metadata["jev-router"], "orchestration-internal");
      assert.equal(ev.metadata["jev-role"], "worker");
      assert.equal(stub.calls.length, 0, "decideRoute NAO chamado");
      assert.equal(m.calls.switchModel.length, 0, "switchModel NAO chamado");
      assert.equal(m.calls.switchAgent.length, 0, "switchAgent NAO chamado");
    } finally {
      stub.restore();
    }
  });

  it("R2: sessao worker detectada por session metadata (sem prompt metadata) tambem escapa", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const info = await m.ctx.session.create({
      agent: "build",
      model: { providerID: "opencode", id: "big-pickle" },
      metadata: { "jev-orchestration": true, "jev-run-id": "r2", "jev-round": 1, "jev-role": "worker", "jev-router": "orchestration-internal" },
    });
    const stub = stubFetch(async () => { throw new Error("nao deveria chamar o Jev"); });
    try {
      const ev = { sessionID: info.id, messageID: "m1", prompt: { text: "execute" }, metadata: {}, delivery: {} };
      await m.hooks.session.prompt(ev);
      assert.equal(ev.metadata["jev-router"], "orchestration-internal");
      assert.equal(stub.calls.length, 0);
      assert.equal(m.calls.switchModel.length, 0);
      assert.equal(m.calls.switchAgent.length, 0);
    } finally {
      stub.restore();
    }
  });

  it("R3: sessao normal continua roteando pelo Jev (switch aplicado)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () =>
      okJev(routeAnswers({ route: "heavy-reasoning", agent: "plan", model: "opencode/muse-spark-1.3-contributor-free", confidence: 0.9, complexity: 2 })),
    );
    try {
      const ev = { sessionID: "s1", messageID: "m1", prompt: { text: "arquitetar sistema distribuido complexo" }, metadata: {}, delivery: {} };
      await m.hooks.session.prompt(ev);
      assert.equal(ev.metadata["jev-router"], "routed");
      assert.equal(m.calls.switchModel.length, 1, "sessao normal continua com switch");
      assert.equal(m.getState().model.id, "muse-spark-1.3-contributor-free");
      assert.equal(m.getState().agent, "plan");
    } finally {
      stub.restore();
    }
  });
});

// ─────────────────────────── S. context hook: instrucao de worker ───────────────────────────

describe("context hook: worker recebe instrucao de trabalhador, normal preservada", () => {
  it("S1: worker session recebe buildWorkerContextInstruction (sem decision boundaries)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const info = await m.ctx.session.create({
      agent: "build",
      model: { providerID: "opencode", id: "big-pickle" },
      metadata: { "jev-orchestration": true, "jev-run-id": "s1", "jev-round": 1, "jev-role": "worker", "jev-router": "orchestration-internal" },
    });
    const ev = { sessionID: info.id, agent: "build", model: { providerID: "opencode", id: "big-pickle" }, system: [], messages: [], tools: {}, options: {} };
    await m.hooks.session.context(ev);
    assert.equal(ev.system.length, 1);
    const text = ev.system[0].text;
    assert.ok(text.includes("ONLY the ExecutionContract"), "instrucao de worker");
    assert.ok(!text.includes("decision boundaries"), "NAO e a instrucao de orchestrator");
    assert.ok(!text.includes("tools.jev.decide"), "worker nao deve ser incentivado a chamar o Jev");
  });

  it("S2: sessao normal mantem a instrucao atual (decision boundaries + pending recovery)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({ "pending-recovery/s1": { action: "retry", tool: "shell", errorClass: "boom", repeats: 2, at: 1 } }),
      options: PLUGIN_OPTS,
    });
    const ev = { sessionID: "s1", agent: "build", model: { providerID: "opencode", id: "big-pickle" }, system: [], messages: [], tools: {}, options: {} };
    await m.hooks.session.context(ev);
    assert.equal(ev.system.length, 2, "instrucao + recomendacao one-shot");
    const text = ev.system[0].text;
    assert.ok(text.includes("decision boundaries"), "instrucao normal preservada");
    assert.ok(text.includes("tools.jev.decide"));
    assert.ok(text.length < 900);
    assert.ok(ev.system[1].text.includes("retry"), "pending-recovery continua funcionando");
  });
});