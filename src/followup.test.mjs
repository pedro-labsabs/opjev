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
  buildFollowupRecord,
  normalizeFollowupRecord,
  readFollowupIndex,
  formatFollowupsSection,
  createFollowupTakeSeam,
  closeFollowupsForRun,
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
