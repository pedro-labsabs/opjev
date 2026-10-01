// Presentation boundary do resultado da orchestration (PR #27) — TESTES.
//
// Contrato: a apresentacao e CLIENT/PRESENTATION side. NAO tem autoridade
// sobre kernel, routing, recovery ou estado do run. Ela apenas TRANSPORTA
// (evento RPC publico) e RENDERIZA (TUI) o notice bounded ja publicado no
// estado authoritative (record/binding + synthetic resume:false).
//
// Propriedades provadas aqui (schema, bounding, identidade, dedupe, erro):
//   V1  buildOrchestrationResultEvent: schema bounded (campos exatos, tamanhos)
//   V2  evento transporta SOMENTE o notice bounded (nunca contexto bruto)
//   V3  runID/sessionID de identidade preservados 1:1 do estado authoritative
//   V4  presenter: sessao visivel no TUI => entrega; sessao interna => ignora
//   V5  presenter: dedupe por runID (replay => 1 display, nunca 2)
//   V6  presenter: falha de render/publicacao NUNCA propaga (erro bounded)
//   V7  presenter: nunca toca inbox, storage authoritative nem routing
//   V8  schema do evento e exatamente o registrado no AdmissionRpc.events
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOrchestrationResultEvent,
  OrchestrationResultRpc,
  createOrchestrationResultPresenter,
  isPresentableSession,
  ORCHESTRATION_RESULT_EVENT,
  NOTICE_EVENT_LIMIT,
} from "./orchestration/presentation.ts";

// ───────────────────────────── helpers ─────────────────────────────

function validEventInput(overrides = {}) {
  return {
    sessionID: "ses_parent000001",
    runID: "auto-ses_parent000001-msg_abc-1a2b3c4d5e6f",
    phase: "completed",
    round: 2,
    notice: "Orquestracao auto-x: fase completed, rodada 2, worker done",
    ...overrides,
  };
}

// ───────────────────────────── V1/V2/V3 — schema/bounding/identidade ──────

test("V1: evento de resultado tem schema bounded com campos exatos", () => {
  const ev = buildOrchestrationResultEvent(validEventInput());
  assert.equal(typeof ev, "object");
  // campos exatos: sem payload extra, sem contexto bruto
  assert.deepEqual(
    Object.keys(ev).sort(),
    ["notice", "phase", "round", "runID", "sessionID"],
  );
  assert.equal(ev.runID, "auto-ses_parent000001-msg_abc-1a2b3c4d5e6f");
  assert.equal(ev.sessionID, "ses_parent000001");
  assert.equal(ev.phase, "completed");
  assert.equal(ev.round, 2);
});

test("V1: notice maior que o limite e truncado bounded", () => {
  const ev = buildOrchestrationResultEvent(
    validEventInput({ notice: "x".repeat(NOTICE_EVENT_LIMIT + 5000) }),
  );
  assert.ok(ev.notice.length <= NOTICE_EVENT_LIMIT);
  assert.ok(ev.notice.endsWith("…"));
});

test("V2: evento nunca transporta campos desconhecidos (fail-closed)", () => {
  const ev = buildOrchestrationResultEvent({
    ...validEventInput(),
    workerTranscript: "contexto bruto proibido",
    apiKey: "sk-proibido",
  });
  assert.equal(ev.workerTranscript, undefined);
  assert.equal(ev.apiKey, undefined);
});

test("V2: input invalido (falta runID/notice) lanca erro bounded", () => {
  assert.throws(() => buildOrchestrationResultEvent({ sessionID: "ses_x", runID: "", notice: "n", phase: "c" }));
  assert.throws(() => buildOrchestrationResultEvent({ sessionID: "ses_x", runID: "r", notice: "", phase: "c" }));
  assert.throws(() => buildOrchestrationResultEvent({ sessionID: "", runID: "r", notice: "n", phase: "c" }));
  assert.throws(() => buildOrchestrationResultEvent(null));
});

test("V3: identidade 1:1 — evento reproduz exatamente runID/sessionID do estado", () => {
  const a = buildOrchestrationResultEvent(validEventInput());
  const b = buildOrchestrationResultEvent(validEventInput());
  assert.equal(a.runID, b.runID);
  assert.equal(a.sessionID, b.sessionID);
});

// ───────────────────────────── V4 — filtro de papel (somente apresentacao) ─

test("V4: sessao visivel no TUI recebe evento; interna e ignorada", async () => {
  const emits = [];
  const presenter = createOrchestrationResultPresenter({
    emit: async (event) => emits.push(event),
    isPresentable: (sessionID) => !String(sessionID).startsWith("ses_interna"),
  });
  await presenter.publish(validEventInput());
  await presenter.publish(validEventInput({ sessionID: "ses_interna_worker01" }));
  assert.equal(emits.length, 1);
  assert.equal(emits[0].sessionID, "ses_parent000001");
});

test("V4: falha do seam de papel NUNCA vira apresentacao (fail-closed)", async () => {
  const emits = [];
  const presenter = createOrchestrationResultPresenter({
    emit: async (event) => emits.push(event),
    isPresentable: () => {
      throw new Error("lookup indisponivel");
    },
  });
  const out = await presenter.publish(validEventInput());
  assert.equal(emits.length, 0);
  assert.equal(out, false);
});

// ───────────────────────────── V5 — dedupe por runID ───────────────────────

test("V5: replay do mesmo runID => exatamente 1 emit (nunca display duplo)", async () => {
  const emits = [];
  const presenter = createOrchestrationResultPresenter({
    emit: async (event) => emits.push(event),
    isPresentable: () => true,
  });
  await presenter.publish(validEventInput());
  await presenter.publish(validEventInput());
  await presenter.publish(validEventInput());
  assert.equal(emits.length, 1);
});

test("V5: runs distintos => eventos distintos (dedupe nao cola identidades)", async () => {
  const emits = [];
  const presenter = createOrchestrationResultPresenter({
    emit: async (event) => emits.push(event),
    isPresentable: () => true,
  });
  await presenter.publish(validEventInput({ runID: "auto-a" }));
  await presenter.publish(validEventInput({ runID: "auto-b" }));
  assert.equal(emits.length, 2);
});

test("V5: dedupe e bounded (cap de memoria, nunca cresce sem limite)", async () => {
  const emits = [];
  const presenter = createOrchestrationResultPresenter({
    emit: async (event) => emits.push(event),
    isPresentable: () => true,
    seenCap: 4,
  });
  for (let i = 0; i < 12; i++) {
    await presenter.publish(validEventInput({ runID: `auto-${i}` }));
  }
  assert.equal(emits.length, 12); // todos novos
  // replay antigo apos cap => pode reemitir (bounded) — mas replay imediato nunca
  await presenter.publish(validEventInput({ runID: "auto-11" }));
  assert.equal(emits.length, 12);
});

test("V6: falha de emit (apresentacao) nao propaga e nao afeta estado", async () => {
  const presenter = createOrchestrationResultPresenter({
    emit: async () => {
      throw new Error("TUI fora do ar");
    },
    isPresentable: () => true,
  });
  const out = await presenter.publish(validEventInput());
  assert.equal(out, false); // degradacao bounded, sem throw
});

test("V6: primeira tentativa falha -> replay do mesmo runID -> apresentacao ocorre exatamente uma vez", async () => {
  let attempts = 0;
  const emits = [];
  const presenter = createOrchestrationResultPresenter({
    emit: async (event) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Falha temporaria de render/transporte");
      }
      emits.push(event);
    },
    isPresentable: () => true,
  });

  const res1 = await presenter.publish(validEventInput({ runID: "run-retry-1" }));
  assert.equal(res1, false);
  assert.equal(emits.length, 0);

  const res2 = await presenter.publish(validEventInput({ runID: "run-retry-1" }));
  assert.equal(res2, true);
  assert.equal(emits.length, 1);

  const res3 = await presenter.publish(validEventInput({ runID: "run-retry-1" }));
  assert.equal(res3, true);
  assert.equal(emits.length, 1);
});

// ───────────────────────────── V7 — sem autoridade ─────────────────────────

test("V7: presenter NAO expoe storage/runner/phase mutations (interface minima)", () => {
  const presenter = createOrchestrationResultPresenter({
    emit: async () => {},
    isPresentable: () => true,
  });
  assert.deepEqual(Object.keys(presenter).sort(), ["publish"]);
});

// ───────────────────── V9 — filtro de papel do lado TUI (puro) ─────────────

test("V9: sessao corrente == sessao do evento e nao-interna => apresentavel", () => {
  assert.equal(
    isPresentableSession({ currentSessionID: "ses_a", eventSessionID: "ses_a" }),
    true,
  );
});

test("V9: sessao corrente diferente do evento => NUNCA apresenta", () => {
  assert.equal(
    isPresentableSession({ currentSessionID: "ses_a", eventSessionID: "ses_b" }),
    false,
  );
  assert.equal(
    isPresentableSession({ currentSessionID: undefined, eventSessionID: "ses_a" }),
    false,
  );
});

test("V9: sessao interna (worker/critic/orchestrator) => NUNCA apresenta", () => {
  const internalMeta = { "jev-role": "worker", "jev-router": "orchestration-internal" };
  assert.equal(
    isPresentableSession({ currentSessionID: "ses_a", eventSessionID: "ses_a", metadata: internalMeta }),
    false,
  );
});

test("V9: subagente nativo (parentID) => NUNCA apresenta", () => {
  assert.equal(
    isPresentableSession({ currentSessionID: "ses_a", eventSessionID: "ses_a", parentID: "ses_parent" }),
    false,
  );
});

// ───────────────────────────── V8 — schema do RPC de evento ────────────────

test("V8: evento registrado no schema publico do RPC (id/define/events)", () => {
  assert.equal(typeof OrchestrationResultRpc.id, "string");
  assert.ok(OrchestrationResultRpc.id.length > 0);
  assert.equal(OrchestrationResultRpc.methods.orchestrate, undefined);
  const ev = OrchestrationResultRpc.events[ORCHESTRATION_RESULT_EVENT];
  assert.ok(ev, "evento orchestration-result deve estar no schema");
  const props = ev.schema.properties;
  assert.deepEqual(Object.keys(props).sort(), ["notice", "phase", "round", "runID", "sessionID"]);
  assert.equal(ev.schema.additionalProperties, false);
  assert.equal(props.notice.maxLength, NOTICE_EVENT_LIMIT);
});
