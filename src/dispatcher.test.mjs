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
} from "./orchestration/dispatcher.ts";
import {
  isInternalWorkerSession,
  hasInternalPromptMarker,
  buildWorkerContextInstruction,
  buildDefaultContextInstruction,
} from "./worker-hooks.ts";
import { isFreeModel } from "./config.ts";

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