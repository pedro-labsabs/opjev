// Contrato real do prompt hook (@opencode/plugin), lido DIRETAMENTE dos .d.ts
// instalados (nao de memoria): o admission layer (#13) so e valido se operar
// sobre o contrato que o runtime de fato expoe.
//
// Consumidores do contrato:
//   - index.ts prompt hook: event e um SessionPrompt real. A admissao muta
//     `prompt.text` (trampoline) e `metadata` — ambos sem readonly no tipo.
//   - delivery steer|queue: o hook nunca cria nem muda delivery (admissao nao
//     fabrica turnos, nao redireciona caixa).
//   - a ausencia de result/cancel/consume confirma que o hook nao "responde"
//     o prompt: a admissao so prepara o terreno para o agente invocar o seam
//     explicito orchestrate_once.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PLUGIN_PKG = new URL("../node_modules/@opencode/plugin/dist/promise/", import.meta.url);
const SCHEMA_PKG = new URL("../node_modules/@opencode/schema/dist/", import.meta.url);

function read(pkg, file) {
  return readFileSync(new URL(file, pkg), "utf8");
}

const SESSION_DTS = read(PLUGIN_PKG, "session.d.ts");
const REGISTRATION_DTS = read(PLUGIN_PKG, "registration.d.ts");
const INBOX_DTS = read(SCHEMA_PKG, "session-inbox.d.ts");

describe("prompt hook contract real (@opencode/plugin .d.ts)", () => {
  it("SessionPrompt: sessionID/messageID readonly; prompt mutavel (trampoline); metadata?; delivery", () => {
    const block = SESSION_DTS.match(/export interface SessionPrompt \{([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.ok(block.length > 0, "interface SessionPrompt encontrada no .d.ts");
    assert.match(block, /readonly\s+sessionID:\s*Session\.ID/, "sessionID readonly");
    assert.match(block, /readonly\s+messageID:\s*SessionMessage\.ID/, "messageID readonly");
    // prompt NAO e readonly: DeepMutable permite o trampoline trocar o texto.
    assert.match(block, /prompt:\s*Types\.DeepMutable<PromptInput\.Prompt>/, "prompt DeepMutable (mutavel)");
    assert.ok(!/readonly\s+prompt/.test(block), "prompt sem readonly");
    assert.match(block, /metadata\?:\s*Record<string,\s*unknown>/, "metadata opcional");
    assert.match(block, /delivery:\s*SessionInbox\.Delivery/, "delivery tipada");
  });

  it("SessionPrompt NAO tem result/cancel/consume (hook nao responde turno)", () => {
    const block = SESSION_DTS.match(/export interface SessionPrompt \{([\s\S]*?)\n\}/)?.[1] ?? "";
    for (const forbidden of ["result", "cancel", "consume"]) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(block), `SessionPrompt sem campo "${forbidden}"`);
    }
  });

  it("ModelHooks callback: (input) => Promise<void> | void (hook pode ser sync)", () => {
    assert.match(
      REGISTRATION_DTS,
      /\(input:\s*Spec\[Name\]\)\s*=>\s*Promise<void>\s*\|\s*void/,
      "callback retorna Promise<void> | void",
    );
  });

  it("SessionInbox.Delivery: literal exatamente steer|queue", () => {
    const delivery = INBOX_DTS.match(/export declare const Delivery: Schema\.Literals<readonly \[([^\]]+)\]>;/)?.[1] ?? "";
    assert.ok(delivery.length > 0, "Delivery schema encontrado");
    for (const literal of ["steer", "queue"]) {
      assert.ok(delivery.includes(`"${literal}"`), `Delivery inclui "${literal}"`);
    }
    assert.ok(!/\b(reject|redirect|drop)\b/.test(delivery), "Delivery sem inventar literais novos");
  });
});