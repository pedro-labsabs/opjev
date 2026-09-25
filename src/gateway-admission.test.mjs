// Testes RED do gateway de admission deterministico (issue #24) — FLUXOS.
//
// Cenarios (spec #24):
//   A3  normal   -> exatamente 1 forward, corpo nativo preservado, zero wake/RPC
//   A4  route    -> decisao REAL (src/router.ts) + apply (model/agent) ANTES do
//                   forward unico; falha de decisao/apply (pre-efeito) -> fallback
//                   normal com exatamente 1 forward
//   A5  orchestrate -> persist-first resume:false (admissao duravel), NUNCA wake
//                   (zero PATCH), dispatch RPC direto ao plugin (1x)
//   A10 falha pre-efeito  -> fallback seguro (normal, 1 forward)
//   A11 falha pos-admissao -> 502 fail-closed, nunca re-encaminha/wake, record
//                   diagnostico preservado; erro upstream definitivo = passthrough
//   A12 marcador interno (worker/critic/orchestrator) -> bypass, sem recursao
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeUpstream, startGateway, testConfig } from "./gateway-testkit.mjs";
import {
  INTERNAL_WORKER_MARKER,
  INTERNAL_WORKER_ROLE,
} from "./worker-hooks.ts";

const RULES = [
  { prefix: "ORCH:", mode: "orchestrate" },
  { prefix: "ROUTE:", mode: "route" },
];

test("A3: modo normal -> exatamente 1 forward com o corpo original byte a byte", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const raw = JSON.stringify({ text: "hello world" });
    const res = await fetch(`${gw.url}/api/session/ses_norm/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data?.id?.startsWith("msg_"), "resposta nativa preservada");

    assert.equal(up.state.prompts.length, 1, "exatamente 1 forward");
    assert.equal(up.state.prompts[0].raw.toString("utf8"), raw, "bytes originais preservados");
    assert.equal(up.state.prompts[0].parsed.resume, undefined, "resume nativo intacto (forward transparente)");
    assert.equal(up.state.patches.length, 0, "nenhum wake");
    assert.equal(up.state.rpcs.length, 0, "nenhuma RPC no modo normal");
    assert.equal(gw.counters().intercepted, 1);
  } finally {
    await gw.close();
    await up.close();
  }
});

test("A4: modo route -> apply (model+agent) ANTES do forward unico, reusando o router real", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const res = await fetch(`${gw.url}/api/session/ses_route/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ROUTE: quick fix typo" }),
    });
    assert.equal(res.status, 200);
    await res.json();

    assert.equal(up.state.prompts.length, 1, "exatamente 1 forward");
    assert.equal(up.state.models.length, 1, "switch de modelo aplicado");
    assert.equal(up.state.agents.length, 1, "switch de agente aplicado");

    // guardrails: modelo aplicado pertence ao FREE_POOL (config.ts)
    const applied = up.state.models[0].raw.model;
    assert.ok(
      applied.providerID === "opencode" && typeof applied.id === "string" && applied.id.length > 0,
      `Model.Ref {providerID,id} valido, recebi ${JSON.stringify(applied)}`,
    );
    assert.ok(
      ["build", "plan"].includes(up.state.agents[0].raw.agent),
      `agente guardrailado, recebi ${JSON.stringify(up.state.agents[0].raw)}`,
    );

    // ordering: route aplicado ANTES do forward
    const order = up.order();
    const iModel = order.indexOf("POST /api/session/ses_route/model");
    const iAgent = order.indexOf("POST /api/session/ses_route/agent");
    const iPrompt = order.lastIndexOf("POST /api/session/ses_route/prompt");
    assert.ok(iModel >= 0 && iAgent >= 0, "switches registrados no upstream");
    assert.ok(iModel < iPrompt && iAgent < iPrompt, `forward deve ser DEPOIS da route: ${order.join(" | ")}`);
    assert.equal(up.state.rpcs.length, 0, "route nao usa RPC (router importado, nao segundo router)");
    assert.equal(gw.counters().routeApplied, 1);
  } finally {
    await gw.close();
    await up.close();
  }
});

test("A10: falha pre-efeito (catalogo/apply de route) -> fallback normal com exatamente 1 forward", async () => {
  // catalogo fora do ar: decisao de route impossivel -> fallback normal
  {
    const up = await startFakeUpstream({ catalogFail: true });
    const gw = await startGateway(up.url, testConfig({ rules: RULES }));
    try {
      const res = await fetch(`${gw.url}/api/session/ses_fb1/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "ROUTE: qualquer coisa" }),
      });
      assert.equal(res.status, 200, "fallback responde nativo");
      assert.equal(up.state.prompts.length, 1, "exatamente 1 forward no fallback");
      assert.equal(up.state.rpcs.length, 0);
      assert.equal(gw.counters().routeFallback, 1, "fallback registrado");
    } finally {
      await gw.close();
      await up.close();
    }
  }

  // switch de modelo falha (pre-admissao) -> segue normal, 1 forward
  {
    const up = await startFakeUpstream({ modelSwitchFail: true });
    const gw = await startGateway(up.url, testConfig({ rules: RULES }));
    try {
      const res = await fetch(`${gw.url}/api/session/ses_fb2/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "ROUTE: quick fix" }),
      });
      assert.equal(res.status, 200);
      assert.equal(up.state.prompts.length, 1, "exatamente 1 forward no fallback");
      assert.ok(gw.counters().routeFallback >= 1);
    } finally {
      await gw.close();
      await up.close();
    }
  }
});

test("A5: modo orchestrate -> persist-first resume:false, NUNCA wake, dispatch RPC direto 1x", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const res = await fetch(`${gw.url}/api/session/ses_orch/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ORCH: build the feature" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data?.id?.startsWith("msg_"), "cliente recebe shape nativo de prompt");
    assert.equal(body.output, undefined, "interno de orquestracao nao vaza ao cliente");

    // admissao duravel: unica chamada de prompt resume:false, texto preservado
    assert.equal(up.state.prompts.length, 1, "exatamente 1 admissao persistida");
    assert.equal(up.state.prompts[0].parsed.resume, false, "persist-first com resume:false");
    assert.equal(up.state.prompts[0].parsed.text, "ORCH: build the feature", "input preservado");

    // nunca wake: zero PATCH de inbox
    assert.equal(up.state.patches.length, 0, "zero wake do parent");

    // RPC direta ao opjev (seam publica), 1 dispatch
    assert.equal(up.state.rpcs.length, 1, "exatamente 1 dispatch RPC");
    assert.equal(up.state.rpcs[0].rpcID, "opjev.admission.v1");
    assert.equal(up.state.rpcs[0].method, "orchestrate");
    assert.equal(up.state.rpcs[0].input.sessionID, "ses_orch");
    assert.equal(up.state.rpcs[0].input.messageID, body.data.id, "identidade real do turno na RPC");
    assert.equal(up.state.rpcs[0].input.objective, "ORCH: build the feature");

    const c = gw.counters();
    assert.equal(c.intercepted, 1);
    assert.equal(c.admitted, 1);
    assert.equal(c.rpcDispatched, 1);
    assert.equal(c.failClosed, 0);
    assert.ok(
      c.records.some((r) => r.state === "started"),
      "record diagnostico do admission persistido",
    );
    // log sem conteudo sensivel de prompt
    for (const line of gw.logs) {
      assert.ok(!/build the feature/.test(line), `log vaza conteudo do prompt: ${line}`);
      assert.ok(!/authorization|password/i.test(line), `log vaza credencial: ${line}`);
    }
  } finally {
    await gw.close();
    await up.close();
  }
});

test("A10c: sessao sem estado legivel -> parcial honesto com rollback=false (nunca silencioso)", async () => {
  const up = await startFakeUpstream({ agentSwitchFail: true, sessionBare: true });
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const res = await fetch(`${gw.url}/api/session/ses_bare/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ROUTE: quick fix" }),
    });
    assert.equal(res.status, 200, "fallback responde nativo mesmo sem estado previo");
    assert.equal(up.state.prompts.length, 1, "exatamente 1 forward (pre-admissao)");
    assert.equal(up.state.models.length, 1, "sem estado anterior: NENHUM rollback inventado");
    const c = gw.counters();
    assert.equal(c.routeApplied, 0);
    assert.equal(c.routePartial, 1, "parcial contabilizado mesmo sem rollback possivel");
    const partial = gw.logs.find((l) => l.includes("route-partial"));
    assert.ok(partial && partial.includes('"rollback":false'), "evento declara rollback=false");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("A10d: forma 200 sem metadata (boundary documentado) => tratada como externa", async () => {
  // Boundary explicita e travada: metadata ausente/ilegivel nao e sinal de
  // papel interno (sessoes normais do runtime nao expoem metadata); ausencia
  // => externa. Lookup que FALHA (rede/5xx) continua fail-closed (SEC-ROLE-1).
  const up = await startFakeUpstream({ sessionBare: true });
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const res = await fetch(`${gw.url}/api/session/ses_bare2/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ORCH: sessao sem metadata" }),
    });
    assert.equal(res.status, 200, "ausencia de metadata nao bloqueia turno externo");
    assert.equal(up.state.prompts.length, 1, "admissao ocorre");
    assert.equal(up.state.rpcs.length, 1, "dispatch ocorre");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("A10b: falha de agent APOS model aplicado -> rollback best-effort, parcial NUNCA silencioso", async () => {
  const up = await startFakeUpstream({ agentSwitchFail: true });
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const res = await fetch(`${gw.url}/api/session/ses_partial/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ROUTE: quick fix" }),
    });
    assert.equal(res.status, 200, "fallback responde nativo mesmo com parcial");
    assert.equal(up.state.prompts.length, 1, "exatamente 1 forward (pre-admissao)");
    assert.equal(up.state.models.length, 2, "model aplicado + rollback best-effort");
    assert.equal(up.state.agents.length, 1, "agent falhou 1x");
    // rollback EFETIVO: estado final da sessao == estado anterior
    const final = await (await fetch(`${up.url}/api/session/ses_partial`)).json();
    assert.equal(final.data?.model?.id, "muse-spark-1.3-contributor-free", "rollback restaurou o modelo anterior");
    const c = gw.counters();
    assert.equal(c.routeApplied, 0, "route NAO conta como aplicada");
    assert.equal(c.routePartial, 1, "parcial registrado em contador proprio (nunca fallback silencioso)");
    assert.ok(
      c.records.length === 0 || c.records.every((r) => r.state !== "started"),
      "nenhum record de orchestration em caminho route",
    );
    assert.ok(
      gw.logs.some((l) => l.includes("route-partial")),
      "evento route-partial emitido no log diagnostico",
    );
    assert.ok(
      !gw.logs.some((l) => l.includes('"type":"route"') && l.includes("ses_partial")),
      "parcial nao se disfarca de route aplicada",
    );
  } finally {
    await gw.close();
    await up.close();
  }
});

test("A12b: sessao interna (metadata worker) com prompt limpo -> bypass, sem orchestration aninhada", async () => {
  const up = await startFakeUpstream({
    sessionMetadata: {
      ses_worker1: { "jev-router": INTERNAL_WORKER_MARKER, "jev-role": INTERNAL_WORKER_ROLE },
    },
  });
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const res = await fetch(`${gw.url}/api/session/ses_worker1/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ORCH: nested attack with clean metadata" }),
    });
    assert.equal(res.status, 200);
    assert.equal(up.state.prompts.length, 1, "forward normal 1x (comportamento nativo preservado)");
    assert.equal(up.state.prompts[0].parsed.resume, undefined, "nunca vira admissao/orchestrate");
    assert.equal(up.state.rpcs.length, 0, "ZERO dispatch para sessao interna");
    assert.equal(up.state.patches.length, 0);
    assert.equal(gw.counters().admitted, 0, "admissao zerada para sessao interna");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("SEC-ROLE-1: orchestrate com session lookup 500 -> fail-closed, zero orchestration", async () => {
  const up = await startFakeUpstream({ sessionFail: true });
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const res = await fetch(`${gw.url}/api/session/ses_unknown_role/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ORCH: papel indeterminado" }),
    });
    assert.equal(res.status, 502, "papel desconhecido = erro bounded, nunca orchestrate");
    const err = await res.json();
    assert.equal(err.error.code, "session-role-unknown");
    assert.equal(up.state.prompts.length, 0, "admissao duravel = 0");
    assert.equal(up.state.rpcs.length, 0, "RPC dispatch = 0");
    assert.equal(up.state.patches.length, 0, "parent wake = 0 (nenhum forward, nenhum PATCH)");
    assert.equal(gw.counters().admitted, 0);

    // Servidor vivo e caminhos explicitos intactos: normal funciona.
    const ok = await fetch(`${gw.url}/api/session/ses_unknown_role/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello normal" }),
    });
    assert.equal(ok.status, 200, "modo normal nao e afetado pelo fail-closed de orchestrate");
    assert.equal(up.state.prompts.length, 1, "apenas o forward normal chegou ao upstream");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("SEC-ROLE-1b: orchestrate para sessao inexistente (404) -> passthrough nativo, zero orchestration", async () => {
  const up = await startFakeUpstream({ sessionNotFound: true });
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const res = await fetch(`${gw.url}/api/session/ses_fantasma/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ORCH: sessao inexistente" }),
    });
    assert.equal(res.status, 404, "lookup definitivo 404 = passthrough nativo");
    const body = await res.text();
    assert.match(body, /session-not-found/, "corpo do lookup repassado (status do lookup, nao do prompt)");
    assert.equal(up.state.prompts.length, 0, "admissao duravel = 0");
    assert.equal(up.state.rpcs.length, 0, "RPC dispatch = 0");
    assert.equal(up.state.patches.length, 0, "parent wake = 0");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("A12c: sessao interna com prefixo ROUTE -> forward sem switches, zero mutacao", async () => {
  const up = await startFakeUpstream({
    sessionMetadata: {
      ses_workerR: { "jev-router": INTERNAL_WORKER_MARKER, "jev-role": INTERNAL_WORKER_ROLE },
    },
  });
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const res = await fetch(`${gw.url}/api/session/ses_workerR/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ROUTE: muda meu modelo" }),
    });
    assert.equal(res.status, 200, "fallback responde nativo");
    assert.equal(up.state.prompts.length, 1, "exatamente 1 forward");
    assert.equal(up.state.models.length, 0, "ZERO switch de modelo em sessao interna");
    assert.equal(up.state.agents.length, 0, "ZERO switch de agente em sessao interna");
    assert.equal(up.state.rpcs.length, 0, "ZERO dispatch");
    assert.equal(gw.counters().routeApplied, 0, "route nao conta como aplicada");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("A12d: route com session-role lookup ambiguo -> fallback normal, zero switches", async () => {
  const up = await startFakeUpstream({ sessionFail: true });
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const res = await fetch(`${gw.url}/api/session/ses_ambrole/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ROUTE: probe" }),
    });
    assert.equal(res.status, 200, "fallback responde nativo");
    assert.equal(up.state.models.length, 0, "ZERO switch de modelo com papel desconhecido");
    assert.equal(up.state.agents.length, 0, "ZERO switch de agente com papel desconhecido");
    assert.equal(up.state.rpcs.length, 0, "ZERO dispatch");
    assert.equal(up.state.patches.length, 0, "nenhum wake");
    assert.equal(up.state.prompts.length, 1, "prompt original encaminhado exatamente 1x");
    const c = gw.counters();
    assert.equal(c.routeApplied, 0, "route nao aplicada");
    assert.equal(c.routeFallback, 1, "fallback contabilizado");
    assert.equal(c.routePartial, 0, "nada parcial (nenhum efeito ocorreu)");
    assert.equal(c.admitted, 0, "admissao zero");
    assert.equal(c.rpcDispatched, 0, "dispatch zero");
  } finally {
    await gw.close();
    await up.close();
  }
});

test("A11: falha pos-admissao -> fail-closed 502, nunca re-encaminha/wake, record preservado", async () => {
  // RPC do plugin falha depois da admissao duravel
  {
    const up = await startFakeUpstream({ rpcMode: "fail500" });
    const gw = await startGateway(up.url, testConfig({ rules: RULES }));
    try {
      const res = await fetch(`${gw.url}/api/session/ses_fc/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "ORCH: vai falhar" }),
      });
      assert.equal(res.status, 502, "fail-closed explicito ao cliente");
      const err = await res.json();
      assert.equal(err.error.code, "orchestration-dispatch-failed");

      assert.equal(up.state.prompts.length, 1, "admissao NAO e re-enviada");
      assert.equal(up.state.patches.length, 0, "NUNCA wake apos admissao");
      const c = gw.counters();
      assert.ok(c.failClosed >= 1);
      assert.ok(
        c.records.some((r) => r.state === "failed"),
        "record diagnostico failed preservado",
      );
    } finally {
      await gw.close();
      await up.close();
    }
  }

  // admissao AMBIGUA (upstream nunca responde) -> 502 sem re-tentativa
  {
    const up = await startFakeUpstream({ promptMode: "hang" });
    const gw = await startGateway(up.url, testConfig({ rules: RULES, upstreamTimeoutMs: 500 }));
    try {
      const res = await fetch(`${gw.url}/api/session/ses_amb/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "ORCH: ambiguo" }),
      });
      assert.equal(res.status, 502);
      const err = await res.json();
      assert.equal(err.error.code, "admission-unknown", "ambiguidade nao vira re-forward");
      assert.equal(up.state.prompts.length, 1, "ZERO re-tentativa que poderia duplicar");
      assert.equal(up.state.rpcs.length, 0);
      assert.equal(up.state.patches.length, 0);
    } finally {
      await gw.close();
      await up.close();
    }
  }

  // erro DEFINITIVO upstream (500) -> passthrough nativo, zero dispatch
  {
    const up = await startFakeUpstream({ promptMode: "fail500" });
    const gw = await startGateway(up.url, testConfig({ rules: RULES }));
    try {
      const res = await fetch(`${gw.url}/api/session/ses_def/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "ORCH: rejeitado" }),
      });
      assert.equal(res.status, 500, "status nativo preservado");
      assert.match(await res.text(), /prompt-rejected/);
      assert.equal(up.state.prompts.length, 1);
      assert.equal(up.state.rpcs.length, 0, "sem admissao -> sem RPC");
      assert.equal(up.state.patches.length, 0);
    } finally {
      await gw.close();
      await up.close();
    }
  }
});

test("A12: marcador interno (worker/critic/orchestrator) -> bypass da admissao, sem recursao", async () => {
  const up = await startFakeUpstream();
  const gw = await startGateway(up.url, testConfig({ rules: RULES }));
  try {
    const res = await fetch(`${gw.url}/api/session/ses_int/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "ORCH: recursive attack",
        metadata: { "jev-router": INTERNAL_WORKER_MARKER, "jev-role": INTERNAL_WORKER_ROLE },
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(up.state.prompts.length, 1, "forward normal 1x");
    assert.equal(up.state.prompts[0].parsed.resume, undefined, "nunca vira admissao/orchestrate");
    assert.equal(up.state.rpcs.length, 0, "ZERO dispatch para marcador interno");
    assert.equal(up.state.patches.length, 0);
    assert.equal(gw.counters().admitted, 0, "admissao zerada para papel interno");
  } finally {
    await gw.close();
    await up.close();
  }
});
