// Harness de teste do gateway: upstream OpenCode FAKE em HTTP real (node:http)
// + starter do gateway real. Os testes exercitam fronteira HTTP de verdade
// (requests/responses sobre socket), nunca mocks de funcao.
//
// O fake upstream implementa o subconjunto do contrato público v2.0.11 que o
// gateway toca: prompt (admissao/resume:false + idempotencia por id), inbox
// PATCH (wake), catalogos model/agent, switches, RPC e SSE de eventos.
import http from "node:http";

export async function startFakeUpstream(opts = {}) {
  const cfg = {
    modelCatalog: opts.modelCatalog ?? [
      { id: "nemotron-3.5-lightning-free", providerID: "opencode", name: "Nemotron" },
      { id: "big-pickle", providerID: "opencode", name: "Big Pickle" },
      { id: "muse-spark-1.3-contributor-free", providerID: "opencode", name: "Muse" },
    ],
    agentCatalog: opts.agentCatalog ?? [
      { id: "build", name: "Build", mode: "primary" },
      { id: "plan", name: "Plan", mode: "primary" },
    ],
    // ok | fail500 | hang (nunca responde = ambiguo)
    promptMode: opts.promptMode ?? "ok",
    // ok | fail500 | invalid-shape (200 sem output.runID)
    rpcMode: opts.rpcMode ?? "ok",
    rpcDelayMs: opts.rpcDelayMs ?? 0,
    modelSwitchFail: opts.modelSwitchFail ?? false,
    agentSwitchFail: opts.agentSwitchFail ?? false,
    catalogFail: opts.catalogFail ?? false,
  };

  const state = {
    order: [],      // [{kind, path}] na ordem chegada — prova ordering route→forward
    prompts: [],    // {path, raw, parsed, createdItem}
    patches: [],    // wake attempts (NUNCA deve existir no modo orchestrate)
    models: [],
    agents: [],
    rpcs: [],
    upgrades: [],   // upgrade attempts (tunel bruto do proxy)
    sse: { connections: 0, closedEarly: 0, completed: 0 },
  };

  let msgSeq = 0;
  const idem = new Map(); // `${sid}\0${id}` -> msgID (idempotencia por id real)
  const sessions = new Map(); // sid -> {model: {providerID,id}, agent} (estado p/ rollback)
  function sessionState(sid) {
    let s = sessions.get(sid);
    if (!s) {
      // Default DIFERENTE do lane fast-coding: garante que um switch de route
      // real muda o estado (exercicio honesto do rollback parcial).
      s = { model: { providerID: "opencode", id: "muse-spark-1.3-contributor-free" }, agent: "build" };
      sessions.set(sid, s);
    }
    return s;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://upstream");
    const path = url.pathname;
    state.order.push({ kind: `${req.method} ${path}`, path });

    try {
      // ---- SSE de eventos -------------------------------------------------
      if (req.method === "GET" && path === "/api/event") {
        state.sse.connections += 1;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        let closed = false;
        req.on("close", () => {
          if (!res.writableEnded) {
            closed = true;
            state.sse.closedEarly += 1;
          }
        });
        res.write('data: {"type":"first"}\n\n');
        setTimeout(() => {
          if (!closed && !res.writableEnded && !res.destroyed) res.write('data: {"type":"second"}\n\n');
        }, 150);
        setTimeout(() => {
          if (!closed && !res.destroyed) {
            res.end();
            state.sse.completed += 1;
          }
        }, 320);
        return;
      }

      if (req.method === "GET" && path === "/api/info") {
        res.writeHead(200, { "content-type": "application/json", "x-fake": "info" });
        res.end(JSON.stringify({ version: "fake-upstream" }));
        return;
      }

      if (req.method === "GET" && path === "/api/custom") {
        res.writeHead(418, { "content-type": "text/plain", "x-custom": "keep-me" });
        res.end("teapot-body");
        return;
      }

      // ---- catalogos ------------------------------------------------------
      if (req.method === "GET" && path === "/api/model") {
        if (cfg.catalogFail) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"catalog-down"}');
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ location: { directory: "/tmp/fake" }, data: cfg.modelCatalog }));
        return;
      }

      if (req.method === "GET" && path === "/api/agent") {
        if (cfg.catalogFail) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"catalog-down"}');
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ location: { directory: "/tmp/fake" }, data: cfg.agentCatalog }));
        return;
      }

      // ---- prompt (admissao) ---------------------------------------------
      const promptMatch = req.method === "POST" && /^\/api\/session\/([^/]+)\/prompt$/.exec(path);
      if (promptMatch) {
        const sid = decodeURIComponent(promptMatch[1]);
        const raw = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          parsed = { __unparsable: true };
        }

        if (cfg.promptMode === "hang") {
          state.prompts.push({ path, raw, parsed, createdItem: false, sid });
          return; // nunca responde — ambiguidade de admissao
        }
        if (cfg.promptMode === "fail500") {
          state.prompts.push({ path, raw, parsed, createdItem: false, sid });
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"prompt-rejected"}');
          return;
        }

        const clientId = typeof parsed.id === "string" ? parsed.id : undefined;
        let msgID;
        let createdItem = true;
        if (clientId !== undefined) {
          const key = `${sid}\0${clientId}`;
          if (idem.has(key)) {
            msgID = idem.get(key);
            createdItem = false; // replay idempotente: MESMO item, count=1
          } else {
            msgID = clientId;
            idem.set(key, msgID);
          }
        } else {
          msgSeq += 1;
          msgID = `msg_test${msgSeq}`;
        }

        state.prompts.push({ path, raw, parsed, createdItem, sid, msgID });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              id: msgID,
              sessionID: sid,
              time: { created: 1790000000000 + msgSeq },
              type: parsed.type === "synthetic" ? "synthetic" : "user",
              payload: { text: parsed.text },
              delivery: parsed.delivery ?? "steer",
            },
          }),
        );
        return;
      }

      // ---- wake (inbox PATCH) ---------------------------------------------
      const patchMatch = req.method === "PATCH" && /^\/api\/session\/([^/]+)\/inbox\/([^/]+)$/.exec(path);
      if (patchMatch) {
        const raw = await readBody(req);
        state.patches.push({ path, raw: raw.toString("utf8") });
        res.writeHead(204);
        res.end();
        return;
      }

      // ---- sessao (leitura de estado p/ rollback de route) -------------------
      const sessionGetMatch = req.method === "GET" && /^\/api\/session\/([^/]+)$/.exec(path);
      if (sessionGetMatch) {
        const sid = decodeURIComponent(sessionGetMatch[1]);
        const st = sessionState(sid);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { id: sid, model: st.model, agent: st.agent } }));
        return;
      }

      // ---- switches de route ----------------------------------------------
      const modelMatch = req.method === "POST" && /^\/api\/session\/([^/]+)\/model$/.exec(path);
      if (modelMatch) {
        const raw = await readBody(req);
        state.models.push({ path, raw: JSON.parse(raw.toString("utf8") || "{}") });
        if (cfg.modelSwitchFail) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"switch-model-down"}');
          return;
        }
        try {
          const m = JSON.parse(raw.toString("utf8"))?.model;
          if (m && typeof m.providerID === "string" && typeof m.id === "string") {
            sessionState(decodeURIComponent(modelMatch[1])).model = { providerID: m.providerID, id: m.id };
          }
        } catch {
          // estado best-effort; o switch ja foi aceito
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }

      const agentMatch = req.method === "POST" && /^\/api\/session\/([^/]+)\/agent$/.exec(path);
      if (agentMatch) {
        const raw = await readBody(req);
        state.agents.push({ path, raw: JSON.parse(raw.toString("utf8") || "{}") });
        if (cfg.agentSwitchFail) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"switch-agent-down"}');
          return;
        }
        try {
          const a = JSON.parse(raw.toString("utf8"))?.agent;
          if (typeof a === "string" && a.length > 0) {
            sessionState(decodeURIComponent(agentMatch[1])).agent = a;
          }
        } catch {
          // estado best-effort; o switch ja foi aceito
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }

      // ---- RPC --------------------------------------------------------------
      const rpcMatch = req.method === "POST" && /^\/api\/rpc\/([^/]+)\/([^/]+)$/.exec(path);
      if (rpcMatch) {
        const raw = await readBody(req);
        let input;
        try {
          input = JSON.parse(raw.toString("utf8")).input;
        } catch {
          input = undefined;
        }
        state.rpcs.push({ rpcID: decodeURIComponent(rpcMatch[1]), method: decodeURIComponent(rpcMatch[2]), input });
        if (cfg.rpcMode === "fail500") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"rpc-down"}');
          return;
        }
        const respond = () => {
          if (res.destroyed) return;
          if (cfg.rpcMode === "invalid-shape") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
            return;
          }
          const sid = String(input?.sessionID ?? "ses_x");
          const mid = String(input?.messageID ?? "msg_x");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ output: { runID: `auto-${sid}-${mid}`, status: "started" } }));
        };
        if (cfg.rpcDelayMs > 0) setTimeout(respond, cfg.rpcDelayMs);
        else respond();
        return;
      }

      // ---- fallback transparente -------------------------------------------
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"not-found"}');
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  // ---- upgrade bruto (eco): prova que o tunel do gateway nao corrompe ----
  const upgradeSockets = new Set();
  server.on("upgrade", (req, socket) => {
    state.upgrades.push({ path: req.url });
    upgradeSockets.add(socket);
    socket.on("close", () => upgradeSockets.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\nUpgrade: echo\r\n\r\n");
    socket.on("data", (chunk) => {
      if (!socket.destroyed) socket.write(chunk); // eco byte a byte
    });
    socket.on("error", () => {
      try {
        socket.destroy();
      } catch {
        // ja fechado
      }
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    cfg,
    state,
    order() {
      return state.order.map((e) => e.kind);
    },
    async close() {
      for (const s of upgradeSockets) {
        try {
          s.destroy();
        } catch {
          // ja fechado
        }
      }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Sobe o gateway REAL (src/gateway/server.ts) em porta efêmera contra o
 * upstream fake. `overrides` entra na config bounded (mesmo shape do env).
 * `logs` coleta as linhas de log do gateway (para asserção de não-vazamento).
 */
export async function startGateway(upstreamUrl, overrides = {}) {
  const { resolveGatewayConfig } = await import("./gateway/config.ts");
  const { createGatewayServer } = await import("./gateway/server.ts");
  const config = resolveGatewayConfig({
    enabled: true,
    upstream: upstreamUrl,
    host: "127.0.0.1",
    port: 0,
    ...overrides,
  });
  const logs = [];
  const gw = createGatewayServer(config, {
    log: (line) => logs.push(line),
  });
  await gw.listen(0);
  return {
    url: `http://127.0.0.1:${gw.port}`,
    port: gw.port,
    logs,
    counters: () => gw.counters(),
    activeSockets: () => gw.activeSockets(),
    close: async () => {
      await gw.close();
    },
  };
}

/** Env determinística default para os testes de modo (regras explícitas). */
export const TEST_RULES = JSON.stringify([
  { prefix: "ORCH:", mode: "orchestrate" },
  { prefix: "ROUTE:", mode: "route" },
]);

/** Config de teste agressiva: timeouts curtos, corpos bounded, log coletado. */
export function testConfig(extra = {}) {
  return {
    routeDecisionTimeoutMs: 300,
    proxyTimeoutMs: 2000,
    rpcTimeoutMs: 1500,
    ...extra,
  };
}
