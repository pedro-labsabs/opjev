// Testes RED do gateway de admission deterministico (issue #24) — PROXY.
//
// Cenarios (spec #24):
//   P1  request nao interceptado -> proxy 1x (uma unica chamada upstream)
//   P2  status/headers/corpo preservados byte a byte nos dois sentidos
//   P15 gateway disabled -> nao sobe; config sem upstream/porta -> erro bounded
//   P16 payload malformed/oversized -> rejeicao bounded 400/413, ZERO upstream
//   P17 streaming progressivo (SSE nao bufferizado) + cancelamento do cliente
//       observado pelo upstream, sem socket leak no gateway
//
// Fronteira HTTP REAL: servidor fake em node:http + gateway real em porta
// efemera; nada aqui mocka funcoes do gateway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeUpstream, startGateway, testConfig } from "./gateway-testkit.mjs";

test("P1: request nao interceptado e proxyado exatamente 1x", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig());
  try {
    const res = await fetch(`${gw.url}/api/info`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.version, "fake-upstream");
    const infoHits = up.order().filter((k) => k === "GET /api/info");
    assert.equal(infoHits.length, 1, "upstream deve ver exatamente 1 chamada");
    assert.equal(gw.counters().intercepted, 0, "prompt nao foi interceptado");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("P2: status, headers e corpo preservados; nao-interceptados incluindo POST SSE-streaming", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig());
  try {
    // status/header/corpo de resposta preservados
    const teapot = await fetch(`${gw.url}/api/custom`);
    assert.equal(teapot.status, 418, "status upstream preservado");
    assert.equal(teapot.headers.get("x-custom"), "keep-me", "header custom preservado");
    assert.equal(await teapot.text(), "teapot-body", "corpo preservado");

    // POST nao-interceptado (synthetic): body bruto identico no upstream
    const raw = JSON.stringify({ text: "synthetic-note", resume: false });
    const syn = await fetch(`${gw.url}/api/session/ses_p2/synthetic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    assert.equal(syn.status, 404, "upstream fake responde 404 (proxy transparente repassa status)");
    const synHits = up.state.prompts.filter((p) => p.path.includes("synthetic"));
    assert.equal(synHits.length, 0, "synthetic nao e tratado como prompt");
    assert.ok(
      up.order().some((k) => k === "POST /api/session/ses_p2/synthetic"),
      "POST nao-interceptado chega ao upstream",
    );
    // nenhuma linha de log do gateway pode conter credencial/conteudo sensivel
    for (const line of gw.logs) {
      assert.ok(!/authorization|password/i.test(line), `log vaza credencial: ${line}`);
    }
  } finally {
    await gw.close();
    await up.close();
  }
});

test("P15: gateway disabled nao sobe; config enabled sem upstream/porta e rejeitada bounded", async () => {
  const { resolveGatewayConfig } = await import("./gateway/config.ts");
  const { createGatewayServer } = await import("./gateway/server.ts");

  // disabled -> createGatewayServer/listen se recusa (porta nao aberta)
  const disabled = resolveGatewayConfig({ enabled: false, upstream: "http://127.0.0.1:9", port: 4611 });
  const gw = createGatewayServer(disabled, { log: () => {} });
  await assert.rejects(() => gw.listen(0), /disabled/i, "enabled=false nao pode subir");

  // enabled sem upstream -> erro bounded
  assert.throws(() => resolveGatewayConfig({ enabled: true, port: 4611 }), /upstream/i);
  // enabled sem porta -> erro bounded
  assert.throws(() => resolveGatewayConfig({ enabled: true, upstream: "http://127.0.0.1:4511" }), /port/i);
  // porta fora de faixa -> erro bounded
  assert.throws(
    () => resolveGatewayConfig({ enabled: true, upstream: "http://127.0.0.1:4511", port: 70000 }),
    /port/i,
  );
  // upstream com esquema invalido -> erro bounded
  assert.throws(
    () => resolveGatewayConfig({ enabled: true, upstream: "ftp://x", port: 4611 }),
    /upstream/i,
  );
});

test("P16: payload malformed e oversized -> 400/413 bounded, ZERO chamadas upstream", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ maxBodyBytes: 1024 }));
  try {
    const bad = await fetch(`${gw.url}/api/session/ses_bad/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.ok(badBody.error?.code, "erro bounded com code");
    assert.ok(badBody.error.message.length <= 300, "mensagem bounded");

    const huge = await fetch(`${gw.url}/api/session/ses_big/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(4000) }),
    });
    assert.equal(huge.status, 413);
    const hugeBody = await huge.json();
    assert.ok(hugeBody.error?.code, "erro bounded com code");

    assert.equal(up.state.prompts.length, 0, "ZERO chamadas upstream em rejeicao bounded");
    assert.equal(up.state.order.length, 0, "ZERO qualquer request upstream");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("P17: SSE streama progressivo pelo gateway e cancelamento do cliente fecha upstream sem leak", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig());
  try {
    // --- streaming progressivo: chunk2 chega ~150ms depois do chunk1 ---
    const t0 = Date.now();
    let tFirst = null;
    let tSecond = null;
    const res = await fetch(`${gw.url}/api/event`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = res.body.getReader();
    async function nextChunk() {
      const { value, done } = await reader.read();
      assert.ok(!done, "stream terminou cedo demais");
      return Buffer.from(value).toString("utf8");
    }
    const c1 = await nextChunk();
    tFirst = Date.now() - t0;
    const c2 = await nextChunk();
    tSecond = Date.now() - t0;
    assert.match(c1, /"first"/);
    assert.match(c2, /"second"/);
    assert.ok(tFirst < 280, `chunk1 chegou tarde (bufferizado?): ${tFirst}ms`);
    assert.ok(
      tSecond - tFirst > 80,
      `chunks chegaram juntos = resposta bufferizada (first=${tFirst}ms second=${tSecond}ms)`,
    );
    await reader.cancel();

    // --- cancelamento: cliente aborta e upstream observa o close ---
    const res2 = await fetch(`${gw.url}/api/event`);
    const reader2 = res2.body.getReader();
    await reader2.read();
    await reader2.cancel(); // aborta do lado do cliente
    const deadline = Date.now() + 2000;
    while (up.state.sse.closedEarly === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(up.state.sse.closedEarly >= 1, "upstream deve observar o cancelamento do cliente");

    // --- sem leak de socket no gateway ---
    const leakDeadline = Date.now() + 2000;
    while (gw.activeSockets() > 0 && Date.now() < leakDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(gw.activeSockets(), 0, "gateway ficou com socket leak");
  } finally {
    await gw.close();
    await up.close();
  }
});
