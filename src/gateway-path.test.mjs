// Testes RED de path malformado no gateway (round de repair, #24).
//
// Entrada HTTP invalida nunca pode derrubar o processo:
//
//   PATH-1 POST /api/session/%ZZ/prompt -> 400 bounded
//   PATH-2 zero efeito upstream (sem admissao/RPC/wake)
//   PATH-3 servidor continua operacional depois da requisicao invalida
//
// O request malformado e enviado via socket bruto (clientes HTTP normais
// normalizam o path antes de enviar).
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startFakeUpstream, startGateway, testConfig } from "./gateway-testkit.mjs";

const RULES = [{ prefix: "ORCH:", mode: "orchestrate" }];

function rawPost(port, path, body) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      const payload = Buffer.from(body, "utf8");
      sock.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${payload.byteLength}\r\nConnection: close\r\n\r\n`,
      );
      sock.write(payload);
    });
    const chunks = [];
    sock.on("data", (c) => chunks.push(c));
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ timeout: true, text: Buffer.concat(chunks).toString("utf8") });
    }, 4000);
    sock.on("close", () => {
      clearTimeout(timer);
      resolve({ timeout: false, text: Buffer.concat(chunks).toString("utf8") });
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve({ timeout: false, text: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

test("PATH: percent-encoding malformado -> 400 bounded, zero upstream, servidor vivo", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    // PATH-1: resposta bounded (nao socket pendurado, nao crash)
    const bad = await rawPost(gw.port, "/api/session/%ZZ/prompt", '{"text":"ORCH: x"}');
    assert.equal(bad.timeout, false, "servidor responde (nao pendura o socket)");
    assert.match(bad.text, /400/, "status 400 bounded");
    assert.match(bad.text, /invalid-session-path/, "code diagnostico bounded");

    // PATH-2: zero efeito upstream
    assert.equal(up.state.prompts.length, 0, "nenhuma admissao");
    assert.equal(up.state.rpcs.length, 0, "nenhuma RPC");
    assert.equal(up.state.patches.length, 0, "nenhum wake");

    // PATH-3: servidor continua operacional no MESMO socket-server
    const ok = await fetch(`${gw.url}/api/session/ses_depois/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello depois" }),
    });
    assert.equal(ok.status, 200, "requests normais continuam funcionando");
    assert.equal(up.state.prompts.length, 1, "apenas o request valido chegou ao upstream");
  } finally {
    await gw.close();
    await up.close();
  }
});
