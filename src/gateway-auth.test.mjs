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
  const { createHash } = await import("node:crypto");
  const expectedHash = createHash("sha256").update(CLIENT_AUTH, "utf8").digest("hex");
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES, upstreamPassword: GW_PASSWORD }));
  try {
    const res = await fetch(`${gw.url}/api/info`, { headers: { authorization: CLIENT_AUTH } });
    assert.equal(res.status, 200);
    const seen = up.state.auth.filter((e) => e.kind === "GET /api/info");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authed, true);
    assert.equal(seen[0].hash, expectedHash, "valor preservado byte a byte (hash), nao so presenca");
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
    for (const line of gw.logs) {
      assert.ok(!/authorization|password/i.test(line), `log vaza credencial: ${line}`);
    }
  } finally {
    await gw.close();
    await up.close();
  }

  // Upstream protegido: anonimo recebe o 401 NATIVO (o upstream decide).
  const SECRET = "Basic b3BlbmNvZGU6c2VjcmV0by1wcm90ZWdpZG8=";
  const up2 = await startFakeUpstream({ requireAuth: SECRET });
  const gw2 = await startGateway(
    up2.url,
    testConfig({ rules: RULES, upstreamPassword: "secreto-protegido" }),
  );
  try {
    const denied = await fetch(`${gw2.url}/api/session/ses_anon/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello anonimo" }),
    });
    assert.equal(denied.status, 401, "upstream protegido nega anonimo via gateway (passthrough)");
    assert.deepEqual(
      authedFor(up2, "POST /api/session/ses_anon/prompt"),
      [false],
      "gateway nao autenticou o anonimo",
    );
  } finally {
    await gw2.close();
    await up2.close();
  }
});

test("AUTH-3: cliente autenticado -> caminho completo funciona; control-plane carrega a credencial", async () => {
  // Politica: o lookup valida a credencial DO CLIENTE; admit/RPC (pos-decisao,
  // mesmo dominio de confianca) usam a senha de env. Aqui ambas coincidem
  // (senha unica do upstream, como em producao).
  const SECRET = "Basic b3BlbmNvZGU6c2VjcmV0by1wcm90ZWdpZG8=";
  const { createHash } = await import("node:crypto");
  const expectedHash = createHash("sha256").update(SECRET, "utf8").digest("hex");
  const up = await startFakeUpstream({ requireAuth: SECRET });
  const gw = await startGateway(
    up.url,
    testConfig({ rules: RULES, upstreamPassword: "secreto-protegido" }),
  );
  try {
    const res = await fetch(`${gw.url}/api/session/ses_cp/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: SECRET },
      body: JSON.stringify({ text: "ORCH: tarefa do control-plane" }),
    });
    assert.equal(res.status, 200, "cliente autenticado orquestra normalmente");
    const hashOf = (kind) => up.state.auth.filter((e) => e.kind === kind).map((e) => e.hash);
    assert.deepEqual(
      hashOf("GET /api/session/ses_cp"),
      [expectedHash],
      "session lookup carrega a credencial do cliente (nao a de env)",
    );
    assert.deepEqual(hashOf("POST /api/session/ses_cp/prompt"), [expectedHash], "admissao autenticada");
    assert.deepEqual(
      hashOf("POST /api/rpc/opjev.admission.v1/orchestrate"),
      [expectedHash],
      "RPC do plugin autenticada",
    );
    for (const line of gw.logs) {
      assert.ok(!/authorization|password|secreto-protegido/i.test(line), `log vaza credencial: ${line}`);
    }
  } finally {
    await gw.close();
    await up.close();
  }
});

test("AUTH-5: orchestrate anonimo ou com credencial invalida -> 401, zero orchestration", async () => {
  // Invariante C1: sem credencial valida do CLIENTE, o gateway nao pode usar
  // a senha de env para admitir/orquestrar em nome dele. O lookup de sessao
  // espelha exatamente a postura de auth do cliente (o upstream decide).
  const SECRET = "Basic b3BlbmNvZGU6c2VjcmV0by1wcm90ZWdpZG8=";
  const up = await startFakeUpstream({ requireAuth: SECRET });
  const gw = await startGateway(
    up.url,
    testConfig({ rules: RULES, upstreamPassword: "secreto-protegido" }),
  );
  try {
    const json = { "content-type": "application/json" };
    // anonimo
    const anon = await fetch(`${gw.url}/api/session/ses_c1/prompt`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: "ORCH: deputado confuso" }),
    });
    assert.equal(anon.status, 401, "anonimo nao orquestra");
    assert.equal((await anon.json()).error?.code, "upstream-unauthorized");
    // credencial invalida (lixo) — presenca sem validade nao autoriza
    const garbage = await fetch(`${gw.url}/api/session/ses_c1/prompt`, {
      method: "POST",
      headers: { ...json, authorization: "Basic Z2FyYmFnZTppbnZhbGlk" },
      body: JSON.stringify({ text: "ORCH: deputado confuso" }),
    });
    assert.equal(garbage.status, 401, "credencial invalida nao orquestra");
    assert.equal(up.state.prompts.length, 0, "admissao duravel = 0");
    assert.equal(up.state.rpcs.length, 0, "RPC dispatch = 0");
    assert.equal(up.state.patches.length, 0, "parent wake = 0");
    assert.equal(gw.counters().admitted, 0);
  } finally {
    await gw.close();
    await up.close();
  }
});

test("AUTH-4: Upgrade obedece a mesma boundary (preserva, nunca injeta)", async () => {
  const { createHash } = await import("node:crypto");
  const expectedHash = createHash("sha256").update(CLIENT_AUTH, "utf8").digest("hex");
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
    const proxyCred = await upgrade("Proxy-Authorization: Basic cHJveHk6c2VjcmV0\r\n");
    assert.match(anon, /101 Switching Protocols/);
    assert.match(authed, /101 Switching Protocols/);
    assert.match(proxyCred, /101 Switching Protocols/, "handshake sobrevive sem proxy-credentials");
    assert.equal(up.state.upgrades.length, 3);
    assert.equal(up.state.upgrades[0].authed, false, "upgrade anonimo nao recebe credencial");
    assert.equal(up.state.upgrades[1].authed, true, "upgrade autenticado preserva auth");
    assert.equal(
      up.state.upgrades[1].hash,
      expectedHash,
      "upgrade preserva o valor byte a byte (hash), nao so presenca",
    );
    assert.equal(
      up.state.upgrades[2].proxyAuth,
      false,
      "proxy-authorization nao atravessa o tunel",
    );
    for (const line of gw.logs) {
      assert.ok(!/authorization|password/i.test(line), `log vaza credencial: ${line}`);
    }
  } finally {
    await gw.close();
    await up.close();
  }
});
