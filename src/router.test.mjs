// Testes comportamentais do jev-free-router.
// Executam o plugin real (index.ts) contra um fake ctx do OpenCode e o Jev
// stubado via global fetch (SystemOne). Não há verificação de texto-fonte:
// cada teste observa comportamento real (hooks, switches, storage, payloads).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import pluginDefault from "../index.ts";
import {
  decideRoute,
  decideEscalation,
  heuristicRoute,
  nextFallback,
  chainFor,
} from "./router.ts";
import { buildSnapshot } from "./snapshot.ts";
import { sanitizeState } from "./sanitize.ts";
import { isFreeModel, FREE_POOL, splitModelRef } from "./config.ts";
import {
  makeCtx,
  makeStorage,
  stubFetch,
  okJev,
  routeAnswers,
  escalateAnswers,
  recoverAnswers,
  choice,
  noul,
  score,
} from "./harness.mjs";

const FREE = [...FREE_POOL];
const ALL_MODELS = [
  "opencode/big-pickle",
  "opencode/mimo-v2.5-free",
  "opencode/ling-3.0-flash-fin-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/muse-spark-1.3-contributor-free",
];

const PLUGIN_OPTS = {
  enableAutoRoute: true,
  jevTimeoutMs: 500,
  confidenceThreshold: 0.55,
  jevEndpoint: "https://opencode.ai/zen/v1/systemone",
  jevModel: "jev-1.13-free",
  apiKeyEnv: "OPENCODE_API_KEY",
};

async function boot(ctx) {
  await pluginDefault.setup(ctx);
  return ctx;
}

async function bootCtx(over = {}) {
  const m = makeCtx(over);
  await pluginDefault.setup(m.ctx);
  return m;
}

describe("DecisionSnapshot (buildSnapshot)", () => {
  it("recupera agente e modelo REAIS da sessao via ctx.session.get", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "plan", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({ "intention/s1": { text: "fazer refactor" } }),
      options: PLUGIN_OPTS,
    });
    const snap = await buildSnapshot(m.ctx, "s1");
    assert.equal(snap.agent, "plan");
    assert.equal(snap.model, "opencode/big-pickle");
    assert.ok(snap.freeModels.includes("opencode/big-pickle"));
    assert.ok(snap.freeModels.every((x) => FREE_POOL.includes(x)));
  });

  it("intencao e truncada (bounded), nunca history completa", async () => {
    const longText = "x".repeat(2000);
    const m = await bootCtx({
      models: ALL_MODELS,
      storage: makeStorage({ "intention/s1": { text: longText } }),
      options: PLUGIN_OPTS,
    });
    const snap = await buildSnapshot(m.ctx, "s1");
    assert.ok(snap.intention.length <= 600, `intenção bounded (got ${snap.intention.length})`);
    assert.match(snap.intention, /truncado/);
  });

  it("aceita contexto especifico da decisao (attempt, lastError, failedModel, priorDecision)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "plan", model: { providerID: "opencode", id: "nemotron-3-ultra-free" } },
      storage: makeStorage({ "intention/s1": { text: "arquitetar tenants" } }),
      options: PLUGIN_OPTS,
    });
    const prior = { at: 1, state: {}, answers: { via: "chain" } };
    const snap = await buildSnapshot(m.ctx, "s1", {
      attempt: 3,
      lastError: "http_error: timeout apos 30s",
      failedModel: "opencode/nemotron-3-ultra-free",
      priorDecision: prior,
    });
    assert.equal(snap.attempt, 3, "attempt real entra no snapshot");
    assert.equal(snap.lastError, "http_error: timeout apos 30s");
    assert.equal(snap.failedModel, "opencode/nemotron-3-ultra-free");
    assert.deepEqual(snap.priorDecision, prior);
    // bounded: erro grande não estoura (era o objetivo do contexto especifico).
    const big = await buildSnapshot(m.ctx, "s1", { lastError: "e".repeat(5000) });
    assert.ok(String(big.lastError).length <= 450, "erro boundado a ~400 chars");
  });
});

describe("prompt hook: agente/modelo reais + decisao do Jev", () => {
  it("1. prompt envia agente/modelo reais ao Jev (nao 'unknown')", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "plan", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => okJev(routeAnswers({ route: "heavy-reasoning", agent: "plan", model: "opencode/muse-spark-1.3-contributor-free" })));
    try {
      const ev = { sessionID: "s1", messageID: "m1", prompt: { text: "arquitetar um sistema distribuido" }, metadata: {}, delivery: {} };
      await m.hooks.session.prompt(ev);
      const body = stub.bodies()[0];
      assert.ok(body, "Jev deve ter sido consultado");
      assert.equal(body.state.agent, "plan");
      assert.equal(body.state.model, "opencode/big-pickle");
      assert.equal(ev.metadata["jev-router"], "routed");
      assert.equal(ev.metadata["jev-model"], "opencode/muse-spark-1.3-contributor-free");
    } finally {
      stub.restore();
    }
  });

  it("2. decisao valida de agente feita pelo Jev nao e sobrescrita", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => okJev(routeAnswers({ route: "fast-coding", agent: "plan", model: "opencode/big-pickle", confidence: 0.95 })));
    try {
      const ev = { sessionID: "s1", messageID: "m1", prompt: { text: "adicionar um botao" }, metadata: {}, delivery: {} };
      await m.hooks.session.prompt(ev);
      const body = stub.bodies()[0];
      const routeQ = body.questions.agent;
      assert.ok(Object.keys(routeQ.criteria).includes("plan"), "pergunta de agent deve listar candidatos validos");
      assert.equal(ev.metadata["jev-agent"], "plan");
      assert.notEqual(ev.metadata["jev-overridden"], true);
    } finally {
      stub.restore();
    }
  });
});

describe("agente elegivel = ctx.agent.list() (sem restricao build|plan)", () => {
  it("agente custom (explore) exposto pelo runtime e aceito e aplicado", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      agents: ["build", "plan", "explore"],
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => okJev(routeAnswers({ route: "research-docs", agent: "explore", model: "opencode/ling-3.0-flash-fin-free", confidence: 0.9 })));
    try {
      const ev = { sessionID: "s1", messageID: "m1", prompt: { text: "pesquisar docs de uma lib desconhecida" }, metadata: {}, delivery: {} };
      await m.hooks.session.prompt(ev);
      const body = stub.bodies()[0];
      assert.ok(body, "Jev deve ter sido consultado");
      // O Jev so conhece candidatos que o runtime expoe (nunca fora da lista).
      assert.ok(Object.keys(body.questions.agent.criteria).includes("explore"), "criteria deve listar explore");
      assert.equal(ev.metadata["jev-agent"], "explore");
      assert.equal(m.getState().agent, "explore", "sessao deve trocar para explore");
      assert.notEqual(ev.metadata["jev-overridden"], true, "decisao valida nao deve ser sobrescrita");
    } finally {
      stub.restore();
    }
  });

  it("lista disponivel mas vazia: nunca apresenta candidatos invalidos (fallback build/plan)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      agents: [],
      session: { agent: "plan", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => okJev(routeAnswers({ route: "research-docs", agent: "super-agent", model: "opencode/ling-3.0-flash-fin-free", confidence: 0.9 })));
    try {
      const ev = { sessionID: "s1", messageID: "m1", prompt: { text: "pesquisar e comparar libs" }, metadata: {}, delivery: {} };
      await m.hooks.session.prompt(ev);
      const body = stub.bodies()[0];
      // Sem lista real, o roteiro apresenta apenas o fallback seguro build/plan.
      const criteria = Object.keys(body.questions.agent.criteria);
      assert.deepEqual(criteria.sort(), ["build", "plan"]);
      assert.ok(["build", "plan"].includes(ev.metadata["jev-agent"]), "agente final deve cair no fallback seguro");
      assert.equal(ev.metadata["jev-overridden"], true, "resposta fora do fallback precisa ser marcada");
    } finally {
      stub.restore();
    }
  });
});

describe("guardrails free-only (modelo)", () => {
  it("3. Jev so consegue selecionar modelos do FREE_POOL", async () => {
    const d = await decideRoute({
      prompt: "implementar feature",
      agent: "build",
      validAgents: ["build", "plan"],
      freeCandidates: FREE,
      route: "unknown",
      jevModel: "jev-1.13-free",
      jevEndpoint: "https://x",
      apiKey: undefined,
      confidenceThreshold: 0.55,
    });
    assert.ok(isFreeModel(d.model), "modelo decidido deve pertencer ao FREE_POOL");
  });

  it("resposta arbitraria do Jev (claude/gpt) e substituida por candidato free", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => okJev(routeAnswers({ route: "fast-coding", agent: "build", model: "anthropic/claude-sonnet-4", confidence: 0.95 })));
    try {
      const ev = { sessionID: "s1", messageID: "m1", prompt: { text: "feature" }, metadata: {}, delivery: {} };
      await m.hooks.session.prompt(ev);
      assert.ok(isFreeModel(ev.metadata["jev-model"]), "modelo aplicado deve ser free");
      assert.equal(ev.metadata["jev-overridden"], true);
    } finally {
      stub.restore();
    }
  });

  it("4b. escolha explicita invalida de agent registra attemptedAgent sem apagar o fallback", async () => {
    const stub = stubFetch(async () => okJev(routeAnswers({ route: "fast-coding", agent: "ghost-agent", model: "opencode/big-pickle", confidence: 0.9 })));
    try {
      const d = await decideRoute({
        prompt: "implementar feature",
        agent: "build",
        validAgents: ["build"],
        freeCandidates: [...FREE_POOL],
        route: "unknown",
        jevModel: "jev-1.13-free",
        jevEndpoint: "https://x",
        apiKey: undefined,
        confidenceThreshold: 0.55,
      });
      assert.equal(d.attemptedAgent, "ghost-agent", "tentativa invalida auditavel");
      assert.equal(d.agent, "build", "fallback operacional da lane mantido");
      assert.equal(d.overridden, true, "substituicao marcada");
    } finally {
      stub.restore();
    }
  });

  it("4. modelo removido do catalogo nao e selecionado", async () => {
    const removed = "opencode/muse-spark-1.3-contributor-free";
    const d = await decideRoute({
      prompt: "pesquisar docs",
      agent: "build",
      validAgents: ["build", "plan"],
      freeCandidates: FREE.filter((x) => x !== removed),
      route: "unknown",
      jevModel: "jev-1.13-free",
      jevEndpoint: "https://x",
      apiKey: undefined,
      confidenceThreshold: 0.55,
    });
    assert.notEqual(d.model, removed, "modelo fora do catalogo nao pode ser escolhido");
  });
});

describe("retry hook", () => {
  it("5. fornece ao Jev o modelo que REALMENTE falhou (snapshot enriquecido)", async () => {
    const storage = makeStorage({
      "route/s1": { route: "fast-coding", model: "opencode/big-pickle", agent: "build", chain: chainFor("fast-coding") },
      "intention/s1": { text: "refatorar o modulo de auth" },
    });
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage,
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => okJev(escalateAnswers("opencode/mimo-v2.5-free")));
    try {
      const ev = {
        sessionID: "s1",
        agent: "build",
        model: { providerID: "opencode", id: "big-pickle" },
        error: { type: "http_error", message: "500 internal", status: 500 },
        attempt: 1,
        decision: {},
      };
      await m.hooks.session.retry(ev);
      // O retry usa o snapshot enriquecido: o payload do SystemOne agora tem
      // session+failure+availableModels, com o modelo que realmente falhou.
      const body = stub.bodies().find((b) => b.state?.failure?.failedModel);
      assert.ok(body, "decideEscalation deve ter sido chamado");
      assert.equal(body.state.failure.failedModel, "opencode/big-pickle");
      assert.equal(body.state.session.intention, "refatorar o modulo de auth");
      assert.equal(body.state.session.attempt, 1, "attempt real do evento entra no estado");
      assert.equal(ev.decision.retry, true);
      assert.equal(m.getState().model.id, "mimo-v2.5-free");
      const stored = storage._map.get("route/s1");
      assert.equal(stored.model, "opencode/mimo-v2.5-free");
      const retryState = storage._map.get("retry/s1");
      assert.ok(retryState.tried.includes("opencode/big-pickle"));
      assert.ok(retryState.tried.includes("opencode/mimo-v2.5-free"));
    } finally {
      stub.restore();
    }
  });

  it("6. throttle global nao causa troca inutil de modelo (sem Jev)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({ "route/s1": { route: "fast-coding", model: "opencode/big-pickle", agent: "build", chain: [] } }),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(() => { throw new Error("nao deveria consultar o Jev"); });
    try {
      const ev = {
        sessionID: "s1",
        agent: "build",
        model: { providerID: "opencode", id: "big-pickle" },
        error: { type: "http_error", message: "rate limit exceeded for Zen free tier", status: 429 },
        attempt: 2,
        decision: {},
      };
      await m.hooks.session.retry(ev);
      assert.deepEqual(ev.decision, { retry: true, delay: 5000 });
      assert.equal(m.calls.switchModel.length, 0, "throttle nao deve trocar modelo");
      assert.equal(stub.calls.length, 0, "throttle nao deve consultar o Jev");
    } finally {
      stub.restore();
    }
  });

  it("context overflow deixa compaction resolver (sem troca, sem Jev)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({ "route/s1": { route: "fast-coding", model: "opencode/big-pickle", agent: "build", chain: [] } }),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(() => { throw new Error("nao deveria consultar o Jev"); });
    try {
      const ev = { sessionID: "s1", agent: "build", model: { providerID: "opencode", id: "big-pickle" }, error: { type: "context", message: "context length exceeded, too large to continue", status: 400 }, attempt: 1, decision: {} };
      await m.hooks.session.retry(ev);
      assert.equal(ev.decision.retry, undefined, "overflow nao deve mutar decision");
      assert.equal(m.calls.switchModel.length, 0);
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
    }
  });

  it("8. cadeia esgotada termina sem loop (retry:false)", async () => {
    const chain = chainFor("fast-coding");
    const lastModel = chain[chain.length - 1];
    const lastId = lastModel.split("/")[1];
    const storage = makeStorage({
      "route/s1": { route: "fast-coding", model: lastModel, agent: "build", chain },
      "retry/s1": { tried: [...chain] },
    });
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: lastId } },
      storage,
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(() => { throw new Error("nao deveria consultar o Jev"); });
    try {
      const ev = { sessionID: "s1", agent: "build", model: { providerID: "opencode", id: lastId }, error: { type: "http_error", message: "500", status: 500 }, attempt: 3, decision: {} };
      await m.hooks.session.retry(ev);
      assert.deepEqual(ev.decision, { retry: false });
      assert.equal(m.calls.switchModel.length, 0, "nada a trocar, sem loop");
    } finally {
      stub.restore();
    }
  });

  it("7. Jev indisponivel usa fallback deterministico (cadeia)", async () => {
    const storage = makeStorage({
      "route/s1": { route: "fast-coding", model: "opencode/big-pickle", agent: "build", chain: chainFor("fast-coding") },
    });
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage,
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(() => { throw new Error("network down"); });
    try {
      const ev = { sessionID: "s1", agent: "build", model: { providerID: "opencode", id: "big-pickle" }, error: { type: "http_error", message: "500", status: 500 }, attempt: 1, decision: {} };
      await m.hooks.session.retry(ev);
      assert.equal(ev.decision.retry, true);
      // fallback: proximo candidato da cadeia apos big-pickle (ordem real da chain).
      const chain = chainFor("fast-coding");
      const expected = chain.find((c) => c !== "opencode/big-pickle");
      assert.equal(m.getState().model.id, expected.split("/")[1]);
    } finally {
      stub.restore();
    }
  });
});

describe("retry hook: snapshot completo ao Jev", () => {
  it("envia intencao/agente/rota/attempt/triedModels/availableModels/erro e priorDecision", async () => {
    const priorDecision = {
      at: Date.now() - 1000,
      state: { failedModel: "opencode/big-pickle" },
      answers: { via: "chain", model: "opencode/mimo-v2.5-free" },
    };
    const storage = makeStorage({
      "route/s1": { route: "fast-coding", model: "opencode/big-pickle", agent: "build", chain: chainFor("fast-coding") },
      "intention/s1": { text: "refatorar o modulo de auth" },
      "retry/s1": { tried: [] },
      "decision/s1/1000": priorDecision,
    });
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage,
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => okJev(escalateAnswers("opencode/mimo-v2.5-free")));
    try {
      const ev = {
        sessionID: "s1",
        agent: "build",
        model: { providerID: "opencode", id: "big-pickle" },
        error: { type: "http_error", message: "500 internal server error", status: 500 },
        attempt: 3,
        decision: {},
      };
      await m.hooks.session.retry(ev);
      const body = stub.bodies().find((b) => b.state?.failure?.failedModel === "opencode/big-pickle");
      assert.ok(body, "decideEscalation deve receber o snapshot enriquecido");
      assert.equal(body.state.session.intention, "refatorar o modulo de auth");
      assert.equal(body.state.session.agent, "build");
      assert.equal(body.state.session.model, "opencode/big-pickle");
      assert.equal(body.state.session.route, "fast-coding");
      assert.equal(body.state.session.attempt, 3, "attempt REAL do evento (nao inventado)");
      assert.equal(body.state.failure.failedModel, "opencode/big-pickle");
      assert.equal(body.state.failure.error, "http_error: 500 internal server error", "erro normalizado e bounded");
      assert.ok(body.state.failure.triedModels.includes("opencode/big-pickle"), "modelos tentados presentes");
      assert.equal(body.state.failure.priorDecision.state.failedModel, "opencode/big-pickle", "decisao anterior entra no snapshot");
      assert.ok(Array.isArray(body.state.availableModels), "candidatos free disponiveis presentes");
      assert.ok(body.state.availableModels.length > 0);
      assert.ok(body.state.availableModels.every((x) => FREE_POOL.includes(x)), "somente free do pool");
      assert.equal(ev.decision.retry, true);
      assert.equal(m.getState().model.id, "mimo-v2.5-free");
    } finally {
      stub.restore();
    }
  });

  it("fallback deterministico preservado quando o Jev esta indisponivel", async () => {
    const storage = makeStorage({
      "route/s1": { route: "fast-coding", model: "opencode/big-pickle", agent: "build", chain: chainFor("fast-coding") },
      "intention/s1": { text: "ajustar testes" },
    });
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage,
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(() => { throw new Error("network down"); });
    try {
      const ev = {
        sessionID: "s1",
        agent: "build",
        model: { providerID: "opencode", id: "big-pickle" },
        error: { type: "http_error", message: "500", status: 500 },
        attempt: 2,
        decision: {},
      };
      await m.hooks.session.retry(ev);
      assert.equal(ev.decision.retry, true);
      const chain = chainFor("fast-coding");
      const expected = chain.find((c) => c !== "opencode/big-pickle");
      assert.equal(m.getState().model.id, expected.split("/")[1]);
    } finally {
      stub.restore();
    }
  });
});

describe("tool execute.after (erros materiais de tools)", () => {
  it("9. ignora sucesso normal e consulta o Jev apenas em erro material", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async (req) => {
      return okJev(recoverAnswers("retry", 1));
    });
    try {
      const okEvent = { tool: "edit", sessionID: "s1", agent: "build", messageID: "m1", id: "c1", input: { filePath: "a.ts" }, status: "completed", result: { type: "text", text: "ok" } };
      await m.hooks.tool["execute.after"](okEvent);
      assert.equal(stub.calls.length, 0, "sucesso nao deve consultar o Jev");
      assert.ok(![...m.storage._map.keys()].some((k) => k.startsWith("tool-errors/")), "sucesso nao deve registrar erro de tool");

      const e1 = { tool: "edit", sessionID: "s1", agent: "build", messageID: "m1", id: "c2", input: { filePath: "a.ts" }, status: "error", error: { message: "permission denied writing a.ts" } };
      await m.hooks.tool["execute.after"](e1);
      assert.equal(stub.calls.length, 0, "1o erro (nao repetido) nao consulta o Jev");

      const e2 = { tool: "edit", sessionID: "s1", agent: "build", messageID: "m1", id: "c3", input: { filePath: "a.ts" }, status: "error", error: { message: "permission denied writing a.ts" } };
      await m.hooks.tool["execute.after"](e2);
      assert.ok(stub.calls.length >= 1, "erro repetido deve consultar o Jev");
      const decisionKeys = [...m.storage._map.keys()].filter((k) => k.startsWith("decision/s1/"));
      assert.ok(decisionKeys.length >= 1, "decisao de tool deve ser catalogada");

      const callsBefore = stub.calls.length;
      const e3 = { tool: "edit", sessionID: "s1", agent: "build", messageID: "m1", id: "c4", input: { filePath: "a.ts" }, status: "error", error: { message: "permission denied writing a.ts" } };
      await m.hooks.tool["execute.after"](e3);
      assert.equal(stub.calls.length, callsBefore, "cooldown: mesma assinatura recente nao re-consulta o Jev");
    } finally {
      stub.restore();
    }
  });
});

describe("pending recovery: recomendacao one-shot no proximo context", () => {
  async function bootRecoveryCtx(action) {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({
        "route/s1": { route: "fast-coding", model: "opencode/big-pickle", agent: "build", chain: chainFor("fast-coding") },
      }),
      options: PLUGIN_OPTS,
    });
    m._stub = stubFetch(async () => okJev(recoverAnswers(action, 0.9)));
    return m;
  }

  async function raiseMaterialToolError(m, tool, message) {
    const e1 = { tool, sessionID: "s1", agent: "build", messageID: "m1", id: `${tool}-1`, input: { x: 1 }, status: "error", error: { message } };
    await m.hooks.tool["execute.after"](e1);
    const e2 = { tool, sessionID: "s1", agent: "build", messageID: "m1", id: `${tool}-2`, input: { x: 1 }, status: "error", error: { message } };
    await m.hooks.tool["execute.after"](e2);
  }

  it("replan e entregue ao proximo context e consumido (one-shot)", async () => {
    const m = await bootRecoveryCtx("replan");
    try {
      await raiseMaterialToolError(m, "edit", "failed to apply patch");
      assert.ok(m._stub.calls.length >= 1, "Jev consultado no erro material");
      assert.ok(m.storage._map.has("pending-recovery/s1"), "recomendacao pendente persistida");

      // Nenhuma troca destrutiva acontece sozinha: agent/modelo intactos.
      assert.equal(m.getState().agent, "build");
      assert.equal(m.getState().model.id, "big-pickle");

      const ev = { sessionID: "s1", agent: "build", system: [] };
      await m.hooks.session.context(ev);
      assert.equal(ev.system.length, 2, "instrucao base + recomendacao one-shot");
      const rec = ev.system[1].text;
      assert.ok(rec.includes("replan"), "recomendacao do Jev entregue no contexto");
      assert.ok(rec.includes("edit"), "menciona a ferramenta que falhou");
      assert.ok(!m.storage._map.has("pending-recovery/s1"), "chave consumida/removida apos entrega");

      const ev2 = { sessionID: "s1", agent: "build", system: [] };
      await m.hooks.session.context(ev2);
      assert.equal(ev2.system.length, 1, "proximo context NAO recebe a recomendacao de novo");
    } finally {
      m._stub.restore();
    }
  });

  it("stop e entregue uma unica vez e nao reinjeta", async () => {
    const m = await bootRecoveryCtx("stop");
    try {
      await raiseMaterialToolError(m, "bash", "command failed with exit 2");
      assert.ok(m.storage._map.has("pending-recovery/s1"), "recomendacao stop pendente");

      const ev = { sessionID: "s1", agent: "build", system: [] };
      await m.hooks.session.context(ev);
      assert.equal(ev.system.length, 2);
      assert.ok(ev.system[1].text.includes("stop"), "recomendacao stop entregue");
      assert.ok(!m.storage._map.has("pending-recovery/s1"), "chave removida");

      const ev2 = { sessionID: "s1", agent: "build", system: [] };
      await m.hooks.session.context(ev2);
      assert.equal(ev2.system.length, 1, "one-shot: nao repete em continuacoes");
    } finally {
      m._stub.restore();
    }
  });

  it("acesso sem sessao/storage nao quebra o context hook", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(() => { throw new Error("nao deve chamar o Jev"); });
    try {
      const ev = { sessionID: "", system: [] };
      await m.hooks.session.context(ev);
      assert.equal(ev.system.length, 1, "sem sessao: apenas a instrucao base");
    } finally {
      stub.restore();
    }
  });
});

describe("switch transacional", () => {
  it("10. falha no switch de modelo nao deixa route/* mentindo", async () => {
    const storage = makeStorage({
      "route/s1": { route: "fast-coding", model: "opencode/big-pickle", agent: "build", chain: chainFor("fast-coding") },
    });
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage,
      options: PLUGIN_OPTS,
      switchBehavior: { switchModelError: new Error("provider down") },
    });
    const stub = stubFetch(async () => okJev(routeAnswers({ route: "heavy-reasoning", agent: "plan", model: "opencode/muse-spark-1.3-contributor-free", confidence: 0.95 })));
    try {
      const ev = { sessionID: "s1", messageID: "m1", prompt: { text: "arquitetar algo novo e complexo" }, metadata: {}, delivery: {} };
      await m.hooks.session.prompt(ev);
      assert.equal(ev.metadata["jev-router"], "switch-failed");
      const stored = storage._map.get("route/s1");
      assert.deepEqual(stored, { route: "fast-coding", model: "opencode/big-pickle", agent: "build", chain: chainFor("fast-coding") }, "route/* deve permanecer o estado real");
      assert.equal(m.getState().model.id, "big-pickle", "sessao nao deve ficar parcialmente alterada");
    } finally {
      stub.restore();
    }
  });

  it("falha no switch de agente pos-modelo faz rollback best-effort do modelo", async () => {
    const storage = makeStorage({});
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage,
      options: PLUGIN_OPTS,
      switchBehavior: { switchAgentError: new Error("agent not found") },
    });
    const stub = stubFetch(async () => okJev(routeAnswers({ route: "heavy-reasoning", agent: "plan", model: "opencode/muse-spark-1.3-contributor-free", confidence: 0.95 })));
    try {
      const ev = { sessionID: "s1", messageID: "m1", prompt: { text: "mudar de arquitetura no sistema" }, metadata: {}, delivery: {} };
      await m.hooks.session.prompt(ev);
      assert.equal(ev.metadata["jev-router"], "switch-failed");
      assert.equal(m.getState().model.id, "big-pickle", "rollback deve restaurar o modelo anterior");
      assert.equal(m.getState().agent, "build");
      assert.equal(storage._map.get("route/s1"), undefined, "sem route/* novo quando a transicao falhou");
    } finally {
      stub.restore();
    }
  });
});

describe("persistencia bounded e sanitizada", () => {
  it("11. sanitizeState remove secrets e trunca payloads grandes", () => {
    const out = sanitizeState({
      apiKey: "sk-1234",
      Authorization: "Bearer xyz",
      token: "abc",
      credentials: { secret: "s" },
      keep: "valor normal",
      big: "z".repeat(20000),
    });
    assert.ok(!JSON.stringify(out).includes("sk-1234"));
    assert.ok(!JSON.stringify(out).includes("Bearer"));
    assert.ok(!JSON.stringify(out).includes("abc"));
    assert.equal(out.keep, "valor normal");
    assert.ok(out.big.length <= 8100, "payload grande deve ser truncado");
  });

  it("tools.jev.decide persiste estado sanitizado (nunca input.state bruto)", async () => {
    const storage = makeStorage({});
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage,
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => okJev({ decisao: choice("opcao-a"), risco: noul(0.2) }));
    try {
      const tool = m.tools.decide;
      const res = await tool.execute({
        state: { apiKey: "sk-x", Authorization: "Bearer y", projeto: "zeta", dados: { x: 1 } },
        questions: { decisao: { type: "choice", instructions: "qual?", criteria: { "opcao-a": "a", "opcao-b": "b" } }, risco: { type: "noul", instructions: "risco?", criteria: { true: "arriscado", false: "seguro" } } },
        sessionID: "s1",
      });
      assert.ok(JSON.parse(res.content).answers, "tool deve retornar respostas");
      const keys = [...storage._map.keys()].filter((k) => k.startsWith("decision/s1/"));
      const record = storage._map.get(keys[0]);
      const serialized = JSON.stringify(record);
      assert.ok(keys.length >= 1);
      assert.ok(!serialized.includes("sk-x"), "apiKey nao pode ser persistida");
      assert.ok(!serialized.includes("Bearer"), "Authorization nao pode ser persistida");
      assert.ok(serialized.length <= 9000, "registro persistido deve ser bounded");
    } finally {
      stub.restore();
    }
  });
});

describe("respostas malformadas do Jev", () => {
  it("12. rota/agente/modelo arbitrarios nunca entram", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => okJev({
      route: choice("lixo-route"),
      agent: choice("super-agent"),
      model: choice("gpt-4o"),
      is_risky: noul(0.1),
      complexity: score(0),
    }));
    try {
      const ev = { sessionID: "s1", messageID: "m1", prompt: { text: "checar comportamento" }, metadata: {}, delivery: {} };
      await m.hooks.session.prompt(ev);
      assert.ok(stub.bodies()[0], "Jev foi consultado");
      assert.ok(isFreeModel(ev.metadata["jev-model"]), "modelo final deve ser free");
      assert.ok(["build", "plan"].includes(ev.metadata["jev-agent"]), "agente final deve ser build|plan");
    } finally {
      stub.restore();
    }
  });
});

describe("context hook enxuto", () => {
  it("injeta instrucao pequena (decision boundaries) com as tools do Jev", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const ev = { sessionID: "s1", agent: "build", model: { providerID: "opencode", id: "big-pickle" }, system: [], messages: [], tools: {}, options: {} };
    await m.hooks.session.context(ev);
    assert.equal(ev.system.length, 1);
    const text = ev.system[0].text;
    assert.ok(text.includes("tools.jev.decide") && text.includes("tools.jev.route") && text.includes("tools.jev.escalate"));
    assert.ok(text.length < 900, `instrucao deve ser pequena (got ${text.length} chars)`);
  });

  it("ensina Code Mode via execute (nunca tool global jev_decide)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const ev = { sessionID: "s1", agent: "build", model: { providerID: "opencode", id: "big-pickle" }, system: [], messages: [], tools: {}, options: {} };
    await m.hooks.session.context(ev);
    const text = ev.system[0].text;
    // O agente precisa saber: namespace jev, chamada por Code Mode, via tool `execute`.
    assert.ok(/code\s*mode/i.test(text), "instrucao deve mencionar Code Mode");
    assert.ok(text.includes("execute"), "instrucao deve apontar o tool `execute` como via de chamada");
    assert.ok(
      text.includes("tools.jev.decide") && text.includes("tools.jev.route") && text.includes("tools.jev.escalate"),
      "instrucao deve listar os paths reais tools.jev.decide/route/escalate",
    );
    // Regressao: nunca instruir o agente a invocar `jev_decide` como tool global
    // (o runtime real responde "No tool named jev_decide is currently available").
    assert.ok(
      !/(?:^|[\s"'`])jev_decide\b/.test(text) && !/tool\s+`?jev_decide`?/.test(text) && !/Tools:\s*jev_decide/.test(text),
      "instrucao nao deve apresentar jev_decide como tool invocavel",
    );
    assert.ok(text.length < 900, `instrucao deve continuar pequena (got ${text.length} chars)`);
  });
});

describe("validateQuestions: contrato real System One", () => {
  it("choice sem criteria falha localmente (nao alcanca endpoint remoto)", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => { throw new Error("nao deveria alcancar o endpoint"); });
    try {
      const tool = m.tools.decide;
      const res = await tool.execute({
        state: { tarefa: "escolher" },
        questions: {
          escolha: {
            type: "choice",
            instructions: "Qual opcao vem primeiro alfabeticamente?",
            // criteria AUSENTE: System One retorna 422
          },
        },
      });
      // Deve retornar erro claro, nunca chamar o endpoint
      assert.ok(res.content.includes("criteria"), "erro deve mencionar criteria");
      assert.ok(res.content.includes("escolha"), "erro deve mencionar nome da pergunta");
      assert.ok(res.content.includes("choice"), "erro deve mencionar o tipo");
      assert.equal(stub.calls.length, 0, "nao deve alcancar o endpoint remoto");
    } finally {
      stub.restore();
    }
  });

  it("choice vazia (criteria: {}) falha localmente", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => { throw new Error("nao deveria alcancar o endpoint"); });
    try {
      const tool = m.tools.decide;
      const res = await tool.execute({
        state: {},
        questions: {
          q: {
            type: "choice",
            instructions: "Pick one",
            criteria: {},
          },
        },
      });
      assert.ok(res.content.includes("criteria") || res.content.includes("vazio"), "criteria vazio deve falhar");
      assert.equal(stub.calls.length, 0, "nao deve alcancar o endpoint remoto");
    } finally {
      stub.restore();
    }
  });

  it("choice valida (com criteria) passa e chega ao endpoint", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => okJev({ escolha: choice("alpha"), risco: noul(0.1) }));
    try {
      const tool = m.tools.decide;
      const res = await tool.execute({
        state: {},
        questions: {
          escolha: {
            type: "choice",
            instructions: "Which option comes first alphabetically?",
            criteria: {
              alpha: "Option alpha",
              beta: "Option beta",
            },
          },
          risco: {
            type: "noul",
            instructions: "Is this risky?",
            criteria: {
              true: "High risk",
              false: "Low risk",
            },
          },
        },
      });
      assert.ok(JSON.parse(res.content).answers, "deve retornar respostas validas");
      assert.ok(stub.calls.length >= 1, "deve ter alcancado o endpoint");
      const body = stub.calls[0].body;
      const qEscolha = body.questions.escolha;
      assert.equal(qEscolha.type, "choice");
      assert.ok(qEscolha.criteria.alpha, "criteria deve ter chave alpha");
      assert.ok(qEscolha.criteria.beta, "criteria deve ter chave beta");
    } finally {
      stub.restore();
    }
  });

  it("noul sem criteria falha localmente", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => { throw new Error("nao deveria alcancar o endpoint"); });
    try {
      const tool = m.tools.decide;
      const res = await tool.execute({
        state: {},
        questions: {
          risco: {
            type: "noul",
            instructions: "Is this risky?",
            // criteria AUSENTE
          },
        },
      });
      assert.ok(res.content.includes("criteria"), "noul sem criteria deve falhar localmente");
      assert.equal(stub.calls.length, 0, "nao deve alcancar o endpoint remoto");
    } finally {
      stub.restore();
    }
  });

  it("score sem criteria falha localmente", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => { throw new Error("nao deveria alcancar o endpoint"); });
    try {
      const tool = m.tools.decide;
      const res = await tool.execute({
        state: {},
        questions: {
          complexidade: {
            type: "score",
            instructions: "How complex?",
            // criteria AUSENTE
          },
        },
      });
      assert.ok(res.content.includes("criteria"), "score sem criteria deve falhar localmente");
      assert.equal(stub.calls.length, 0, "nao deve alcancar o endpoint remoto");
    } finally {
      stub.restore();
    }
  });

  it("noul com criteria valido passa", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => okJev({ risco: noul(0.8) }));
    try {
      const tool = m.tools.decide;
      const res = await tool.execute({
        state: {},
        questions: {
          risco: {
            type: "noul",
            instructions: "Is this risky?",
            criteria: {
              true: "Deleta dados, muda infra",
              false: "Leitura, edicao local",
            },
          },
        },
      });
      assert.ok(JSON.parse(res.content).answers, "deve retornar respostas");
      assert.ok(stub.calls.length >= 1, "deve ter alcancado o endpoint");
    } finally {
      stub.restore();
    }
  });

  it("score com criteria array valido passa", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const stub = stubFetch(async () => okJev({ complexidade: score(1) }));
    try {
      const tool = m.tools.decide;
      const res = await tool.execute({
        state: {},
        questions: {
          complexidade: {
            type: "score",
            instructions: "How complex is this task?",
            criteria: ["Trivial", "Moderate", "Very complex"],
          },
        },
      });
      assert.ok(JSON.parse(res.content).answers, "deve retornar respostas");
      assert.ok(stub.calls.length >= 1, "deve ter alcancado o endpoint");
    } finally {
      stub.restore();
    }
  });

  it("schema da tool decide expoe questions como objeto estrutural", async () => {
    const m = await bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
    const tool = m.tools.decide;
    assert.ok(tool, "tool decide deve existir");
    assert.ok(tool.input, "tool decide deve ter input schema");
    assert.equal(tool.input.type, "object", "input deve ser tipo object");
    const q = tool.input.properties.questions;
    assert.ok(q, "questions deve existir no schema");
    assert.equal(q.type, "object", "questions deve ser tipo object");
    // O schema nao deve usar placeholder ambiguo "nome"
    assert.ok(!q.description.includes("{ nome:"), "description nao deve usar placeholder 'nome' como propriedade literal");
    // Deve mencionar a forma correta
    assert.ok(q.description.includes("type"), "description deve mencionar campo type");
    assert.ok(q.description.includes("instructions"), "description deve mencionar campo instructions");
    assert.ok(q.description.includes("criteria"), "description deve mencionar campo criteria");
    // Deve incluir exemplo de choice
    assert.ok(q.description.includes("criteria:") || q.description.includes("criteria"), "description deve incluir exemplo com criteria");
  });
});

describe("validateQuestions: formato por tipo (choice/noul/score)", () => {
  async function bootDecide() {
    return bootCtx({
      models: ALL_MODELS,
      session: { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
      storage: makeStorage({}),
      options: PLUGIN_OPTS,
    });
  }

  it("choice com criteria array falha localmente (sem rede)", async () => {
    const m = await bootDecide();
    const stub = stubFetch(async () => { throw new Error("nao deveria alcancar o endpoint"); });
    try {
      const res = await m.tools.decide.execute({
        state: {},
        questions: { q: { type: "choice", instructions: "pick", criteria: ["alpha", "beta"] } },
      });
      assert.ok(res.content.includes("criteria"), "erro deve mencionar criteria");
      assert.ok(res.content.includes('"q"') || res.content.includes("q"), "erro deve indicar a pergunta");
      assert.ok(res.content.includes("choice"), "erro deve indicar o tipo");
      assert.equal(stub.calls.length, 0, "nao deve alcancar o endpoint");
    } finally {
      stub.restore();
    }
  });

  it("noul com criteria array falha localmente (sem rede)", async () => {
    const m = await bootDecide();
    const stub = stubFetch(async () => { throw new Error("nao deveria alcancar o endpoint"); });
    try {
      const res = await m.tools.decide.execute({
        state: {},
        questions: { q: { type: "noul", instructions: "risk?", criteria: ["yes", "no"] } },
      });
      assert.ok(res.content.includes("criteria"), "erro deve mencionar criteria");
      assert.ok(res.content.includes("noul"), "erro deve indicar o tipo");
      assert.equal(stub.calls.length, 0, "nao deve alcancar o endpoint");
    } finally {
      stub.restore();
    }
  });

  it("score com criteria objeto falha localmente (sem rede)", async () => {
    const m = await bootDecide();
    const stub = stubFetch(async () => { throw new Error("nao deveria alcancar o endpoint"); });
    try {
      const res = await m.tools.decide.execute({
        state: {},
        questions: { q: { type: "score", instructions: "complexity?", criteria: { low: "low", high: "high" } } },
      });
      assert.ok(res.content.includes("criteria"), "erro deve mencionar criteria");
      assert.ok(res.content.includes("score"), "erro deve indicar o tipo");
      assert.equal(stub.calls.length, 0, "nao deve alcancar o endpoint");
    } finally {
      stub.restore();
    }
  });

  it("valores nao-string dentro de criteria falham localmente", async () => {
    const m = await bootDecide();
    const stub = stubFetch(async () => { throw new Error("nao deveria alcancar o endpoint"); });
    try {
      const r1 = await m.tools.decide.execute({
        state: {},
        questions: { q: { type: "choice", instructions: "pick", criteria: { alpha: 123, beta: "b" } } },
      });
      assert.ok(r1.content.includes("criteria"), "choice com valor numerico deve falhar");
      assert.equal(stub.calls.length, 0, "nao deve alcancar o endpoint");
      const r2 = await m.tools.decide.execute({
        state: {},
        questions: { q: { type: "score", instructions: "c?", criteria: ["ok", 42] } },
      });
      assert.ok(r2.content.includes("criteria"), "score com elemento numerico deve falhar");
      assert.equal(stub.calls.length, 0, "nao deve alcancar o endpoint");
      const r3 = await m.tools.decide.execute({
        state: {},
        questions: { q: { type: "noul", instructions: "r?", criteria: { true: 1, false: "no" } } },
      });
      assert.ok(r3.content.includes("criteria"), "noul com valor numerico deve falhar");
      assert.equal(stub.calls.length, 0, "nao deve alcancar o endpoint");
    } finally {
      stub.restore();
    }
  });

  it("state null falha localmente (sem rede, nunca 422 remoto)", async () => {
    const m = await bootDecide();
    const stub = stubFetch(async () => { throw new Error("nao deveria alcancar o endpoint"); });
    try {
      const res = await m.tools.decide.execute({
        state: null,
        questions: { q: { type: "choice", instructions: "pick", criteria: { alpha: "a", beta: "b" } } },
      });
      assert.ok(res.content.includes("state"), "erro deve mencionar state");
      assert.equal(stub.calls.length, 0, "nao deve alcancar o endpoint");
    } finally {
      stub.restore();
    }
  });

  it("schema de state expoe objeto-ou-texto (nunca null)", async () => {
    const m = await bootDecide();
    const s = m.tools.decide.input.properties.state;
    assert.ok(s, "state deve existir no schema");
    assert.ok(s.anyOf, "state deve declarar anyOf objeto/string");
    assert.ok(/nunca null/i.test(s.description), "description deve dizer nunca null");
  });

  it("schema de questions expoe estrutura real (additionalProperties)", async () => {
    const m = await bootDecide();
    const q = m.tools.decide.input.properties.questions;
    assert.equal(q.type, "object", "questions deve ser object");
    assert.ok(q.additionalProperties, "questions deve declarar additionalProperties para <questionName>");
    const qs = q.additionalProperties;
    assert.equal(qs.type, "object", "cada pergunta deve ser object");
    assert.ok(qs.properties?.type, "pergunta deve declarar campo type");
    assert.ok(qs.properties?.instructions, "pergunta deve declarar campo instructions");
    assert.ok(qs.properties?.criteria, "pergunta deve declarar campo criteria");
    const req = qs.required ?? [];
    assert.ok(req.includes("type") && req.includes("instructions") && req.includes("criteria"), "type/instructions/criteria obrigatorios");
  });

  it("context hook ensina operacao Code Mode sem ambiguidade", async () => {
    const m = await bootDecide();
    const ev = { sessionID: "s1", agent: "build", model: { providerID: "opencode", id: "big-pickle" }, system: [], messages: [], tools: {}, options: {} };
    await m.hooks.session.context(ev);
    const text = ev.system[0].text;
    assert.ok(text.includes("execute"), "deve mandar usar a tool execute");
    assert.ok(/javascript/i.test(text), "deve dizer que dentro de execute se escreve JavaScript");
    assert.ok(/sem\s+import/i.test(text), "deve avisar sem imports");
    assert.ok(/nao.*(chame|tente|invoque).*jev\.decide.*(diret|como tool)/i.test(text), "deve proibir chamar jev.decide diretamente");
    assert.ok(text.includes("return await tools.jev.decide"), "deve trazer exemplo return await tools.jev.decide(...)");
    assert.ok(text.length < 900, `instrucao deve continuar enxuta (got ${text.length})`);
  });
});

describe("unidades puras (importadas do codigo real)", () => {
  it("heuristicRoute: pesquisa -> research-docs", () => {
    const d = heuristicRoute("pesquisar docs oficiais do React e comparar libs");
    assert.equal(d.route, "research-docs");
    assert.equal(d.agent, "plan");
  });

  it("nextFallback: avanca na cadeia e esgota com undefined", () => {
    const chain = chainFor("fast-coding");
    assert.equal(nextFallback("fast-coding", chain[0]), chain[1]);
    assert.equal(nextFallback("fast-coding", chain[chain.length - 1]), undefined);
  });

  it("splitModelRef produz { providerID, id }", () => {
    assert.deepEqual(splitModelRef("opencode/big-pickle"), { providerID: "opencode", id: "big-pickle" });
  });

  it("decideEscalation so escolhe candidatos restantes (nunca o que falhou)", async () => {
    const d = await decideEscalation({
      failedModel: "opencode/big-pickle",
      reason: "falhou",
      candidates: FREE,
      triedModels: ["opencode/big-pickle"],
      jevModel: "jev-1.13-free",
      jevEndpoint: "https://x",
      apiKey: undefined,
    });
    assert.ok(d.model !== undefined);
    assert.notEqual(d.model, "opencode/big-pickle");
  });
});