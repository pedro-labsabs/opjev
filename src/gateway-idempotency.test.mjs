// Testes RED do gateway de admission deterministico (issue #24) — IDENTIDADE.
//
// Cenarios (spec #24):
//   I6  orchestrate -> exatamente 1 dispatch de runOrchestrationOnce (a seam e
//       unica: RPC do plugin; o gateway nao tem segundo motor de orquestracao)
//   I7  duplicata concorrente + retry/replay do MESMO request (id real no
//       payload) -> UM run efetivo; turnos identicos sem id continuam turnos
//       distintos
//   I8  duas mensagens identicas sem id -> DUAS admissions (turnos distintos)
//   I9  duas sessoes -> isolamento (locks/records por chave, nunca cross-session)
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeUpstream, startGateway, testConfig } from "./gateway-testkit.mjs";

const RULES = [{ prefix: "ORCH:", mode: "orchestrate" }];

async function orch(gw, sid, payload) {
  const res = await fetch(`${gw.url}/api/session/${sid}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("I6: orchestrate -> exatamente 1 dispatch via seam RPC do plugin (sem motor no gateway)", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const r = await orch(gw, "ses_i6", { text: "ORCH: uma vez so" });
    assert.equal(r.status, 200);
    assert.equal(up.state.rpcs.length, 1, "1 dispatch RPC = 1 chamada de runOrchestrationOnce no plugin");
    assert.equal(gw.counters().rpcDispatched, 1);
    assert.equal(gw.counters().rpcSkippedDuplicate, 0);
    // unica via de execucao e a RPC publica; nenhuma chamada de wake/model
    assert.equal(up.state.patches.length, 0);
    assert.equal(up.state.models.length, 0);
    assert.equal(up.state.prompts[0].parsed.resume, false);
  } finally {
    await gw.close();
    await up.close();
  }
});

test("I7: duplicata CONCORRENTE com id real + replay -> UM run efetivo", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const payload = { id: "msg_dup1", text: "ORCH: duplicata" };
    const [a, b] = await Promise.all([
      orch(gw, "ses_i7", payload),
      orch(gw, "ses_i7", payload),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.data.id, "msg_dup1", "identidade real preservada");
    assert.equal(b.body.data.id, "msg_dup1", "replay devolve o MESMO id");

    // upstream:2 requests de persist, MAS um unico item logico
    assert.equal(up.state.prompts.length, 2, "upstream viu as duas persistencias (idempotentes)");
    assert.equal(
      up.state.prompts.filter((p) => p.createdItem).length,
      1,
      "exatamente 1 item duravel para o mesmo id",
    );
    assert.equal(up.state.rpcs.length, 1, "UM run efetivo: segunda duplicata nao dispara RPC");
    assert.equal(gw.counters().rpcDispatched, 1);
    assert.equal(gw.counters().rpcSkippedDuplicate, 1, "duplicata suprimida e registrada");
    assert.equal(up.state.patches.length, 0, "nunca wake");

    // replay sequencial tardio -> continua idempotente
    const c = await orch(gw, "ses_i7", payload);
    assert.equal(c.status, 200);
    assert.equal(up.state.rpcs.length, 1, "replay tardio tambem nao cria run novo");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("I7b: CINCO duplicatas concorrentes com id real -> UM run efetivo", async () => {
  const up = await startFakeUpstream({ rpcDelayMs: 60 });
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const payload = { id: "msg_dup5", text: "ORCH: cinco concorrentes" };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => orch(gw, "ses_i7b", payload)),
    );
    for (const r of results) assert.equal(r.status, 200);
    const ids = results.map((r) => r.body.data.id);
    assert.ok(ids.every((id) => id === "msg_dup5"), "todas devolvem a mesma identidade");
    const dispatched = gw.counters().records.filter((r) => r.state === "started").length;
    assert.equal(up.state.rpcs.length, 1, "UM run efetivo entre 5 concorrentes");
    assert.equal(dispatched, 1);
    assert.equal(gw.counters().rpcSkippedDuplicate, 4, "4 duplicatas suprimidas e registradas");
    assert.equal(up.state.patches.length, 0, "nunca wake");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("I7c: restart do gateway -> record DURAVEL do plugin mantem run<=1", async () => {
  // Semantica em duas camadas: records do gateway sao process-local (o
  // gateway readmite e re-dispara a RPC apos restart); a unicidade
  // cross-processo vive no record duravel do plugin (aqui emulado por
  // rpcDedupe: segunda RPC da mesma identidade => duplicate-ignored).
  const up = await startFakeUpstream({ rpcDedupe: true });
  const payload = { id: "msg_restart1", text: "ORCH: restart" };
  const gw1 = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const r1 = await orch(gw1, "ses_restart", payload);
    assert.equal(r1.status, 200);
  } finally {
    await gw1.close();
  }
  assert.equal(up.state.rpcs.length, 1, "primeiro dispatch antes do restart");
  const gw2 = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const r2 = await orch(gw2, "ses_restart", payload);
    assert.equal(r2.status, 200, "replay apos restart responde nativo");
    assert.equal(r2.body.data.id, "msg_restart1", "mesma identidade duravel readmitida");
    assert.equal(up.state.rpcs.length, 2, "gateway sem memoria re-dispara a RPC no wire");
    assert.equal(up.state.patches.length, 0, "nenhum wake em nenhum momento");
    assert.equal(up.state.rpcRuns, 1, "record DURAVEL: UM run efetivo apesar de 2 RPCs no wire");
    assert.equal(gw2.counters().rpcDispatched, 1, "gateway registra o re-dispatch como diagnostico");
    assert.equal(gw2.counters().rpcSkippedDuplicate, 0, "skip local nao se aplica pos-restart (memoria perdida)");
  } finally {
    await gw2.close();
    await up.close();
  }
});

test("I8: duas mensagens IDENTICAS sem id -> DUAS admissions (turnos distintos preservados)", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const t1 = await orch(gw, "ses_i8", { text: "ORCH: mesmo texto" });
    const t2 = await orch(gw, "ses_i8", { text: "ORCH: mesmo texto" });
    assert.equal(t1.status, 200);
    assert.equal(t2.status, 200);
    assert.notEqual(t1.body.data.id, t2.body.data.id, "ids distintos = turnos distintos");
    assert.equal(up.state.rpcs.length, 2, "DUAS admissions/runs (sem hash(text) como identidade)");
    assert.equal(gw.counters().admitted, 2);
    const runIDs = gw.counters().records.map((r) => r.runID);
    assert.equal(new Set(runIDs).size, 2, "runIDs distintos por identidade de turno real");
    // runID nunca deriva de hash do texto: mesmo texto => runIDs diferentes so
    // por causa da identidade (sessionID+messageID), nao do conteudo
    assert.ok(runIDs.every((id) => id.includes("ses_i8")), "runID derivado da identidade");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("I9: duas sessoes -> isolamento de locks/records (mesmo texto nunca cruza)", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    // Mesmo texto, identidades DISTINTAS (ids sao globais por upstream: o
    // mesmo id em outra sessao e 409 — ver I9b). Turnos distintos => 2 runs.
    const [a, b] = await Promise.all([
      orch(gw, "ses_left", { id: "msg_shared_left", text: "ORCH: mesmo texto em sessoes distintas" }),
      orch(gw, "ses_right", { id: "msg_shared_right", text: "ORCH: mesmo texto em sessoes distintas" }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(up.state.rpcs.length, 2, "concorrencia cross-session nao suprime nenhum run");
    const sids = up.state.rpcs.map((r) => r.input.sessionID).sort();
    assert.deepEqual(sids, ["ses_left", "ses_right"]);
    assert.equal(gw.counters().rpcDispatched, 2);
    const keys = gw.counters().records.map((r) => `${r.sessionID}|${r.runID}`);
    assert.equal(new Set(keys).size, 2, "records isolados por sessao");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("I9b: mesmo id em OUTRA sessao -> 409 nativo passthrough, zero RPC, zero wake", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const first = await orch(gw, "ses_one", { id: "msg_global1", text: "ORCH: primeira" });
    assert.equal(first.status, 200);
    assert.equal(up.state.rpcs.length, 1);
    const clash = await orch(gw, "ses_two", { id: "msg_global1", text: "ORCH: colisao global de id" });
    assert.equal(clash.status, 409, "conflito global repassado verbatim (pre-admissao)");
    assert.equal(up.state.rpcs.length, 1, "sem admissao -> sem RPC nova");
    assert.equal(up.state.patches.length, 0, "nunca wake");
    assert.equal(gw.counters().admitted, 1, "segunda sessao nao e admitida");
  } finally {
    await gw.close();
    await up.close();
  }
});
