// Testes de estabilização E2E multi-round (Issue #14)
// Matriz mínima obrigatória de 17 cenários do Orchestration Control Plane
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRunState, transitionRun } from "./orchestration/state-machine.ts";
import { OrchestrationError } from "./orchestration/types.ts";
import {
  WORKER_TIMEOUT_MS,
  buildWorkerPrompt,
  extractFinalAssistantText,
  runOrchestrationOnce,
  runOrchestrationResume,
} from "./orchestration/dispatcher.ts";
import {
  buildHumanRequest,
  validateHumanDecision,
  validateResumableRunState,
} from "./orchestration/human-gate.ts";
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
import { AdmissionRpc } from "./orchestration/admission-rpc.ts";
import { resumeLockCount } from "./orchestration/resume-lock.ts";

const PLUGIN_OPTS = {
  jevModel: "jev-1.13-free",
  jevEndpoint: "https://opencode.ai/zen/v1/systemone",
  apiKeyEnv: "OPENCODE_API_KEY",
  enableAutoRoute: false,
};

const ALL_MODELS = [
  "opencode/big-pickle",
  "opencode/mimo-v2.5-free",
  "opencode/ling-3.0-flash-fin-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/muse-spark-1.3-contributor-free",
];

async function bootCtx(over = {}) {
  const m = makeCtx(over);
  await pluginDefault.setup(m.ctx);
  return m;
}

function baseContract(over = {}) {
  return {
    runID: "e2e-matrix-run",
    objective: "Implementar auth e sanitizacao de tokens",
    scope: { include: ["src/auth.ts"], exclude: [] },
    constraints: ["usar stdlib crypto", "zero external dependencies"],
    acceptanceCriteria: ["typecheck passa", "testes passam"],
    requiredEvidence: ["worker-session-outcome", "worker-final-response"],
    maxRounds: 3,
    ...over,
  };
}

function acceptAnswers(confidence = 0.95) {
  return {
    done: { type: "noul", noul: 1.0 },
    failure_class: { type: "choice", choice: "none" },
    same_executor_can_repair: { type: "noul", noul: 1 },
    next_action: { type: "choice", choice: "accept", confidence },
  };
}

function repairAnswers(confidence = 0.9) {
  return {
    done: { type: "noul", noul: 0.0 },
    failure_class: { type: "choice", choice: "implementation" },
    same_executor_can_repair: { type: "noul", noul: 1 },
    next_action: { type: "choice", choice: "repair-same", confidence },
  };
}

describe("Issue #14 — Gate Definitivo de Estabilização E2E Multi-Round (17 Cenários)", () => {
  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Happy path → accept
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 1: Happy path → accept (round 1 completed com evidência limpa, sem worker auto-approval)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
      workerBehavior: {
        outcome: "succeeded",
        messages: [
          {
            id: "w1-msg",
            type: "assistant",
            content: [{ type: "text", text: "DONE_AUTH_IMPLEMENTED" }],
          },
        ],
      },
      criticBehavior: {
        outcome: "succeeded",
        messages: [
          {
            id: "c1-msg",
            type: "assistant",
            content: [{ type: "text", text: JSON.stringify({ findings: [] }) }],
          },
        ],
      },
    });

    stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
      }
      if (body?.questions?.done) {
        return okJev(acceptAnswers());
      }
      return okJev(acceptAnswers());
    });

    const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 3 }) });
    const out = JSON.parse(res.content);

    assert.equal(out.phase, "completed", "final phase deve ser completed");
    assert.equal(out.round, 1, "concluido na rodada 1");
    assert.equal(out.verdict.nextAction, "accept");
    assert.equal(out.rounds.length, 1);
    assert.equal(out.evidence.deterministicChecks.every((c) => c.status === "pass"), true, "todos checks pass");
    assert.equal(out.evidence.criticFindings.length, 0, "critic sem findings");

    // Worker isolado de critic: sessoes distintas criadas
    assert.ok(out.rounds[0].workerSessionID, "workerSessionID presente");
    assert.ok(out.rounds[0].criticSessionID, "criticSessionID presente");
    assert.notEqual(out.rounds[0].workerSessionID, out.rounds[0].criticSessionID, "worker e critic em sessoes distintas");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Critic encontra problema → Jev não aceita
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 2: Critic encontra problema → Jev não aceita (gate determinístico bloqueia accept se critic falha)", async () => {
    // Critic acha blocker e Jev desonesto tenta retornar accept -> kernel rejeita
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
      workerBehavior: {
        outcome: "succeeded",
        messages: [
          { id: "w-msg", type: "assistant", content: [{ type: "text", text: "WORKER_CLAIMS_SUCCESS" }] },
        ],
      },
      criticBehavior: {
        outcome: "succeeded",
        messages: [
          {
            id: "c-msg",
            type: "assistant",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  findings: [
                    { id: "f1", severity: "blocker", category: "correctness", summary: "Auth bypass detected", path: "src/auth.ts" },
                  ],
                }),
              },
            ],
          },
        ],
      },
    });

    stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
      }
      // Jev desonesto tenta aceitar mesmo com blocker
      return okJev(acceptAnswers());
    });

    const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 1 }) });
    const out = JSON.parse(res.content);

    // O gate determinístico bloqueia accept quando há hard failure: nunca vira completed
    assert.equal(out.phase, "failed", "hard failure deterministica nunca vira completed");
    assert.match(out.error ?? "", /deterministicChecks contem hard failure/, "mensagem diagnostica explicita");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. repair-same
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 3: repair-same (mesma workerSessionID, mesmo agent e model, novo critic, avanço de round)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
      workerBehavior: {
        outcomes: ["failed", "succeeded"],
        messagesByRound: [
          [{ id: "w1", type: "assistant", content: [{ type: "text", text: "WORKER_FAILED_ROUND_1" }] }],
          [{ id: "w2", type: "assistant", content: [{ type: "text", text: "WORKER_FIXED_ROUND_2" }] }],
        ],
      },
      criticBehavior: {
        messagesByRound: [
          [{ id: "c1", type: "assistant", content: [{ type: "text", text: JSON.stringify({ findings: [{ id: "f1", severity: "major", category: "correctness", summary: "Missing null check" }] }) }] }],
          [{ id: "c2", type: "assistant", content: [{ type: "text", text: JSON.stringify({ findings: [] }) }] }],
        ],
      },
    });

    let judgeCount = 0;
    stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
      }
      if (body?.questions?.done) {
        judgeCount += 1;
        return okJev(judgeCount === 1 ? repairAnswers() : acceptAnswers());
      }
      return okJev(acceptAnswers());
    });

    const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 3 }) });
    const out = JSON.parse(res.content);

    assert.equal(out.phase, "completed");
    assert.equal(out.round, 2, "concluido no round 2 apos repair-same");
    assert.equal(out.rounds.length, 2);

    // Invariante repair-same: mesma workerSessionID
    assert.equal(out.rounds[0].workerSessionID, out.rounds[1].workerSessionID, "workerSessionID reutilizado exatamente");
    assert.equal(out.rounds[0].agent, out.rounds[1].agent, "agent preservado");
    assert.equal(out.rounds[0].model, out.rounds[1].model, "model preservado");

    // Invariante critic: critic NUNCA e reutilizado, nova sessao em toda rodada
    assert.notEqual(out.rounds[0].criticSessionID, out.rounds[1].criticSessionID, "criticSessionID SEMPRE novo");

    const wSession = m.workerSessions.get(out.rounds[0].workerSessionID);
    assert.ok(wSession);
    assert.equal(wSession.prompts.length, 2, "dois prompts enviados para a mesma sessao");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. fresh-same
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 4: fresh-same (nova workerSessionID, mesmo agent e model, avanço de round)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
      workerBehavior: {
        outcomes: ["failed", "succeeded"],
        messagesByRound: [
          [{ id: "w1", type: "assistant", content: [{ type: "text", text: "WORKER_FAILED_ROUND_1" }] }],
          [{ id: "w2", type: "assistant", content: [{ type: "text", text: "WORKER_SUCCEEDED_ROUND_2" }] }],
        ],
      },
    });

    let judgeCount = 0;
    stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
      }
      if (body?.questions?.done) {
        judgeCount += 1;
        if (judgeCount === 1) {
          return okJev({
            done: { type: "noul", noul: 0 },
            failure_class: { type: "choice", choice: "implementation" },
            same_executor_can_repair: { type: "noul", noul: 1 },
            next_action: { type: "choice", choice: "fresh-same", confidence: 0.9 },
          });
        }
        return okJev(acceptAnswers());
      }
      return okJev(acceptAnswers());
    });

    const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 3 }) });
    const out = JSON.parse(res.content);

    assert.equal(out.phase, "completed");
    assert.equal(out.round, 2);
    assert.equal(out.rounds.length, 2);

    // Invariante fresh-same: sessao worker e NOVA, mas agent e model sao preservados
    assert.notEqual(out.rounds[0].workerSessionID, out.rounds[1].workerSessionID, "workerSessionID DEVE ser diferente (fresh)");
    assert.equal(out.rounds[0].agent, out.rounds[1].agent, "agent preservado");
    assert.equal(out.rounds[0].model, out.rounds[1].model, "model preservado");

    const workers = m.workerCalls.create.filter((c) => c.metadata?.["jev-role"] === "worker");
    assert.equal(workers.length, 2, "duas worker sessions criadas no total");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. switch-model
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 5: switch-model (troca explicita de modelo com filtro estrito ao FREE_POOL, fresh worker, tracking de tentativas)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
      workerBehavior: {
        outcomes: ["failed", "succeeded"],
        messagesByRound: [
          [{ id: "w1", type: "assistant", content: [{ type: "text", text: "WORKER_FAILED_MODEL_1" }] }],
          [{ id: "w2", type: "assistant", content: [{ type: "text", text: "WORKER_SUCCESS_MODEL_2" }] }],
        ],
      },
    });

    let judgeCount = 0;
    const selectedModel = "opencode/nemotron-3.5-lightning-free";
    stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
      }
      if (body?.questions?.done) {
        judgeCount += 1;
        if (judgeCount === 1) {
          return okJev({
            done: { type: "noul", noul: 0 },
            failure_class: { type: "choice", choice: "wrong-model" },
            same_executor_can_repair: { type: "noul", noul: 0 },
            next_action: { type: "choice", choice: "switch-model", confidence: 0.9 },
          });
        }
        return okJev(acceptAnswers());
      }
      if (body?.questions?.selected_model) {
        // Jev seleciona o novo modelo a partir dos candidatos via question selected_model
        return okJev({
          selected_model: { type: "choice", choice: selectedModel, confidence: 0.9 },
        });
      }
      return okJev(acceptAnswers());
    });

    const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 3 }) });
    const out = JSON.parse(res.content);

    assert.equal(out.phase, "completed");
    assert.equal(out.round, 2);
    assert.equal(out.rounds[0].model, "opencode/big-pickle");
    assert.equal(out.rounds[1].model, selectedModel);
    assert.ok(isFreeModel(out.rounds[1].model), "modelo selecionado pertence ao FREE_POOL");
    assert.notEqual(out.rounds[0].workerSessionID, out.rounds[1].workerSessionID, "fresh worker session");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. switch-agent
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 6: switch-agent (troca de agente com filtro primaryEligible no catalogo runtime, fresh worker)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      agents: ["build", "plan"],
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
      workerBehavior: {
        outcomes: ["failed", "succeeded"],
        messagesByRound: [
          [{ id: "w1", type: "assistant", content: [{ type: "text", text: "WORKER_FAILED_AGENT_BUILD" }] }],
          [{ id: "w2", type: "assistant", content: [{ type: "text", text: "WORKER_SUCCESS_AGENT_PLAN" }] }],
        ],
      },
    });

    let judgeCount = 0;
    stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
      }
      if (body?.questions?.done) {
        judgeCount += 1;
        if (judgeCount === 1) {
          return okJev({
            done: { type: "noul", noul: 0 },
            failure_class: { type: "choice", choice: "wrong-agent" },
            same_executor_can_repair: { type: "noul", noul: 0 },
            next_action: { type: "choice", choice: "switch-agent", confidence: 0.9 },
          });
        }
        return okJev(acceptAnswers());
      }
      if (body?.questions?.selected_agent) {
        return okJev({
          selected_agent: { type: "choice", choice: "plan", confidence: 0.9 },
        });
      }
      return okJev(acceptAnswers());
    });

    const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 3 }) });
    const out = JSON.parse(res.content);

    assert.equal(out.phase, "completed");
    assert.equal(out.round, 2);
    assert.equal(out.rounds[0].agent, "build");
    assert.equal(out.rounds[1].agent, "plan");
    assert.notEqual(out.rounds[0].workerSessionID, out.rounds[1].workerSessionID);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. replan
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 7: replan (fase planning, orchestrator isolado read-only, revisao validada sem aumento de maxRounds, fresh worker round 2)", async () => {
    const revisedContract = {
      runID: "e2e-matrix-replan",
      objective: "Objetivo reformulado e delimitado com passos menores",
      scope: { include: ["src/auth.ts"], exclude: [] },
      constraints: ["usar stdlib crypto"],
      acceptanceCriteria: ["testes passam"],
      requiredEvidence: ["worker-session-outcome", "worker-final-response"],
      maxRounds: 3,
    };

    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
      workerBehavior: {
        outcomes: ["failed", "succeeded"],
        messagesByRound: [
          [{ id: "w1", type: "assistant", content: [{ type: "text", text: "WORKER_FAILED_ROUND_1" }] }],
          [{ id: "w2", type: "assistant", content: [{ type: "text", text: "WORKER_SUCCESS_ROUND_2" }] }],
        ],
      },
    });

    // Injetamos a resposta do orchestrator via context
    const originalContext = m.ctx.session.context;
    m.ctx.session.context = async ({ sessionID }) => {
      const w = m.workerSessions.get(sessionID);
      if (w?.metadata?.["jev-role"] === "orchestrator") {
        return [
          {
            id: "orch-msg",
            type: "assistant",
            content: [{ type: "text", text: JSON.stringify(revisedContract) }],
          },
        ];
      }
      return await originalContext({ sessionID });
    };

    let judgeCount = 0;
    stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
      }
      if (body?.questions?.done) {
        judgeCount += 1;
        if (judgeCount === 1) {
          return okJev({
            done: { type: "noul", noul: 0 },
            failure_class: { type: "choice", choice: "bad-contract" },
            same_executor_can_repair: { type: "noul", noul: 0 },
            next_action: { type: "choice", choice: "replan", confidence: 0.9 },
          });
        }
        return okJev(acceptAnswers());
      }
      return okJev(acceptAnswers());
    });

    const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ runID: "e2e-matrix-replan", maxRounds: 3 }) });
    const out = JSON.parse(res.content);

    assert.equal(out.phase, "completed");
    assert.equal(out.round, 2);

    // Orquestrador foi criado como sessao read-only com role orchestrator
    const orchCreates = m.workerCalls.create.filter((c) => c.metadata?.["jev-role"] === "orchestrator");
    assert.equal(orchCreates.length, 1, "exatamente 1 sessao orchestrator criada");
    assert.ok(
      orchCreates[0].permissions?.some((p) => p.effect === "deny" && p.action === "edit"),
      "orchestrator possui politica read-only negando mutacao",
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. human + resume
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 8: human + resume (pausa awaiting-human com requestID deterministico, lock serializa concorrencia, retomada explicita fecha run)", async () => {
    const storage = makeStorage({});
    const m = await bootCtx({
      models: ALL_MODELS,
      storage,
      options: PLUGIN_OPTS,
      workerBehavior: {
        outcomes: ["failed", "succeeded"],
        messagesByRound: [
          [{ id: "w1", type: "assistant", content: [{ type: "text", text: "WORKER_STOPPED_FOR_HUMAN" }] }],
          [{ id: "w2", type: "assistant", content: [{ type: "text", text: "WORKER_RESUMED_AND_SUCCEEDED" }] }],
        ],
      },
    });

    let judgeCount = 0;
    stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
      }
      if (body?.questions?.done) {
        judgeCount += 1;
        if (judgeCount === 1) {
          return okJev({
            done: { type: "noul", noul: 0 },
            failure_class: { type: "choice", choice: "missing-context" },
            same_executor_can_repair: { type: "noul", noul: 0 },
            next_action: { type: "choice", choice: "human", confidence: 0.95 },
          });
        }
        return okJev(acceptAnswers());
      }
      return okJev(acceptAnswers());
    });

    const runID = "e2e-matrix-human";
    // 1. Execucao inicial entra em pausa
    const res1 = await m.tools.orchestrate_once.execute({ contract: baseContract({ runID, maxRounds: 3 }) });
    const out1 = JSON.parse(res1.content);

    assert.equal(out1.phase, "awaiting-human", "run pausou em awaiting-human");
    assert.ok(out1.pendingHuman?.requestID, "requestID deterministico presente");
    const reqID = out1.pendingHuman.requestID;

    // 2. Protecao de caller role: sessao de worker e REJEITADA
    const fakeWorkerContext = { sessionID: out1.rounds[0].workerSessionID };
    const rejectRes = await m.tools.orchestrate_resume.execute(
      { runID, decision: { requestID: reqID, action: "resume" } },
      fakeWorkerContext,
    );
    assert.match(rejectRes.content, /chamada interna de orchestration.*somente um humano/, "caller interno rejeitado");

    // 3. Concorrencia deterministica: duas chamadas simultaneas sobrepostas para o mesmo runID+requestID
    const humanContext = { sessionID: "user-human-session" };
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    let enteredResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    let gated = false;

    // Intercepta a criacao/prompt do worker da rodada 2 para segurar o winner na secao critica
    const origPrompt = m.ctx.session.prompt;
    m.ctx.session.prompt = async (args) => {
      if (!gated && args?.metadata?.["jev-role"] === "worker" && args?.metadata?.["jev-round"] === 2) {
        gated = true;
        enteredResolve();
        await gate;
      }
      return origPrompt(args);
    };

    const tool = m.tools.orchestrate_resume;
    const origExecute = tool.execute;
    const events = [];
    let seq = 0;
    tool.execute = async function (input, context) {
      const id = events.filter((e) => e.t === "enter").length;
      events.push({ t: "enter", id, s: seq++ });
      try {
        return await origExecute.call(this, input, context);
      } finally {
        events.push({ t: "exit", id, s: seq++ });
      }
    };

    const resumePayload = { runID, decision: { requestID: reqID, action: "resume" } };
    const both = Promise.all([
      tool.execute(resumePayload, humanContext),
      tool.execute(resumePayload, humanContext),
    ]);

    // Aguarda o winner entrar na execucao da rodada 2 enquanto o loser esta em voo
    await entered;
    releaseGate();
    const [r1, r2] = await both;

    const parseResume = (r) => {
      try { return { ok: true, data: JSON.parse(r.content) }; }
      catch { return { ok: false, content: String(r.content) }; }
    };
    const parsed1 = parseResume(r1);
    const parsed2 = parseResume(r2);
    const wins = [parsed1, parsed2].filter((p) => p.ok && p.data.phase === "completed");
    const losses = [parsed1, parsed2].filter((p) => !p.ok || p.data.phase !== "completed");

    // Prova de concorrencia real (overlap temporal comprovado)
    const enters = events.filter((e) => e.t === "enter").map((e) => e.s).sort((a, b) => a - b);
    const exits = events.filter((e) => e.t === "exit").map((e) => e.s).sort((a, b) => a - b);
    assert.equal(enters.length, 2, "duas chamadas de resume entraram");
    assert.equal(exits.length, 2, "duas chamadas de resume sairam");
    assert.ok(enters[1] < exits[0], "a segunda chamada comecou ANTES da primeira terminar (overlap real)");

    // Prova de resultado estrito
    assert.equal(wins.length, 1, "exatamente 1 winner completou com sucesso");
    assert.equal(losses.length, 1, "exatamente 1 loser rejeitado");
    assert.equal(wins[0].data.phase, "completed", "winner concluiu em completed");
    assert.equal(wins[0].data.round, 2, "round incrementado uma unica vez (1 -> 2)");
    assert.match(losses[0].content, /invalid-resumable-run|invalid-human-decision/, "loser rejeitado bounded");

    // Verificacao de persistencia e contagem de sessoes
    const hdRecords = m.ctx.storage._log.filter(
      (w) => w.key === `orchestration/run/${runID}` && w.value?.checkpoint === "human-decision"
    );
    assert.equal(hdRecords.length, 1, "exatamente 1 record human-decision persistido");

    const r2Workers = m.workerCalls.create.filter(
      (c) => c.metadata?.["jev-role"] === "worker" && c.metadata?.["jev-round"] === 2
    );
    assert.equal(r2Workers.length, 1, "exatamente 1 worker instanciado para o round 2");

    const r2Critics = m.workerCalls.create.filter(
      (c) => c.metadata?.["jev-role"] === "critic" && c.metadata?.["jev-round"] === 2
    );
    assert.equal(r2Critics.length, 1, "exatamente 1 critic instanciado para o round 2");

    assert.equal(resumeLockCount(), 0, "lock de concorrencia devidamente liberado apos a conclusao");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. stop
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 9: stop (terminação imediata em stopped sem novas rodadas nem sessões)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
      workerBehavior: {
        outcome: "failed",
        messages: [{ id: "w1", type: "assistant", content: [{ type: "text", text: "CANNOT_PROCEED" }] }],
      },
    });

    stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
      }
      return okJev({
        done: { type: "noul", noul: 0 },
        failure_class: { type: "choice", choice: "bad-contract" },
        same_executor_can_repair: { type: "noul", noul: 0 },
        next_action: { type: "choice", choice: "stop", confidence: 0.99 },
      });
    });

    const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 3 }) });
    const out = JSON.parse(res.content);

    assert.equal(out.phase, "stopped", "fase final deve ser stopped");
    assert.equal(out.round, 1);
    assert.equal(out.rounds.length, 1, "zero novas rodadas executadas");

    // Zero worker sessions adicionais
    const workers = m.workerCalls.create.filter((c) => c.metadata?.["jev-role"] === "worker");
    assert.equal(workers.length, 1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. Worker timeout / interrupted
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 10: worker timeout/interrupted (interrupção bounded, deterministic check fail, fase failed sem hang)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
      workerBehavior: {
        outcome: "interrupted",
        messages: [{ id: "w-hang", type: "assistant", content: [{ type: "text", text: "" }] }],
      },
    });

    // Simulamos timeout disparando interrupt
    m.ctx.session.wait = async () => {
      if (m.ctx.session.interrupt) {
        await m.ctx.session.interrupt({ sessionID: "worker-1" });
      }
      throw new Error("worker execution timed out after limit");
    };

    stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
      }
      return okJev(acceptAnswers());
    });

    const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 2 }) });
    const out = JSON.parse(res.content);

    assert.equal(out.phase, "failed", "timeout resulta em failed");
    assert.equal(out.worker.outcome, "interrupted", "worker registrado como interrupted");
    assert.match(out.error ?? "", /timed out/, "erro diagnostico bounded");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. Critic timeout / failure
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 11: critic timeout/failure (critic crash/output invalido -> critic-session-outcome=fail, bloqueia auto-approval)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
      workerBehavior: {
        outcome: "succeeded",
        messages: [{ id: "w-ok", type: "assistant", content: [{ type: "text", text: "WORKER_CLEAN_RESULT" }] }],
      },
      criticBehavior: {
        outcome: "failed",
        messages: [{ id: "c-err", type: "assistant", content: [{ type: "text", text: "INVALID_NON_JSON_OUTPUT_CORRUPTED" }] }],
      },
    });

    stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
      }
      // Jev tenta aceitar, mas gate deterministico vai barrar
      return okJev(acceptAnswers());
    });

    const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 1 }) });
    const out = JSON.parse(res.content);

    assert.equal(out.phase, "failed", "critic failure bloqueia completed via accept");
    assert.match(out.error ?? "", /deterministicChecks contem hard failure/, "failing check critic-session-outcome impede accept");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. Jev unavailable / timeout
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 12: Jev unavailable/timeout (falha 500 do Jev aborta boundedly sem loop infinito nem crash)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
      workerBehavior: {
        outcome: "succeeded",
        messages: [{ id: "w-ok", type: "assistant", content: [{ type: "text", text: "WORKER_RESULT" }] }],
      },
    });

    stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
      }
      // Jev retorna HTTP 500
      return new Response(JSON.stringify({ error: "SystemOne 500 Internal Server Error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 2 }) });
    const out = JSON.parse(res.content);

    assert.equal(out.phase, "failed", "Jev indisponivel resulta em fase failed");
    assert.match(out.error ?? "", /HTTP 500|SystemOne/, "erro capturado bounded");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 13. Provider / global throttle
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 13: provider/global throttle (detecta 429/rate-limit e aborta com switch-throttled sem criar storm de workers)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
      workerBehavior: {
        outcome: "failed",
        messages: [
          {
            id: "w-rate",
            type: "assistant",
            content: [{ type: "text", text: "429 Too Many Requests: provider rate limit exceeded for all tenants" }],
          },
        ],
      },
    });

    stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
      }
      // Jev tenta trocar de modelo sob throttle global
      return okJev({
        done: { type: "noul", noul: 0 },
        failure_class: { type: "choice", choice: "environment" },
        same_executor_can_repair: { type: "noul", noul: 0 },
        next_action: { type: "choice", choice: "switch-model", confidence: 0.9 },
      });
    });

    const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 3 }) });
    const out = JSON.parse(res.content);

    assert.equal(out.phase, "failed");
    assert.match(out.error ?? "", /switch-throttled|throttle global/, "detectou throttle e bloqueou storm");

    // Zero worker sessions adicionais foram criadas
    const workers = m.workerCalls.create.filter((c) => c.metadata?.["jev-role"] === "worker");
    assert.equal(workers.length, 1, "apenas 1 worker criada, nenhuma subsequente sob throttle");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 14. maxRounds exhaustion
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 14: maxRounds exhaustion (esgotamento de budget pausa em awaiting-human com kind max-rounds, round nunca excede limite)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
      workerBehavior: {
        outcome: "failed",
        messages: [{ id: "w-fail", type: "assistant", content: [{ type: "text", text: "STILL_FAILING" }] }],
      },
    });

    stubFetch(async ({ body }) => {
      if (body?.questions?.route) {
        return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
      }
      // Sempre pede repair-same
      return okJev(repairAnswers());
    });

    // Contrato com maxRounds: 2
    const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 2 }) });
    const out = JSON.parse(res.content);

    assert.equal(out.phase, "awaiting-human", "esgotamento de maxRounds pausa em awaiting-human");
    assert.equal(out.round, 2, "round NUNCA excede maxRounds");
    assert.equal(out.pendingHuman?.kind, "max-rounds", "human request tipado como max-rounds");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 15. Tentativa de recursão por sessão interna
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 15: tentativa de recursão por sessão interna (bypass em prompt hook, admission RPC e resume tool)", async () => {
    // 15a: Prompt hook bypass para sessões internas (worker, critic, orchestrator)
    const mPrompt = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({}),
      options: { ...PLUGIN_OPTS, enableAutoRoute: true },
    });

    for (const role of ["worker", "critic", "orchestrator"]) {
      const s = await mPrompt.ctx.session.create({
        metadata: {
          "jev-role": role,
          "jev-router": "orchestration-internal",
        },
      });
      const promptEvent = {
        sessionID: s.id,
        prompt: { text: "execute recursion step" },
        metadata: {},
      };
      await mPrompt.hooks.session.prompt(promptEvent);
      assert.equal(promptEvent.metadata["jev-router"], "orchestration-internal", `hook seta jev-router para ${role}`);
      assert.equal(promptEvent.metadata["jev-role"], role, `hook preserva jev-role para ${role}`);
      const routeRecord = mPrompt.ctx.storage._map.get(`route/${s.id}`);
      assert.equal(routeRecord, undefined, `zero storage route escrito para ${role}`);
    }

    const storage = makeStorage({});
    const m = await bootCtx({
      models: ALL_MODELS,
      storage,
      options: PLUGIN_OPTS,
    });

    // Cria a sessão de worker usando o runtime do context com markers internos
    const internalWorker = await m.ctx.session.create({
      metadata: {
        "jev-role": "worker",
        "jev-router": "orchestration-internal",
      },
    });
    const internalSessionID = internalWorker.id;

    // 15b: Admission RPC com sessao interna retorna internal-bypass sem criar run nem record
    let dispatched = 0;
    const { createAdmissionOrchestrateHandler } = await import("./orchestration/admission-rpc.ts");
    const rpcHandler = createAdmissionOrchestrateHandler({
      storage,
      runner: async () => {
        dispatched += 1;
        return { runID: "test", phase: "completed" };
      },
      publish: async () => {},
      isInternalSession: async (sid) => sid === internalSessionID,
    });

    const rpcRes = await rpcHandler({
      sessionID: internalSessionID,
      messageID: "msg-1",
      objective: "Recursion attempt",
    });

    assert.equal(rpcRes.status, "internal-bypass", "admission rpc retorna internal-bypass");
    assert.equal(dispatched, 0, "zero runs disparados via sessao interna");

    // 15c: orchestrate_resume com caller interno registrado e rejeitado com erro diagnostico
    const resumeRes = await m.tools.orchestrate_resume.execute(
      { runID: "any-run", decision: { requestID: "req-1", action: "resume" } },
      { sessionID: internalSessionID },
    );
    assert.match(resumeRes.content, /chamada interna de orchestration.*somente um humano/, "caller interno bloqueado");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 16. Agent / model candidate inválido
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 16: agent/model candidate inválido (rejeita modelos pagos, inexistentes, agentes desconhecidos e não primários)", async () => {
    // 16a: switch-model com modelo fora do FREE_POOL (ex: gpt-4o pago)
    {
      const m = await bootCtx({
        models: ALL_MODELS,
        storage: makeStorage({}),
        options: PLUGIN_OPTS,
        workerBehavior: {
          outcome: "failed",
          messages: [{ id: "w-fail", type: "assistant", content: [{ type: "text", text: "FAIL" }] }],
        },
      });

      stubFetch(async ({ body }) => {
        if (body?.questions?.route) {
          return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
        }
        if (body?.questions?.done) {
          return okJev({
            done: { type: "noul", noul: 0 },
            failure_class: { type: "choice", choice: "wrong-model" },
            same_executor_can_repair: { type: "noul", noul: 0 },
            next_action: { type: "choice", choice: "switch-model", confidence: 0.9 },
          });
        }
        if (body?.questions?.selected_model) {
          return okJev({
            selected_model: { type: "choice", choice: "openai/gpt-4o", confidence: 0.99 },
          });
        }
        return okJev(acceptAnswers());
      });

      const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 2 }) });
      const out = JSON.parse(res.content);

      assert.equal(out.phase, "failed");
      assert.match(out.error ?? "", /fora dos candidatos validos|invalid-selection/, "modelo fora do FREE_POOL rejeitado");
      const r2Workers = m.workerCalls.create.filter((c) => c.metadata?.["jev-round"] === 2);
      assert.equal(r2Workers.length, 0, "zero workers criados na rodada 2 para modelo fora do pool");
    }

    // 16b: switch-model com modelo inexistente / não elegível no catálogo
    {
      const m = await bootCtx({
        models: ALL_MODELS,
        storage: makeStorage({}),
        options: PLUGIN_OPTS,
        workerBehavior: {
          outcome: "failed",
          messages: [{ id: "w-fail", type: "assistant", content: [{ type: "text", text: "FAIL" }] }],
        },
      });

      stubFetch(async ({ body }) => {
        if (body?.questions?.route) {
          return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
        }
        if (body?.questions?.done) {
          return okJev({
            done: { type: "noul", noul: 0 },
            failure_class: { type: "choice", choice: "wrong-model" },
            same_executor_can_repair: { type: "noul", noul: 0 },
            next_action: { type: "choice", choice: "switch-model", confidence: 0.9 },
          });
        }
        if (body?.questions?.selected_model) {
          return okJev({
            selected_model: { type: "choice", choice: "fake-provider/nonexistent-model", confidence: 0.99 },
          });
        }
        return okJev(acceptAnswers());
      });

      const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 2 }) });
      const out = JSON.parse(res.content);

      assert.equal(out.phase, "failed");
      assert.match(out.error ?? "", /fora dos candidatos validos|invalid-selection/, "modelo inexistente rejeitado");
      const r2Workers = m.workerCalls.create.filter((c) => c.metadata?.["jev-round"] === 2);
      assert.equal(r2Workers.length, 0, "zero workers criados na rodada 2 para modelo inexistente");
    }

    // 16c: switch-agent com agente desconhecido (não existe no runtime)
    {
      const m = await bootCtx({
        models: ALL_MODELS,
        storage: makeStorage({}),
        options: PLUGIN_OPTS,
        workerBehavior: {
          outcome: "failed",
          messages: [{ id: "w-fail", type: "assistant", content: [{ type: "text", text: "FAIL" }] }],
        },
      });

      stubFetch(async ({ body }) => {
        if (body?.questions?.route) {
          return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
        }
        if (body?.questions?.done) {
          return okJev({
            done: { type: "noul", noul: 0 },
            failure_class: { type: "choice", choice: "wrong-agent" },
            same_executor_can_repair: { type: "noul", noul: 0 },
            next_action: { type: "choice", choice: "switch-agent", confidence: 0.9 },
          });
        }
        if (body?.questions?.selected_agent) {
          return okJev({
            selected_agent: { type: "choice", choice: "unknown-rogue-agent", confidence: 0.99 },
          });
        }
        return okJev(acceptAnswers());
      });

      const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 2 }) });
      const out = JSON.parse(res.content);

      assert.equal(out.phase, "failed");
      assert.match(out.error ?? "", /nao existe no catalogo|invalid-selection/, "agente desconhecido rejeitado");
      const r2Workers = m.workerCalls.create.filter((c) => c.metadata?.["jev-round"] === 2);
      assert.equal(r2Workers.length, 0, "zero workers criados na rodada 2 para agente desconhecido");
    }

    // 16d: switch-agent com agente conhecido mas não primaryEligible (ex: mode: subagent)
    {
      const m = await bootCtx({
        models: ALL_MODELS,
        agents: ["build", "plan", { id: "explore", name: "explore", mode: "subagent" }],
        storage: makeStorage({}),
        options: PLUGIN_OPTS,
        workerBehavior: {
          outcome: "failed",
          messages: [{ id: "w-fail", type: "assistant", content: [{ type: "text", text: "FAIL" }] }],
        },
      });

      stubFetch(async ({ body }) => {
        if (body?.questions?.route) {
          return okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle" }));
        }
        if (body?.questions?.done) {
          return okJev({
            done: { type: "noul", noul: 0 },
            failure_class: { type: "choice", choice: "wrong-agent" },
            same_executor_can_repair: { type: "noul", noul: 0 },
            next_action: { type: "choice", choice: "switch-agent", confidence: 0.9 },
          });
        }
        if (body?.questions?.selected_agent) {
          return okJev({
            selected_agent: { type: "choice", choice: "explore", confidence: 0.99 },
          });
        }
        return okJev(acceptAnswers());
      });

      const res = await m.tools.orchestrate_once.execute({ contract: baseContract({ maxRounds: 2 }) });
      const out = JSON.parse(res.content);

      assert.equal(out.phase, "failed");
      assert.match(out.error ?? "", /nao elegivel como primary|invalid-selection/, "agente nao-primary rejeitado");
      const r2Workers = m.workerCalls.create.filter((c) => c.metadata?.["jev-round"] === 2);
      assert.equal(r2Workers.length, 0, "zero workers criados na rodada 2 para agente nao-primary");
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 17. Stale evidence / evidence da rodada errada
  // ─────────────────────────────────────────────────────────────────────────────
  it("Cenário 17: stale evidence / evidence da rodada errada (EVIDENCE_READY com round inconsistente e rejeitado deterministamente)", () => {
    const c = baseContract({ maxRounds: 3 });
    let state = createRunState(c);
    state = transitionRun(state, { type: "CONTRACT_READY" }).state;
    state = transitionRun(state, { type: "EXECUTION_STARTED", executor: { agent: "build", model: "opencode/big-pickle", sessionID: "w1" } }).state;
    state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "succeeded" }).state;

    assert.equal(state.phase, "evaluating");
    assert.equal(state.round, 1);

    // Stale evidence: rodada 2 quando state.round === 1
    const staleEvidence = {
      round: 2, // round mismatch!
      executor: { agent: "build", model: "opencode/big-pickle", sessionID: "w1" },
      outcome: "succeeded",
      deterministicChecks: [{ name: "worker-session-outcome", status: "pass" }],
      criticFindings: [],
      resultSummary: "ok",
    };

    assert.throws(
      () => {
        transitionRun(state, { type: "EVIDENCE_READY", evidence: staleEvidence });
      },
      (err) => {
        assert.ok(err instanceof OrchestrationError);
        assert.equal(err.code, "invalid-evidence");
        assert.match(err.message, /expected round 1, received round 2/);
        return true;
      },
      "stale evidence deve disparar OrchestrationError(invalid-evidence)",
    );
  });
});
