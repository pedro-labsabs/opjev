// Testes RED do gate humano + retomada EXPLICITA de orquestracao (issue #12).
//
// Cobertura mandatoria:
//   HUMAN1-8  -> kernel: HumanRequest no estado de pausa + HumanDecision bounded
//   HUMA1     -> auditoria humanDecision na history projetada (sem crescimento)
//   PAUSE1    -> pausa persiste checkpoint human-awaiting e expoe pendingHuman
//   RESUME1-12/9b -> retomada (preservacao de switch, instrucao bounded,
//                validacao do estado persistido, storage-truth na falha,
//                sem createRunState/selectExecutor, checkpoints, ordem,
//                stop, duplicata/stale, frescor de sessao)
//   AUTH1-4   -> caller guard via Tool.Context real do @opencode/plugin 2.0.7
//   DESC3 / DESC3-resume / SCHEMA1-2 -> descricao e schema das tools
//   E2E1-2    -> tool-level plugin E2E + real-runtime E2E
//
// Classificacao do E2E (documentada no PR): "real plugin entrypoint (index.ts
// carregado de verdade) + simulated OpenCode runtime (harness fake-ctx) +
// deterministic SystemOne stub (fetch interceptado)". NAO ha smoke com Jev
// real/OpenCode server neste ambiente: nao existem API keys no env e o CLI
// opencode nao roda sessoes credenciadas — bloqueio documentado, nao silencioso.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createRunState, transitionRun } from "./orchestration/state-machine.ts";
import { OrchestrationError } from "./orchestration/types.ts";
import {
  buildHumanRequest,
  validateHumanDecision,
  validateResumableRunState,
} from "./orchestration/human-gate.ts";
import { runOrchestrationOnce, runOrchestrationResume } from "./orchestration/dispatcher.ts";
import pluginDefault from "../index.ts";
import { FREE_POOL } from "./config.ts";
import {
  makeCtx,
  makeStorage,
  stubFetch,
  okJev,
  routeAnswers,
} from "./harness.mjs";

// ─────────────────────────── fixtures: kernel ───────────────────────────

const EXECUTOR = { agent: "build", model: "opencode/big-pickle", sessionID: "w1" };

const HUMAN_VERDICT = {
  done: false,
  failureClass: "missing-context",
  sameExecutorCanRepair: false,
  nextAction: "human",
};
const REPAIR_VERDICT = {
  done: false,
  failureClass: "implementation",
  sameExecutorCanRepair: true,
  nextAction: "repair-same",
};
const SWITCH_VERDICT = {
  done: false,
  failureClass: "wrong-model",
  sameExecutorCanRepair: false,
  nextAction: "switch-model",
};

function contract(over = {}) {
  return {
    runID: "resume-run",
    objective: "Implementar o fluxo autenticado",
    scope: { include: ["src/auth.ts"], exclude: [] },
    constraints: ["nao alterar o runtime"],
    acceptanceCriteria: ["typecheck passa"],
    requiredEvidence: ["worker-session-outcome", "worker-final-response"],
    maxRounds: 3,
    ...over,
  };
}

function roundEvidence(round = 1) {
  return {
    round,
    executor: { agent: "build", model: "opencode/big-pickle", sessionID: "w1" },
    outcome: "failed",
    deterministicChecks: [{ name: "worker-session-outcome", status: "fail" }],
    criticFindings: [{ severity: "important", summary: "criterio pendente" }],
    resultSummary: "rodada nao concluiu o criterio",
  };
}

/** Rodada 1 executada + verdict recebido -> estado de pausa (TransitionResult). */
function pauseTransition(over = {}, verdict = HUMAN_VERDICT) {
  let s = createRunState(contract(over));
  s = transitionRun(s, { type: "CONTRACT_READY" }).state;
  s = transitionRun(s, { type: "EXECUTION_STARTED", executor: EXECUTOR }).state;
  s = transitionRun(s, { type: "EXECUTION_FINISHED", outcome: "failed" }).state;
  s = transitionRun(s, { type: "EVIDENCE_READY", evidence: roundEvidence(1) }).state;
  return transitionRun(s, { type: "VERDICT_RECEIVED", verdict });
}

const pauseByHuman = (over = {}) => pauseTransition(over, HUMAN_VERDICT).state;
const pauseByBudget = (over = {}) => pauseTransition({ maxRounds: 1, ...over }, REPAIR_VERDICT).state;
const pauseBySwitch = (over = {}) => pauseTransition({ maxRounds: 1, ...over }, SWITCH_VERDICT).state;

function expectCode(fn, code) {
  assert.throws(
    fn,
    (err) => err instanceof OrchestrationError && err.code === code,
    `esperado OrchestrationError code=${code}`,
  );
}

function expectRejectCode(promise, code) {
  return assert.rejects(
    promise,
    (err) => err instanceof OrchestrationError && err.code === code,
    `esperado rejeicao OrchestrationError code=${code}`,
  );
}

// ─────────────────────────── fixtures: dispatcher (fakes injetados) ───────────────────────────

function makeDeps(over = {}) {
  const effects = [];
  const prompts = [];
  let workerSeq = 0;
  let criticSeq = 0;
  let judgeIdx = 0;
  let promptIdx = 0;
  const runtime = {
    createWorker: async () => {
      effects.push("create");
      if (over.createError) throw over.createError;
      if (over.createErrorAt !== undefined && workerSeq + 1 >= over.createErrorAt) {
        throw over.createError ?? new Error("createWorker quebrou na retomada");
      }
      workerSeq += 1;
      const ids = over.workerSessionIDs ?? [];
      return { sessionID: ids[workerSeq - 1] ?? `w${workerSeq}` };
    },
    prompt: async ({ sessionID, text, metadata } = {}) => {
      const idx = promptIdx++;
      if (over.promptErrorAt !== undefined && idx >= over.promptErrorAt) {
        throw over.promptError ?? new Error("worker prompt quebrou");
      }
      effects.push("prompt");
      prompts.push({ sessionID, text, metadata });
    },
    wait: async () => {
      effects.push("wait");
    },
    get: async () => {
      effects.push("get");
      return over.view ?? { agent: "build", model: "opencode/big-pickle", outcome: "succeeded" };
    },
    context: async () => {
      effects.push("context");
      return [{ type: "assistant", content: [{ type: "text", text: "RESUME_WORKER_OK" }] }];
    },
    interrupt: async () => {},
    ...over.runtime,
  };
  const critic = {
    createCritic: async () => {
      effects.push("critic-create");
      return { sessionID: `c${++criticSeq}` };
    },
    prompt: async () => {},
    wait: async () => {},
    get: async () => ({ agent: "build", model: "opencode/big-pickle", outcome: "succeeded" }),
    context: async () => [
      { type: "assistant", content: [{ type: "text", text: JSON.stringify({ findings: [] }) }] },
    ],
    interrupt: async () => {},
  };
  const orchestrator = {
    createOrchestrator: async () => ({ sessionID: "o1" }),
    prompt: async () => {},
    wait: async () => {},
    get: async () => ({ outcome: "succeeded" }),
    context: async () => [
      {
        type: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              runID: "resume-run",
              objective: "revised objective",
              scope: { include: [], exclude: [] },
              constraints: [],
              acceptanceCriteria: ["done"],
              requiredEvidence: ["worker-session-outcome"],
              maxRounds: 3,
            }),
          },
        ],
      },
    ],
    interrupt: async () => {},
  };
  const decisions = {
    selectExecutor: async () => {
      effects.push("select");
      return { agent: "build", model: "opencode/big-pickle", via: "jev", route: "fast-coding", confidence: 0.9 };
    },
    judgeRound: async () => {
      effects.push("judge");
      const idx = judgeIdx++;
      if (over.judgeErrorAt !== undefined && idx >= over.judgeErrorAt) {
        throw over.judgeError ?? new Error("judge indisponivel");
      }
      const seq = over.judgeSeq ?? [humanAnswers()];
      return seq[Math.min(idx, seq.length - 1)];
    },
    selectModel: async () => {
      effects.push("select-model");
      return { model: "opencode/mimo-v2.5-free" };
    },
    selectAgent: async () => {
      effects.push("select-agent");
      return { agent: "plan" };
    },
  };
  const persistCalls = [];
  const persist = async (input) => {
    persistCalls.push(input);
  };
  return { runtime, critic, orchestrator, decisions, effects, prompts, persistCalls, persist };
}

function resumeDeps(t) {
  return {
    runtime: t.runtime,
    critic: t.critic,
    orchestrator: t.orchestrator,
    decisions: t.decisions,
    persist: t.persist,
  };
}

/** Rodada 1 real via runOrchestrationOnce -> run pausado (fixture fiel ao store). */
async function pausedRun(over = {}) {
  const t = makeDeps(over);
  const result = await runOrchestrationOnce(contract({ maxRounds: over.maxRounds ?? 3 }), resumeDeps(t));
  assert.equal(result.phase, "awaiting-human", "fixture deve pausar no boundary humano");
  assert.ok(result.pendingHuman, "resultado de pausa expoe pendingHuman");
  const last = t.persistCalls[t.persistCalls.length - 1];
  assert.equal(last.kind, "human-awaiting", "ultima checkpoint da pausa e human-awaiting");
  assert.equal(last.state.phase, "awaiting-human");
  return { t, result, state: last.state };
}

async function resume(t, state, decision, extra = {}) {
  return runOrchestrationResume({ state, decision, ...extra }, resumeDeps(t));
}

function resumeDecision(state, over = {}) {
  return { requestID: state.pendingHuman.requestID, action: "resume", ...over };
}

// ─────────────────────────── fixtures: tool-level (plugin real + harness) ───────────────────────────

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

function humanAnswers() {
  return {
    done: { type: "noul", noul: 0.1 },
    failure_class: { type: "choice", choice: "missing-context" },
    same_executor_can_repair: { type: "noul", noul: 0.1 },
    next_action: { type: "choice", choice: "human", confidence: 0.8 },
  };
}

function switchModelAnswers() {
  return {
    done: { type: "noul", noul: 0.1 },
    failure_class: { type: "choice", choice: "wrong-model" },
    same_executor_can_repair: { type: "noul", noul: 0.1 },
    next_action: { type: "choice", choice: "switch-model", confidence: 0.8 },
  };
}

const HUMAN_CALLER = { sessionID: "human-caller", agent: "build", messageID: "msg-1", id: "call-1" };

/**
 * Plugin real executa orchestrate_once e pausa no boundary humano. Espelha o
 * que o store contem em orchestration/run/<runID> antes de qualquer resume.
 */
async function pausedTool(over = {}) {
  const m = await bootCtx({
    models: ALL_MODELS,
    storage: makeStorage({}),
    options: PLUGIN_OPTS,
    location: "/proj",
  });
  // Observabilidade da verdade do storage: toda escrita fica registrada.
  const writes = [];
  const storage = m.ctx.storage;
  const origSet = storage.set;
  storage.set = async (k, v) => {
    writes.push({ k, checkpoint: v?.checkpoint, phase: v?.state?.phase, round: v?.state?.round });
    return origSet.call(storage, k, v);
  };
  let judgeIdx = 0;
  const stub = stubFetch(async ({ body }) => {
    if (body?.questions?.route) {
      return okJev(
        routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle", confidence: 0.9 }),
      );
    }
    if (body?.questions?.next_action) {
      const idx = judgeIdx++;
      if (over.judgeThrowAt !== undefined && idx >= over.judgeThrowAt) {
        throw new Error("jev indisponivel");
      }
      const seq = over.judgeSeq ?? [humanAnswers()];
      return okJev(seq[Math.min(idx, seq.length - 1)]);
    }
    return okJev(acceptAnswers());
  });
  const runID = over.runID ?? "resume-tool";
  const res = await m.tools.orchestrate_once.execute({
    contract: {
      runID,
      objective: "Do it.",
      scope: { include: [], exclude: [] },
      constraints: [],
      acceptanceCriteria: ["done"],
      requiredEvidence: ["worker-session-outcome"],
      maxRounds: over.maxRounds ?? 1,
    },
  });
  const out = JSON.parse(res.content);
  assert.equal(out.phase, "awaiting-human", "fixture deve pausar no boundary humano");
  assert.ok(out.pendingHuman, "orchestrate_once devolve pendingHuman na pausa");
  return { m, stub, out, writes, runID };
}

// ═══════════════════════════ HUMAN: kernel + HumanDecision ═══════════════════════════

describe("HUMAN: HumanRequest na pausa + HUMAN_DECISION_RECEIVED no kernel", () => {
  it("HUMAN1: verdict human -> awaiting-human + request-human + pendingHuman deterministico (jev-human)", () => {
    const r = pauseTransition({}, HUMAN_VERDICT);
    assert.equal(r.state.phase, "awaiting-human");
    assert.deepEqual(r.commands, [{ type: "request-human" }]);
    const ph = r.state.pendingHuman;
    assert.ok(ph, "HumanRequest presente no estado");
    assert.equal(ph.requestID, "human:1:1:jev-human");
    assert.equal(ph.kind, "jev-human");
    assert.equal(ph.round, 1);
    assert.equal(ph.currentMaxRounds, 3);
    assert.equal(ph.minimumMaxRounds, 2, "minimumMaxRounds = round + 1");
    assert.equal(ph.requiredAuthority, "resume-or-stop", "orcamento atual comporta round+1");
    assert.equal(typeof ph.reason, "string");
    assert.ok(ph.reason.length > 0 && ph.reason.length <= 500, "reason bounded (<=500)");
    assert.match(ph.reason, /verdict human/);
    // Determinista (sem random/UUID): duas pausas identicas geram o mesmo requestID.
    const again = pauseTransition({}, HUMAN_VERDICT).state.pendingHuman;
    assert.equal(again.requestID, ph.requestID, "requestID deterministico human:<round>:<historyLen>:<kind>");
    // Auditoria do verdict ficou no estado.
    assert.equal(r.state.lastVerdict.nextAction, "human");
    assert.ok(r.state.evidence, "evidence da rodada pausada permanece para o resume");
  });

  it("HUMAN2: esgotamento de maxRounds -> pendingHuman kind=max-rounds, autoridade de orcamento", () => {
    const state = pauseByBudget();
    assert.equal(state.phase, "awaiting-human");
    const ph = state.pendingHuman;
    assert.equal(ph.kind, "max-rounds");
    assert.equal(ph.requestID, "human:1:1:max-rounds");
    assert.equal(ph.round, 1);
    assert.equal(ph.currentMaxRounds, 1);
    assert.equal(ph.minimumMaxRounds, 2);
    assert.equal(ph.requiredAuthority, "increase-budget-or-stop", "resume exige aumentar o orcamento");
    assert.match(ph.reason, /orcamento esgotado/);
    assert.ok(ph.reason.length <= 500, "reason bounded");
    // Pausa por switch no limite tambem e max-rounds (kernel nunca inventa select).
    const sw = pauseBySwitch();
    assert.equal(sw.pendingHuman.kind, "max-rounds");
    assert.equal(sw.phase, "awaiting-human");
  });

  it("HUMAN3: validateHumanDecision rejeita forma nao-bounded (chaves/acoes/instrucao/newMaxRounds)", () => {
    const state = pauseByHuman(); // maxRounds=3, requestID human:1:1:jev-human
    const req = state.pendingHuman.requestID;
    const invalid = [
      [null, "nao-objeto"],
      ["resume", "nao-objeto-string"],
      [{ action: "resume" }, "sem requestID"],
      [{ requestID: 42, action: "stop" }, "requestID nao-string"],
      [{ requestID: req, action: "approve" }, "action desconhecida"],
      [{ requestID: "human:9:9:jev-human", action: "stop" }, "requestID stale"],
      [{ requestID: req, action: "resume", approved: true }, "chave approved proibida"],
      [{ requestID: req, action: "resume", model: "openai/gpt-4o" }, "chave model proibida"],
      [{ requestID: req, action: "resume", sessionID: "sess" }, "chave sessionID proibida"],
      [{ requestID: req, action: "stop", instruction: "continue" }, "instruction em stop"],
      [{ requestID: req, action: "stop", newMaxRounds: 5 }, "newMaxRounds em stop"],
      [{ requestID: req, action: "resume", instruction: "x".repeat(1001) }, "instruction > 1000"],
      [{ requestID: req, action: "resume", instruction: "" }, "instruction vazia"],
      [{ requestID: req, action: "resume", newMaxRounds: "5" }, "coercao de string"],
      [{ requestID: req, action: "resume", newMaxRounds: true }, "booleano"],
      [{ requestID: req, action: "resume", newMaxRounds: 2.5 }, "nao-inteiro"],
      [{ requestID: req, action: "resume", newMaxRounds: 101 }, "> CONTRACT_LIMITS.maxRounds"],
      [{ requestID: req, action: "resume", newMaxRounds: 0 }, "< 1"],
      [{ requestID: req, action: "resume", newMaxRounds: 2 }, "reducao de maxRounds"],
      [{ requestID: req, action: "resume", toolPermissions: ["edit"] }, "chave toolPermissions proibida"],
      [{ requestID: req, action: "resume", revisedContract: {} }, "chave revisedContract proibida"],
    ];
    for (const [decision, label] of invalid) {
      expectCode(() => validateHumanDecision(decision, state), "invalid-human-decision");
      // A autoridade do kernel e a mesma porta: transitionRun rejeita igual.
      expectCode(
        () => transitionRun(state, { type: "HUMAN_DECISION_RECEIVED", decision }),
        "invalid-human-decision",
      );
    }
    // Forma valida nao-bounded alvo: apenas as 4 chaves sao aceitas.
    validateHumanDecision({ requestID: req, action: "resume" }, state);
    validateHumanDecision({ requestID: req, action: "resume", instruction: "w".repeat(1000) }, state);
    validateHumanDecision({ requestID: req, action: "resume", newMaxRounds: 100 }, state);
    validateHumanDecision({ requestID: req, action: "stop" }, state);
  });

  it("HUMAN4: resume valido (sem newMaxRounds quando orcamento basta) -> ready, round+1, executor sem sessionID", () => {
    const state = pauseByHuman(); // maxRounds=3 >= round+1=2
    const requestID = state.pendingHuman.requestID;
    const r = transitionRun(state, { type: "HUMAN_DECISION_RECEIVED", decision: { requestID, action: "resume" } });
    assert.equal(r.state.phase, "ready", "resume abre exatamente UMA rodada nova");
    assert.equal(r.state.round, 2, "round+1 aplicado uma unica vez");
    assert.equal(r.state.contract.maxRounds, 3, "sem newMaxRounds o orcamento nao muda");
    assert.equal(r.state.pendingHuman, undefined, "pendingHuman consumido");
    assert.deepEqual(
      r.state.executor,
      { agent: "build", model: "opencode/big-pickle" },
      "executor canonico preservado, sessionID descartada",
    );
    assert.deepEqual(r.commands, [{ type: "dispatch", mode: "human-resume" }]);
    assert.equal(r.state.history.length, 1, "decisao associa entrada, nao cresce history");
    assert.deepEqual(r.state.history[0].humanDecision, {
      requestID,
      action: "resume",
      maxRoundsBefore: 3,
      maxRoundsAfter: 3,
    });
    assert.ok(!("instruction" in r.state.history[0].humanDecision), "sem instruction => chave ausente");
    assert.equal(r.state.lastVerdict.nextAction, "human", "verdict anterior preservado");
    assert.ok(r.state.evidence, "evidence preservada para o recovery prompt");
  });

  it("HUMAN5: resume com instruction + newMaxRounds -> instruction auditada, so maxRounds muda no contrato", () => {
    const state = pauseByHuman();
    const requestID = state.pendingHuman.requestID;
    const instruction = "Foco no escopo declarado; nada fora de src/auth.ts.";
    const r = transitionRun(state, {
      type: "HUMAN_DECISION_RECEIVED",
      decision: { requestID, action: "resume", instruction, newMaxRounds: 5 },
    });
    assert.equal(r.state.phase, "ready");
    assert.equal(r.state.round, 2);
    assert.equal(r.state.contract.maxRounds, 5, "apenas contract.maxRounds pode mudar");
    assert.equal(r.state.contract.objective, state.contract.objective, "objective intocado");
    assert.deepEqual(r.state.contract.scope, state.contract.scope, "scope intocado");
    assert.deepEqual(r.state.contract.constraints, state.contract.constraints, "constraints intocadas");
    assert.deepEqual(r.state.contract.acceptanceCriteria, state.contract.acceptanceCriteria, "criterios intocados");
    assert.deepEqual(r.state.contract.requiredEvidence, state.contract.requiredEvidence, "evidence req intocada");
    assert.equal(r.state.contract.runID, state.contract.runID, "runID intocado");
    assert.deepEqual(r.state.history[0].humanDecision, {
      requestID,
      action: "resume",
      instruction,
      maxRoundsBefore: 3,
      maxRoundsAfter: 5,
    });
  });

  it("HUMAN6: stop -> stopped, sem nova rodada, humanDecision auditada, pendingHuman consumido", () => {
    const state = pauseByHuman();
    const requestID = state.pendingHuman.requestID;
    const r = transitionRun(state, { type: "HUMAN_DECISION_RECEIVED", decision: { requestID, action: "stop" } });
    assert.equal(r.state.phase, "stopped");
    assert.equal(r.state.round, 1, "stop nao abre rodada");
    assert.equal(r.state.pendingHuman, undefined);
    assert.deepEqual(r.commands, [{ type: "stop" }]);
    assert.deepEqual(r.state.history[0].humanDecision, {
      requestID,
      action: "stop",
      maxRoundsBefore: 3,
      maxRoundsAfter: 3,
    });
    assert.equal(r.state.history.length, 1, "sem crescimento de history");
  });

  it("HUMAN7: requestID stale -> invalid-human-decision; HUMAN_DECISION_RECEIVED fora de awaiting-human -> invalid-transition", () => {
    const state = pauseByHuman();
    const requestID = state.pendingHuman.requestID;
    // Stale: outro requestID (mesmo que estruturalmente valido).
    expectCode(
      () => transitionRun(state, { type: "HUMAN_DECISION_RECEIVED", decision: { requestID: "human:1:1:max-rounds", action: "stop" } }),
      "invalid-human-decision",
    );
    // Duplicata: apos resume a fase deixou de ser awaiting-human.
    const ready = transitionRun(state, { type: "HUMAN_DECISION_RECEIVED", decision: { requestID, action: "resume" } }).state;
    expectCode(
      () => transitionRun(ready, { type: "HUMAN_DECISION_RECEIVED", decision: { requestID, action: "stop" } }),
      "invalid-transition",
      "segundo resume/stop em fase ready e invalid-transition",
    );
    // Apos stop, idem.
    const stopped = transitionRun(state, { type: "HUMAN_DECISION_RECEIVED", decision: { requestID, action: "stop" } }).state;
    expectCode(
      () => transitionRun(stopped, { type: "HUMAN_DECISION_RECEIVED", decision: { requestID, action: "resume" } }),
      "invalid-transition",
    );
    // Nunca ha transicao silenciosa: silencio/timeout nao geram HUMAN_DECISION_RECEIVED.
    const again = pauseByHuman();
    assert.equal(again.phase, "awaiting-human", "silencio mantem a pausa intacta");
  });

  it("HUMAN8: gate duro de orcamento — resume sem newMaxRounds suficiente e invalid-human-decision", () => {
    const budget = pauseByBudget(); // max-rounds: round 1, maxRounds 1, min 2
    expectCode(
      () => transitionRun(budget, { type: "HUMAN_DECISION_RECEIVED", decision: { requestID: budget.pendingHuman.requestID, action: "resume" } }),
      "invalid-human-decision",
      "kind=max-rounds exige newMaxRounds",
    );
    const tooLow = pauseByBudget();
    expectCode(
      () => transitionRun(tooLow, {
        type: "HUMAN_DECISION_RECEIVED",
        decision: { requestID: tooLow.pendingHuman.requestID, action: "resume", newMaxRounds: 1 },
      }),
      "invalid-human-decision",
      "newMaxRounds precisa ser >= round+1",
    );
    const exact = pauseByBudget();
    const r = transitionRun(exact, {
      type: "HUMAN_DECISION_RECEIVED",
      decision: { requestID: exact.pendingHuman.requestID, action: "resume", newMaxRounds: exact.pendingHuman.minimumMaxRounds },
    });
    assert.equal(r.state.phase, "ready");
    assert.equal(r.state.round, 2);
    assert.equal(r.state.contract.maxRounds, 2, "newMaxRounds minimo aceito = round+1");
    // kind=jev-human tambem e barrado quando o orcamento atual nao comporta round+1.
    const tight = pauseByHuman({ maxRounds: 1 });
    assert.equal(tight.pendingHuman.kind, "jev-human");
    assert.equal(tight.pendingHuman.requiredAuthority, "increase-budget-or-stop");
    expectCode(
      () => transitionRun(tight, { type: "HUMAN_DECISION_RECEIVED", decision: { requestID: tight.pendingHuman.requestID, action: "resume" } }),
      "invalid-human-decision",
    );
    // E o limite superior absoluto continua CONTRACT_LIMITS.maxRounds=100.
    const hi = pauseByBudget();
    expectCode(
      () => transitionRun(hi, {
        type: "HUMAN_DECISION_RECEIVED",
        decision: { requestID: hi.pendingHuman.requestID, action: "resume", newMaxRounds: 101 },
      }),
      "invalid-human-decision",
    );
    // buildHumanRequest e puro/deterministico e espelha o kernel.
    const ph = buildHumanRequest({ round: 1, historyLength: 1, kind: "max-rounds", currentMaxRounds: 1 });
    assert.equal(ph.requestID, "human:1:1:max-rounds");
    assert.equal(ph.minimumMaxRounds, 2);
    assert.equal(ph.requiredAuthority, "increase-budget-or-stop");
  });
});

// ═══════════════════════════ HUMA: auditoria da decisao ═══════════════════════════

describe("HUMA: auditoria humanDecision na projecao", () => {
  it("HUMA1: history projetada carrega humanDecision na entry da rodada pausada, sem crescimento", async () => {
    const { t, state } = await pausedRun({ maxRounds: 3, judgeSeq: [humanAnswers()] });
    const before = state.history.length;
    const res = await resume(t, state, { requestID: state.pendingHuman.requestID, action: "stop" });
    assert.equal(res.history.length, before, "stop associa, nao cresce a history");
    const withDecision = res.history.filter((h) => h.humanDecision);
    assert.equal(withDecision.length, 1, "exatamente a entry da rodada pausada carrega a auditoria");
    assert.equal(withDecision[0].round, 1);
    assert.deepEqual(withDecision[0].humanDecision, {
      requestID: state.pendingHuman.requestID,
      action: "stop",
      maxRoundsBefore: 3,
      maxRoundsAfter: 3,
    });
    assert.equal((res.rounds ?? []).length, 0, "stop nao executa rodadas");
    assert.equal(res.pendingHuman, undefined, "decisao ja consumida");
  });
});

// ═══════════════════════════ PAUSE: checkpoint human-awaiting ═══════════════════════════

describe("PAUSE: pausa persistida + pendingHuman no resultado da tool", () => {
  it("PAUSE1: orchestrate_once pausa -> checkpoint human-awaiting observavel, sem worker extra", async () => {
    const { m, stub, out } = await pausedTool({ runID: "pause-1", maxRounds: 2 });
    try {
      assert.equal(out.phase, "awaiting-human");
      assert.deepEqual(out.pendingCommands, ["request-human"]);
      const ph = out.pendingHuman;
      assert.equal(ph.requestID, "human:1:1:jev-human");
      assert.equal(ph.kind, "jev-human");
      assert.equal(ph.round, 1);
      assert.equal(ph.currentMaxRounds, 2);
      assert.equal(ph.minimumMaxRounds, 2);
      assert.equal(ph.requiredAuthority, "resume-or-stop");
      assert.ok(ph.reason.length > 0 && ph.reason.length <= 500, "reason bounded");

      const stored = m.storage._map.get("orchestration/run/pause-1");
      assert.ok(stored, "orchestration/run/<runID> persistido");
      assert.equal(stored.checkpoint, "human-awaiting", "checkpoint kind exposto no record");
      assert.equal(stored.state.phase, "awaiting-human");
      assert.equal(stored.state.pendingHuman.requestID, ph.requestID);
      assert.equal(stored.state.round, 1, "pausa nao abre rodada nova");
      assert.equal(stored.workerSessionID, out.worker.sessionID, "checkpoint carrega workerSessionID");
      assert.equal(stored.criticSessionID, out.critic.sessionID, "checkpoint carrega criticSessionID");
      assert.ok(stored.updatedAt > 0, "timestamp persistido");

      const workers = m.workerCalls.create.filter((c) => c.metadata?.["jev-role"] === "worker");
      assert.equal(workers.length, 1, "nenhuma worker nova apos o boundary humano");
      const critics = m.workerCalls.create.filter((c) => c.metadata?.["jev-role"] === "critic");
      assert.equal(critics.length, 1, "nenhum critic novo apos o boundary humano");
    } finally {
      stub.restore();
    }
  });
});

// ═══════════════════════════ RESUME: retomada explicita ═══════════════════════════

describe("RESUME: runOrchestrationResume (scheduler compartilhado, seam unico)", () => {
  it("RESUME1: preservacao de switch — executor canonico mantido, SEM select, sessao worker fresca", async () => {
    // Pausa no limite apos verdict switch-model: o destino do switch NUNCA foi
    // escolhido; o resume executa com o executor canonico do estado.
    const { t, state } = await pausedRun({ maxRounds: 1, judgeSeq: [switchModelAnswers(), acceptAnswers()] });
    assert.equal(state.pendingHuman.kind, "max-rounds");
    const res = await resume(t, state, resumeDecision(state, { newMaxRounds: 2 }));
    assert.equal(res.phase, "completed");
    assert.equal(res.round, 2);
    assert.equal(res.rounds[0].action, "human-resume", "rodada retomada marcada como human-resume");
    assert.equal(res.worker.agent, "build", "agent canonico preservado");
    assert.equal(res.worker.model, "opencode/big-pickle", "model canonico preservado (switch destino nunca escolhido)");
    assert.notEqual(res.worker.sessionID, state.executor.sessionID, "sessao realmente fresca");
    assert.equal(t.effects.filter((e) => e === "select").length, 1, "selectExecutor apenas do run inicial");
    assert.equal(t.effects.filter((e) => e === "select-model").length, 0, "switch destino nunca selecionado no resume");
    assert.equal(t.effects.filter((e) => e === "select-agent").length, 0);
  });

  it("RESUME2: instrucao humana bounded entra SO na prompt da rodada retomada (human-resume)", async () => {
    const { t, state } = await pausedRun({ maxRounds: 1, judgeSeq: [humanAnswers(), acceptAnswers()] });
    const instruction = "w".repeat(1000); // exatamente o limite
    const res = await resume(t, state, resumeDecision(state, { newMaxRounds: 2, instruction }));
    assert.equal(res.phase, "completed");

    const pausedPrompt = t.prompts.find((p) => p.metadata?.["jev-round"] === 1);
    assert.ok(pausedPrompt, "prompt da rodada pausada registrada");
    assert.ok(!pausedPrompt.text.includes("HUMAN_INSTRUCTION"), "rodada pausada nunca viu a instrucao");

    const resumed = t.prompts.find((p) => p.metadata?.["jev-round"] === 2 && p.metadata?.["jev-role"] === "worker");
    assert.ok(resumed, "prompt da rodada retomada registrada");
    assert.ok(resumed.text.includes("RECOVERY_ACTION: human-resume"), "RECOVERY_ACTION: human-resume");
    assert.ok(resumed.text.includes(`HUMAN_INSTRUCTION: ${instruction}`), "instrucao bounded integral");
    assert.ok(resumed.text.includes("ROUND: 2/2"), "ROUND: N/M");
    assert.ok(resumed.text.includes("OBJECTIVE:"), "contract no prompt");
    assert.ok(resumed.text.includes("SCOPE_INCLUDE"), "escopo no prompt");
    assert.ok(resumed.text.includes("CONSTRAINTS"), "restricoes no prompt");
    assert.ok(resumed.text.includes("ACCEPTANCE_CRITERIA"), "criterios no prompt");
    assert.ok(resumed.text.includes("REQUIRED_EVIDENCE"), "evidencia exigida no prompt");
    assert.ok(resumed.text.includes("PREVIOUS_FAILURE_CLASS"), "falha anterior bounded");
    assert.ok(resumed.text.includes("PREVIOUS_RESULT_SUMMARY"), "evidencia anterior bounded");
    assert.ok(resumed.text.includes("explicitly authorized by a human"), "autorizacao humana explicita");
    assert.ok(resumed.text.includes("Do not infer additional permissions"), "sem permissao inferida");
    assert.ok(resumed.text.includes("Do not declare approval"), "nunca declara aprovacao");
    // Sem instrucao -> placeholder deterministico.
    const { t: t2, state: s2 } = await pausedRun({ maxRounds: 1, judgeSeq: [humanAnswers(), acceptAnswers()] });
    await resume(t2, s2, resumeDecision(s2, { newMaxRounds: 2 }));
    const noInstr = t2.prompts.find((p) => p.metadata?.["jev-round"] === 2);
    assert.ok(
      noInstr.text.includes("HUMAN_INSTRUCTION: [human authorized continuation without additional instruction]"),
      "placeholder quando humano autoriza sem instrucao",
    );
  });

  it("RESUME3: validateResumableRunState valida o estado persistido com forma bounded", () => {
    const valid = pauseByHuman();
    validateResumableRunState(valid, "resume-run"); // nao lanca
    const cases = [
      [null, "state ausente"],
      ["x", "state nao-objeto"],
      [{ ...valid, phase: "ready" }, "phase nao-awaiting-human"],
      [{ ...valid, phase: "completed" }, "phase completed"],
      [{ ...valid, phase: "failed" }, "phase failed"],
      [{ ...valid, contract: { ...valid.contract, runID: "outro" } }, "runID divergente"],
      [{ ...valid, contract: { ...valid.contract, maxRounds: 0 } }, "contract invalido"],
      [{ ...valid, contract: undefined }, "sem contract"],
      [{ ...valid, round: 1.5 }, "round nao-inteiro"],
      [{ ...valid, round: 0 }, "round < 1"],
      [{ ...valid, history: "nope" }, "history nao-array"],
      [{ ...valid, history: [null] }, "history entry invalida"],
      [{ ...valid, history: [{ round: "1" }] }, "history round nao-inteiro"],
      [{ ...valid, pendingHuman: undefined }, "sem pendingHuman"],
      [{ ...valid, pendingHuman: { ...valid.pendingHuman, requestID: "" } }, "requestID vazio"],
      [{ ...valid, pendingHuman: { ...valid.pendingHuman, kind: "auto" } }, "kind desconhecido"],
      [{ ...valid, pendingHuman: { ...valid.pendingHuman, round: 2 } }, "pendingHuman.round != state.round"],
      [{ ...valid, pendingHuman: { ...valid.pendingHuman, reason: "x".repeat(501) }, }, "reason > 500"],
      [{ ...valid, pendingHuman: { ...valid.pendingHuman, requiredAuthority: "approve" } }, "autoridade desconhecida"],
      [{ ...valid, pendingHuman: { ...valid.pendingHuman, currentMaxRounds: 9 } }, "currentMaxRounds != contract.maxRounds"],
      [{ ...valid, pendingHuman: { ...valid.pendingHuman, minimumMaxRounds: 9 } }, "minimumMaxRounds != round+1"],
      [{ ...valid, executor: undefined }, "sem executor canonico"],
      [{ ...valid, executor: { agent: "", model: "opencode/big-pickle" } }, "executor.agent vazio"],
      [{ ...valid, executor: { agent: "build", model: "" } }, "executor.model vazio"],
      [{ ...valid, evidence: undefined }, "sem evidence"],
      [{ ...valid, evidence: { ...valid.evidence, round: 5 } }, "evidence.round != round"],
      [{ ...valid, evidence: { ...valid.evidence, executor: { model: "opencode/big-pickle" } } }, "evidence.executor sem agent"],
      [{ ...valid, evidence: { ...valid.evidence, deterministicChecks: "nope" } }, "deterministicChecks nao-array"],
      [{ ...valid, evidence: { ...valid.evidence, criticFindings: "nope" } }, "criticFindings nao-array"],
      [{ ...valid, evidence: { ...valid.evidence, resultSummary: "" } }, "resultSummary vazio"],
      [{ ...valid, lastVerdict: undefined }, "sem lastVerdict"],
      [{ ...valid, lastVerdict: { done: "yes" } }, "lastVerdict invalido"],
    ];
    for (const [tampered, label] of cases) {
      expectCode(() => validateResumableRunState(tampered, "resume-run"), "invalid-resumable-run");
    }
    // runID do caller divergente do contract persistido tambem e rejeitado.
    expectCode(() => validateResumableRunState(pauseByHuman(), "outro-run"), "invalid-resumable-run");
  });

  it("RESUME4: falha apos o resume persiste run-failed (storage nunca mostra ready enquanto a API falha)", async () => {
    const { t, state } = await pausedRun({ maxRounds: 3, judgeSeq: [humanAnswers()], promptErrorAt: 1 });
    const res = await resume(t, state, resumeDecision(state));
    assert.equal(res.phase, "failed", "resultado comunica a falha");
    assert.ok(res.error && res.error.includes("worker prompt quebrou"), "erro bounded no resultado");
    const kinds = t.persistCalls.map((c) => c.kind);
    const hd = kinds.indexOf("human-decision");
    assert.ok(hd >= 0, "human-decision persistido antes do scheduler");
    assert.equal(t.persistCalls[hd].state.phase, "ready", "autoridade aplicada antes de executar");
    const last = t.persistCalls[t.persistCalls.length - 1];
    assert.equal(last.kind, "run-failed", "ultima verdade do store e run-failed");
    assert.equal(last.state.phase, "failed", "store em failed, nunca ready");
    assert.ok(!t.persistCalls.some((c, i) => i > hd && c.state.phase === "ready"), "nenhuma escrita ready apos a falha");
  });

  it("RESUME5: sem createRunState/selectExecutor — round/history/contract carregados do estado persistido", async () => {
    const { t, state } = await pausedRun({ maxRounds: 3, judgeSeq: [humanAnswers(), acceptAnswers()] });
    assert.equal(state.history.length, 1, "fixture tem a rodada pre-pausa");
    const res = await resume(t, state, resumeDecision(state));
    assert.equal(res.phase, "completed");
    assert.equal(res.round, 2, "round 2 vem do estado persistido (createRunState daria round 1)");
    assert.equal(res.selection, undefined, "resume nunca reseleciona executor");
    assert.equal(res.history.length, 2, "history preservada + nova rodada");
    assert.equal(res.history[0].round, 1, "rodada pre-pausa preservada (nunca history restart)");
    assert.equal(res.history[1].round, 2);
    assert.equal(t.effects.filter((e) => e === "select").length, 1, "selectExecutor so do run inicial");
    const audited = res.history.find((h) => h.humanDecision);
    assert.ok(audited, "humanDecision auditado na entry da rodada pausada");
    assert.equal(audited.round, 1);
    assert.equal(audited.humanDecision.action, "resume");
  });

  it("RESUME6: ordem dos checkpoints — human-decision (autoridade aplicada) ANTES de qualquer worker nova", async () => {
    const { t, state } = await pausedRun({ maxRounds: 1, judgeSeq: [humanAnswers(), acceptAnswers()] });
    await resume(t, state, resumeDecision(state, { newMaxRounds: 2 }));
    const kinds = t.persistCalls.map((c) => c.kind);
    const awaiting = kinds.lastIndexOf("human-awaiting");
    const decision = kinds.indexOf("human-decision");
    const created = kinds.lastIndexOf("worker-created");
    assert.ok(awaiting >= 0 && decision > awaiting, "human-decision vem depois da pausa");
    assert.ok(created > decision, "worker nova so apos a decisao ser persistida");
    const hd = t.persistCalls[decision];
    assert.equal(hd.state.phase, "ready", "autoridade aplicada (round aberta, orcamento novo)");
    assert.equal(hd.state.round, 2);
    assert.equal(hd.state.contract.maxRounds, 2);
    assert.equal(hd.state.pendingHuman, undefined, "pendingHuman ja consumido no checkpoint");
    assert.equal(hd.kind, "human-decision");
    assert.ok(typeof hd.at === "number" && hd.at > 0, "clock injetado no checkpoint");
    const last = t.persistCalls[t.persistCalls.length - 1];
    assert.equal(last.kind, "verdict-applied");
    assert.equal(last.state.phase, "completed");
  });

  it("RESUME7: stop nunca executa trabalho novo e persiste human-decision stopped", async () => {
    const { t, state } = await pausedRun({ maxRounds: 3 });
    const creates = t.effects.filter((e) => e === "create").length;
    const judges = t.effects.filter((e) => e === "judge").length;
    const prompts = t.prompts.length;
    const res = await resume(t, state, { requestID: state.pendingHuman.requestID, action: "stop" });
    assert.equal(res.phase, "stopped");
    assert.deepEqual(res.pendingCommands, ["stop"]);
    assert.equal(res.round, 1, "stop nao abre rodada");
    assert.equal(res.verdict, undefined, "sem verdict novo");
    assert.equal(t.effects.filter((e) => e === "create").length, creates, "nenhuma worker nova");
    assert.equal(t.effects.filter((e) => e === "judge").length, judges, "nenhum julgamento novo");
    assert.equal(t.prompts.length, prompts, "nenhum prompt novo");
    const last = t.persistCalls[t.persistCalls.length - 1];
    assert.equal(last.kind, "human-decision");
    assert.equal(last.state.phase, "stopped", "storage-truth do stop");
    assert.equal(last.state.pendingHuman, undefined);
    assert.equal(last.workerSessionID, "w1", "checkpoint carrega a sessao da rodada pausada");
  });

  it("RESUME8: retomada duplicada e rejeitada na tool (estado nao-asyncnhuman -> invalid-resumable-run)", async () => {
    const { m, stub, out, runID } = await pausedTool({ runID: "dup-8", maxRounds: 1 });
    try {
      const stopRes = await m.tools.orchestrate_resume.execute(
        { runID, decision: { requestID: out.pendingHuman.requestID, action: "stop" } },
        HUMAN_CALLER,
      );
      const stopped = JSON.parse(stopRes.content);
      assert.equal(stopped.phase, "stopped");
      // Segunda chamada com o MESMO requestID: o run ja nao esta mais pausado.
      const again = await m.tools.orchestrate_resume.execute(
        { runID, decision: { requestID: out.pendingHuman.requestID, action: "resume", newMaxRounds: 2 } },
        HUMAN_CALLER,
      );
      assert.ok(again.content.includes("invalid-resumable-run"), again.content);
      assert.ok(!again.content.includes('"phase"'), "nenhum resultado de run fabricado");
      const stored = m.storage._map.get(`orchestration/run/${runID}`);
      assert.equal(stored.state.phase, "stopped", "verdade do stop preservada pela chamada duplicada");
    } finally {
      stub.restore();
    }
  });

  it("RESUME9: requestID stale rejeitado no dispatcher — sem checkpoint, sem worker nova", async () => {
    const { t, state } = await pausedRun({ maxRounds: 3 });
    const persistBefore = t.persistCalls.length;
    const createsBefore = t.effects.filter((e) => e === "create").length;
    await expectRejectCode(
      resume(t, state, { requestID: "human:9:9:jev-human", action: "resume" }),
      "invalid-human-decision",
    );
    assert.equal(t.persistCalls.length, persistBefore, "nenhum checkpoint em decisao invalida");
    assert.equal(t.effects.filter((e) => e === "create").length, createsBefore, "nenhuma worker nova");
  });

  it("RESUME9b: requestID stale rejeitado na tool — sem worker nova, sem chamada ao Jev", async () => {
    const { m, stub, runID } = await pausedTool({ runID: "stale-9b", maxRounds: 1 });
    try {
      const fetches = stub.calls.length;
      const creates = m.workerCalls.create.length;
      const res = await m.tools.orchestrate_resume.execute(
        { runID, decision: { requestID: "human:9:9:jev-human", action: "resume", newMaxRounds: 2 } },
        HUMAN_CALLER,
      );
      assert.ok(res.content.includes("invalid-human-decision"), res.content);
      assert.equal(m.workerCalls.create.length, creates, "nenhuma worker nova");
      assert.equal(stub.calls.length, fetches, "nenhuma consulta ao Jev");
      const stored = m.storage._map.get(`orchestration/run/${runID}`);
      assert.equal(stored.checkpoint, "human-awaiting", "storage intacto");
    } finally {
      stub.restore();
    }
  });

  it("RESUME10: sessao reutilizada no resume -> human-resume-not-fresh (falha bounded, run-failed)", async () => {
    const { t, state } = await pausedRun({
      maxRounds: 3,
      judgeSeq: [humanAnswers(), acceptAnswers()],
      runtime: { createWorker: async () => ({ sessionID: "w1" }) },
    });
    const res = await resume(t, state, resumeDecision(state));
    assert.equal(res.phase, "failed");
    assert.ok(res.error && res.error.includes("human-resume"), res.error);
    assert.ok(res.error.includes("ja utilizada"), "erro cita a sessao ja utilizada");
    const last = t.persistCalls[t.persistCalls.length - 1];
    assert.equal(last.kind, "run-failed", "falha de frescor persistida");
    assert.equal(last.state.phase, "failed");
  });

  it("RESUME11: falha do julgamento pos-resume persiste run-failed com as sessoes da rodada", async () => {
    const { t, state } = await pausedRun({ maxRounds: 3, judgeSeq: [humanAnswers()], judgeErrorAt: 1 });
    const res = await resume(t, state, resumeDecision(state));
    assert.equal(res.phase, "failed");
    assert.ok(res.error && res.error.includes("judge indisponivel"), res.error);
    const kinds = t.persistCalls.map((c) => c.kind);
    assert.ok(kinds.includes("human-decision"), "decisao persistida antes");
    const last = t.persistCalls[t.persistCalls.length - 1];
    assert.equal(last.kind, "run-failed");
    assert.equal(last.state.phase, "failed");
    assert.equal(last.workerSessionID, "w2", "checkpoint carrega a worker da rodada que falhou");
    assert.equal(last.criticSessionID, "c2", "checkpoint carrega o critic da rodada que falhou");
    assert.equal(last.state.round, 2, "round da falha preservada");
  });

  it("RESUME12: createWorker/executor canonico fora do pool falham POS-resume -> run-failed e a ultima verdade", async () => {
    // (a) createWorker quebra na rodada retomada: a autoridade (human-decision,
    // phase ready) ja foi aplicada; a ultima verdade do store NUNCA pode
    // permanecer ready quando a API falhou.
    const a = await pausedRun({ maxRounds: 3, judgeSeq: [humanAnswers()], createErrorAt: 2 });
    const resA = await resume(a.t, a.state, resumeDecision(a.state));
    assert.equal(resA.phase, "failed");
    assert.ok(resA.error && resA.error.includes("createWorker quebrou na retomada"), resA.error);
    const kindsA = a.t.persistCalls.map((c) => c.kind);
    const hdA = kindsA.indexOf("human-decision");
    assert.ok(hdA >= 0, "decisao persistida antes do scheduler");
    const lastA = a.t.persistCalls[a.t.persistCalls.length - 1];
    assert.equal(lastA.kind, "run-failed");
    assert.equal(lastA.state.phase, "failed");
    assert.ok(
      !a.t.persistCalls.some((c, i) => i > hdA && c.state.phase === "ready"),
      "nenhuma escrita ready apos a decisao quando a retomada falha",
    );

    // (b) executor canonico com model fora do FREE_POOL (estado pausado
    // corrompido/stale): validacao de forma passa, mas o dispatcher falha
    // bounded ANTES da worker — e tambem persiste run-failed.
    const b = await pausedRun({ maxRounds: 3, judgeSeq: [humanAnswers()] });
    const tampered = { ...b.state, executor: { agent: "build", model: "openai/gpt-4o" } };
    const resB = await resume(b.t, tampered, resumeDecision(tampered));
    assert.equal(resB.phase, "failed");
    assert.ok(resB.error && resB.error.includes("FREE_POOL"), resB.error);
    const lastB = b.t.persistCalls[b.t.persistCalls.length - 1];
    assert.equal(lastB.kind, "run-failed");
    assert.equal(lastB.state.phase, "failed");
  });
});

// ═══════════════════════════ AUTH: quem pode decidir o gate ═══════════════════════════

describe("AUTH: caller guard em orchestrate_resume (Tool.Context real)", () => {
  it("AUTH1: sessao humana decide stop -> stopped + human-decision persistido, zero fetch/worker novos", async () => {
    const { m, stub, out, runID } = await pausedTool({ runID: "auth-1", maxRounds: 3 });
    try {
      const fetches = stub.calls.length;
      const creates = m.workerCalls.create.length;
      const res = await m.tools.orchestrate_resume.execute(
        { runID, decision: { requestID: out.pendingHuman.requestID, action: "stop" } },
        HUMAN_CALLER,
      );
      const stopped = JSON.parse(res.content);
      assert.equal(stopped.phase, "stopped");
      assert.deepEqual(stopped.pendingCommands, ["stop"]);
      assert.equal(stub.calls.length, fetches, "stop nao consulta o Jev");
      assert.equal(m.workerCalls.create.length, creates, "stop nao cria sessao");
      const stored = m.storage._map.get(`orchestration/run/${runID}`);
      assert.equal(stored.checkpoint, "human-decision", "checkpoint da decisao observavel");
      assert.equal(stored.state.phase, "stopped");
      assert.equal(stored.workerSessionID, "worker-1", "sessao da rodada pausada preservada no record");
    } finally {
      stub.restore();
    }
  });

  it("AUTH2: worker/critic/orchestrator internos NUNCA decidem o gate humano", async () => {
    const { m, stub, out, runID } = await pausedTool({ runID: "auth-2", maxRounds: 3 });
    try {
      const fetches = stub.calls.length;
      const internal = await m.ctx.session.create({
        agent: "build",
        model: { providerID: "opencode", id: "big-pickle" },
        metadata: {
          "jev-orchestration": true,
          "jev-run-id": runID,
          "jev-round": 1,
          "jev-role": "worker",
          "jev-router": "orchestration-internal",
        },
      });
      // Baseline apos a criacao da sessao interna (que ja conta como create):
      // o que importa e que o tool NAO crie nenhuma sessao nova.
      const creates = m.workerCalls.create.length;
      // Decision VALIDA chamada de sessao interna: o guard rejeita ANTES de tudo.
      const res = await m.tools.orchestrate_resume.execute(
        { runID, decision: { requestID: out.pendingHuman.requestID, action: "stop" } },
        { sessionID: internal.id, agent: "build", messageID: "m", id: "c" },
      );
      assert.match(res.content, /interna/i, "rejeicao cita sessao interna");
      assert.match(res.content, /worker/i, "rejeicao cita o papel interno");
      assert.equal(stub.calls.length, fetches, "nenhuma chamada ao Jev");
      assert.equal(m.workerCalls.create.length, creates, "nenhuma sessao nova");
      const stored = m.storage._map.get(`orchestration/run/${runID}`);
      assert.equal(stored.checkpoint, "human-awaiting", "nenhum checkpoint de decisao gravado");
      assert.equal(stored.state.phase, "awaiting-human", "run segue pausado");
    } finally {
      stub.restore();
    }
  });

  it("AUTH3: context/sessionID ausente ou invalido -> rejeicao (caller nunca inferido)", async () => {
    const { m, stub, out, runID } = await pausedTool({ runID: "auth-3", maxRounds: 3 });
    try {
      const decision = { requestID: out.pendingHuman.requestID, action: "stop" };
      const noCtx = await m.tools.orchestrate_resume.execute({ runID, decision });
      assert.match(noCtx.content, /contexto do chamador/i, "sem context nao ha decisao");
      const emptySid = await m.tools.orchestrate_resume.execute({ runID, decision }, { sessionID: "" });
      assert.match(emptySid.content, /contexto do chamador/i);
      const noSid = await m.tools.orchestrate_resume.execute({ runID, decision }, { agent: "build" });
      assert.match(noSid.content, /contexto do chamador/i);
      const stored = m.storage._map.get(`orchestration/run/${runID}`);
      assert.equal(stored.checkpoint, "human-awaiting", "nenhuma decisao aplicada sem caller verificavel");
      assert.equal(stored.state.phase, "awaiting-human");
      assert.equal(out.phase, "awaiting-human", "silencio/falha de contexto nunca viram aprovacao");
    } finally {
      stub.restore();
    }
  });

  it("AUTH4: input.callerRole NUNCA e aceito (schema nem execucao)", async () => {
    const { m, stub, out, runID } = await pausedTool({ runID: "auth-4", maxRounds: 3 });
    try {
      const tool = m.tools.orchestrate_resume;
      assert.ok(tool, "tool registrada");
      assert.equal(tool.input.properties.callerRole, undefined, "schema nao declara callerRole");
      const res = await tool.execute(
        { runID, decision: { requestID: out.pendingHuman.requestID, action: "stop" }, callerRole: "human" },
        HUMAN_CALLER,
      );
      assert.match(res.content, /callerRole/, "chave desconhecida rejeitada explicitamente");
      const stored = m.storage._map.get(`orchestration/run/${runID}`);
      assert.equal(stored.checkpoint, "human-awaiting", "callerRole nunca virou autoridade");
      assert.equal(stored.state.phase, "awaiting-human");
    } finally {
      stub.restore();
    }
  });
});

// ═══════════════════════════ DESC / SCHEMA ═══════════════════════════

describe("DESC3: descriptions publicadas do gate humano", () => {
  it("DESC3: orchestrate_once documenta pausa human-awaiting + retomada via orchestrate_resume", async () => {
    const m = await bootCtx({ models: ALL_MODELS, storage: makeStorage({}), options: PLUGIN_OPTS });
    const desc = String(m.tools.orchestrate_once.description ?? "");
    assert.ok(desc.includes("human-awaiting"), "checkpoint de pausa documentado");
    assert.ok(desc.includes("pendingHuman"), "HumanRequest exposto no resultado documentado");
    assert.ok(desc.includes("orchestrate_resume"), "seam unico de retomada documentado");
    assert.ok(desc.includes("auto-resume"), "ausencia de auto-resume documentada");
    assert.ok(desc.includes("human"), "human continua boundary documentado");
    assert.ok(desc.includes("replan"), "replan continua documentado");
    assert.ok(
      !desc.includes("switch-model/switch-agent/replan/human"),
      "sem stale pending conjunto (regressao DESC1)",
    );
  });

  it("DESC3-resume: orchestrate_resume documenta HumanDecision bounded + caller humano + sem auto-resume", async () => {
    const m = await bootCtx({ models: ALL_MODELS, storage: makeStorage({}), options: PLUGIN_OPTS });
    const tool = m.tools.orchestrate_resume;
    assert.ok(tool, "tool orchestrate_resume existe");
    const desc = String(tool.description ?? "");
    assert.ok(desc.includes("requestID"), "requestID documentado");
    assert.ok(desc.includes("newMaxRounds"), "orcamento documentado");
    assert.ok(desc.includes("awaiting-human"), "boundary documentado");
    assert.ok(desc.includes("resume") && desc.includes("stop"), "as duas acoes documentadas");
    assert.match(desc, /humano|humana/i, "autoridade humana documentada");
    assert.ok(desc.includes("context.sessionID"), "caller vem do Tool.Context real");
    assert.ok(desc.includes("callerRole"), "callerRole explicitamente proibido");
    assert.match(desc, /auto-resume/i, "sem auto-resume documentado");
    assert.match(desc, /human-resume/, "mode human-resume documentado");
  });
});

describe("SCHEMA1-2: registration e input schema da orchestrate_resume", () => {
  it("SCHEMA1: tool em tools.jev (namespace jev + codemode), sem global underscore, contexto real 2.0.7", async () => {
    const m = await bootCtx({ models: ALL_MODELS, storage: makeStorage({}), options: PLUGIN_OPTS });
    const tool = m.tools.orchestrate_resume;
    assert.ok(tool, "tool orchestrate_resume deve existir");
    assert.equal(tool.options.namespace, "jev");
    assert.equal(tool.options.codemode, true);
    assert.equal(m.tools["jev_orchestrate_resume"], undefined, "nunca tool global com underscore");
    assert.equal(typeof tool.execute, "function");
    // Caller guard assenta no Tool.Context REAL do @opencode/plugin 2.0.7.
    const pkg = JSON.parse(readFileSync("node_modules/@opencode/plugin/package.json", "utf8"));
    assert.equal(pkg.version, "2.0.7", "plugin real 2.0.7 instalado");
    const schema = readFileSync("node_modules/@opencode/schema/dist/tool.d.ts", "utf8");
    assert.match(schema, /readonly sessionID: Session\.ID/, "Tool.Context real expoe sessionID");
    assert.match(schema, /interface Context/, "Tool.Context real e a fonte do caller");
  });

  it("SCHEMA2: input {runID, decision} additionalProperties=false; HumanDecision com 4 chaves bounded", async () => {
    const m = await bootCtx({ models: ALL_MODELS, storage: makeStorage({}), options: PLUGIN_OPTS });
    const input = m.tools.orchestrate_resume.input;
    assert.equal(input.type, "object");
    assert.deepEqual(input.required, ["runID", "decision"]);
    assert.equal(input.additionalProperties, false);
    assert.deepEqual(Object.keys(input.properties).sort(), ["decision", "runID"]);
    assert.equal(input.properties.runID.type, "string");
    const d = input.properties.decision;
    assert.equal(d.type, "object");
    assert.deepEqual(d.required, ["requestID", "action"]);
    assert.equal(d.additionalProperties, false, "HumanDecision sem chaves desconhecidas");
    assert.deepEqual(Object.keys(d.properties).sort(), ["action", "instruction", "newMaxRounds", "requestID"]);
    assert.equal(d.properties.requestID.type, "string");
    assert.deepEqual(d.properties.action.enum, ["resume", "stop"]);
    assert.equal(d.properties.instruction.type, "string");
    assert.equal(d.properties.instruction.maxLength, 1000, "instruction bounded");
    assert.equal(d.properties.newMaxRounds.type, "integer");
    assert.equal(d.properties.newMaxRounds.minimum, 1);
    assert.equal(d.properties.newMaxRounds.maximum, 100, "CONTRACT_LIMITS.maxRounds");
    // O schema NAO declara agent/model/sessionID/approved/revisedContract.
    for (const banned of ["agent", "model", "sessionID", "approved", "revisedContract", "callerRole"]) {
      assert.equal(d.properties[banned], undefined, `HumanDecision nunca declara ${banned}`);
    }
  });
});

// ═══════════════════════════ E2E (plugin real + runtime simulado + SystemOne stub) ═══════════════════════════

describe("E2E: orchestrate_once -> orchestrate_resume no entrypoint real do plugin", () => {
  it("E2E1 [real plugin entrypoint + simulated runtime + deterministic SystemOne stub]: pausa -> resume -> completed", async () => {
    const { m, stub, out, runID } = await pausedTool({
      runID: "e2e-resume",
      maxRounds: 1,
      judgeSeq: [humanAnswers(), acceptAnswers()],
    });
    try {
      // Pausa ja validada pela fixture; guarda o requestID deterministico.
      assert.equal(out.pendingHuman.requestID, "human:1:1:jev-human");
      const fetchesAfterPause = stub.calls.length;
      const pausePrompt = m.workerCalls.prompt.find((p) => p.metadata?.["jev-round"] === 1);
      assert.ok(pausePrompt && !pausePrompt.text.includes("HUMAN_INSTRUCTION"));

      const res = await m.tools.orchestrate_resume.execute(
        {
          runID,
          decision: {
            requestID: out.pendingHuman.requestID,
            action: "resume",
            newMaxRounds: 2,
            instruction: "Continue apenas no escopo declarado.",
          },
        },
        HUMAN_CALLER,
      );
      const resumed = JSON.parse(res.content);
      assert.equal(resumed.phase, "completed");
      assert.equal(resumed.round, 2);
      assert.deepEqual(resumed.pendingCommands, []);
      assert.equal(resumed.verdict.nextAction, "accept");
      assert.equal(resumed.selection, undefined, "sem reselecao no resume");
      assert.equal(resumed.rounds.length, 1, "apenas a rodada retomada nesta chamada");
      assert.equal(resumed.rounds[0].action, "human-resume");
      assert.equal(resumed.pendingHuman, undefined, "sem pausa pendente ao final");

      // Worker fresca (nunca a sessao pausada).
      const workers = m.workerCalls.create.filter((c) => c.metadata?.["jev-role"] === "worker");
      assert.equal(workers.length, 2, "worker nova somente apos decisao humana");
      assert.notEqual(resumed.worker.sessionID, out.worker.sessionID, "sessao realmente nova");
      assert.equal(workers[1].metadata["jev-round"], 2, "worker da rodada retomada");

      // Prompt da rodada retomada carrega a autorizacao humana bounded.
      const prompt = m.workerCalls.prompt.find(
        (p) => p.metadata?.["jev-round"] === 2 && p.metadata?.["jev-role"] === "worker",
      );
      assert.ok(prompt, "prompt da rodada retomada");
      assert.ok(prompt.text.includes("RECOVERY_ACTION: human-resume"));
      assert.ok(prompt.text.includes("HUMAN_INSTRUCTION: Continue apenas no escopo declarado."));
      assert.ok(prompt.text.includes("explicitly authorized by a human"));
      assert.ok(prompt.text.includes("Do not infer additional permissions"));
      assert.ok(prompt.text.includes("Do not declare approval"));
      assert.ok(prompt.text.includes("ROUND: 2/2"));

      // Auditoria da decisao na history projetada.
      const audited = resumed.history.find((h) => h.humanDecision);
      assert.ok(audited, "humanDecision auditado");
      assert.deepEqual(audited.humanDecision, {
        requestID: "human:1:1:jev-human",
        action: "resume",
        instruction: "Continue apenas no escopo declarado.",
        maxRoundsBefore: 1,
        maxRoundsAfter: 2,
      });
      assert.equal(resumed.history.length, 2, "history = rodada pausada + rodada retomada");

      // Nenhuma selecao de executor no resume: so o julgamento da rodada.
      const resumeFetches = stub.calls.slice(fetchesAfterPause);
      assert.equal(resumeFetches.length, 1, "apenas o judge da rodada retomada");
      assert.ok(resumeFetches.every((c) => !c.body?.questions?.route), "resume nunca roteia/seleciona");
      assert.ok(resumeFetches[0].body?.questions?.next_action, "julgamento SystemOne da rodada retomada");

      // Verdade do storage: human-awaiting -> human-decision (ready) -> completed.
      const runWrites = [];
      let i = 0;
      for (const w of m.ctx.storage._log) {
        if (w.key === `orchestration/run/${runID}`) {
          runWrites.push({ i, checkpoint: w.value.checkpoint, phase: w.value.state.phase, contract: w.value.state.contract });
        }
        i++;
      }
      const stored = m.storage._map.get(`orchestration/run/${runID}`);
      assert.equal(stored.state.phase, "completed");
      assert.equal(stored.state.contract.maxRounds, 2, "newMaxRounds aplicado e persistido");
      assert.ok(stored.workerSessionID === resumed.worker.sessionID, "record aponta a worker vigente");
      assert.ok(
        runWrites.some((w) => w.checkpoint === "human-awaiting"),
        "checkpoint human-awaiting observavel",
      );
      const decisionWrite = runWrites.find((w) => w.checkpoint === "human-decision");
      assert.ok(decisionWrite, "checkpoint human-decision observavel");
      assert.equal(decisionWrite.phase, "ready", "autoridade aplicada gravada antes de executar");
      assert.equal(decisionWrite.contract.maxRounds, 2, "orcamento novo gravado na decisao");
      assert.equal(runWrites[runWrites.length - 1].checkpoint, "verdict-applied");
    } finally {
      stub.restore();
    }
  });

  it("E2E2 [real plugin entrypoint + simulated runtime + deterministic SystemOne stub]: falha pos-resume -> storage em run-failed", async () => {
    const { m, stub, out, runID } = await pausedTool({
      runID: "e2e-fail",
      maxRounds: 1,
      judgeSeq: [humanAnswers()],
      judgeThrowAt: 1, // julgamento da rodada retomada falha
    });
    try {
      const res = await m.tools.orchestrate_resume.execute(
        { runID, decision: { requestID: out.pendingHuman.requestID, action: "resume", newMaxRounds: 2 } },
        HUMAN_CALLER,
      );
      const failed = JSON.parse(res.content);
      assert.equal(failed.phase, "failed", "API comunica a falha");
      assert.ok(failed.error && failed.error.includes("jev indisponivel"), failed.error);

      // Ninguem reescreve ready depois da falha: run-failed e a ultima verdade.
      const runWrites = [];
      let i = 0;
      for (const w of m.ctx.storage._log) {
        if (w.key === `orchestration/run/${runID}`) {
          runWrites.push({ i, checkpoint: w.value.checkpoint, phase: w.value.state.phase });
        }
        i++;
      }
      const decisionWrite = runWrites.find((w) => w.checkpoint === "human-decision");
      const failedWrite = runWrites.find((w) => w.checkpoint === "run-failed");
      assert.ok(decisionWrite, "human-decision persistido antes do scheduler");
      assert.equal(decisionWrite.phase, "ready", "autoridade aplicada (transitorio)");
      assert.ok(failedWrite, "run-failed persistido");
      assert.ok(failedWrite.i > decisionWrite.i, "run-failed vem DEPOIS de human-decision");
      assert.equal(failedWrite.i, runWrites[runWrites.length - 1].i, "nenhuma escrita apos run-failed");
      assert.equal(failedWrite.phase, "failed");

      const stored = m.storage._map.get(`orchestration/run/${runID}`);
      assert.equal(stored.checkpoint, "run-failed", "storage nao mostra ready quando a API falhou");
      assert.equal(stored.state.phase, "failed");
      assert.equal(stored.state.round, 2, "round da rodada que falhou");
      // Worker foi criada (decisao valida), mas o run terminou failed de verdade.
      const workers = m.workerCalls.create.filter((c) => c.metadata?.["jev-role"] === "worker");
      assert.equal(workers.length, 2, "rodada retomada chegou a criar worker antes da falha");
    } finally {
      stub.restore();
    }
  });
});
