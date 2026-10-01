// Testes RED do gateway de admission (#13) — FOLLOW-UP no wire.
//
// O gateway segue SEM autoridade de binding: ele sempre despacha a RPC ao
// plugin (control plane) e apenas OBSERVA o status. Um follow-up em binding
// ativo => a RPC responde { runID: R (dono), status: "followup-attached" };
// o gateway registra o evento/contador e NUNCA conta isso como segundo run
// (rpc-dispatched continua 1 por turno inicial).
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

test("G1: follow-up em binding ativo => 200 nativo, evento rpc-followup-attached, ZERO segundo dispatch", async () => {
  const up = await startFakeUpstream({ rpcFollowupAware: true });
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const a = await orch(gw, "ses_g1", { id: "msg_gA", text: "ORCH: tarefa inicial" });
    assert.equal(a.status, 200);
    assert.equal(gw.counters().rpcDispatched, 1, "turno inicial => 1 run");

    const b = await orch(gw, "ses_g1", { id: "msg_gF", text: "ORCH: follow-up durante o run" });
    assert.equal(b.status, 200, "follow-up responde o shape nativo (admissao)");
    assert.equal(up.state.rpcs.length, 2, "RPC do follow-up chega ao plugin (control plane decide)");
    assert.equal(gw.counters().rpcDispatched, 1, "ZERO segundo run: attach nao e dispatch de run");
    assert.equal(gw.counters().followupAttached, 1, "attach observavel no gateway");

    // evento carrega o runID DONO (associacao F->R observavel no wire)
    const attachEvents = gw.events().filter((e) => e.type === "rpc-followup-attached");
    assert.equal(attachEvents.length, 1);
    assert.equal(attachEvents[0].runID, `auto-ses_g1-msg_gA`, "evento associa F ao run R");
    assert.equal(attachEvents[0].sessionID, "ses_g1");
    assert.equal(attachEvents[0].messageID, "msg_gF");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("G2: replay do follow-up (mesmo id) => nenhum attach duplicado, zero run", async () => {
  const up = await startFakeUpstream({ rpcFollowupAware: true });
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    await orch(gw, "ses_g2", { id: "msg_gA2", text: "ORCH: tarefa" });
    const payload = { id: "msg_gF2", text: "ORCH: follow-up" };
    const first = await orch(gw, "ses_g2", payload);
    assert.equal(first.status, 200);
    const attachedBefore = gw.counters().followupAttached;
    assert.equal(attachedBefore, 1);

    const replay = await orch(gw, "ses_g2", payload);
    assert.equal(replay.status, 200);
    assert.equal(gw.counters().followupAttached, 1, "nenhum attach duplicado");
    assert.equal(gw.counters().rpcDispatched, 1, "zero segundo run");
    const dupIgnored = gw.events().filter((e) => e.type === "rpc-duplicate-ignored");
    assert.ok(dupIgnored.length >= 1, "replay observavel como duplicate-ignored (plugin decide)");
    assert.equal(dupIgnored[0].runID, "auto-ses_g2-msg_gA2", "evento carrega o run dono");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("G3: dois follow-ups distintos no mesmo run ativo => 2 attaches, ainda 1 run", async () => {
  const up = await startFakeUpstream({ rpcFollowupAware: true });
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    await orch(gw, "ses_g3", { id: "msg_gA3", text: "ORCH: tarefa" });
    const f1 = await orch(gw, "ses_g3", { id: "msg_gF3a", text: "ORCH: follow 1" });
    const f2 = await orch(gw, "ses_g3", { id: "msg_gF3b", text: "ORCH: follow 2" });
    assert.equal(f1.status, 200);
    assert.equal(f2.status, 200);
    assert.equal(gw.counters().followupAttached, 2);
    assert.equal(gw.counters().rpcDispatched, 1, "nenhum dos follows cria run");
    const runs = gw.counters().records.filter((r) => r.state === "started");
    assert.equal(runs.length, 1, "exatamente 1 run started no gateway");
  } finally {
    await gw.close();
    await up.close();
  }
});
