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
  followupRevisionKey,
  normalizeFollowupRecord,
  buildFollowupRecord,
  createFollowupTakeSeam,
} from "./orchestration/followup.ts";
import { sessionBindingKey } from "./orchestration/admission.ts";
import { createAdmissionOrchestrateHandler } from "./orchestration/admission-rpc.ts";

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    _map: map,
  };
}

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
    judgeRound: async (input) => {
      effects.push("judge");
      const a = judgeAnswersSeq[judgeSeq] ?? judgeAnswersSeq[judgeAnswersSeq.length - 1];
      judgeSeq += 1;
      if (input?.state?.pendingFollowupsCount > 0 && over.judgeRespectsPending !== false) {
        return REPAIR_ANSWERS;
      }
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

test("D6 [RED P1 2]: falha no runtime.prompt apos take/preparacao NAO deixa followup como consumed no storage", async () => {
  const c = contract({ maxRounds: 1 });
  const { deps, store, promptCalls } = fakeDeps({}, {});
  const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  await seedFollowup(storage, c.runID, "msg_D6");
  deps.followups = createFollowupTakeSeam({ storage, now: () => 5 });
  deps.storage = storage;

  // runtime.prompt falha ao tentar entregar o prompt contendo F
  deps.runtime.prompt = async () => {
    throw new Error("falha de conexao/network no prompt");
  };

  const res = await runOrchestrationOnce(c, deps);
  assert.equal(res.phase, "failed", "run deve falhar se o prompt falhar");

  const rec = normalizeFollowupRecord(store.get(followupKey(c.runID, "msg_D6")));
  assert.equal(rec.state, "pending", "followup deve continuar PENDING se o prompt falhou antes de ser entregue");
});

test("D7 [RED P1 2]: falha no meio do take de 2 follow-ups NAO deixa o primeiro como consumed se o take lancar erro", async () => {
  const store = fakeStorage();
  await store.set(followupKey("r1", "m1"), buildFollowupRecord({ sessionID: "s", messageID: "m1", runID: "r1", text: "f1", at: 1 }));
  await store.set(followupKey("r1", "m2"), buildFollowupRecord({ sessionID: "s", messageID: "m2", runID: "r1", text: "f2", at: 2 }));
  await store.set(followupIndexKey("r1"), ["m1", "m2"]);

  // Injeta falha no storage ao tentar gravar m2
  const origSet = store.set.bind(store);
  store.set = async (key, val) => {
    if (key.includes("m2")) throw new Error("falha de escrita no m2");
    return origSet(key, val);
  };

  const take = createFollowupTakeSeam({ storage: store, now: () => 10 });
  await assert.rejects(
    () => take("r1", 1),
    (err) => err.message.includes("falha de escrita no m2"),
  );

  const rec1 = normalizeFollowupRecord(await store.get(followupKey("r1", "m1")));
  assert.equal(rec1.state, "pending", "m1 deve permanecer PENDING se a operacao atomica do take falhar");
});

test("D8 [SCHEDULER / GOVERNANCE]: F chega apos prompt da rodada 1 -> Jev recebe snapshot com F e decide repair-same -> rodada 2 consome F -> worker recebe F no prompt -> run conclui; E tentativa de accept com F pendente e rejeitada pelo kernel", async () => {
  const c = contract({ maxRounds: 3 });

  // Parte 1: Se o Jev tentar emitir accept mesmo com F pendente no frontier, o kernel rejeita
  {
    const { deps, store } = fakeDeps({
      judgeAnswersSeq: [ACCEPT_ANSWERS],
      judgeRespectsPending: false, // Forca Jev a tentar accept mesmo com F pendente
    }, {});
    const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
    deps.followups = createFollowupTakeSeam({ storage, now: () => 5 });
    deps.storage = storage;

    // F chega apos prompt (durante wait) para permanecer pendente no frontier de julgamento
    const origWait = deps.runtime.wait;
    deps.runtime.wait = async (arg) => {
      await seedFollowup(storage, c.runID, "msg_D8_bad");
      return origWait(arg);
    };

    const res = await runOrchestrationOnce(c, deps);
    assert.equal(res.phase, "failed", "run deve falhar bounded porque kernel rejeitou accept com follow-up pendente");
    assert.ok(res.error?.includes("incompativel com follow-ups pendentes"), "diagnostico do kernel presente");
  }

  // Parte 2: Fluxo canonico — control plane captura frontier, Jev decide repair-same, rodada 2 consome F, run completa
  {
    const { deps, store, promptCalls } = fakeDeps({}, {});
    const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
    deps.followups = createFollowupTakeSeam({ storage, now: () => 10 });
    deps.storage = storage;

    // F chega apos o prompt da rodada 1 ter sido enviado (durante runtime.wait)
    const origWait = deps.runtime.wait;
    let waitCalls = 0;
    deps.runtime.wait = async (arg) => {
      waitCalls += 1;
      if (waitCalls === 1) {
        await seedFollowup(storage, c.runID, "msg_D8_late", "instrucao do follow-up tardio");
      }
      return origWait(arg);
    };

    let receivedJudgementState;
    const origJudge = deps.decisions.judgeRound;
    deps.decisions.judgeRound = async (arg) => {
      if (arg.state.round === 1) {
        receivedJudgementState = arg.state;
      }
      return origJudge(arg);
    };

    const res = await runOrchestrationOnce(c, deps);
    assert.equal(res.phase, "completed", "run completa com sucesso na rodada 2");
    assert.equal(res.rounds.length, 2, "executou exatamente 2 rodadas");

    // Jev recebeu o snapshot contendo F no julgamento da rodada 1
    assert.ok(receivedJudgementState, "Jev recebeu RoundJudgementState");
    assert.equal(receivedJudgementState.pendingFollowupsCount, 1, "Jev conhecia a contagem de follow-ups pendentes");
    assert.equal(receivedJudgementState.pendingFollowups?.[0]?.messageID, "msg_D8_late");
    assert.equal(receivedJudgementState.pendingFollowups?.[0]?.text, "instrucao do follow-up tardio");

    // Rodada 1 nao continha F no prompt; Rodada 2 continha F
    assert.equal(promptCalls.length, 2);
    assert.equal(promptCalls[0].text.includes("msg_D8_late"), false, "rodada 1 ja havia sido enviada");
    assert.ok(promptCalls[1].text.includes("SESSION_FOLLOWUPS"), "rodada 2 contem follow-up");
    assert.ok(promptCalls[1].text.includes("msg_D8_late"), "messageID presente na rodada 2");
    assert.ok(promptCalls[1].text.includes("instrucao do follow-up tardio"));

    // Follow-up verificado como consumed no storage
    const rec = normalizeFollowupRecord(store.get(followupKey(c.runID, "msg_D8_late")));
    assert.equal(rec.state, "consumed");
    assert.equal(rec.consumedRound, 2);
    assert.equal(rec.consumedBoundary, "round-2-worker-prompt");
  }
});

test("D9 [FENCING]: race onde F chega durante judgeRound invalida verdict stale e re-julga com frontier atualizado", async () => {
  const c = contract({ maxRounds: 3 });
  const { deps, store } = fakeDeps({}, {});
  const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  deps.followups = createFollowupTakeSeam({ storage, now: () => 15 });
  deps.storage = storage;

  let judgeCalls = 0;
  const origJudge = deps.decisions.judgeRound;
  deps.decisions.judgeRound = async (arg) => {
    judgeCalls += 1;
    if (judgeCalls === 1) {
      // Simula a race: F chega no meio do primeiro julgamento (revision muda de 0 para 1)
      await seedFollowup(storage, c.runID, "msg_D9_race", "race instruction");
      // Jev responde com base no snapshot anterior (stale)
      return ACCEPT_ANSWERS;
    }
    // Na segunda chamada (re-julgamento apos fencing detectar stale):
    if (judgeCalls === 2) {
      assert.equal(arg.state.pendingFollowupsCount, 1, "segundo julgamento recebe frontier atualizado");
    }
    return origJudge(arg); // retorna REPAIR_ANSWERS pois ha pending
  };

  const res = await runOrchestrationOnce(c, deps);
  assert.equal(res.phase, "completed");
  assert.equal(res.rounds.length, 2, "rodada 1 re-julgou e abriu rodada 2");
  assert.ok(judgeCalls >= 3, "judgeRound foi chamado pelo menos 3 vezes (2 na rodada 1 devido ao fencing, 1 na rodada 2)");

  const rec = normalizeFollowupRecord(store.get(followupKey(c.runID, "msg_D9_race")));
  assert.equal(rec.state, "consumed");
  assert.equal(rec.consumedRound, 2);
});

test("D10 [TWO-PHASE DELIVERY]: protocolo reserve -> prompt -> confirm garante que falha no prompt nunca deixa estado como consumed", async () => {
  const c = contract({ maxRounds: 2 });
  const { deps, store } = fakeDeps({}, {});
  const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  await seedFollowup(storage, c.runID, "msg_D10", "payload importante");
  deps.followups = createFollowupTakeSeam({ storage, now: () => 20 });
  deps.storage = storage;

  let promptAttempts = 0;
  deps.runtime.prompt = async () => {
    promptAttempts += 1;
    // Antes da entrega do prompt, o record esta em estado reserved no storage (nao consumed!)
    const midState = normalizeFollowupRecord(store.get(followupKey(c.runID, "msg_D10")));
    assert.equal(midState.state, "reserved", "durante a preparacao do prompt o estado e reserved, NUNCA consumed antecipado");
    assert.equal(midState.reservedRound, 1);
    throw new Error("falha fatal na entrega do prompt ao worker");
  };

  const res = await runOrchestrationOnce(c, deps);
  assert.equal(res.phase, "failed");

  // Apos falha, record NAO mente que foi consumed
  const finalState = normalizeFollowupRecord(store.get(followupKey(c.runID, "msg_D10")));
  assert.notEqual(finalState.state, "consumed", "nunca pode estar consumed se o worker nao recebeu");
});

test("D11 [TWO-PHASE DELIVERY / RECONCILIATION]: crash apos reserve antes do prompt deixa reserved, reconciliado deterministicamente na retomada", async () => {
  const c = contract({ maxRounds: 3 });
  const { deps, store, promptCalls } = fakeDeps({}, {});
  const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };

  // Followup ficou em estado 'reserved' na rodada 1 como se o processo tivesse caido
  await seedFollowup(storage, c.runID, "msg_D11_crash", "conteudo preservado");
  const seam = createFollowupTakeSeam({ storage, now: () => 5000, leaseMs: 1000 });
  deps.followups = seam;
  deps.storage = storage;

  // Forca o record a ficar 'reserved' com timestamp antigo (lease expirado)
  const reservedItem = normalizeFollowupRecord(store.get(followupKey(c.runID, "msg_D11_crash")));
  await storage.set(followupKey(c.runID, "msg_D11_crash"), {
    ...reservedItem,
    state: "reserved",
    reservedAt: 1, // no passado (5000 - 1 > 1000)
    reservedRound: 1,
  });

  // Na rodada 1, reserve detecta o reserved stale e o reconcilia
  const res = await runOrchestrationOnce(c, deps);
  assert.equal(res.phase, "completed");

  // Worker de fato recebeu o prompt com o follow-up recuperado
  assert.ok(promptCalls[0].text.includes("conteudo preservado"), "worker recebeu o follow-up reconciliado");
  const finalState = normalizeFollowupRecord(store.get(followupKey(c.runID, "msg_D11_crash")));
  assert.equal(finalState.state, "consumed", "follow-up consumido apos entrega real");
  assert.equal(finalState.consumedRound, 1);
});

test("D12 [TWO-PHASE DELIVERY / EXACTLY-ONCE]: falha no confirm apos prompt com sucesso propaga erro, preserva delivery receipt e reconcilia sem redelivery", async () => {
  const c = contract({ maxRounds: 2 });
  const { deps, store, promptCalls } = fakeDeps({}, {});

  let failConfirm = true;
  const storage = {
    get: (k) => store.get(k),
    set: async (k, v) => {
      // Falha ao confirmar gravacao do consumed no storage
      if (failConfirm && v && v.state === "consumed") {
        throw new Error("falha fatal no storage durante confirm");
      }
      store.set(k, v);
    },
  };
  await seedFollowup(storage, c.runID, "msg_D12", "payload confirm");
  deps.followups = createFollowupTakeSeam({ storage, now: () => 10 });
  deps.storage = storage;

  // Run deve falhar bounded porque confirm falhou (nao engolir silenciosamente)
  const res = await runOrchestrationOnce(c, deps);
  assert.equal(res.phase, "failed", "run falha bounded quando confirm do follow-up falha");
  assert.ok(res.error?.includes("storage durante confirm"));

  // Verificacao pos-falha do ambiguity window:
  // 1. Worker REALMENTE recebeu F no prompt
  assert.ok(promptCalls[0].text.includes("payload confirm"), "worker recebeu F antes da falha do confirm");

  // 2. F NUNCA volta para 'pending' (evita redelivery duplicate)
  const recAfterFail = normalizeFollowupRecord(store.get(followupKey(c.runID, "msg_D12")));
  assert.notEqual(recAfterFail.state, "pending", "F nao pode ser revertido para pending apos entrega real");
  assert.ok(recAfterFail.deliveredAt !== undefined, "delivery receipt gravado");

  // 3. Reconciliacao/retomada: storage recuperado reconcilia para 'consumed' e ZERO redelivery
  failConfirm = false;
  const seam = createFollowupTakeSeam({ storage, now: () => 20 });
  const recResult = await seam.reconcile(c.runID, 1);
  assert.ok(recResult.confirmed?.includes("msg_D12") || recResult.reconciled?.length === 0);
  const recState = normalizeFollowupRecord(store.get(followupKey(c.runID, "msg_D12")));
  assert.equal(recState.state, "consumed", "reconciliado para consumed");

  // 4. Nova tentativa de reserve nao devolve F
  const secondReserve = await seam.reserve(c.runID, 2);
  assert.equal(secondReserve.length, 0, "F nunca e redelivered");
});

test("D13 [LINEARIZATION / RACE]: corrida real via admission handler durante terminal fence -> F attachado lineariza antes do commit, força re-julgamento e consumo na rodada 2", async () => {
  const c = contract({ maxRounds: 3 });
  c.sessionID = "ses_D13";
  const { deps, store } = fakeDeps({}, {});
  const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  deps.followups = createFollowupTakeSeam({ storage, now: () => 10 });
  deps.storage = storage;

  // Inicializa binding como running
  await storage.set(sessionBindingKey(c.sessionID), { runID: c.runID, phase: "running", at: 1 });

  const admissionHandler = createAdmissionOrchestrateHandler({
    storage,
    runner: async () => {},
    publish: async () => {},
  });

  let judgeCount = 0;
  const origJudge = deps.decisions.judgeRound;
  deps.decisions.judgeRound = async (arg) => {
    judgeCount += 1;
    if (judgeCount === 1) {
      // Janela exata: avaliacao da rodada 1 completou e admission real de F chega antes do commit terminal
      const attachRes = await admissionHandler({
        sessionID: c.sessionID,
        messageID: "msg_D13_late",
        objective: "instrucao que chegou no fim via handler real",
      });
      assert.equal(attachRes.status, "followup-attached", "admission real anexou F ao run ativo");
      return ACCEPT_ANSWERS; // primeira tentativa tenta accept baseado no snapshot inicial
    }
    if (judgeCount === 2) {
      // Re-julgamento sob o shared boundary:
      assert.equal(arg.state.pendingFollowupsCount, 1, "segundo julgamento conhecia F anexado pelo handler");
      return origJudge(arg); // retorna REPAIR_ANSWERS pois ha pending
    }
    return origJudge(arg);
  };

  const res = await runOrchestrationOnce(c, deps);
  assert.equal(res.phase, "completed", "run deve completar apenas apos consumir F na rodada 2");
  assert.equal(res.rounds.length, 2, "executou 2 rodadas completas");

  // Follow-up consumido com boundary de entrega na rodada 2
  const rec = normalizeFollowupRecord(store.get(followupKey(c.runID, "msg_D13_late")));
  assert.equal(rec.state, "consumed");
  assert.equal(rec.consumedRound, 2);
  assert.equal(rec.consumedBoundary, "round-2-worker-prompt");
});

test("D13b [LINEARIZATION / RACE]: admission apos commit terminal ve binding terminal e NUNCA anexa ao run concluido", async () => {
  const c = contract({ maxRounds: 2 });
  c.sessionID = "ses_D13b";
  const { deps, store } = fakeDeps({}, {});
  const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  deps.followups = createFollowupTakeSeam({ storage, now: () => 10 });
  deps.storage = storage;

  await storage.set(sessionBindingKey(c.sessionID), { runID: c.runID, phase: "running", at: 1 });

  let newRunDispatched = false;
  const admissionHandler = createAdmissionOrchestrateHandler({
    storage,
    runner: async (contract) => {
      newRunDispatched = true;
      assert.notEqual(contract.runID, c.runID, "novo runID deve ser gerado, nunca anexar ao concluido");
    },
    publish: async () => {},
  });

  const res = await runOrchestrationOnce(c, deps);
  assert.equal(res.phase, "completed");

  // Binding agora esta terminal (completed)
  const binding = await storage.get(sessionBindingKey(c.sessionID));
  assert.equal(binding.phase, "completed");

  // Novo prompt chega apos terminalizacao: handler de admission DEVE iniciar novo fluxo, nunca followup-attached
  const afterOut = await admissionHandler({
    sessionID: c.sessionID,
    messageID: "msg_after_terminal",
    objective: "tarefa seguinte",
  });
  assert.notEqual(afterOut.status, "followup-attached", "nunca anexa follow-up a run terminal");
  assert.equal(afterOut.status, "started");
  assert.ok(newRunDispatched, "disparou nova execucao isolada");
});

test("D14 [FAIL-CLOSED]: erro de leitura no storage do frontier nunca vira pending=0 e falha o run bounded", async () => {
  const c = contract({ maxRounds: 2 });
  const { deps, store } = fakeDeps({}, {});
  const storage = {
    get: async (k) => {
      if (k.includes("followup")) {
        throw new Error("storage indisponivel / erro de rede");
      }
      return store.get(k);
    },
    set: async (k, v) => store.set(k, v),
  };
  deps.followups = createFollowupTakeSeam({ storage, now: () => 10 });
  deps.storage = storage;

  const res = await runOrchestrationOnce(c, deps);
  assert.equal(res.phase, "failed", "run deve falhar bounded em estado ambiguo do storage");
  assert.ok(res.error?.includes("storage indisponivel"), "diagnostico de erro de storage presente");
});

test("D14b [FAIL-CLOSED GRANULAR]: falhas individuais em index read, revision read ou record read impedem completed e falham bounded", async () => {
  const readTargets = [
    { name: "index read", match: (k, id) => k === followupIndexKey(id) },
    { name: "revision read", match: (k, id) => k === followupRevisionKey(id) },
    { name: "record read", match: (k, id) => k === followupKey(id, "msg_p12") },
  ];

  for (const target of readTargets) {
    const c = contract({ maxRounds: 2 });
    const { deps, store } = fakeDeps({}, {});
    await seedFollowup(store, c.runID, "msg_p12", "texto p12");
    const storage = {
      get: async (k) => {
        if (target.match(k, c.runID)) {
          throw new Error(`erro injetado de leitura: ${target.name}`);
        }
        return store.get(k);
      },
      set: async (k, v) => store.set(k, v),
    };
    deps.followups = createFollowupTakeSeam({ storage, now: () => 10 });
    deps.storage = storage;

    const res = await runOrchestrationOnce(c, deps);
    assert.equal(res.phase, "failed", `falha em ${target.name} DEVE falhar o run bounded e nunca virar completed`);
    assert.ok(res.error?.includes(target.name), `diagnostico de ${target.name} presente`);
  }
});


test("D15 [FAULT INJECTION / TERMINAL WRITE]: falha de storage ao gravar sessionBindingKey no commit terminal falha bounded e previne attach zumbi", async () => {
  const c = contract({ maxRounds: 2 });
  c.sessionID = "ses_D15";
  const { deps, store } = fakeDeps({}, {});

  let failTerminalBindingWrite = true;
  const storage = {
    get: (k) => store.get(k),
    set: async (k, v) => {
      if (failTerminalBindingWrite && k === sessionBindingKey(c.sessionID) && (v?.phase === "completed" || v?.phase === "stopped")) {
        throw new Error("storage falhou durante gravacao de binding terminal");
      }
      store.set(k, v);
    },
  };
  deps.followups = createFollowupTakeSeam({ storage, now: () => 10 });
  deps.storage = storage;

  await storage.set(sessionBindingKey(c.sessionID), { runID: c.runID, phase: "running", at: 1 });

  const res = await runOrchestrationOnce(c, deps);
  assert.equal(res.phase, "failed", "run deve falhar bounded quando write do binding terminal falha");
  assert.ok(res.error?.includes("binding terminal"));

  // Verifica que o binding nao ficou como 'completed' mentiroso
  const finalBinding = await storage.get(sessionBindingKey(c.sessionID));
  assert.equal(finalBinding.phase, "failed", "binding marcado como failed para nao aceitar follow-up zumbi");

  // Tentativa de attach via admission handler deve recusar anexar a run falhado
  const admissionHandler = createAdmissionOrchestrateHandler({
    storage,
    runner: async () => {},
    publish: async () => {},
  });
  const attachAttempt = await admissionHandler({
    sessionID: c.sessionID,
    messageID: "msg_D15_late",
    objective: "instrucao para run zumbi",
  });
  assert.notEqual(attachAttempt.status, "followup-attached", "nunca anexa a run cujo commit terminal falhou");
});

test("D16 [FAIL-CLOSED TRI-STATE]: erro transiente em runtime.context produz 'unknown' e NUNCA autoriza redelivery; retry bem-sucedido converge para consumed", async () => {
  const c = contract({ maxRounds: 2 });
  const { deps, store, promptCalls } = fakeDeps({}, {});
  const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  await seedFollowup(storage, c.runID, "msg_D16", "instrucao D16");

  // Simula crash após prompt ter sido recebido pelo worker mas antes do confirm/markDelivered
  // Nesse cenário, o record ficou 'reserved' com lease expirado e sem deliveredAt gravado
  const key = followupKey(c.runID, "msg_D16");
  await storage.set(key, {
    ...normalizeFollowupRecord(store.get(key)),
    state: "reserved",
    reservedAt: 1000,
    reservedRound: 1,
    reservedSessionID: "ses_worker_D16",
  });

  const seam = createFollowupTakeSeam({ storage, now: () => 100000 }); // lease expirado

  // 1. runtime.context lanca erro transiente (timeout/rede) => checkDelivered retorna "unknown"
  let contextShouldFail = true;
  const mockCheckDelivered = async (rec) => {
    if (!rec?.reservedSessionID) return "not-delivered";
    if (contextShouldFail) {
      throw new Error("timeout/rede no runtime.context"); // fail-closed!
    }
    return "delivered";
  };

  // Reconcile chamado sob erro transiente: NUNCA deve reverter para pending nem confirmar
  const recResFail = await seam.reconcile(c.runID, 2, { leaseMs: 1000, checkDelivered: mockCheckDelivered });
  assert.equal(recResFail.reconciled.length, 0, "nunca reverte para pending sob erro/ambiguidade");
  assert.equal(recResFail.confirmed?.length ?? 0, 0);

  // Reserve chamado sob erro transiente: NUNCA deve reservar para nova entrega (zero duplicate delivery)
  const resReserveFail = await seam.reserve(c.runID, 2, { leaseMs: 1000, checkDelivered: mockCheckDelivered });
  assert.equal(resReserveFail.length, 0, "fail-closed: nunca redeliver se status de entrega e unknown");

  // Estado continua reserved (bloqueado para redelivery)
  const recStillReserved = normalizeFollowupRecord(store.get(key));
  assert.equal(recStillReserved.state, "reserved");

  // 2. Erro transiente resolvido: runtime.context responde com sucesso confirmando entrega
  contextShouldFail = false;
  const recResSuccess = await seam.reconcile(c.runID, 2, { leaseMs: 1000, checkDelivered: mockCheckDelivered });
  assert.deepEqual(recResSuccess.confirmed, ["msg_D16"], "confirmado para consumed");

  const recFinal = normalizeFollowupRecord(store.get(key));
  assert.equal(recFinal.state, "consumed", "convergiu para consumed");
  assert.ok(recFinal.consumedBoundary?.includes("delivered-round-1"));

  // Tentativa subsequente de reserve: continua zero entregas
  const resReserveFinal = await seam.reserve(c.runID, 2, { leaseMs: 1000, checkDelivered: mockCheckDelivered });
  assert.equal(resReserveFinal.length, 0, "zero redelivery apos convergencia");
});

test("D17 [INTEGRATED ADMISSION / CLOSE HONESTY]: confirm falha depois do prompt entregue e o CALLBACK REAL do admission fecha o run sem converter F entregue em unconsumed", async () => {
  const store = new Map();
  const sessionID = "ses_D17";

  // Falha TRANSITORIA e one-shot no storage: apenas o confirm falha; o
  // reconciliamento posterior do closeFollowupsForRun precisa conseguir gravar.
  let failConfirmOnce = true;
  const storage = {
    get: async (k) => store.get(k),
    set: async (k, v) => {
      if (failConfirmOnce && v && v.state === "consumed") {
        failConfirmOnce = false;
        throw new Error("falha transitoria de storage durante confirm");
      }
      store.set(k, v);
    },
  };
  const seam = createFollowupTakeSeam({ storage, now: () => 10 });

  // O handler publica o notice terminal; a promise abaixo permite AGUARDAR o
  // callback real (nao uma simulacao).
  let resolveTerminal;
  const terminalDone = new Promise((r) => {
    resolveTerminal = r;
  });
  let runIDSeen;

  const handler = createAdmissionOrchestrateHandler({
    storage,
    // Runner = a RODADA real. Reproduz o caminho de producao: F chega e e
    // anexado ao run ATIVO enquanto ele executa, a rodada reserva F, entrega o
    // prompt ao worker (sucesso) e o confirm falha no storage.
    runner: async (executionContract) => {
      runIDSeen = executionContract.runID;
      // F anexado ao run ativo durante a execucao (o mesmo estado que
      // attachFollowupToActiveRun produz: record + index).
      await seedFollowup(storage, executionContract.runID, "msg_D17_followup", "instrucao entregue ao worker");
      const taken = await seam.reserve(executionContract.runID, 1, { sessionID: "worker_D17" });
      assert.equal(taken.length, 1, "F foi reservado para a rodada");
      await seam.markDelivered(executionContract.runID, taken, 1, "worker_D17");
      // confirm lanca => o runner propaga => o handler entra no callback terminal
      await seam.confirm(executionContract.runID, taken, 1);
      return { runID: executionContract.runID, phase: "completed" };
    },
    publish: async (_sessionID, text) => {
      resolveTerminal(text);
    },
  });

  // Sem binding previo => o handler DISPARA o runner de verdade (status started).
  const res = await handler({
    sessionID,
    messageID: "msg_D17_dispatch",
    objective: "tarefa que dispara o run ativo",
  });
  assert.equal(res.status, "started");
  assert.ok(res.runID, "runID do run despachado");

  // Aguarda o CALLBACK REAL do handler (fecha binding + closeFollowupsForRun).
  const notice = await terminalDone;
  assert.ok(String(notice).includes("failed"), `notice terminal deve refletir a falha do runner: ${notice}`);

  const binding = await storage.get(sessionBindingKey(sessionID));
  assert.equal(binding.phase, "failed", "callback terminal marcou o run como failed");

  // Verificacao crucial (#13 review): F FOI entregue ao worker (deliveredAt
  // gravado por markDelivered antes da falha do confirm). O fechamento do run
  // NUNCA pode classificar delivery comprovado como "unconsumed".
  const finalRecord = normalizeFollowupRecord(store.get(followupKey(runIDSeen, "msg_D17_followup")));
  assert.equal(finalRecord.state, "consumed", "NUNCA fecha follow-up entregue como unconsumed");
  assert.equal(finalRecord.consumedBoundary, "round-1-worker-prompt");
  assert.equal(finalRecord.consumedRound, 1);
  assert.ok(finalRecord.deliveredAt !== undefined, "prova de entrega preservada no record final");
  assert.ok(String(notice).includes("follow-ups consumidos: 1"), `notice contabiliza F como consumido: ${notice}`);
  assert.ok(String(notice).includes("nao consumidos: 0"), `notice nunca contabiliza delivery comprovado como nao consumido: ${notice}`);
});

test("D18 [TRANSIENT runtime.context]: F entregue e crash pre-receipt com leitura da sessao worker falhando NUNCA redelivera; convergencia apos recuperacao", async () => {
  const c = contract({ maxRounds: 2 });
  const { deps, store, promptCalls } = fakeDeps({ judgeAnswersSeq: [REPAIR_ANSWERS, ACCEPT_ANSWERS] }, {});
  const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  await seedFollowup(storage, c.runID, "msg_D18", "instrucao entregue antes do crash");

  // Estado pos-crash: runtime.prompt ENTREGOU F ao worker antigo, mas o
  // processo caiu antes do markDelivered/confirm => record segue "reserved",
  // sem deliveredAt, com lease expirado. A UNICA prova disponivel sobre a
  // entrega e a leitura do contexto da sessao worker antiga.
  const key = followupKey(c.runID, "msg_D18");
  await storage.set(key, {
    ...normalizeFollowupRecord(await storage.get(key)),
    state: "reserved",
    reservedAt: 1000,
    reservedRound: 1,
    reservedSessionID: "w_old_D18",
  });

  let contextBroken = true;
  const realContext = deps.runtime.context;
  deps.runtime.context = async ({ sessionID } = {}) => {
    if (sessionID === "w_old_D18") {
      if (contextBroken) throw new Error("timeout transitorio ao ler a sessao worker antiga");
      return [{ type: "user", id: "msg_D18", content: [{ type: "text", text: "instrucao entregue antes do crash" }] }];
    }
    return await realContext({ sessionID });
  };
  deps.followups = createFollowupTakeSeam({ storage, now: () => 100000 });

  const res = await runOrchestrationOnce(c, deps);
  assert.notEqual(res.phase, "completed", "run nao pode completar enquanto F esta em estado ambiguo");

  // Prova central: ZERO redelivery. Nenhum prompt entregue ao worker pode
  // conter F de novo enquanto a entrega anterior nao pode ser verificada.
  assert.ok(promptCalls.length > 0, "a rodada de ambiguidade executou");
  for (const call of promptCalls) {
    assert.ok(!call.text.includes("msg_D18"), "F jamais reentregue em prompt sob ambiguidade de entrega");
    assert.ok(!call.text.includes("instrucao entregue antes do crash"), "texto de F jamais reentregue");
  }
  const duringAmbiguity = normalizeFollowupRecord(store.get(key));
  assert.equal(duringAmbiguity.state, "reserved", "ambiguidade NUNCA reverte para pending (redelivery) nem marca consumed sem prova");
  assert.equal(duringAmbiguity.deliveredAt, undefined, "nenhuma prova de entrega foi inventada");

  // Recuperacao: a leitura da sessao worker antiga volta a responder e
  // DETECTA que F ja estava no input do worker => convergencia para consumed,
  // ainda sem reentregar F em nenhum prompt.
  contextBroken = false;
  const promptCallsBefore = promptCalls.length;
  const res2 = await runOrchestrationOnce(c, deps);
  const recoveryPrompts = promptCalls.slice(promptCallsBefore);
  assert.ok(recoveryPrompts.length > 0, "a rodada de recuperacao executou");
  for (const call of recoveryPrompts) {
    assert.ok(!call.text.includes("msg_D18"), "convergencia sem redelivery: F nao volta ao prompt");
  }
  assert.equal(res2.phase, "completed", "run completa apos reconciliar F como consumido");

  const finalRecord = normalizeFollowupRecord(store.get(key));
  assert.equal(finalRecord.state, "consumed", "convergiu para consumed ao detectar a entrega anterior");
  assert.equal(finalRecord.consumedRound, 1, "boundary aponta a rodada em que F foi realmente entregue");
  assert.equal(finalRecord.consumedBoundary, "round-1-worker-prompt");
});