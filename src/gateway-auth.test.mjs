// Testes RED da fronteira de autenticacao do gateway (round de repair, #24).
//
// Invariante:
//   cliente sem Authorization NUNCA herda a credencial upstream do gateway.
//   Chamadas internas do control-plane (admissao, RPC, catalogos, switches,
//   session lookup) usam a credencial de env — nunca o trafego do cliente.
//
// Cenarios:
//   AUTH-1 client com Authorization -> preservada byte a byte no upstream
//   AUTH-2 client sem Authorization (gateway COM senha) -> upstream sem auth
//   AUTH-3 control-plane autentica (admit/RPC com senha) mesmo com cliente anonimo
//   AUTH-4 HTTP e Upgrade obedecem a mesma boundary
//
// Fronteira HTTP REAL: fake em node:http + gateway real; sem mocks de funcao.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startFakeUpstream, startGateway, testConfig } from "./gateway-testkit.mjs";

const RULES = [
  { prefix: "ORCH:", mode: "orchestrate" },
  { prefix: "ROUTE:", mode: "route" },
];
const CLIENT_AUTH = "Basic Y2xpZW50OnRva2VuLWNsaWVudGU=";
const GW_PASSWORD = "segredo-upstream-de-teste";

function authedFor(up, kind) {
  return up.state.auth.filter((e) => e.kind === kind).map((e) => e.authed);
}

test("AUTH-1: Authorization do cliente e preservada byte a byte no upstream", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES, upstreamPassword: GW_PASSWORD }));
  try {
    const res = await fetch(`${gw.url}/api/info`, { headers: { authorization: CLIENT_AUTH } });
    assert.equal(res.status, 200);
    assert.deepEqual(authedFor(up, "GET /api/info"), [true], "upstream ve request autenticado");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("AUTH-2: cliente sem Authorization NAO herda a credencial do gateway", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES, upstreamPassword: GW_PASSWORD }));
  try {
    // GET comum sem auth
    const info = await fetch(`${gw.url}/api/info`);
    assert.equal(info.status, 200);
    // POST normal sem auth (forward transparente)
    const prompt = await fetch(`${gw.url}/api/session/ses_anon/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello anonimo" }),
    });
    assert.equal(prompt.status, 200);
    assert.deepEqual(authedFor(up, "GET /api/info"), [false], "sem injecao implicita no GET");
    assert.deepEqual(
      authedFor(up, "POST /api/session/ses_anon/prompt"),
      [false],
      "sem injecao implicita no forward",
    );
  } finally {
    await gw.close();
    await up.close();
  }
});

test("AUTH-3: control-plane autentica com a senha de env mesmo com cliente anonimo", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES, upstreamPassword: GW_PASSWORD }));
  try {
    // Cliente ANONIMO pede orchestrate: admissao + RPC (control-plane) usam a
    // senha; nenhum request carrega privilegio para o cliente.
    const res = await fetch(`${gw.url}/api/session/ses_cp/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ORCH: tarefa do control-plane" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      authedFor(up, "POST /api/session/ses_cp/prompt"),
      [true],
      "admissao persist-first (control-plane) autenticada",
    );
    assert.deepEqual(
      authedFor(up, "POST /api/rpc/opjev.admission.v1/orchestrate"),
      [true],
      "RPC do plugin (control-plane) autenticada",
    );
    assert.deepEqual(
      authedFor(up, "GET /api/session/ses_cp"),
      [true],
      "session lookup (control-plane) autenticado",
    );
  } finally {
    await gw.close();
    await up.close();
  }
});

test("AUTH-4: Upgrade obedece a mesma boundary (preserva, nunca injeta)", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ upstreamPassword: GW_PASSWORD }));
  let anon = null;
  let authed = null;
  try {
    async function upgrade(extraHeaders) {
      return new Promise((resolve, reject) => {
        const sock = net.connect(gw.port, "127.0.0.1", () => {
          sock.write(
            "GET /api/echo-channel HTTP/1.1\r\n" +
              `Host: 127.0.0.1:${gw.port}\r\n` +
              "Connection: upgrade\r\n" +
              "Upgrade: echo\r\n" +
              extraHeaders +
              "\r\n",
          );
        });
        const chunks = [];
        sock.on("data", (c) => chunks.push(c));
        const text = () => Buffer.concat(chunks).toString("utf8");
        const deadline = Date.now() + 5000;
        (async () => {
          for (;;) {
            if (text().includes("101")) break;
            if (Date.now() >= deadline) throw new Error(`sem 101: ${JSON.stringify(text().slice(0, 120))}`);
            await new Promise((r) => setTimeout(r, 25));
          }
          sock.write("ping-up");
          for (;;) {
            if (text().includes("ping-up")) break;
            if (Date.now() >= deadline) throw new Error("sem eco");
            await new Promise((r) => setTimeout(r, 25));
          }
          sock.destroy();
          resolve(text());
        })().catch(reject);
      });
    }
    anon = await upgrade("");
    authed = await upgrade(`Authorization: ${CLIENT_AUTH}\r\n`);
    assert.match(anon, /101 Switching Protocols/);
    assert.match(authed, /101 Switching Protocols/);
    assert.equal(up.state.upgrades.length, 2);
    assert.equal(up.state.upgrades[0].authed, false, "upgrade anonimo nao recebe credencial");
    assert.equal(up.state.upgrades[1].authed, true, "upgrade autenticado preserva auth");
  } finally {
    await gw.close();
    await up.close();
  }
});
