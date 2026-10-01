// Testes RED do contrato de follow-up/session continuity (#13) — HANDLER de
// admission (control plane). O contrato:
//
//   active binding + follow-up novo => mesmo run => zero novo orchestration run
//   => input preservado (duravel/bounded) => consumo explícito e rastreável
//
// Pontos de aceite cobertos aqui (#13): 1-5, 8-9, 11, 12, 13, 17.
// Consumo no boundary de rodada: src/followup-dispatcher.test.mjs.
// Observabilidade no gateway: src/gateway-followup.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAdmissionOrchestrateHandler } from "./orchestration/admission-rpc.ts";
import { sessionBindingKey, admissionRecordKey, autoAdmissionRunID } from "./orchestration/admission.ts";
import {
  FOLLOWUP_LIMITS,
  followupKey,
  followupIndexKey,
  normalizeFollowupRecord,
  buildFollowupRecord,
} from "./orchestration/followup.ts";

function fakeDeps(overrides = {}) {
  const store = new Map();
  const state = { runs: [], published: [], runnerDelayMs: 0 };
  const deps = {
    storage: {
      async get(key) {
        return store.get(key);
      },
      async set(key, value) {
        store.set(key, value);
      },
    },
    async runner(contract) {
      if (state.runnerDelayMs > 0) await new Promise((r) => setTimeout(r, state.runnerDelayMs));
      state.runs.push(contract);
      return {
        runID: contract.runID,
        phase: "completed",
        round: 1,
        pendingCommands: [],
        rounds: [],
        worker: { sessionID: "ses_w1", agent: "build", model: "opencode/big-pickle", outcome: "succeeded", finalText: "ok" },
      };
    },
    async publish(sessionID, text) {
      state.published.push({ sessionID, text });
    },
    ...overrides,
  };
  return { deps, store, state, handler: createAdmissionOrchestrateHandler(deps) };
}

/** Semeia um binding ATIVO (run R em execucao), como o handler real deixaria. */
async function seedActiveBinding(store, sessionID, initialMessageID = "msg_A") {
  const runID = autoAdmissionRunID(sessionID, initialMessageID);
  await store.set(sessionBindingKey(sessionID), { runID, phase: "running", at: 1 });
  await store.set(admissionRecordKey(sessionID, initialMessageID), { runID, state: "started", at: 1 });
  return runID;
}

const FOLLOWUP_TEXT = "tambem cubra o caso de timeout no teste";

// ───────────────────────── A. attach em binding ativo ─────────────────────────

test("C1: binding ativo + follow-up novo => followup-attached, ZERO segundo run, input preservado", async () => {
  const { deps, store, state, handler } = fakeDeps();
  const sessionID = "ses_cont1";
  const runR = await seedActiveBinding(store, sessionID);

  const out = await handler({ sessionID, messageID: "msg_F1", objective: FOLLOWUP_TEXT });
  assert.equal(out.status, "followup-attached", "status de attach (nao started)");
  assert.equal(out.runID, runR, "F fica associado ao run ATIVO R");
  assert.equal(state.runs.length, 0, "ZERO novo orchestration run");

  // binding intacto: continua apontando para R em execucao
  const binding = store.get(sessionBindingKey(sessionID));
  assert.equal(binding.runID, runR);
  assert.equal(binding.phase, "running");

  // provenance duravel completa (as 5 perguntas do contrato)
  const rec = normalizeFollowupRecord(store.get(followupKey(runR, "msg_F1")));
  assert.equal(rec.messageID, "msg_F1", "qual messageID originou");
  assert.equal(rec.sessionID, sessionID, "qual sessao recebeu");
  assert.equal(rec.runID, runR, "qual run possui");
  assert.equal(rec.state, "pending", "ainda nao consumido (rastreavel)");
  assert.equal(rec.text, FOLLOWUP_TEXT, "input preservado (bounded)");
  assert.deepEqual(store.get(followupIndexKey(runR)), ["msg_F1"]);

  // admission record da identidade do follow-up (trail duravel)
  const record = store.get(admissionRecordKey(sessionID, "msg_F1"));
  assert.equal(record.runID, runR);
  assert.equal(record.state, "followup-attached");

  // observavel: notice bounded na sessao (synthetic resume:false — sem wake)
  await new Promise((r) => setImmediate(r));
  const attachNotice = state.published.find((p) => p.text.includes("msg_F1"));
  assert.ok(attachNotice, "notice de attach publicado");
  assert.equal(attachNotice.sessionID, sessionID);
  assert.ok(attachNotice.text.length <= 2000, "notice bounded");
  assert.ok(attachNotice.text.includes(runR), "notice associa F a R");
});

test("C2: replay do mesmo messageID (binding ativo) => duplicate-ignored, storage intacto", async () => {
  const { deps, store, state, handler } = fakeDeps();
  const sessionID = "ses_cont2";
  const runR = await seedActiveBinding(store, sessionID);

  const first = await handler({ sessionID, messageID: "msg_F1", objective: FOLLOWUP_TEXT });
  assert.equal(first.status, "followup-attached");
  const recBefore = JSON.stringify(store.get(followupKey(runR, "msg_F1")));
  const idxBefore = JSON.stringify(store.get(followupIndexKey(runR)));
  const recordBefore = JSON.stringify(store.get(admissionRecordKey(sessionID, "msg_F1")));

  const replay = await handler({ sessionID, messageID: "msg_F1", objective: FOLLOWUP_TEXT });
  assert.equal(replay.status, "duplicate-ignored", "replay nao duplica pending input");
  assert.equal(state.runs.length, 0, "zero segundo run no replay");
  assert.equal(JSON.stringify(store.get(followupKey(runR, "msg_F1"))), recBefore, "record intacto");
  assert.equal(JSON.stringify(store.get(followupIndexKey(runR))), idxBefore, "index sem duplicata");
  assert.equal(JSON.stringify(store.get(admissionRecordKey(sessionID, "msg_F1"))), recordBefore);
});

test("C3: concorrencia do mesmo follow-up => exatamente 1 record, 1 attach + 1 duplicate", async () => {
  const { deps, store, state, handler } = fakeDeps();
  const sessionID = "ses_cont3";
  const runR = await seedActiveBinding(store, sessionID);

  const [a, b] = await Promise.all([
    handler({ sessionID, messageID: "msg_Fc", objective: FOLLOWUP_TEXT }),
    handler({ sessionID, messageID: "msg_Fc", objective: FOLLOWUP_TEXT }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["duplicate-ignored", "followup-attached"], "um anexa, o outro ignora");
  assert.equal(state.runs.length, 0, "zero segundo run");
  assert.deepEqual(store.get(followupIndexKey(runR)), ["msg_Fc"], "index sem duplicata (session lock)");
  assert.ok(store.get(followupKey(runR, "msg_Fc")), "exatamente 1 record");
});

test("C4: awaiting-human + follow-up => ZERO auto-resume, ZERO followup, ZERO run", async () => {
  const { deps, store, state, handler } = fakeDeps();
  const sessionID = "ses_cont4";
  const runR = await seedActiveBinding(store, sessionID);
  await store.set(sessionBindingKey(sessionID), { runID: runR, phase: "awaiting-human", at: 1 });

  const out = await handler({ sessionID, messageID: "msg_Fh", objective: FOLLOWUP_TEXT });
  assert.equal(out.status, "awaiting-human-no-resume", "gate humano prevalece");
  assert.equal(out.runID, runR);
  assert.equal(state.runs.length, 0, "nenhum run criado");
  assert.equal(store.get(followupKey(runR, "msg_Fh")), undefined, "nenhum followup armazenado");
  assert.equal(store.get(followupIndexKey(runR)), undefined, "nenhum index escrito");
  assert.equal(store.get(admissionRecordKey(sessionID, "msg_Fh")), undefined, "sem record de attach");
});

test("C5: run terminal (completed) + nova mensagem => novo run permitido (admission normal)", async () => {
  const { deps, store, state, handler } = fakeDeps();
  const sessionID = "ses_cont5";
  const oldRun = autoAdmissionRunID(sessionID, "msg_A");
  await store.set(sessionBindingKey(sessionID), { runID: oldRun, phase: "completed", at: 1 });
  await store.set(admissionRecordKey(sessionID, "msg_A"), { runID: oldRun, state: "completed", at: 1 });

  const out = await handler({ sessionID, messageID: "msg_G", objective: "nova tarefa" });
  assert.equal(out.status, "started", "nova mensagem inicia novo run");
  assert.equal(out.runID, autoAdmissionRunID(sessionID, "msg_G"));
  assert.equal(state.runs.length, 1, "exatamente 1 novo run");
  assert.notEqual(out.runID, oldRun);
});

test("C6: replay TARDIO de follow-up ja anexado (binding terminal) => duplicate-ignored, zero run", async () => {
  const { deps, store, state, handler } = fakeDeps();
  const sessionID = "ses_cont6";
  const runR = autoAdmissionRunID(sessionID, "msg_A");
  // F foi anexado quando R estava ativo; depois R terminou
  await store.set(sessionBindingKey(sessionID), { runID: runR, phase: "completed", at: 2 });
  await store.set(admissionRecordKey(sessionID, "msg_A"), { runID: runR, state: "completed", at: 2 });
  await store.set(admissionRecordKey(sessionID, "msg_F1"), { runID: runR, state: "followup-attached", at: 1 });
  await store.set(
    followupKey(runR, "msg_F1"),
    buildFollowupRecord({ sessionID, messageID: "msg_F1", runID: runR, text: FOLLOWUP_TEXT, at: 1 }),
  );
  await store.set(followupIndexKey(runR), ["msg_F1"]);

  const out = await handler({ sessionID, messageID: "msg_F1", objective: FOLLOWUP_TEXT });
  assert.equal(out.status, "duplicate-ignored", "mesma identidade nunca cria outro run");
  assert.equal(state.runs.length, 0, "replay tardio nao executa worker por acidente");
  assert.deepEqual(store.get(followupIndexKey(runR)), ["msg_F1"], "sem duplicata de storage");
});

test("C7: cap de follow-ups por run => followup-limit-reached, storage bounded", async () => {
  const { deps, store, state, handler } = fakeDeps();
  const sessionID = "ses_cont7";
  const runR = await seedActiveBinding(store, sessionID);

  for (let i = 0; i < FOLLOWUP_LIMITS.perRun; i += 1) {
    const out = await handler({ sessionID, messageID: `msg_cap${i}`, objective: `f${i}` });
    assert.equal(out.status, "followup-attached", `attach ${i}`);
  }
  const over = await handler({ sessionID, messageID: "msg_cap_over", objective: "f_over" });
  assert.equal(over.status, "followup-limit-reached", "cap respeitado, fail-closed bounded");
  assert.equal(state.runs.length, 0);
  assert.equal(store.get(admissionRecordKey(sessionID, "msg_cap_over")), undefined, "cap rejeitado nao grava record");
  assert.equal(store.get(followupIndexKey(runR)).length, FOLLOWUP_LIMITS.perRun, "index capped");
});

test("C8: falha de persistencia do follow-up => fail-closed (erro bounded, zero runner, binding intocado)", async () => {
  const store = new Map();
  const brokenRunID = autoAdmissionRunID("ses_cont8", "msg_A");
  const deps = {
    storage: {
      async get(key) {
        return store.get(key);
      },
      async set(key, value) {
        if (key === followupIndexKey(brokenRunID)) throw new Error("storage down");
        store.set(key, value);
      },
    },
    async runner() {
      throw new Error("runner nunca deveria ser chamado");
    },
    async publish() {},
  };
  const handler = createAdmissionOrchestrateHandler(deps);
  const sessionID = "ses_cont8";
  await store.set(sessionBindingKey(sessionID), { runID: brokenRunID, phase: "running", at: 1 });

  await assert.rejects(
    () => handler({ sessionID, messageID: "msg_F8", objective: FOLLOWUP_TEXT }),
    (err) => err.code === "followup-persistence-failed",
    "erro bounded fail-closed",
  );
  assert.equal(store.get(sessionBindingKey(sessionID)).phase, "running", "binding intocado");
  assert.equal(store.get(followupKey(brokenRunID, "msg_F8")), undefined, "record parcial nunca fica solto");
});

test("C9: duas sessoes simultaneas permanecem isoladas (follow-up de S1 nao vaza em S2)", async () => {
  const { deps, store, state, handler } = fakeDeps();
  const runRA = await seedActiveBinding(store, "ses_A9", "msg_A");
  const runRB = await seedActiveBinding(store, "ses_B9", "msg_B");

  const [a, b] = await Promise.all([
    handler({ sessionID: "ses_A9", messageID: "msg_FA", objective: "para A" }),
    handler({ sessionID: "ses_B9", messageID: "msg_FB", objective: "para B" }),
  ]);
  assert.equal(a.status, "followup-attached");
  assert.equal(b.status, "followup-attached");
  assert.equal(a.runID, runRA, "F_A pertence ao run de S1");
  assert.equal(b.runID, runRB, "F_B pertence ao run de S2");
  assert.equal(state.runs.length, 0, "nenhum dos dois cria run");
  assert.deepEqual(store.get(followupIndexKey(runRA)), ["msg_FA"]);
  assert.deepEqual(store.get(followupIndexKey(runRB)), ["msg_FB"]);
  const recA = normalizeFollowupRecord(store.get(followupKey(runRA, "msg_FA")));
  assert.equal(recA.sessionID, "ses_A9");
  assert.equal(store.get(followupKey(runRA, "msg_FB")), undefined, "sem vazamento entre sessoes");
});

test("C10: run conclui com follow-up pendente nao consumido => fechado honestamente + notice observavel", async () => {
  const { deps, store, state, handler } = fakeDeps();
  state.runnerDelayMs = 40; // janela para o attach antes da conclusao
  const sessionID = "ses_cont10";

  const started = await handler({ sessionID, messageID: "msg_A", objective: "tarefa inicial" });
  assert.equal(started.status, "started");
  const attached = await handler({ sessionID, messageID: "msg_F10", objective: FOLLOWUP_TEXT });
  assert.equal(attached.status, "followup-attached");

  await new Promise((r) => setTimeout(r, 90)); // runner termina => callback fecha follow-ups
  assert.equal(state.runs.length, 1, "apenas o run original");
  const rec = normalizeFollowupRecord(store.get(followupKey(started.runID, "msg_F10")));
  assert.equal(rec.state, "unconsumed", "pendente fechado honestamente (run terminal)");
  assert.equal(rec.consumedBoundary, "run-finished-without-consumption");

  const notice = state.published.find((p) => p.text.includes(started.runID) && p.text.includes("completed"));
  assert.ok(notice, "notice de conclusao publicado");
  assert.ok(notice.text.includes("follow-ups"), `notice menciona follow-ups: ${notice.text}`);
  assert.ok(notice.text.includes("nao consumidos: 1"), "contagem de nao consumidos observavel");
});

test("C11: run conclui sem follow-ups => notice NAO menciona follow-ups (bounded e limpo)", async () => {
  const { deps, store, state, handler } = fakeDeps();
  const out = await handler({ sessionID: "ses_cont11", messageID: "msg_A11", objective: "tarefa" });
  assert.equal(out.status, "started");
  await new Promise((r) => setTimeout(r, 30));
  const notice = state.published.find((p) => p.text.includes(out.runID));
  assert.ok(notice, "notice de conclusao");
  assert.equal(notice.text.includes("follow-ups"), false, "sem follow-ups => sem mencao");
});

test("C12: run FALHA com follow-up pendente => mesmo fechamento honesto (fail-closed observavel)", async () => {
  const store = new Map();
  const state = { runs: 0, published: [] };
  const deps = {
    storage: {
      async get(key) {
        return store.get(key);
      },
      async set(key, value) {
        store.set(key, value);
      },
    },
    async runner() {
      state.runs += 1;
      await new Promise((r) => setTimeout(r, 40)); // janela para o attach antes da falha
      throw new Error("boom no worker");
    },
    async publish(sessionID, text) {
      state.published.push({ sessionID, text });
    },
  };
  const handler = createAdmissionOrchestrateHandler(deps);
  const sessionID = "ses_cont12";
  const started = await handler({ sessionID, messageID: "msg_A", objective: "tarefa" });
  assert.equal(started.status, "started");
  const attached = await handler({ sessionID, messageID: "msg_F12", objective: FOLLOWUP_TEXT });
  assert.equal(attached.status, "followup-attached", "attach acontece enquanto o run ainda esta ativo");
  await new Promise((r) => setTimeout(r, 80)); // runner falha => callback fecha follow-ups

  const binding = store.get(sessionBindingKey(sessionID));
  assert.equal(binding.phase, "failed");
  const rec = store.get(followupKey(started.runID, "msg_F12"));
  assert.ok(rec, "follow-up permanece duravel (nao descartado)");
  assert.equal(rec.state, "unconsumed", "fechado honestamente no failure path");
  const notice = state.published.find((p) => p.text.includes(started.runID) && p.text.includes("failed"));
  assert.ok(notice && notice.text.includes("nao consumidos: 1"), "failure path observavel no notice");
});
