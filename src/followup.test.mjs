// Testes RED do pending-input bounded de follow-up (#13) — MODULO.
//
// Contrato (#13): sessao S -> run R ativo -> follow-up F -> F continua R
//   => identidade/provenance suficientes (messageID, sessionID, runID, estado,
//      boundary de consumo), storage bounded, consumo exactly-once.
//
// Sem rede: storage fake (get/set), lock real (withKeyedLock).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FOLLOWUP_LIMITS,
  followupKey,
  followupIndexKey,
  followupRevisionKey,
  buildFollowupRecord,
  normalizeFollowupRecord,
  readFollowupIndex,
  formatFollowupsSection,
  createFollowupTakeSeam,
  closeFollowupsForRun,
  getInputFrontier,
} from "./orchestration/followup.ts";

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

const R = "auto-ses_x-msg_A-0123456789ab";

test("F1: buildFollowupRecord preserva provenance completa e faz bound do texto", () => {
  const rec = buildFollowupRecord({
    sessionID: "ses_x",
    messageID: "msg_F",
    runID: R,
    text: "adicione o teste X",
    at: 1234,
  });
  assert.equal(rec.messageID, "msg_F", "qual messageID originou");
  assert.equal(rec.sessionID, "ses_x", "qual sessao recebeu");
  assert.equal(rec.runID, R, "qual run possui");
  assert.equal(rec.state, "pending", "ainda nao consumido");
  assert.equal(rec.text, "adicione o teste X");
  assert.equal(rec.at, 1234);

  // bound: texto maior que o limite e truncado deterministicamente
  const long = "x".repeat(FOLLOWUP_LIMITS.text + 500);
  const rec2 = buildFollowupRecord({ sessionID: "ses_x", messageID: "msg_F", runID: R, text: long, at: 1 });
  assert.ok(rec2.text.length <= FOLLOWUP_LIMITS.text, `texto capped (${rec2.text.length})`);
  assert.ok(rec2.text.length < long.length, "conteudo descartado para manter bound");

  // fail-closed: identidade invalida nunca vira record
  assert.throws(() => buildFollowupRecord({ sessionID: "", messageID: "msg_F", runID: R, text: "a", at: 1 }));
  assert.throws(() => buildFollowupRecord({ sessionID: "ses_x", messageID: "msg_F", runID: "", text: "a", at: 1 }));
  assert.throws(() => buildFollowupRecord({ sessionID: "ses_x", messageID: "msg_F", runID: R, text: "", at: 1 }));
});

test("F2: normalizeFollowupRecord e fail-closed (forma desconhecida => erro bounded)", () => {
  const good = buildFollowupRecord({ sessionID: "ses_x", messageID: "msg_F", runID: R, text: "t", at: 5 });
  assert.equal(normalizeFollowupRecord(good).messageID, "msg_F");
  assert.equal(normalizeFollowupRecord(JSON.parse(JSON.stringify(good))).state, "pending");

  // consumido com boundary observavel
  const consumed = { ...good, state: "consumed", consumedAt: 9, consumedBoundary: "round-2-worker-prompt", consumedRound: 2 };
  const nc = normalizeFollowupRecord(consumed);
  assert.equal(nc.state, "consumed");
  assert.equal(nc.consumedBoundary, "round-2-worker-prompt");
  assert.equal(nc.consumedRound, 2);

  for (const bad of [undefined, null, "x", 42, [], {}, { messageID: "m" }]) {
    assert.throws(() => normalizeFollowupRecord(bad), `forma invalida rejeitada: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => normalizeFollowupRecord({ ...good, state: "weird" }), "estado desconhecido rejeitado");
});

test("F3: chaves determinísticas e index bounded", () => {
  assert.equal(followupKey(R, "msg_F"), `orchestration/followup/${R}/msg_F`);
  assert.equal(followupIndexKey(R), `orchestration/followup-index/${R}`);
  assert.deepEqual(readFollowupIndex(["a", "b"]), ["a", "b"]);
  assert.deepEqual(readFollowupIndex(undefined), []);
  assert.throws(() => readFollowupIndex("x"), "index nao-array rejeitado");
  assert.throws(() => readFollowupIndex([1, 2]), "index com nao-strings rejeitado");
  assert.throws(
    () => readFollowupIndex(Array.from({ length: FOLLOWUP_LIMITS.perRun + 1 }, (_, i) => `m${i}`)),
    "index acima do cap rejeitado",
  );
});

test("F4: take seam — consumo exactly-once com boundary observavel e ordem do index", async () => {
  const store = fakeStorage();
  const take = createFollowupTakeSeam({ storage: store, now: () => 777 });
  // dois follow-ups pendentes do mesmo run
  for (const [i, mid] of [["0", "msg_1"], ["1", "msg_2"]].values()) {
    await store.set(followupKey(R, mid), buildFollowupRecord({ sessionID: "ses_x", messageID: mid, runID: R, text: `f${mid}`, at: Number(i) }));
  }
  await store.set(followupIndexKey(R), ["msg_1", "msg_2"]);

  const taken = await take(R, 2);
  assert.equal(taken.length, 2, "todos os pendentes da rodada");
  assert.deepEqual(taken.map((t) => t.messageID), ["msg_1", "msg_2"], "ordem do index (attach)");
  assert.equal(taken[0].text, "fmsg_1");

  const rec1 = normalizeFollowupRecord(await store.get(followupKey(R, "msg_1")));
  assert.equal(rec1.state, "consumed", "marcado consumido");
  assert.equal(rec1.consumedBoundary, "round-2-worker-prompt", "boundary governado registrado");
  assert.equal(rec1.consumedRound, 2);
  assert.equal(rec1.consumedAt, 777);

  // replay do take: ZERO consumo adicional (exactly-once)
  const again = await take(R, 3);
  assert.deepEqual(again, [], "segunda take nao consome de novo");
});

test("F5: take seam — cap por rodada, registros ausentes/invalidos ignorados (bounded)", async () => {
  const store = fakeStorage();
  const take = createFollowupTakeSeam({ storage: store, now: () => 1 });
  const ids = Array.from({ length: FOLLOWUP_LIMITS.perRound + 2 }, (_, i) => `msg_${i}`);
  for (const mid of ids) {
    await store.set(followupKey(R, mid), buildFollowupRecord({ sessionID: "s", messageID: mid, runID: R, text: "t", at: 1 }));
  }
  await store.set(followupIndexKey(R), ["msg_missing", "not-a-record", ...ids]);
  const taken = await take(R, 1);
  assert.equal(taken.length, FOLLOWUP_LIMITS.perRound, "cap perRound respeitado");
  assert.deepEqual(taken.map((t) => t.messageID), ids.slice(0, FOLLOWUP_LIMITS.perRound));

  // sobrou pendente: proxima take consome o restante (bounded por rodada)
  const rest = await take(R, 2);
  assert.deepEqual(rest.map((t) => t.messageID), ids.slice(FOLLOWUP_LIMITS.perRound));
});

test("F6: take concorrente serializa por run — soma dos consumos = pendentes (exactly-once)", async () => {
  const store = fakeStorage();
  const take = createFollowupTakeSeam({ storage: store, now: () => 1 });
  const ids = Array.from({ length: FOLLOWUP_LIMITS.perRound + 1 }, (_, i) => `msg_c${i}`);
  for (const mid of ids) {
    await store.set(followupKey(R, mid), buildFollowupRecord({ sessionID: "s", messageID: mid, runID: R, text: "t", at: 1 }));
  }
  await store.set(followupIndexKey(R), ids);
  // duas takes concorrentes do mesmo run: cada record e consumido UMA vez
  const [a, b] = await Promise.all([take(R, 1), take(R, 1)]);
  const all = [...a, ...b].map((t) => t.messageID);
  assert.equal(new Set(all).size, all.length, "nenhum messageID duplicado entre takes concorrentes");
  assert.equal(all.length, ids.length, "todos os pendentes consumidos exatamente uma vez");
});

test("F6b [RESERVED CRASH RECOVERY]: crash apos reserve deixa record reserved -> reconcilia deterministicamente sem perder F nem autorizar redelivery ambigua", async () => {
  let currentTime = 100;
  const store = fakeStorage();
  const seam = createFollowupTakeSeam({ storage: store, now: () => currentTime, leaseMs: 5000 });

  await store.set(followupKey(R, "msg_crash"), buildFollowupRecord({ sessionID: "s", messageID: "msg_crash", runID: R, text: "t_crash", at: 1 }));
  await store.set(followupIndexKey(R), ["msg_crash"]);

  // 1. Processo reserva F para rodada 1
  const reserved = await seam.reserve(R, 1, { sessionID: "worker_dead" });
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].messageID, "msg_crash");

  const recReserved = normalizeFollowupRecord(await store.get(followupKey(R, "msg_crash")));
  assert.equal(recReserved.state, "reserved");

  // Input frontier conta reserved como pendente (fail-closed, nunca ignora trabalho pendente)
  const frontierBefore = await seam.getFrontier(R);
  assert.equal(frontierBefore.pendingCount, 1);

  // 2. Simula crash: nenhum prompt aconteceu, lease expira
  currentTime += 10000;

  // 3. Proxima rodada (rodada 2) com outro worker: reconcile ou reserve re-adquire o item stale apos comprovado not-delivered
  const checkDeliveryNotDelivered = async () => "not-delivered";
  const recon = await seam.reconcile(R, 2, { checkDelivered: checkDeliveryNotDelivered });
  assert.deepEqual(recon.reconciled, ["msg_crash"]);

  const recReconciled = normalizeFollowupRecord(await store.get(followupKey(R, "msg_crash")));
  assert.equal(recReconciled.state, "pending", "item stale sem entrega reverte para pending");

  // 4. Nova reserva na rodada 2 tem sucesso
  const reReserved = await seam.reserve(R, 2, { sessionID: "worker_alive" });
  assert.equal(reReserved.length, 1);
  assert.equal(reReserved[0].messageID, "msg_crash");

  // 5. Teste de fail-closed: se checkDelivery for "unknown", NUNCA reverte nem re-reserva
  currentTime += 10000;
  const checkDeliveryUnknown = async () => "unknown";
  const reconAmbiguous = await seam.reconcile(R, 3, { checkDelivered: checkDeliveryUnknown });
  assert.deepEqual(reconAmbiguous.reconciled, [], "sob ambiguidade, reconcile nao toca no estado");
});

test("F6c [P1.4 RESERVED RECOVERY SUITE]: cobre crash pre-prompt, prompt failure, prompt sucesso + crash pre-confirm, confirm failure e restart/retry", async () => {
  let currentTime = 1000;
  const store = fakeStorage();
  const seam = createFollowupTakeSeam({ storage: store, now: () => currentTime, leaseMs: 5000 });

  // 1. Crash apos reserve antes de runtime.prompt:
  await store.set(followupKey(R, "msg_pre_prompt"), buildFollowupRecord({ sessionID: "s", messageID: "msg_pre_prompt", runID: R, text: "t1", at: 1 }));
  await store.set(followupIndexKey(R), ["msg_pre_prompt"]);
  const res1 = await seam.reserve(R, 1, { sessionID: "worker_1" });
  assert.equal(res1.length, 1);
  // Simula crash antes do prompt: nenhum prompt enviado. Lease expira.
  currentTime += 10000;
  // Reconcile com checkDelivered confirmando que nao foi entregue reverte para pending
  const rec1 = await seam.reconcile(R, 2, { checkDelivered: async () => "not-delivered" });
  assert.deepEqual(rec1.reconciled, ["msg_pre_prompt"]);
  assert.equal((await store.get(followupKey(R, "msg_pre_prompt"))).state, "pending");

  // 2. Runtime.prompt falha (erro de rede/timeout antes do worker processar):
  const res2 = await seam.reserve(R, 2, { sessionID: "worker_2" });
  assert.equal(res2.length, 1);
  // prompt falhou -> revertFollowupConsumption chamado
  const { revertFollowupConsumption } = await import("./orchestration/followup.ts");
  await revertFollowupConsumption({ storage: store }, R, res2);
  assert.equal((await store.get(followupKey(R, "msg_pre_prompt"))).state, "pending");

  // 3. Runtime.prompt sucesso + crash antes de confirm:
  // Prompt tem sucesso -> markDelivered registra deliveredAt
  const res3 = await seam.reserve(R, 2, { sessionID: "worker_3" });
  await seam.markDelivered(R, res3, 2, "worker_3");
  // Crash acontece antes do confirm(): record continua reserved mas com deliveredAt gravado
  const recDelivered = await store.get(followupKey(R, "msg_pre_prompt"));
  assert.equal(recDelivered.state, "reserved");
  assert.ok(recDelivered.deliveredAt !== undefined);
  // Reconcile/restart apos crash detecta deliveredAt ou checkDelivered e confirma como consumed sem redelivery
  currentTime += 10000;
  const rec3 = await seam.reconcile(R, 3, { checkDelivered: async () => "delivered" });
  assert.deepEqual(rec3.confirmed, ["msg_pre_prompt"]);
  const finalRec3 = await store.get(followupKey(R, "msg_pre_prompt"));
  assert.equal(finalRec3.state, "consumed");

  // 4. Confirm storage failure: prompt teve sucesso, markDelivered gravado, confirm falha com erro de storage
  await store.set(followupKey(R, "msg_confirm_fail"), buildFollowupRecord({ sessionID: "s", messageID: "msg_confirm_fail", runID: R, text: "t2", at: 1 }));
  await store.set(followupIndexKey(R), ["msg_pre_prompt", "msg_confirm_fail"]);
  const res4 = await seam.reserve(R, 3, { sessionID: "worker_4" });
  await seam.markDelivered(R, res4, 3, "worker_4");
  // Na falha do confirm, o dispatcher NAO reverte para pending porque deliveredAt esta presente
  await revertFollowupConsumption({ storage: store }, R, res4);
  const recAfterRevertAttempt = await store.get(followupKey(R, "msg_confirm_fail"));
  assert.notEqual(recAfterRevertAttempt.state, "pending", "nunca reverte para pending apos entrega confirmada");
  // No restart/retry, reconcile confirma como consumed
  const rec4 = await seam.reconcile(R, 4, { checkDelivered: async () => "delivered" });
  assert.deepEqual(rec4.confirmed, ["msg_confirm_fail"]);
  assert.equal((await store.get(followupKey(R, "msg_confirm_fail"))).state, "consumed");

  // 5. Restart/retry com reserved existente:
  // Novo reserve no run nunca devolve itens ja consumidos
  const resEmpty = await seam.reserve(R, 5);
  assert.equal(resEmpty.length, 0, "zero redelivery de follow-ups consumidos");
});

test("F7: closeFollowupsForRun — contabiliza consumidos e fecha pendentes como unconsumed", async () => {

  const store = fakeStorage();
  const take = createFollowupTakeSeam({ storage: store, now: () => 1 });
  await store.set(followupKey(R, "msg_1"), buildFollowupRecord({ sessionID: "s", messageID: "msg_1", runID: R, text: "t", at: 1 }));
  await store.set(followupKey(R, "msg_2"), buildFollowupRecord({ sessionID: "s", messageID: "msg_2", runID: R, text: "t", at: 2 }));
  await store.set(followupIndexKey(R), ["msg_1", "msg_2"]);
  // cap default por rodada e 5: limita a rodada a 1 para consumir so msg_1
  const take1 = createFollowupTakeSeam({ storage: store, now: () => 1, perRound: 1 });
  await take1(R, 1); // msg_1 consumido; msg_2 continua pendente

  const counts = await closeFollowupsForRun({ storage: store, now: () => 42 }, R);
  assert.deepEqual(counts, { consumed: 1, pending: 1 });
  const rec2 = normalizeFollowupRecord(await store.get(followupKey(R, "msg_2")));
  assert.equal(rec2.state, "unconsumed", "pendente fechado honestamente (run terminal)");
  assert.equal(rec2.consumedBoundary, "run-finished-without-consumption");
  assert.equal(rec2.consumedAt, 42);

  // idempotente: fechar de novo nao muda nada
  const again = await closeFollowupsForRun({ storage: store, now: () => 99 }, R);
  assert.deepEqual(again, { consumed: 1, pending: 1 });
  const rec2b = normalizeFollowupRecord(await store.get(followupKey(R, "msg_2")));
  assert.equal(rec2b.consumedAt, 42, "nunca re-carimba");
});

test("F7b: closeFollowupsForRun — follow-up com deliveredAt NUNCA fecha como unconsumed (reconcilia honestamente como consumed)", async () => {
  const store = fakeStorage();
  // msg_deliv foi entregue (deliveredAt presente, estado reserved)
  await store.set(
    followupKey(R, "msg_deliv"),
    {
      ...buildFollowupRecord({ sessionID: "s", messageID: "msg_deliv", runID: R, text: "t", at: 1 }),
      state: "reserved",
      deliveredAt: 10,
      reservedRound: 1,
    },
  );
  // msg_pending continua puramente pending
  await store.set(
    followupKey(R, "msg_pending"),
    buildFollowupRecord({ sessionID: "s", messageID: "msg_pending", runID: R, text: "t", at: 2 }),
  );
  await store.set(followupIndexKey(R), ["msg_deliv", "msg_pending"]);

  const counts = await closeFollowupsForRun({ storage: store, now: () => 50 }, R);
  // msg_deliv virou consumed (+1), msg_pending virou unconsumed (+1)
  assert.deepEqual(counts, { consumed: 1, pending: 1 });

  const recDeliv = normalizeFollowupRecord(await store.get(followupKey(R, "msg_deliv")));
  assert.equal(recDeliv.state, "consumed", "item entregue deve fechar como consumed, nunca unconsumed");
  assert.equal(recDeliv.consumedRound, 1);
  assert.equal(recDeliv.consumedBoundary, "round-1-worker-prompt");
  assert.equal(recDeliv.consumedAt, 50);

  const recPend = normalizeFollowupRecord(await store.get(followupKey(R, "msg_pending")));
  assert.equal(recPend.state, "unconsumed");
  assert.equal(recPend.consumedBoundary, "run-finished-without-consumption");
});

test("F8: formatFollowupsSection — bounded, com messageID e texto; vazio => string vazia", () => {
  const items = [
    { messageID: "msg_1", text: "também rode o teste Y" },
    { messageID: "msg_2", text: "z".repeat(FOLLOWUP_LIMITS.text + 100) },
  ];
  const section = formatFollowupsSection(items, 2);
  assert.ok(section.includes("SESSION_FOLLOWUPS"));
  assert.ok(section.includes("msg_1"), "messageID visivel");
  assert.ok(section.includes("também rode o teste Y"), "texto preservado");
  assert.ok(section.length < 6000, `secao bounded (${section.length})`);
  assert.equal(formatFollowupsSection([], 2), "");
});

test("F9 [P1.2 FAIL-CLOSED FRONTIER]: erros de leitura em index, revision ou record propagam e NUNCA viram pendingCount=0", async () => {
  // 1. Falha de leitura em followup index read
  const store1 = fakeStorage();
  await store1.set(followupIndexKey(R), ["msg_1"]);
  const failingIndexStore = {
    async get(key) {
      if (key === followupIndexKey(R)) throw new Error("storage disk error: index read");
      return store1.get(key);
    },
    async set(key, value) { return store1.set(key, value); },
  };
  await assert.rejects(
    () => getInputFrontier({ storage: failingIndexStore }, R),
    (err) => err.message.includes("index read"),
    "index read error DEVE propagar e nunca virar pendingCount=0",
  );

  // 2. Falha de leitura em followup revision read
  const store2 = fakeStorage();
  await store2.set(followupIndexKey(R), ["msg_1"]);
  const failingRevStore = {
    async get(key) {
      if (key === followupRevisionKey(R)) throw new Error("storage disk error: revision read");
      return store2.get(key);
    },
    async set(key, value) { return store2.set(key, value); },
  };
  await assert.rejects(
    () => getInputFrontier({ storage: failingRevStore }, R),
    (err) => err.message.includes("revision read"),
    "revision read error DEVE propagar e nunca virar pendingCount=0",
  );

  // 3. Falha de leitura em followup record read
  const store3 = fakeStorage();
  await store3.set(followupIndexKey(R), ["msg_1"]);
  const failingRecordStore = {
    async get(key) {
      if (key === followupKey(R, "msg_1")) throw new Error("storage disk error: record read");
      return store3.get(key);
    },
    async set(key, value) { return store3.set(key, value); },
  };
  await assert.rejects(
    () => getInputFrontier({ storage: failingRecordStore }, R),
    (err) => err.message.includes("record read"),
    "record read error DEVE propagar e nunca virar pendingCount=0",
  );
});
