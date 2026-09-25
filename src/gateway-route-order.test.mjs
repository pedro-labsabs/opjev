// Testes RED da ORDEM do role guard no route (round de repair, #24).
//
// Invariante: SEM confirmacao de papel externo, NENHUM trabalho de routing:
//   ZERO catalogos, ZERO Jev, ZERO switches — um unico forward nativo.
//
// Cobertura em dois niveis:
//   - aqui: decideAndApplyRoute() direto contra fakes HTTP reais (upstream +
//     Jev), com contagem de Jev via endpoint fake dedicado;
//   - gateway-admission.test.mjs (A12c/A12d): mesma matriz via gateway HTTP
//     real (catalogos observaveis no fake upstream).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeUpstream, startFakeJev, testConfig } from "./gateway-testkit.mjs";
import { resolveGatewayConfig } from "./gateway/config.ts";
import { decideAndApplyRoute } from "./gateway/route.ts";
import { UpstreamClient } from "./gateway/upstream.ts";
import {
  INTERNAL_WORKER_MARKER,
  INTERNAL_WORKER_ROLE,
} from "./worker-hooks.ts";

function gatewayConfig(upstreamUrl) {
  return resolveGatewayConfig({
    enabled: true,
    upstream: upstreamUrl,
    host: "127.0.0.1",
    port: 0,
    routeDecisionTimeoutMs: 1500,
  });
}

function counts(up, jev, sid) {
  const order = up.order();
  return {
    sessionGet: order.filter((k) => k === `GET /api/session/${sid}`).length,
    modelCatalog: order.filter((k) => k === "GET /api/model").length,
    agentCatalog: order.filter((k) => k === "GET /api/agent").length,
    jevCalls: jev.state.calls.length,
    models: up.state.models.length,
    agents: up.state.agents.length,
  };
}

test("R-INT: sessao interna conhecida -> ZERO pipeline de routing", async () => {
  const up = await startFakeUpstream({
    sessionMetadata: {
      ses_worder: { "jev-router": INTERNAL_WORKER_MARKER, "jev-role": INTERNAL_WORKER_ROLE },
    },
  });
  const jev = await startFakeJev();
  const upstream = new UpstreamClient({ origin: up.url, timeoutMs: 2000 });
  try {
    const outcome = await decideAndApplyRoute({
      sessionID: "ses_worder",
      text: "ROUTE: rerrotear worker",
      config: gatewayConfig(up.url),
      upstream,
      jevEndpoint: jev.url,
      jevApiKey: "test-key",
    });
    assert.equal(outcome.applied, false, "route nao aplicada em sessao interna");
    const c = counts(up, jev, "ses_worder");
    assert.equal(c.sessionGet, 1, "role lookup executado (1 GET sessao)");
    assert.equal(c.modelCatalog, 0, "ZERO catalogo de modelos antes do guard");
    assert.equal(c.agentCatalog, 0, "ZERO catalogo de agentes antes do guard");
    assert.equal(c.jevCalls, 0, "ZERO chamada Jev para sessao interna");
    assert.equal(c.models, 0, "ZERO model switch");
    assert.equal(c.agents, 0, "ZERO agent switch");
  } finally {
    await up.close();
    await jev.close();
  }
});

test("R-UNK: papel desconhecido (lookup falha) -> ZERO pipeline de routing", async () => {
  const up = await startFakeUpstream({ sessionFail: true });
  const jev = await startFakeJev();
  const upstream = new UpstreamClient({ origin: up.url, timeoutMs: 2000 });
  try {
    const outcome = await decideAndApplyRoute({
      sessionID: "ses_unkorder",
      text: "ROUTE: probe",
      config: gatewayConfig(up.url),
      upstream,
      jevEndpoint: jev.url,
      jevApiKey: "test-key",
    });
    assert.equal(outcome.applied, false, "papel desconhecido nao roteia");
    const c = counts(up, jev, "ses_unkorder");
    assert.equal(c.sessionGet, 1, "lookup tentado (1 GET sessao, falhou)");
    assert.equal(c.modelCatalog, 0, "ZERO catalogo com papel desconhecido");
    assert.equal(c.agentCatalog, 0, "ZERO catalogo com papel desconhecido");
    assert.equal(c.jevCalls, 0, "ZERO chamada Jev com papel desconhecido");
    assert.equal(c.models, 0, "ZERO model switch");
    assert.equal(c.agents, 0, "ZERO agent switch");
  } finally {
    await up.close();
    await jev.close();
  }
});

test("R-EXT: sessao externa conhecida -> pipeline de routing preservada", async () => {
  const up = await startFakeUpstream();
  const jev = await startFakeJev();
  const upstream = new UpstreamClient({ origin: up.url, timeoutMs: 2000 });
  try {
    const outcome = await decideAndApplyRoute({
      sessionID: "ses_extorder",
      text: "ROUTE: quick fix typo",
      config: gatewayConfig(up.url),
      upstream,
      jevEndpoint: jev.url,
      jevApiKey: "test-key",
    });
    assert.equal(outcome.applied, true, "sessao externa roteia normalmente");
    const c = counts(up, jev, "ses_extorder");
    assert.equal(c.sessionGet, 1, "lookup primeiro");
    assert.ok(c.modelCatalog >= 1 && c.agentCatalog >= 1, "catalogos consultados");
    assert.ok(c.jevCalls >= 1, "Jev consultado (fake 500 => fallback heuristico)");
    assert.equal(c.models, 1, "model switch aplicado");
    assert.equal(c.agents, 1, "agent switch aplicado");
  } finally {
    await up.close();
    await jev.close();
  }
});
