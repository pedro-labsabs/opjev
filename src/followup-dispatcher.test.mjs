// Testes RED do consumo de follow-ups pelo Dispatcher (#13) — BOUNDARY DE RODADA.
//
// O pending-input bounded e consumido pelo control plane em um boundary ja
// governado (montagem do prompt da rodada, ownership do dispatcher/kernel):
//   - exatamente uma vez por messageID (registro consumido com round/boundary);
//   - sem nova rodada, sem nova transicao normativa, sem tocar maxRounds;
//   - falha do consumo nunca derruba a rodada (follow-up continua pendente).
import { test } from "node:test";
import assert from "node:assert/strict";

import { runOrchestrationOnce, buildWorkerPrompt } from "./orchestration/dispatcher.ts";
import {
  followupKey,
  followupIndexKey,
  normalizeFollowupRecord,
  buildFollowupRecord,
  createFollowupTakeSeam,
} from "./orchestration/followup.ts";

function contract(over = {}) {
  return {
    runID: "test-run-followup",
    objective: "Implementar o modulo auth",
    scope: { include: [], exclude: [] },
    constraints: ["nao alterar o runtime"],
    acceptanceCriteria: ["typecheck passa"],
    requiredEvidence: ["worker-session-outcome", "worker-final-response"],
    maxRounds: 3,
    ...over,
  };
}

const ACCEPT_ANSWERS = {
  done: { type: "noul", noul: 1 },
  failure_class: { type: "choice", choice: "none", probabilities: {}, confidence: 0.9 },
  same_executor_can_repair: { type: "noul", noul: 1 },
  next_action: { type: "choice", choice: "accept", probabilities: {}, confidence: 0.9 },
};

const REPAIR_ANSWERS = {
  done: { type: "noul", noul: 0 },
  failure_class: { type: "choice", choice: "implementation", probabilities: {}, confidence: 0.9 },
  same_executor_can_repair: { type: "noul", noul: 1 },
  next_action: { type: "choice", choice: "repair-same", probabilities: {}, confidence: 0.9 },
};

function fakeDeps(over = {}, storageSeed) {
  const store = new Map(Object.entries(storageSeed ?? {}));
  const storage = {
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
  const effects = [];
  const promptCalls = [];
  let workerSeq = 0;
  let judgeSeq = 0;
  const runtime = {
    createWorker: async () => {
      effects.push("create");
      workerSeq += 1;
      return { sessionID: over.workerSessionIDs?.[workerSeq - 1] ?? `w${workerSeq}` };
    },
    prompt: async ({ sessionID, text, metadata }) => {
      effects.push("prompt");
      promptCalls.push({ sessionID, text, metadata });
    },
    wait: async () => effects.push("wait"),
    get: async () => {
      effects.push("get");
      return over.view ?? { agent: "build", model: "opencode/big-pickle", outcome: "succeeded" };
    },
    context: async () => {
      effects.push("context");
      return over.messages ?? [{ type: "assistant", content: [{ type: "text", text: "ORCHESTRATION_WORKER_OK" }] }];
    },
    interrupt: async () => effects.push("interrupt"),
  };
  const critic = {
    createCritic: async () => ({ sessionID: "c1" }),
    prompt: async () => {},
    wait: async () => {},
    get: async () => ({ agent: "build", model: "opencode/big-pickle", outcome: "succeeded" }),
    context: async () => [{ type: "assistant", content: [{ type: "text", text: JSON.stringify({ findings: [] }) }] }],
    interrupt: async () => {},
  };
  const judgeAnswersSeq = over.judgeAnswersSeq ?? [ACCEPT_ANSWERS];
  const decisions = {
    selectExecutor: async () => ({ agent: "build", model: "opencode/big-pickle", via: "jev", route: "fast-coding", confidence: 0.9 }),
    judgeRound: async () => {
      effects.push("judge");
      const a = judgeAnswersSeq[judgeSeq] ?? judgeAnswersSeq[judgeAnswersSeq.length - 1];
      judgeSeq += 1;
      return a;
    },
    selectModel: async () => ({ model: "opencode/mimo-v2.5-free" }),
    selectAgent: async () => ({ agent: "plan" }),
  };
  const deps = {
    runtime,
    critic,
    decisions,
    ...(over.followups !== undefined ? { followups: over.followups } : {}),
  };
  return { deps, store, storage, effects, promptCalls };
}

async function seedFollowup(storage, runID, messageID, text = "cobrir tambem o caso X") {
  await storage.set(followupKey(runID, messageID), buildFollowupRecord({ sessionID: "ses_par", messageID, runID, text, at: 1 }));
  const prior = (await storage.get(followupIndexKey(runID))) ?? [];
  await storage.set(followupIndexKey(runID), [...prior, messageID]);
}

test("D1: rodada 2 (repair) consome o follow-up exatamente uma vez, com boundary observavel", async () => {
  const c = contract({ maxRounds: 3 });
  const { deps, store, promptCalls } = fakeDeps({ judgeAnswersSeq: [REPAIR_ANSWERS, ACCEPT_ANSWERS] }, {});
  const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  // O follow-up chega DURANTE o run (entre a rodada 1 e a 2): o attach e
  // simulado no judgeRound da rodada 1 — exatamente a janela real de um
  // follow-up de usuario durante um run ativo.
  const originalJudge = deps.decisions.judgeRound;
  let judgeCalls = 0;
  deps.decisions.judgeRound = async (input) => {
    judgeCalls += 1;
    if (judgeCalls === 1) await seedFollowup(storage, c.runID, "msg_D1");
    return originalJudge(input);
  };
  deps.followups = createFollowupTakeSeam({ storage, now: () => 5 });

  const result = await runOrchestrationOnce(c, deps);
  assert.equal(result.phase, "completed", "run segue ate completar");
  assert.equal(result.rounds.length, 2, "duas rodadas (initial + repair) — follow-up nao acrescenta rodada");
  assert.ok(result.rounds.length <= c.maxRounds, "maxRounds preservado");

  // o prompt da rodada 2 carrega a secao bounded de follow-ups
  assert.equal(promptCalls.length, 2, "dois prompts (uma rodada cada)");
  assert.equal(promptCalls[0].text.includes("SESSION_FOLLOWUPS"), false, "rodada 1 sem secao (nada pendente na montagem)");
  assert.ok(promptCalls[1].text.includes("SESSION_FOLLOWUPS"), "rodada 2 injeta a secao de follow-ups");
  assert.ok(promptCalls[1].text.includes("msg_D1"), "messageID visivel na rodada");
  assert.ok(promptCalls[1].text.includes("cobrir tambem o caso X"), "texto do follow-up preservado");

  // registro: consumido exatamente uma vez, no boundary da rodada 2
  const rec = normalizeFollowupRecord(store.get(followupKey(c.runID, "msg_D1")));
  assert.equal(rec.state, "consumed");
  assert.equal(rec.consumedRound, 2);
  assert.equal(rec.consumedBoundary, "round-2-worker-prompt");

  // replay de consumo: take de novo nao devolve nada
  const take = createFollowupTakeSeam({ storage, now: () => 6 });
  assert.deepEqual(await take(c.runID, 3), [], "exactly-once no consumo");
});

test("D2: follow-up anexado antes do build do prompt inicial e consumido na rodada 1 (janela de corrida)", async () => {
  const c = contract({ maxRounds: 1 });
  const { deps, store, promptCalls } = fakeDeps({}, {});
  const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  await seedFollowup(storage, c.runID, "msg_D2");
  deps.followups = createFollowupTakeSeam({ storage, now: () => 5 });

  const result = await runOrchestrationOnce(c, deps);
  assert.equal(result.phase, "completed");
  assert.ok(promptCalls[0].text.includes("SESSION_FOLLOWUPS"), "prompt inicial ja carrega o follow-up");
  assert.ok(promptCalls[0].text.includes("msg_D2"));
  const rec = normalizeFollowupRecord(store.get(followupKey(c.runID, "msg_D2")));
  assert.equal(rec.state, "consumed");
  assert.equal(rec.consumedRound, 1);
  assert.equal(rec.consumedBoundary, "round-1-worker-prompt");
});

test("D3: falha do consumo nunca derruba a rodada — follow-up continua pendente (fail-closed bounded)", async () => {
  const c = contract({ maxRounds: 1 });
  const { deps, store, promptCalls } = fakeDeps({}, {});
  const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  await seedFollowup(storage, c.runID, "msg_D3");
  deps.followups = {
    take: async () => {
      throw new Error("storage indisponivel");
    },
  };

  const result = await runOrchestrationOnce(c, deps);
  assert.equal(result.phase, "completed", "rodada segue sem a secao");
  assert.equal(promptCalls[0].text.includes("SESSION_FOLLOWUPS"), false, "sem secao");
  const rec = normalizeFollowupRecord(store.get(followupKey(c.runID, "msg_D3")));
  assert.equal(rec.state, "pending", "follow-up NAO e marcado consumido (nenhuma mentira)");
});

test("D4: sem o seam de follow-ups, o dispatcher fica EXATAMENTE como antes (regressao zero)", async () => {
  const c = contract({ maxRounds: 1 });
  const { deps, promptCalls } = fakeDeps({}, {});
  const result = await runOrchestrationOnce(c, deps);
  assert.equal(result.phase, "completed");
  assert.equal(promptCalls.length, 1);
  assert.equal(promptCalls[0].text.includes("SESSION_FOLLOWUPS"), false);
  // prompt igual ao canone: nenhuma secao extra inventada
  const canonical = buildWorkerPrompt(c, 1, 1);
  assert.equal(promptCalls[0].text, canonical);
});

test("D5: cap por rodada — excedente e consumido no boundary seguinte, cada item uma unica vez", async () => {
  const c = contract({ maxRounds: 3 });
  // run de 2 rodadas: repair na rodada 1, accept na rodada 2
  const judgeAnswersSeq = [REPAIR_ANSWERS, ACCEPT_ANSWERS];
  const { deps, store, promptCalls } = fakeDeps({ judgeAnswersSeq }, {});
  const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  const ids = ["msg_D5a", "msg_D5b", "msg_D5c", "msg_D5d", "msg_D5e", "msg_D5f", "msg_D5g"];
  for (const id of ids) await seedFollowup(storage, c.runID, id, "instrucao adicional sem id");
  deps.followups = createFollowupTakeSeam({ storage, now: () => 1 });

  const result = await runOrchestrationOnce(c, deps);
  assert.equal(result.phase, "completed");
  assert.equal(result.rounds.length, 2);
  const inRound = (text) => (text.match(/\[msg_D5[a-g]\]/g) ?? []);
  assert.equal(inRound(promptCalls[0].text).length, 5, "rodada 1 consome o cap (5)");
  assert.equal(inRound(promptCalls[1].text).length, 2, "rodada 2 consome o excedente (2)");
  for (const id of ids) {
    const rec = normalizeFollowupRecord(store.get(followupKey(c.runID, id)));
    assert.equal(rec.state, "consumed", `${id} consumido`);
  }
  // nenhum messageID aparece em mais de um prompt (exactly-once visivel)
  const round1 = new Set(inRound(promptCalls[0].text));
  const round2 = inRound(promptCalls[1].text);
  assert.equal(round2.filter((id) => round1.has(id)).length, 0, "sem sobreposicao entre rodadas");
});
