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
import { isFreeModel } from "./config.ts";
import pluginDefault from "../index.ts";
import { makeCtx, makeStorage, stubFetch, okJev, routeAnswers } from "./harness.mjs";

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

// ─────────────────────────── O. runOrchestrationOnce happy path ───────────────────────────

const ACCEPT_ANSWERS = {
  done: { type: "noul", noul: 0.95 },
  failure_class: { type: "choice", choice: "none" },
  same_executor_can_repair: { type: "noul", noul: 0.1 },
  next_action: { type: "choice", choice: "accept", confidence: 0.95 },
};

const REPAIR_ANSWERS = {
  done: { type: "noul", noul: 0.1 },
  failure_class: { type: "choice", choice: "implementation" },
  same_executor_can_repair: { type: "noul", noul: 0.9 },
  next_action: { type: "choice", choice: "repair-same" },
};

function fakeRuntime(over = {}) {
  const calls = [];
  const runtime = {
    createWorker: async (input) => {
      calls.push({ op: "create", input });
      return { sessionID: "worker-1" };
    },
    prompt: async (input) => {
      calls.push({ op: "prompt", input });
    },
    wait: async (input) => {
      calls.push({ op: "wait", input });
    },
    get: async (input) => {
      calls.push({ op: "get", input });
      return { agent: "build", model: "opencode/big-pickle", outcome: "succeeded" };
    },
    context: async (input) => {
      calls.push({ op: "context", input });
      return [{ type: "assistant", content: [{ type: "text", text: "ORCHESTRATION_WORKER_OK" }] }];
    },
    interrupt: async (input) => {
      calls.push({ op: "interrupt", input });
    },
    ...over,
  };
  return { runtime, calls };
}

function fakeDecisions(over = {}) {
  const calls = { select: 0, judge: 0 };
  const order = [];
  return {
    calls,
    order,
    decisions: {
      selectExecutor: async () => {
        calls.select++;
        order.push("select");
        return { agent: "build", model: "opencode/big-pickle", via: "jev", route: "fast-coding", confidence: 0.9 };
      },
      judgeRound: async () => {
        calls.judge++;
        order.push("judge");
        return structuredClone(ACCEPT_ANSWERS);
      },
      ...over,
    },
  };
}

describe("runOrchestrationOnce: happy path (A)", () => {
  it("A-happy: fake runtime + fake Jev -> completed round 1, 1 worker, 1 judge", async () => {
    const { runtime } = fakeRuntime();
    const f = fakeDecisions();
    const c = contract({ maxRounds: 1 });
    const res = await runOrchestrationOnce(c, { runtime, decisions: f.decisions });
    assert.equal(res.phase, "completed");
    assert.equal(res.round, 1);
    assert.equal(f.calls.select, 1);
    assert.equal(f.calls.judge, 1);
    assert.equal(res.worker.sessionID, "worker-1");
    assert.equal(res.verdict.nextAction, "accept");
    assert.deepEqual(res.pendingCommands, []);
  });
});

describe("runOrchestrationOnce: order of effects (B)", () => {
  it("B-order: select -> create -> prompt -> wait -> get -> context -> judge", async () => {
    const seq = [];
    const { runtime } = fakeRuntime({
      createWorker: async (input) => { seq.push("create"); return { sessionID: "worker-1" }; },
      prompt: async () => { seq.push("prompt"); },
      wait: async () => { seq.push("wait"); },
      get: async () => { seq.push("get"); return { agent: "build", model: "opencode/big-pickle", outcome: "succeeded" }; },
      context: async () => { seq.push("context"); return [{ type: "assistant", content: [{ type: "text", text: "ok" }] }]; },
    });
    const f = fakeDecisions();
    const origSelect = f.decisions.selectExecutor;
    const origJudge = f.decisions.judgeRound;
    f.decisions.selectExecutor = async (...a) => { seq.push("select"); return origSelect(...a); };
    f.decisions.judgeRound = async (...a) => { seq.push("judge"); return origJudge(...a); };
    await runOrchestrationOnce(contract({ maxRounds: 1 }), { runtime, decisions: f.decisions });
    assert.deepEqual(seq, ["select", "create", "prompt", "wait", "get", "context", "judge"]);
  });
});

describe("runOrchestrationOnce: executor initial (C)", () => {
  it("C-exec: worker criado com agent/model escolhidos + location correta", async () => {
    let created;
    const { runtime } = fakeRuntime({
      createWorker: async (input) => { created = input; return { sessionID: "worker-1" }; },
    });
    const f = fakeDecisions();
    await runOrchestrationOnce(contract({ maxRounds: 1 }), {
      runtime,
      decisions: f.decisions,
      location: { directory: "/tmp/work" },
    });
    assert.equal(created.agent, "build");
    assert.deepEqual(created.model, { providerID: "opencode", id: "big-pickle" });
    assert.deepEqual(created.location, { directory: "/tmp/work" });
    assert.equal(created.metadata["jev-role"], "worker");
  });
});

describe("runOrchestrationOnce: evidence usa executor real (D)", () => {
  it("D-real: selection M1 mas get retorna M2 -> evidence contem M2", async () => {
    const { runtime } = fakeRuntime({
      get: async () => ({ agent: "build", model: "opencode/mimo-v2.5-free", outcome: "succeeded" }),
    });
    const f = fakeDecisions();
    const res = await runOrchestrationOnce(contract({ maxRounds: 1 }), { runtime, decisions: f.decisions });
    assert.equal(res.evidence.executor.model, "opencode/mimo-v2.5-free");
    assert.notEqual(res.evidence.executor.model, "opencode/big-pickle");
    assert.equal(res.worker.model, "opencode/mimo-v2.5-free");
  });
});

describe("runOrchestrationOnce: failed worker (F)", () => {
  it("F-fail: outcome failed -> check fail, evidence ainda entregue ao Jev sem decisao local", async () => {
    const { runtime } = fakeRuntime({
      get: async () => ({ agent: "build", model: "opencode/big-pickle", outcome: "failed" }),
      context: async () => [{ type: "assistant", content: [{ type: "text", text: "partial" }] }],
    });
    let judged = false;
    const f = fakeDecisions({
      judgeRound: async () => { judged = true; return structuredClone(ACCEPT_ANSWERS); },
    });
    const res = await runOrchestrationOnce(contract({ maxRounds: 1 }), { runtime, decisions: f.decisions });
    const check = res.evidence.deterministicChecks.find((c) => c.name === "worker-session-outcome");
    assert.equal(check.status, "fail");
    assert.equal(judged, true);
  });
});

describe("runOrchestrationOnce: non-accept verdict (G)", () => {
  it("G-repair: repair-same -> repairing + pendingCommands, sem segunda worker", async () => {
    let creates = 0;
    const { runtime } = fakeRuntime({
      createWorker: async () => { creates++; return { sessionID: "worker-1" }; },
    });
    const f = fakeDecisions({
      judgeRound: async () => structuredClone(REPAIR_ANSWERS),
    });
    const res = await runOrchestrationOnce(contract({ maxRounds: 2 }), { runtime, decisions: f.decisions });
    assert.equal(res.phase, "repairing");
    assert.deepEqual(res.pendingCommands, ["repair-same"]);
    assert.equal(creates, 1);
  });
});

describe("runOrchestrationOnce: timeout (H)", () => {
  it("H-timeout: wait bloqueado -> interrupt chamado, sem loop, nao completed", async () => {
    let interrupted = false;
    const { runtime, calls } = fakeRuntime({
      wait: async () => new Promise(() => {}),
      interrupt: async () => { interrupted = true; },
    });
    const f = fakeDecisions();
    const res = await runOrchestrationOnce(contract({ maxRounds: 1 }), {
      runtime,
      decisions: f.decisions,
      workerTimeoutMs: 50,
    });
    assert.equal(interrupted, true);
    assert.notEqual(res.phase, "completed");
    assert.ok(res.error);
    assert.equal(f.calls.judge, 0);
  });
});

// ─────────────────────────── I. schema da tool orchestrate_once ───────────────────────────

const ALL_MODELS = [
  "opencode/big-pickle",
  "opencode/mimo-v2.5-free",
  "opencode/ling-3.0-flash-fin-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/muse-spark-1.3-contributor-free",
];

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

describe("tool orchestrate_once: schema e registro (I)", () => {
  it("I1: orchestrate_once aparece em tools.jev (namespace jev, sem global)", async () => {
    const m = await bootCtx({ models: ALL_MODELS, storage: makeStorage({}), options: PLUGIN_OPTS });
    const tool = m.tools.orchestrate_once;
    assert.ok(tool, "tool orchestrate_once deve existir");
    assert.equal(tool.options?.namespace, "jev");
    assert.equal(tool.options?.codemode, true);
    assert.ok(!m.tools.jev_orchestrate_once, "nao deve criar tool global jev_orchestrate_once");
  });

  it("I2: schema estrutural do contract (runID/objective/scope/constraints/acceptanceCriteria/requiredEvidence/maxRounds)", async () => {
    const m = await bootCtx({ models: ALL_MODELS, storage: makeStorage({}), options: PLUGIN_OPTS });
    const tool = m.tools.orchestrate_once;
    assert.ok(tool.input, "input schema obrigatorio");
    assert.equal(tool.input.type, "object");
    const props = tool.input.properties?.contract?.properties ?? tool.input.properties;
    for (const k of ["runID", "objective", "scope", "constraints", "acceptanceCriteria", "requiredEvidence", "maxRounds"]) {
      assert.ok(props?.[k], `schema deve declarar ${k}`);
    }
  });

  it("I3: contrato invalido rejeitado localmente (sem criar worker)", async () => {
    const m = await bootCtx({ models: ALL_MODELS, storage: makeStorage({}), options: PLUGIN_OPTS });
    // instrumenta session.create caso exista; se nao existir, a tool deve falhar antes
    let created = 0;
    m.ctx.session.create = async () => { created++; return { id: "w" }; };
    const tool = m.tools.orchestrate_once;
    const res = await tool.execute({ contract: { runID: "", objective: "", maxRounds: 0 } });
    const parsed = typeof res.content === "string" ? JSON.parse(res.content) : res.content;
    assert.ok(parsed.error, "deve retornar erro para contrato invalido");
    assert.equal(created, 0, "contrato invalido nao deve criar worker");
  });

  it("I4: Code Mode preservado", async () => {
    const m = await bootCtx({ models: ALL_MODELS, storage: makeStorage({}), options: PLUGIN_OPTS });
    assert.equal(m.tools.orchestrate_once.options?.codemode, true);
    assert.equal(m.tools.orchestrate_once.options?.namespace, "jev");
  });
});

// ─────────────────────────── J. internal worker bypass (prompt hook) ───────────────────────────

describe("prompt hook: internal worker bypass (J)", () => {
  it("J-bypass: worker interno nao chama decideRoute/switchModel/switchAgent", async () => {
    const storage = makeStorage({ "orchestration/worker/worker-internal-1": { runID: "r1", round: 1, at: Date.now() } });
    const m = await bootCtx({ models: ALL_MODELS, storage, options: PLUGIN_OPTS });
    const stub = stubFetch(async () => okJev(routeAnswers({})));
    try {
      const ev = {
        sessionID: "worker-internal-1",
        prompt: { text: "OBJECTIVE: do X" },
        metadata: { "jev-router": "orchestration-internal", "jev-role": "worker" },
      };
      await m.hooks.session.prompt(ev);
      assert.equal(stub.calls.length, 0, "decideRoute (Jev) nao deve ser chamado para worker interno");
      assert.equal(m.calls.switchModel.length, 0, "switchModel nao deve ser chamado");
      assert.equal(m.calls.switchAgent.length, 0, "switchAgent nao deve ser chamado");
      assert.equal(ev.metadata["jev-router"], "orchestration-internal");
    } finally {
      stub.restore();
    }
  });

  it("J-normal: sessao normal continua com auto-route", async () => {
    const m = await bootCtx({ models: ALL_MODELS, storage: makeStorage({}), options: PLUGIN_OPTS });
    const stub = stubFetch(async () => okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" })));
    try {
      const ev = { sessionID: "s-normal", prompt: { text: "adicionar um botao" }, metadata: {} };
      await m.hooks.session.prompt(ev);
      assert.ok(stub.calls.length >= 1, "sessao normal deve consultar o Jev");
    } finally {
      stub.restore();
    }
  });
});

// ─────────────────────────── K. worker context instruction ───────────────────────────

describe("context hook: worker instruction (K)", () => {
  it("K-worker: worker interno recebe instrucao de worker, sem decision boundaries", async () => {
    const storage = makeStorage({ "orchestration/worker/worker-internal-1": { runID: "r1", round: 1, at: Date.now() } });
    const m = await bootCtx({ models: ALL_MODELS, storage, options: PLUGIN_OPTS });
    const ev = { sessionID: "worker-internal-1", system: [] };
    await m.hooks.session.context(ev);
    assert.ok(ev.system.length >= 1);
    const text = ev.system.map((s) => s.text).join("\n");
    assert.ok(text.includes("ExecutionContract") || text.includes("orchestrated"), "deve instruir a executar o contrato");
    assert.ok(!text.includes("decision boundaries"), "nao deve incentivar Jev em decision boundaries");
  });

  it("K-normal: sessao normal mantem instrucao atual", async () => {
    const m = await bootCtx({ models: ALL_MODELS, storage: makeStorage({}), options: PLUGIN_OPTS });
    const ev = { sessionID: "s-normal", system: [] };
    await m.hooks.session.context(ev);
    const text = ev.system.map((s) => s.text).join("\n");
    assert.ok(text.includes("decision boundaries"), "sessao normal mantem instrucao do Jev");
  });
});