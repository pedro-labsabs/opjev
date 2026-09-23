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

test("I9: duas sessoes -> isolamento de locks/records (mesmo id/texto nunca cruza)", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const payload = { id: "msg_shared", text: "ORCH: mesmo id em sessoes distintas" };
    const [a, b] = await Promise.all([
      orch(gw, "ses_left", payload),
      orch(gw, "ses_right", payload),
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
