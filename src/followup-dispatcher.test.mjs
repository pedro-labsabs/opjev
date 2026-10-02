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
import { sessionBindingKey } from "./orchestration/admission.ts";

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

test("D12 [TWO-PHASE DELIVERY]: falha no confirm apos prompt com sucesso propaga erro e nao esconde inconsistencia", async () => {
  const c = contract({ maxRounds: 2 });
  const { deps, store } = fakeDeps({}, {});

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
});

test("D13 [LINEARIZATION / RACE]: F chega apos ultimo fence do judge e antes da persistencia terminal -> detectado no shared boundary, re-julga e consome em rodada 2", async () => {
  const c = contract({ maxRounds: 3 });
  c.sessionID = "ses_D13";
  const { deps, store } = fakeDeps({}, {});
  const storage = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  deps.followups = createFollowupTakeSeam({ storage, now: () => 10 });
  deps.storage = storage;

  // Inicializa binding como running
  await storage.set(sessionBindingKey(c.sessionID), { runID: c.runID, phase: "running", at: 1 });

  let judgeCount = 0;
  const origJudge = deps.decisions.judgeRound;
  deps.decisions.judgeRound = async (arg) => {
    judgeCount += 1;
    if (judgeCount === 1) {
      // Simula a janela exata: judgeRound terminou a avaliacao da rodada 1 e vai emitir accept.
      // Nesse exato instante (antes do shared boundary persistir terminal), F linearizou no storage.
      await seedFollowup(storage, c.runID, "msg_D13_late", "instrucao que chegou no fim");
      return ACCEPT_ANSWERS; // primeira tentativa tenta accept baseado no snapshot inicial
    }
    if (judgeCount === 2) {
      // Na segunda chamada (re-julgamento sob o shared boundary):
      assert.equal(arg.state.pendingFollowupsCount, 1, "segundo julgamento conhecia F");
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
