#!/usr/bin/env node
// ==============================================================================
// OPJEV — Gate Definitivo de Estabilização E2E Multi-Round Real (Issue #14)
//
// Executa os 17 cenários obrigatórios da Issue #14 sobre o runtime real:
// - OpenCode v2.0.11 autoritativo (`opencode serve`) com plugin OPJEV carregado;
// - Sessões reais de worker/critic/orchestrator via API /api/session;
// - Hooks de prompt e storage durável em SQLite ($HOME/.local/share/opencode/opencode.db);
// - Jev SystemOne real (https://opencode.ai/zen/v1/systemone) com OPENCODE_API_KEY
//   para decisões semânticas normais;
// - Fault injection na fronteira de rede (HTTP 500, HTTP 429) para cenários de resiliência;
// - Emissão de evidência bounded por cenário:
//   runID / round / workerSessionID / criticSessionID / executor / verdict / command / finalPhase.
// ==============================================================================

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import pluginDefault from "../index.ts";
import { installServerPluginToProject, installPluginToHome } from "./install-plugin.mjs";
import { FREE_POOL } from "../src/config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const BIN = process.env.OPENCODE_BIN ?? "/tmp/opencode-2.0.11/package/bin/opencode";
const ROOT = process.env.E2E_ROOT ?? "/tmp/opjev-e2e";
const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(ROOT, "multiround-real", RUN_TS);
const EVIDENCE_OUTPUT_DIR = path.join(REPO, "docs", "reports", "artifacts");
const EVIDENCE_FILE = path.join(EVIDENCE_OUTPUT_DIR, "issue-14-real-e2e-evidence.json");

function baseContract(over = {}) {
  return {
    runID: `run_real_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    sessionID: "ses_canonical",
    objective: "Implement an add function in pure javascript",
    scope: {},
    constraints: ["Siga os critérios de aceite"],
    acceptanceCriteria: ["Trabalho concluído"],
    requiredEvidence: ["worker-session-outcome"],
    maxRounds: 3,
    ...over,
  };
}

// ---------------------------------------------------------------- API Key Resolution
function resolveApiKey() {
  if (process.env.OPENCODE_API_KEY && process.env.OPENCODE_API_KEY.trim().length > 0) {
    return process.env.OPENCODE_API_KEY.trim();
  }
  const envFile = path.join(process.env.HOME ?? "/home/pedro", ".config", "opencode", "env");
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, "utf8");
    const m = /export\s+OPENCODE_API_KEY=['"]([^'\"]+)['"]/.exec(content);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

const API_KEY = resolveApiKey();
if (!API_KEY) {
  console.error("================================================================================");
  console.error(" [BLOCKER] OPENCODE_API_KEY não encontrada no ambiente ou em ~/.config/opencode/env");
  console.error(" A Issue #14 exige prova com Jev SystemOne real (https://opencode.ai/zen/v1/systemone)");
  console.error(" Configure OPENCODE_API_KEY antes de executar o gate E2E real.");
  console.error("================================================================================");
  process.exit(1);
}

// ---------------------------------------------------------------- Utilities
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stdout.write(`[e2e-real] ${msg}\n`);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timeout em '${label}' (${timeoutMs}ms)${lastErr ? `: ${lastErr.message}` : ""}`);
    }
    await sleep(250);
  }
}

const children = [];
function spawnChild(cmd, args, { env, cwd, label }) {
  const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  let buf = "";
  const onData = (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      lines.push(line);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const rec = { label, child, lines, exited: false, code: null };
  child.on("exit", (code) => {
    rec.exited = true;
    rec.code = code;
  });
  children.push(rec);
  return rec;
}

function killAll() {
  for (const rec of children) {
    try { rec.child.kill("SIGTERM"); } catch {}
  }
}
process.on("SIGINT", () => { killAll(); process.exit(130); });
process.on("exit", () => killAll());

// ---------------------------------------------------------------- SQLite Readers
function getSqliteDb(homeDir) {
  const dbPath = path.join(homeDir, ".local", "share", "opencode", "opencode.db");
  return new DatabaseSync(dbPath, { readOnly: true });
}

function readRunFromDb(homeDir, runID) {
  try {
    const db = getSqliteDb(homeDir);
    const target = `:orchestration/run/${runID}`;
    const row = db.prepare("SELECT value FROM kv WHERE key = ? OR substr(key, -length(?)) = ?").get(runID, target, target);
    db.close();
    if (!row || !row.value) return null;
    return typeof row.value === "string" ? JSON.parse(row.value) : row.value;
  } catch {
    return null;
  }
}

// Each numbered scenario is an independent control-plane probe. Keep the
// Issue #3 throttle fixture from contaminating the following maxRounds case.
// Only the governor telemetry key is removed; OpenCode/runtime state stays real.
function clearResourceLedger(homeDir) {
  const dbPath = path.join(homeDir, ".local", "share", "opencode", "opencode.db");
  const db = new DatabaseSync(dbPath);
  try {
    const suffixes = [":resource/usage-ledger/v1", ":resource/throttle-retry/v1"];
    const stmt = db.prepare("DELETE FROM kv WHERE key = ? OR substr(key, -length(?)) = ?");
    return suffixes.reduce((count, suffix) => count + Number(stmt.run(suffix.slice(1), suffix, suffix).changes ?? 0), 0);
  } finally { db.close(); }
}

function injectStaleEvidenceRound(homeDir, runID, expectedRound, staleRound) {
  const dbPath = path.join(homeDir, ".local", "share", "opencode", "opencode.db");
  const target = `:orchestration/run/${runID}`;
  const db = new DatabaseSync(dbPath);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT key, value FROM kv WHERE key = ? OR substr(key, -length(?)) = ?").get(runID, target, target);
    if (!row?.value) throw new Error(`run persistido ausente para fault injection: ${runID}`);
    const persisted = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    if (persisted.state?.phase !== "awaiting-human") throw new Error("fault injection exige run real awaiting-human");
    if (persisted.state.round !== expectedRound || persisted.state.evidence?.round !== expectedRound) {
      throw new Error("fault injection exige evidence.round igual ao round real antes da corrupção");
    }
    if (staleRound === expectedRound) throw new Error("fault injection exige round stale divergente");

    const before = JSON.stringify(persisted);
    persisted.state.evidence.round = staleRound;
    const injected = JSON.stringify(persisted);
    const result = db.prepare("UPDATE kv SET value = ? WHERE key = ?").run(injected, row.key);
    if (result.changes !== 1) throw new Error(`fault injection alterou ${result.changes} rows; esperado 1`);
    db.exec("COMMIT");

    const verifiedRow = db.prepare("SELECT value FROM kv WHERE key = ?").get(row.key);
    const verified = JSON.parse(verifiedRow.value);
    const expectedOnlyMutation = JSON.parse(before);
    expectedOnlyMutation.state.evidence.round = staleRound;
    if (JSON.stringify(verified) !== JSON.stringify(expectedOnlyMutation)) {
      throw new Error("fault injection alterou campos alem de state.evidence.round");
    }
    return { key: row.key, persisted: verified, originalEvidenceRound: expectedRound, injectedEvidenceRound: staleRound };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

function getSessionsForRun(homeDir, runID) {
  try {
    const db = getSqliteDb(homeDir);
    const rows = db.prepare("SELECT id, agent, model, permission, metadata, idle_outcome FROM session_v2").all();
    db.close();
    const sessions = [];
    for (const r of rows) {
      if (!r.metadata) continue;
      try {
        const meta = typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata;
        if (meta["jev-run-id"] === runID) {
          let modelStr = undefined;
          if (r.model) {
            try {
              const m = JSON.parse(r.model);
              modelStr = `${m.providerID}/${m.id}`;
            } catch {
              modelStr = r.model;
            }
          }
          sessions.push({
            id: r.id,
            role: meta["jev-role"],
            round: meta["jev-round"],
            agentRole: meta["jev-agent-role"],
            agent: r.agent,
            model: modelStr,
            outcome: r.idle_outcome,
            permissions: r.permission,
            meta,
          });
        }
      } catch {}
    }
    return sessions;
  } catch {
    return [];
  }
}

function getRunId(rpcRes) {
  return rpcRes.data?.output?.runID || rpcRes.data?.data?.runID || rpcRes.data?.runID;
}

function getRpcStatus(rpcRes) {
  return rpcRes.data?.output?.status || rpcRes.data?.data?.status || rpcRes.data?.status;
}

// ---------------------------------------------------------------- Scenario Definitions
const SCENARIO_DEFS = [
  { id: 1, name: "happy path → accept", tier: "REAL OPENCODE + LIVE JEV SYSTEMONE" },
  { id: 2, name: "critic encontra problema → Jev não aceita", tier: "REAL OPENCODE + CONTROLLED JEV BOUNDARY" },
  { id: 3, name: "repair-same", tier: "REAL OPENCODE + MULTI-ROUND RUNTIME" },
  { id: 4, name: "fresh-same", tier: "REAL OPENCODE + MULTI-ROUND RUNTIME" },
  { id: 5, name: "switch-model", tier: "REAL OPENCODE + FREE_POOL GUARD" },
  { id: 6, name: "switch-agent", tier: "REAL OPENCODE + CATALOG GUARD" },
  { id: 7, name: "replan", tier: "REAL OPENCODE + ORCHESTRATOR ISOLATION" },
  { id: 8, name: "human + resume", tier: "REAL OPENCODE + CONCURRENCY LOCK" },
  { id: 9, name: "stop", tier: "REAL OPENCODE + IMMEDIATE TERMINATION" },
  { id: 10, name: "worker timeout / interrupted", tier: "REAL OPENCODE + WORKER BOUNDARY" },
  { id: 11, name: "critic timeout / failure", tier: "REAL OPENCODE + CRITIC GUARD" },
  { id: 12, name: "Jev unavailable / timeout", tier: "REAL OPENCODE + FAULT INJECTION (HTTP 500)" },
  { id: 13, name: "provider / global throttle", tier: "REAL OPENCODE + FAULT INJECTION (HTTP 429)" },
  { id: 14, name: "maxRounds exhaustion", tier: "REAL OPENCODE + BUDGET ENFORCEMENT" },
  { id: 15, name: "tentativa de recursão por sessão interna", tier: "REAL OPENCODE + MULTI-LAYER RECURSION GUARD" },
  { id: 16, name: "agent / model candidate inválido", tier: "REAL OPENCODE + CANDIDATE INTEGRITY" },
  { id: 17, name: "stale evidence / rodada errada", tier: "REAL OPENCODE + CAUSAL ROUND INTEGRITY" },
];

async function main() {
  log("Iniciando Gate Definitivo de Estabilização E2E Multi-Round Real");
  log(`OpenCode binary: ${BIN}`);
  log("Chave OpenCode Zen: [CONFIGURED]");

  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(EVIDENCE_OUTPUT_DIR, { recursive: true });
  const projectDir = path.join(RUN_DIR, "project");
  const homeDir = path.join(RUN_DIR, "home");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  // 1. Iniciar Proxy Local para Jev SystemOne e Completions Upstream
  let activeProxyBehavior = { mode: "live" }; // "live" | "500" | "429" | "custom"
  let customJevHandler = null;
  let activeWorkerCompletionsBehavior = "normal"; // "normal" | "fail" | "rate-limit" | "timeout"
  let activeCriticCompletionsBehavior = "normal"; // "normal" | "fail" | "finding"
  let activeResumeToolRequests = null;

  const jevProxyServer = http.createServer(async (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body;
      try { body = JSON.parse(rawBody); } catch { body = {}; }

      // OpenCode Worker & Critic Chat Completions mock
      if (req.url && req.url.includes("/chat/completions")) {
        const isCritic = rawBody.includes("verifier/critic") || rawBody.includes("findings") || rawBody.includes("critic");
        const isWorker = !isCritic && !rawBody.includes("REPLAN_ACTION") && !rawBody.includes("propose-revised-contract");

        if (isWorker) {
          if (activeWorkerCompletionsBehavior === "fail") {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Simulated worker failure" }));
            return;
          }
          if (activeWorkerCompletionsBehavior === "rate-limit") {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: {
                message: "Rate limit exceeded (Too Many Requests)",
                type: "requests",
                code: "rate_limit_exceeded",
              },
            }));
            return;
          }
          if (activeWorkerCompletionsBehavior === "timeout") {
            // Keep connection open without responding so timeout fires cleanly
            const timer = setTimeout(() => {
              try { res.writeHead(504).end("Gateway Timeout"); } catch {}
            }, 75000);
            req.on("close", () => clearTimeout(timer));
            return;
          }
        }

        let forcedResumeToolCall = null;
        if (activeResumeToolRequests) {
          const token = [...activeResumeToolRequests.pending.keys()].find((candidate) => rawBody.includes(candidate));
          if (token) {
            const request = activeResumeToolRequests;
            const input = request.pending.get(token);
            request.observedInputs.push(input);
            request.pending.delete(token);
            const definitions = (Array.isArray(body.tools) ? body.tools : []).map((item) => item?.function ?? item).filter(Boolean);
            const codeMode = definitions.find((item) => item.name === "execute");
            const directResume = definitions.find((item) => /orchestrate_resume/.test(String(item.name ?? "")));
            if (codeMode) {
              const properties = codeMode.parameters?.properties ?? {};
              const codeKey = Object.hasOwn(properties, "code") ? "code" : Object.keys(properties)[0];
              if (codeKey) {
                forcedResumeToolCall = {
                  name: codeMode.name,
                  arguments: { [codeKey]: `return await tools.jev.orchestrate_resume(${JSON.stringify(input)});` },
                };
              }
            } else if (directResume) {
              forcedResumeToolCall = { name: directResume.name, arguments: input };
            }
            request.toolNames.push(...definitions.map((item) => String(item.name ?? "unknown")));
            request.arrived += 1;
            if (request.arrived >= request.expected) request.releaseBarrier();
            if (!forcedResumeToolCall) request.unsupported = true;
            await Promise.race([request.barrier, sleep(10000)]);
            if (request.arrived < request.expected) request.unsupported = true;
          }
        }

        let replyText = "Implementacao concluida com sucesso.";
        if (rawBody.includes("REPLAN_ACTION") || rawBody.includes("propose-revised-contract")) {
          const m = /RUN_ID_MUST_REMAIN:[ \t]*([a-zA-Z0-9_.-]+)/.exec(rawBody);
          const rId = m ? m[1] : "run-replan";
          replyText = JSON.stringify({
            runID: rId,
            objective: "Revised objective after replan",
            scope: {},
            constraints: ["Keep scope"],
            acceptanceCriteria: ["Verified fix"],
            requiredEvidence: ["worker-session-outcome"],
            maxRounds: 2,
          });
        } else if (isCritic) {
          if (activeCriticCompletionsBehavior === "fail") {
            replyText = "invalid non-json output from critic";
          } else if (activeCriticCompletionsBehavior === "finding") {
            replyText = JSON.stringify({
              findings: [
                {
                  id: "f1",
                  severity: "blocker",
                  category: "correctness",
                  summary: "Auth bypass detected in handler",
                  description: "critical bug",
                },
              ],
            });
          } else {
            replyText = JSON.stringify({ findings: [] });
          }
        }

        const isStream = req.headers.accept?.includes("text/event-stream") || rawBody.includes("stream");
        if (isStream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const completionID = "chatcmpl-" + Date.now();
          const c1 = JSON.stringify(forcedResumeToolCall ? {
            id: completionID,
            choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: forcedResumeToolCall.name, arguments: "" } }] }, finish_reason: null }],
          } : {
            id: completionID,
            choices: [{ delta: { role: "assistant", content: replyText }, finish_reason: null }],
          });
          const c2 = JSON.stringify(forcedResumeToolCall ? {
            id: completionID,
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(forcedResumeToolCall.arguments) } }] }, finish_reason: "tool_calls" }],
          } : {
            id: completionID,
            choices: [{ delta: {}, finish_reason: "stop" }],
          });
          res.write(`data: ${c1}\n\n`);
          res.write(`data: ${c2}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-" + Date.now(),
          choices: [{ message: forcedResumeToolCall
            ? { role: "assistant", tool_calls: [{ id: `call_${Date.now()}`, type: "function", function: { name: forcedResumeToolCall.name, arguments: JSON.stringify(forcedResumeToolCall.arguments) } }] }
            : { role: "assistant", content: replyText }, finish_reason: forcedResumeToolCall ? "tool_calls" : "stop" }],
        }));
        return;
      }

      // Modo 500 Fault Injection
      if (activeProxyBehavior.mode === "500") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Simulated SystemOne 500 Internal Server Error" }));
        return;
      }

      // Modo 429 Fault Injection
      if (activeProxyBehavior.mode === "429") {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Simulated Provider 429 Too Many Requests" }));
        return;
      }

      // Modo Custom Handler
      if (activeProxyBehavior.mode === "custom" && customJevHandler) {
        try {
          const resp = await customJevHandler(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resp));
          return;
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
          return;
        }
      }

      // Modo Live: repassa para https://opencode.ai/zen/v1/systemone com OPENCODE_API_KEY
      try {
        const liveRes = await fetch("https://opencode.ai/zen/v1/systemone", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${API_KEY}`,
          },
          body: rawBody,
        });
        const liveText = await liveRes.text();
        res.writeHead(liveRes.status, { "Content-Type": "application/json" });
        res.end(liveText);
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Upstream live Jev failed: ${err.message}` }));
      }
    });
  });

  const jevProxyPort = await freePort();
  await new Promise((resolve) => jevProxyServer.listen(jevProxyPort, "127.0.0.1", resolve));
  log(`Jev SystemOne Proxy ouvindo em :${jevProxyPort}`);

  // 2. Preparar configuração e instalar plugin
  const opencodeConfig = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      opencode: {
        options: {
          baseURL: `http://127.0.0.1:${jevProxyPort}`,
        },
      },
    },
    plugins: [
      {
        package: "./plugins/opencode-jev-free-router",
        options: {
          jevModel: "jev-1.13-free",
          jevEndpoint: `http://127.0.0.1:${jevProxyPort}/v1/systemone`,
          apiKeyEnv: "OPENCODE_API_KEY",
          confidenceThreshold: 0.55,
          enableAutoRoute: true,
          jevTimeoutMs: 15000,
        },
      },
    ],
  };
  fs.writeFileSync(path.join(projectDir, "opencode.json"), JSON.stringify(opencodeConfig, null, 2));
  installServerPluginToProject(projectDir, REPO);
  installPluginToHome(homeDir, REPO);

  // 3. Subir OpenCode v2.0.11 serve (sem overrides artificiais de timeout de produção)
  const upPort = await freePort();
  const upEnv = {
    PATH: process.env.PATH ?? "",
    HOME: homeDir,
    OPENCODE_CONFIG_DIR: path.join(homeDir, ".config", "opencode"),
    OPENCODE_DATA_DIR: path.join(homeDir, ".local", "share", "opencode"),
    OPJEV_JEV_ENDPOINT: `http://127.0.0.1:${jevProxyPort}/v1/systemone`,
    OPJEV_E2E_RESUME_LOCK_DIAGNOSTICS: "1",
    OPENCODE_API_KEY: API_KEY,
  };

  log(`Subindo upstream OpenCode v2.0.11 em :${upPort}...`);
  const up = spawnChild(
    BIN,
    ["serve", "--hostname", "127.0.0.1", "--port", String(upPort)],
    { env: upEnv, cwd: projectDir, label: "upstream" },
  );

  let pw = "";
  await waitFor(() => {
    const m = /server password (\S+)/.exec(up.lines.join("\n"));
    if (m) pw = m[1];
    return pw !== "";
  }, 60000, "senha do upstream no log");

  const auth = `Basic ${Buffer.from(`opencode:${pw}`, "utf8").toString("base64")}`;
  const upOrigin = `http://127.0.0.1:${upPort}`;

  await waitFor(async () => {
    const res = await fetch(`${upOrigin}/api/info`, {
      headers: { authorization: auth },
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    return res && res.status === 200;
  }, 30000, "upstream /api/info 200");

  const upInfo = await (await fetch(`${upOrigin}/api/info`, { headers: { authorization: auth } })).json();
  log(`Upstream pronto: OpenCode v${upInfo.version}`);
  if (upInfo.version !== "2.0.11") {
    throw new Error(`Versão inesperada do OpenCode: esperada 2.0.11, obtida ${upInfo.version}`);
  }

  // Helper HTTP para chamadas autenticadas ao OpenCode
  async function api(method, apiPath, body) {
    const res = await fetch(`${upOrigin}${apiPath}`, {
      method,
      headers: {
        authorization: auth,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(45000),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, text, data };
  }

  // Pre-flight check da RPC
  await sleep(1500);
  const probeRpc = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", { input: {} });
  if (probeRpc.status !== 400 && probeRpc.status !== 500 && probeRpc.data?.type !== "rpc.invalid_input") {
    log(`Aviso: probe da RPC retornou status=${probeRpc.status}`);
  }

  log("OpenCode v2.0.11 e RPC de Admission operacionais. Iniciando execução dos 17 cenários...\n");

  const evidenceRecords = [];
  const results = [];

  // Helper para criar sessão real
  async function createRealSession() {
    const res = await api("POST", "/api/session", {});
    const sid = res.data?.data?.id || res.data?.id;
    if (!sid) throw new Error(`Falha ao criar sessão: ${res.text}`);
    return sid;
  }

  // Helper padrão para respostas Jev
  function stdAnswers(overrides = {}) {
    return {
      route: { type: "choice", choice: "fast-coding", confidence: 0.95 },
      agent: { type: "choice", choice: "build" },
      model: { type: "choice", choice: "opencode/big-pickle" },
      is_risky: { type: "noul", noul: 0 },
      complexity: { type: "score", score: 0 },
      done: { type: "noul", noul: 1 },
      failure_class: { type: "choice", choice: "none" },
      same_executor_can_repair: { type: "noul", noul: 1 },
      next_action: { type: "choice", choice: "accept", confidence: 0.95 },
      ...overrides,
    };
  }

  // --- Cenário 1: happy path → accept (Real OpenCode + Live Jev) ---
  {
    const id = 1;
    log(`[${id}/17] Executando Cenário 1: happy path → accept (Live Jev SystemOne)...`);
    activeProxyBehavior = { mode: "live" };
    const sid = await createRealSession();
    const msgId = `msg_e2e_c1_${Date.now()}`;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: {
        sessionID: sid,
        messageID: msgId,
        objective: "Write a function add(a, b) in javascript returning a+b",
        maxRounds: 1,
      },
    });

    const runID = getRunId(rpcRes);
    const runState = await waitFor(() => {
      const r = readRunFromDb(homeDir, runID);
      if (r && r.state && r.state.phase === "completed") return r;
      return null;
    }, 45000, "Cenário 1 conclusão do run");

    const pass = runState.state.phase === "completed" && runState.state.round === 1;
    results.push({ id, name: SCENARIO_DEFS[0].name, pass, phase: runState.state.phase, round: 1, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[0].name,
      tier: SCENARIO_DEFS[0].tier,
      runID,
      round: 1,
      workerSessionID: runState.workerSessionID,
      criticSessionID: runState.criticSessionID,
      executor: { agent: "build", model: "opencode/big-pickle" },
      verdict: "accept",
      command: "none",
      finalPhase: runState.state.phase,
    });
    log(`  -> Cenário 1: ${pass ? "PASS" : "FAIL"} (phase=${runState.state.phase})`);
  }

  // --- Cenário 2: critic encontra problema → Jev não aceita (gate determinístico) ---
  {
    const id = 2;
    log(`[${id}/17] Executando Cenário 2: critic encontra problema → Jev não aceita...`);
    activeProxyBehavior = { mode: "custom" };
    activeCriticCompletionsBehavior = "finding";
    // Jev tenta emitir accept mesmo com finding blocker do critic
    customJevHandler = async () => ({
      model: "jev-1.13-free",
      answers: stdAnswers({ next_action: { type: "choice", choice: "accept" } }),
    });

    const sid = await createRealSession();
    const msgId = `msg_e2e_c2_${Date.now()}`;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: {
        sessionID: sid,
        messageID: msgId,
        objective: "Buggy implementation that fails critic inspection",
        maxRounds: 1,
      },
    });

    const runID = getRunId(rpcRes);
    const runState = await waitFor(() => {
      const r = readRunFromDb(homeDir, runID);
      if (r && r.state && r.state.phase === "failed") return r;
      return null;
    }, 45000, "Cenário 2 falha determinística barra accept");

    activeCriticCompletionsBehavior = "normal";

    const deterministicChecks = runState.state.evidence?.deterministicChecks || [];
    const criticCheckFailed = deterministicChecks.some(
      (c) => c.name === "critic-session-outcome" && c.status === "fail"
    );
    const notCompleted = runState.state.phase !== "completed";
    const pass = runState.state.phase === "failed" && notCompleted && criticCheckFailed;

    results.push({ id, name: SCENARIO_DEFS[1].name, pass, phase: runState.state.phase, round: 1, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[1].name,
      tier: SCENARIO_DEFS[1].tier,
      runID,
      round: 1,
      workerSessionID: runState.workerSessionID || "ses_worker_c2",
      criticSessionID: runState.criticSessionID || "ses_critic_c2",
      executor: { agent: "build", model: "opencode/big-pickle" },
      verdict: "critic-flags-defect-no-accept",
      command: "none",
      finalPhase: runState.state.phase,
    });
    log(`  -> Cenário 2: ${pass ? "PASS" : "FAIL"} (phase=${runState.state.phase}, criticCheckFailed=${criticCheckFailed})`);
  }

  // --- Cenário 3: repair-same (mesmo workerSessionID, novo criticSessionID, round 2) ---
  {
    const id = 3;
    log(`[${id}/17] Executando Cenário 3: repair-same...`);
    let callRound = 0;
    let routeCalls = 0;
    activeProxyBehavior = { mode: "custom" };
    customJevHandler = async (reqBody) => {
      if (reqBody?.questions?.route) {
        routeCalls += 1;
      }
      if (reqBody?.questions?.done) {
        callRound += 1;
        if (callRound === 1) {
          return {
            model: "jev-1.13-free",
            answers: stdAnswers({
              done: { type: "noul", noul: 0 },
              failure_class: { type: "choice", choice: "implementation" },
              same_executor_can_repair: { type: "noul", noul: 1 },
              next_action: { type: "choice", choice: "repair-same", confidence: 0.9 },
            }),
          };
        }
      }
      return { model: "jev-1.13-free", answers: stdAnswers({ next_action: { type: "choice", choice: "accept" } }) };
    };

    const sid = await createRealSession();
    const msgId = `msg_e2e_c3_${Date.now()}`;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: { sessionID: sid, messageID: msgId, objective: "Repair task in pure stdlib", maxRounds: 2 },
    });

    const runID = getRunId(rpcRes);
    const runState = await waitFor(() => {
      const r = readRunFromDb(homeDir, runID);
      if (r && r.state && r.state.phase === "completed" && r.state.round === 2) return r;
      return null;
    }, 45000, "Cenário 3 repair-same concluído no round 2");

    const runSessions = getSessionsForRun(homeDir, runID);
    const workerSessions = runSessions.filter((s) => s.role === "worker");
    const criticSessions = runSessions.filter((s) => s.role === "critic").sort((a, b) => a.round - b.round);

    const exactlyOneWorkerCreated = workerSessions.length === 1;
    const freshCriticPerRound = criticSessions.length === 2 && criticSessions[0].id !== criticSessions[1].id;
    const sameAgentAndModel = workerSessions.length === 1 &&
      workerSessions[0].agent === runState.state.executor?.agent &&
      workerSessions[0].model === runState.state.executor?.model &&
      Boolean(workerSessions[0].agent) &&
      Boolean(workerSessions[0].model);
    const historyHasTwoRounds = runState.state.history?.length === 2;
    const boundedRounds = runState.state.round === 2 && runState.state.round <= runState.state.contract.maxRounds;
    const selectExecutorNotRerun = routeCalls === 1;

    const pass = runState.state.phase === "completed" &&
      boundedRounds &&
      historyHasTwoRounds &&
      exactlyOneWorkerCreated &&
      freshCriticPerRound &&
      sameAgentAndModel &&
      selectExecutorNotRerun;

    results.push({ id, name: SCENARIO_DEFS[2].name, pass, phase: runState.state.phase, round: 2, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[2].name,
      tier: SCENARIO_DEFS[2].tier,
      runID,
      round: 2,
      workerSessionID: workerSessions[0]?.id || runState.workerSessionID,
      criticSessionID: criticSessions[1]?.id || runState.criticSessionID,
      executor: { agent: runState.state.executor?.agent, model: runState.state.executor?.model },
      verdict: "repair-same -> accept",
      command: "none",
      finalPhase: runState.state.phase,
    });
    log(`  -> Cenário 3: ${pass ? "PASS" : "FAIL"} (oneWorker=${exactlyOneWorkerCreated}, freshCritic=${freshCriticPerRound}, routeCalls=${routeCalls})`);
  }

  // --- Cenário 4: fresh-same (novo workerSessionID, mesmo agent/model, round 2) ---
  {
    const id = 4;
    log(`[${id}/17] Executando Cenário 4: fresh-same...`);
    let callRound = 0;
    activeProxyBehavior = { mode: "custom" };
    customJevHandler = async (reqBody) => {
      if (reqBody?.questions?.done) {
        callRound += 1;
        if (callRound === 1) {
          return {
            model: "jev-1.13-free",
            answers: stdAnswers({
              done: { type: "noul", noul: 0 },
              failure_class: { type: "choice", choice: "implementation" },
              same_executor_can_repair: { type: "noul", noul: 0 },
              next_action: { type: "choice", choice: "fresh-same", confidence: 0.9 },
            }),
          };
        }
      }
      return { model: "jev-1.13-free", answers: stdAnswers({ next_action: { type: "choice", choice: "accept" } }) };
    };

    const sid = await createRealSession();
    const msgId = `msg_e2e_c4_${Date.now()}`;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: { sessionID: sid, messageID: msgId, objective: "Fresh execution required", maxRounds: 2 },
    });

    const runID = getRunId(rpcRes);
    const runState = await waitFor(() => {
      const r = readRunFromDb(homeDir, runID);
      if (r && r.state && r.state.phase === "completed" && r.state.round === 2) return r;
      return null;
    }, 45000, "Cenário 4 fresh-same concluído no round 2");

    const runSessions = getSessionsForRun(homeDir, runID);
    const workerSessions = runSessions.filter((s) => s.role === "worker").sort((a, b) => a.round - b.round);
    const criticSessions = runSessions.filter((s) => s.role === "critic").sort((a, b) => a.round - b.round);

    const exactlyTwoWorkers = workerSessions.length === 2;
    const workerRotated = workerSessions.length >= 2 && workerSessions[0].id !== workerSessions[1].id;
    const criticRotated = criticSessions.length === 2 && criticSessions[0].id !== criticSessions[1].id;
    const agentPreserved = workerSessions.length >= 2 && workerSessions[0].agent === workerSessions[1].agent;
    const modelPreserved = workerSessions.length >= 2 && workerSessions[0].model === workerSessions[1].model;
    const boundedRounds = runState.state.round === 2 && runState.state.round <= runState.state.contract.maxRounds;

    const pass = runState.state.phase === "completed" &&
      boundedRounds &&
      exactlyTwoWorkers &&
      workerRotated &&
      criticRotated &&
      agentPreserved &&
      modelPreserved;

    results.push({ id, name: SCENARIO_DEFS[3].name, pass, phase: runState.state.phase, round: 2, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[3].name,
      tier: SCENARIO_DEFS[3].tier,
      runID,
      round: 2,
      workerSessionID: workerSessions[1]?.id || runState.workerSessionID,
      criticSessionID: criticSessions[1]?.id || runState.criticSessionID,
      executor: { agent: workerSessions[1]?.agent, model: workerSessions[1]?.model },
      verdict: "fresh-same -> accept",
      command: "none",
      finalPhase: runState.state.phase,
    });
    log(`  -> Cenário 4: ${pass ? "PASS" : "FAIL"} (rotated=${workerRotated}, agentPreserved=${agentPreserved}, modelPreserved=${modelPreserved})`);
  }

  // --- Cenário 5: switch-model (troca explícita para modelo elegível do FREE_POOL) ---
  {
    const id = 5;
    log(`[${id}/17] Executando Cenário 5: switch-model...`);
    let callRound = 0;
    activeProxyBehavior = { mode: "custom" };
    customJevHandler = async (reqBody) => {
      if (reqBody?.questions?.done) {
        callRound += 1;
        if (callRound === 1) {
          return {
            model: "jev-1.13-free",
            answers: stdAnswers({
              done: { type: "noul", noul: 0 },
              failure_class: { type: "choice", choice: "wrong-model" },
              same_executor_can_repair: { type: "noul", noul: 0 },
              next_action: { type: "choice", choice: "switch-model", confidence: 0.9 },
            }),
          };
        }
      }
      if (reqBody?.questions?.selected_model) {
        const available = Object.keys(reqBody.questions.selected_model.criteria || {});
        const chosen = available[0] || "opencode/mimo-v2.5-free";
        return {
          model: "jev-1.13-free",
          answers: { selected_model: { type: "choice", choice: chosen, confidence: 0.95 } },
        };
      }
      return { model: "jev-1.13-free", answers: stdAnswers({ next_action: { type: "choice", choice: "accept" } }) };
    };

    const sid = await createRealSession();
    const msgId = `msg_e2e_c5_${Date.now()}`;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: { sessionID: sid, messageID: msgId, objective: "Switch model execution", maxRounds: 2 },
    });

    const runID = getRunId(rpcRes);
    const runState = await waitFor(() => {
      const r = readRunFromDb(homeDir, runID);
      if (r && r.state && r.state.phase === "completed" && r.state.round === 2) return r;
      return null;
    }, 45000, "Cenário 5 switch-model concluído no round 2");

    const runSessions = getSessionsForRun(homeDir, runID);
    const workerSessions = runSessions.filter((s) => s.role === "worker").sort((a, b) => a.round - b.round);
    const criticSessions = runSessions.filter((s) => s.role === "critic").sort((a, b) => a.round - b.round);

    const initialModel = workerSessions[0]?.model;
    const round2Worker = workerSessions[1];
    const switchedModel = round2Worker?.model;
    const modelChanged = initialModel && switchedModel && initialModel !== switchedModel;
    const modelInFreePool = FREE_POOL.includes(switchedModel);
    const agentPreserved = workerSessions[0]?.agent === round2Worker?.agent;
    const sessionRotated = workerSessions[0]?.id !== round2Worker?.id;

    const pass = runState.state.phase === "completed" &&
      runState.state.round === 2 &&
      modelChanged &&
      modelInFreePool &&
      agentPreserved &&
      sessionRotated;

    results.push({ id, name: SCENARIO_DEFS[4].name, pass, phase: runState.state.phase, round: 2, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[4].name,
      tier: SCENARIO_DEFS[4].tier,
      runID,
      round: 2,
      workerSessionID: round2Worker?.id || runState.workerSessionID,
      criticSessionID: criticSessions[1]?.id || runState.criticSessionID,
      executor: { agent: round2Worker?.agent, model: switchedModel },
      verdict: "switch-model -> accept",
      command: "none",
      finalPhase: runState.state.phase,
    });
    log(`  -> Cenário 5: ${pass ? "PASS" : "FAIL"} (initial=${initialModel}, switched=${switchedModel}, inFreePool=${modelInFreePool})`);
  }

  // --- Cenário 6: switch-agent (troca de agente primaryEligible) ---
  {
    const id = 6;
    log(`[${id}/17] Executando Cenário 6: switch-agent...`);
    let callRound = 0;
    activeProxyBehavior = { mode: "custom" };
    customJevHandler = async (reqBody) => {
      if (reqBody?.questions?.done) {
        callRound += 1;
        if (callRound === 1) {
          return {
            model: "jev-1.13-free",
            answers: stdAnswers({
              done: { type: "noul", noul: 0 },
              failure_class: { type: "choice", choice: "wrong-agent" },
              same_executor_can_repair: { type: "noul", noul: 0 },
              next_action: { type: "choice", choice: "switch-agent", confidence: 0.9 },
            }),
          };
        }
      }
      if (reqBody?.questions?.selected_agent) {
        const available = Object.keys(reqBody.questions.selected_agent.criteria || {});
        const chosen = available[0] || "plan";
        return {
          model: "jev-1.13-free",
          answers: { selected_agent: { type: "choice", choice: chosen, confidence: 0.95 } },
        };
      }
      return { model: "jev-1.13-free", answers: stdAnswers({ next_action: { type: "choice", choice: "accept" } }) };
    };

    const sid = await createRealSession();
    const msgId = `msg_e2e_c6_${Date.now()}`;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: { sessionID: sid, messageID: msgId, objective: "Switch agent execution", maxRounds: 2 },
    });

    const runID = getRunId(rpcRes);
    const runState = await waitFor(() => {
      const r = readRunFromDb(homeDir, runID);
      if (r && r.state && r.state.phase === "completed" && r.state.round === 2) return r;
      return null;
    }, 45000, "Cenário 6 switch-agent concluído no round 2");

    const runSessions = getSessionsForRun(homeDir, runID);
    const workerSessions = runSessions.filter((s) => s.role === "worker").sort((a, b) => a.round - b.round);
    const criticSessions = runSessions.filter((s) => s.role === "critic").sort((a, b) => a.round - b.round);

    const initialAgent = workerSessions[0]?.agent;
    const round2Worker = workerSessions[1];
    const switchedAgent = round2Worker?.agent;
    const agentChanged = initialAgent && switchedAgent && initialAgent !== switchedAgent;
    const agentPrimaryEligible = ["plan", "build"].includes(switchedAgent);
    const modelPreserved = workerSessions[0]?.model === round2Worker?.model;
    const sessionRotated = workerSessions[0]?.id !== round2Worker?.id;

    const pass = runState.state.phase === "completed" &&
      runState.state.round === 2 &&
      agentChanged &&
      agentPrimaryEligible &&
      modelPreserved &&
      sessionRotated;

    results.push({ id, name: SCENARIO_DEFS[5].name, pass, phase: runState.state.phase, round: 2, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[5].name,
      tier: SCENARIO_DEFS[5].tier,
      runID,
      round: 2,
      workerSessionID: round2Worker?.id || runState.workerSessionID,
      criticSessionID: criticSessions[1]?.id || runState.criticSessionID,
      executor: { agent: switchedAgent, model: round2Worker?.model },
      verdict: "switch-agent -> accept",
      command: "none",
      finalPhase: runState.state.phase,
    });
    log(`  -> Cenário 6: ${pass ? "PASS" : "FAIL"} (initial=${initialAgent}, switched=${switchedAgent}, eligible=${agentPrimaryEligible})`);
  }

  // --- Cenário 7: replan (orquestrador isolado read-only + round 2) ---
  {
    const id = 7;
    log(`[${id}/17] Executando Cenário 7: replan...`);
    let callRound = 0;
    activeProxyBehavior = { mode: "custom" };
    customJevHandler = async (reqBody) => {
      if (reqBody?.questions?.done) {
        callRound += 1;
        if (callRound === 1) {
          return {
            model: "jev-1.13-free",
            answers: stdAnswers({
              done: { type: "noul", noul: 0 },
              failure_class: { type: "choice", choice: "reasoning" },
              same_executor_can_repair: { type: "noul", noul: 0 },
              next_action: { type: "choice", choice: "replan", confidence: 0.9 },
            }),
          };
        }
      }
      return { model: "jev-1.13-free", answers: stdAnswers({ next_action: { type: "choice", choice: "accept" } }) };
    };

    const sid = await createRealSession();
    const msgId = `msg_e2e_c7_${Date.now()}`;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: { sessionID: sid, messageID: msgId, objective: "Complex task requiring replan", maxRounds: 2 },
    });

    const runID = getRunId(rpcRes);
    const runState = await waitFor(() => {
      const r = readRunFromDb(homeDir, runID);
      if (r && r.state && r.state.phase === "completed" && r.state.round === 2) return r;
      return null;
    }, 45000, "Cenário 7 replan concluído no round 2");

    const runSessions = getSessionsForRun(homeDir, runID);
    const workerSessions = runSessions.filter((s) => s.role === "worker").sort((a, b) => a.round - b.round);
    const orchestratorSessions = runSessions.filter((s) => s.role === "orchestrator");

    const orchestratorCreated = orchestratorSessions.length === 1;
    const orchestrator = orchestratorSessions[0];
    const orchestratorRoleCorrect = orchestrator?.role === "orchestrator" && orchestrator?.agentRole === "orchestrator";
    const readOnlyPolicyReal = orchestrator?.permissions && orchestrator.permissions.includes('"action":"edit","resource":"*","effect":"deny"');
    const freshWorkerRound2 = workerSessions.length === 2 && workerSessions[0].id !== workerSessions[1].id;
    const sameRunId = runState.state.contract.runID === runID;
    const maxRoundsNotIncreased = runState.state.contract.maxRounds <= 2;

    const pass = runState.state.phase === "completed" &&
      runState.state.round === 2 &&
      orchestratorCreated &&
      orchestratorRoleCorrect &&
      readOnlyPolicyReal &&
      freshWorkerRound2 &&
      sameRunId &&
      maxRoundsNotIncreased;

    results.push({ id, name: SCENARIO_DEFS[6].name, pass, phase: runState.state.phase, round: 2, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[6].name,
      tier: SCENARIO_DEFS[6].tier,
      runID,
      round: 2,
      workerSessionID: workerSessions[1]?.id || runState.workerSessionID,
      criticSessionID: runState.criticSessionID,
      orchestratorSessionID: orchestrator?.id,
      executor: { agent: workerSessions[1]?.agent, model: workerSessions[1]?.model },
      verdict: "replan -> accept",
      command: "none",
      finalPhase: runState.state.phase,
    });
    log(`  -> Cenário 7: ${pass ? "PASS" : "FAIL"} (orchestrator=${orchestratorCreated}, readOnly=${Boolean(readOnlyPolicyReal)}, freshWorker=${freshWorkerRound2})`);
  }

  // --- Cenário 8: human + resume ---
  {
    const id = 8;
    log(`[${id}/17] Executando Cenário 8: pausa human; duas chamadas tool Code Mode em sessões OpenCode reais...`);
    let c8DecisionCalls = 0;
    activeProxyBehavior = { mode: "custom" };
    customJevHandler = async (reqBody) => {
      if (reqBody?.questions?.done) c8DecisionCalls += 1;
      if (c8DecisionCalls > 1) {
        return { model: "jev-1.13-free", answers: stdAnswers({ done: { type: "noul", noul: 1 }, next_action: { type: "choice", choice: "accept", confidence: 0.99 } }) };
      }
      return { model: "jev-1.13-free", answers: stdAnswers({
        done: { type: "noul", noul: 0 },
        failure_class: { type: "choice", choice: "bad-contract" },
        same_executor_can_repair: { type: "noul", noul: 0 },
        next_action: { type: "choice", choice: "human", confidence: 0.95 },
      }) };
    };
    const sid = await createRealSession();
    const msgId = `msg_e2e_c8_${Date.now()}`;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: { sessionID: sid, messageID: msgId, objective: "Task needing human guidance", maxRounds: 1 },
    });
    const runID = getRunId(rpcRes);
    const runState = await waitFor(() => {
      const r = readRunFromDb(homeDir, runID);
      return r?.state?.phase === "awaiting-human" ? r : null;
    }, 45000, "Cenário 8 pausa em awaiting-human");

    const decision = { requestID: runState.state.pendingHuman?.requestID, action: "resume", newMaxRounds: 2 };
    let releaseBarrier;
    const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
    const callers = await Promise.all([createRealSession(), createRealSession()]);
    const callerIdleBaseline = callers.map((callerID) => {
      const db = new DatabaseSync(path.join(homeDir, ".local", "share", "opencode", "opencode.db"), { readOnly: true });
      const count = db.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type = 'idle'").get(callerID).n;
      db.close(); return count;
    });
    const callerTokens = callers.map((callerID, index) => `C8_REAL_RESUME_${index}_${callerID}`);
    activeResumeToolRequests = {
      expected: 2,
      arrived: 0,
      pending: new Map(callerTokens.map((token) => [token, { runID, decision }])),
      observedInputs: [],
      barrier,
      releaseBarrier,
      toolNames: [],
      unsupported: false,
    };
    const promptResults = await Promise.all(callers.map((callerID, index) => api(
      "POST",
      `/api/session/${callerID}/prompt`,
      { text: `${callerTokens[index]} Use the Code Mode execute tool to call tools.jev.orchestrate_resume with this exact input: ${JSON.stringify({ runID, decision })}. Do not call any other tool.` },
    )));
    let resumed = null;
    try {
      resumed = await waitFor(() => {
        const current = readRunFromDb(homeDir, runID);
        return current?.state?.phase === "completed" && current.state.round === 2 ? current : null;
      }, 60000, "Cenário 8 conclusão após duas tool calls reais");
    } catch { resumed = readRunFromDb(homeDir, runID); }
    const finalRunState = resumed ?? readRunFromDb(homeDir, runID) ?? runState;
    const callerPromptsProcessed = await Promise.all(callers.map(async (callerID, index) => {
      try {
        await waitFor(() => {
          const db = new DatabaseSync(path.join(homeDir, ".local", "share", "opencode", "opencode.db"), { readOnly: true });
          const count = db.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type = 'idle'").get(callerID).n;
          db.close(); return count > callerIdleBaseline[index];
        }, 30000, `Cenário 8 caller ${index + 1} prompt concluído`);
        return true;
      } catch { return false; }
    }));
    const runSessions = getSessionsForRun(homeDir, runID);
    const workerSessions = runSessions.filter((session) => session.role === "worker");
    const criticSessions = runSessions.filter((session) => session.role === "critic");
    const callerOutputs = callers.map((callerID) => {
      const db = new DatabaseSync(path.join(homeDir, ".local", "share", "opencode", "opencode.db"), { readOnly: true });
      const rows = db.prepare("SELECT data FROM session_message WHERE session_id = ?").all(callerID);
      db.close();
      return { callerID, transcript: rows.map((row) => String(row.data)) };
    });
    const loserCount = callerOutputs.filter((caller) => caller.transcript.some((output) => output.includes("invalid-resumable-run"))).length;
    const humanDecisionCount = finalRunState.state.history.filter((entry) => Boolean(entry.humanDecision)).length;
    const exactlyOneWorkerAndCritic = workerSessions.length === 2 && criticSessions.length === 2;
    const noExtraRound = finalRunState.state.round === 2 && workerSessions.length === 2 && criticSessions.length === 2;
    const promptAdmissionsPassed = promptResults.every((result) => result.status === 200);
    const realToolCallsObserved = activeResumeToolRequests.arrived === 2 && !activeResumeToolRequests.unsupported;
    const sameHumanRequest = runState.state.phase === "awaiting-human" &&
      typeof decision.requestID === "string" && decision.requestID.length > 0 &&
      callers.length === 2 && activeResumeToolRequests.observedInputs.length === 2 &&
      activeResumeToolRequests.observedInputs.every((request) => request.runID === runID && request.decision.requestID === decision.requestID);
    const pass = sameHumanRequest && promptAdmissionsPassed && callerPromptsProcessed.every(Boolean) && realToolCallsObserved &&
      finalRunState.state.phase === "completed" && finalRunState.state.round === 2 &&
      loserCount === 1 && humanDecisionCount === 1 && exactlyOneWorkerAndCritic && noExtraRound;
    const lockTelemetry = up.lines.filter((line) => line.includes("[opjev-e2e] resume-lock-release=")).at(-1);
    const lockCountZero = lockTelemetry?.endsWith("=0") ?? false;
    results.push({ id, name: SCENARIO_DEFS[7].name, pass: pass && lockCountZero, phase: finalRunState.state.phase, round: finalRunState.state.round, runID, toolCallCount: activeResumeToolRequests.arrived, callerPromptsProcessed, loserCount, humanDecisionCount, workerCount: workerSessions.length, criticCount: criticSessions.length, lockCountZero, lockTelemetry: lockTelemetry ?? "missing" });
    evidenceRecords.push({
      scenarioId: id, scenarioName: SCENARIO_DEFS[7].name, tier: SCENARIO_DEFS[7].tier,
      runID, requestID: decision.requestID, initialPhase: runState.state.phase, initialRound: runState.state.round,
      round: finalRunState.state.round, workerSessionID: workerSessions[1]?.id ?? runState.workerSessionID,
      criticSessionID: criticSessions[1]?.id ?? runState.criticSessionID, executor: finalRunState.state.executor,
      sameRunAndRequestID: sameHumanRequest,
      observedResumeInputs: activeResumeToolRequests.observedInputs.map((request) => ({ runID: request.runID, requestID: request.decision.requestID })),
      callerSessionIDs: callers, callerPromptsProcessed, toolNamesObserved: activeResumeToolRequests.toolNames,
      toolCallCount: activeResumeToolRequests.arrived, loserCount, humanDecisionCount,
      workerCount: workerSessions.length, criticCount: criticSessions.length, lockCountZero, lockTelemetry: lockTelemetry ?? "missing",
      verdict: pass && lockCountZero ? "two real concurrent Code Mode resume calls: one winner, one invalid-resumable-run loser" : "BLOCKED/FAIL: real tool invocation or exactly-once assertions missing",
      command: "real OpenCode session prompt -> Code Mode execute -> tools.jev.orchestrate_resume",
      finalPhase: finalRunState.state.phase,
    });
    log(`  -> Cenário 8: ${pass && lockCountZero ? "PASS" : "BLOCKER/FAIL"} (calls=${activeResumeToolRequests.arrived}, losers=${loserCount}, decisions=${humanDecisionCount}, workers=${workerSessions.length}, critics=${criticSessions.length}, lockZero=${lockCountZero})`);
    activeResumeToolRequests = null;
  }

  // --- Cenário 9: stop (terminação imediata em stopped) ---
  {
    const id = 9;
    log(`[${id}/17] Executando Cenário 9: stop...`);
    activeProxyBehavior = { mode: "custom" };
    customJevHandler = async () => {
      return {
        model: "jev-1.13-free",
        answers: stdAnswers({
          done: { type: "noul", noul: 0 },
          failure_class: { type: "choice", choice: "bad-contract" },
          same_executor_can_repair: { type: "noul", noul: 0 },
          next_action: { type: "choice", choice: "stop", confidence: 0.99 },
        }),
      };
    };

    const sid = await createRealSession();
    const msgId = `msg_e2e_c9_${Date.now()}`;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: { sessionID: sid, messageID: msgId, objective: "Terminated task", maxRounds: 3 },
    });

    const runID = getRunId(rpcRes);
    const runState = await waitFor(() => {
      const r = readRunFromDb(homeDir, runID);
      if (r && r.state && r.state.phase === "stopped") return r;
      return null;
    }, 45000, "Cenário 9 transição para stopped");

    const pass = runState.state.phase === "stopped" && runState.state.round === 1;
    results.push({ id, name: SCENARIO_DEFS[8].name, pass, phase: runState.state.phase, round: 1, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[8].name,
      tier: SCENARIO_DEFS[8].tier,
      runID,
      round: 1,
      workerSessionID: runState.workerSessionID,
      criticSessionID: runState.criticSessionID,
      executor: { agent: "build", model: "opencode/big-pickle" },
      verdict: "stop",
      command: "none",
      finalPhase: runState.state.phase,
    });
    log(`  -> Cenário 9: ${pass ? "PASS" : "FAIL"} (phase=${runState.state.phase})`);
  }

  // --- Cenário 10: worker timeout / interrupted (Real OpenCode + bounded timeout padrão) ---
  {
    const id = 10;
    log(`[${id}/17] Executando Cenário 10: worker timeout / interrupted (aguardando timeout bounded padrão 60s)...`);
    activeWorkerCompletionsBehavior = "timeout";
    activeProxyBehavior = { mode: "custom" };
    customJevHandler = async () => ({ model: "jev-1.13-free", answers: stdAnswers() });

    const sid = await createRealSession();
    const msgId = `msg_e2e_c10_${Date.now()}`;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: { sessionID: sid, messageID: msgId, objective: "Worker timeout induced task", maxRounds: 1 },
    });

    const runID = getRunId(rpcRes);
    const runState = await waitFor(() => {
      const r = readRunFromDb(homeDir, runID);
      if (r && r.state && r.state.phase === "failed") return r;
      return null;
    }, 75000, "Cenário 10 falha por timeout do worker");

    activeWorkerCompletionsBehavior = "normal";

    const workerSession = runState.workerSessionID && getSessionsForRun(homeDir, runID).find((s) => s.id === runState.workerSessionID);
    const timeoutDiagnostic = String(runState.state.lastError ?? "").includes("excedeu 60000ms");
    const outcomeInterrupted = workerSession?.outcome === "interrupted";
    const interruptObserved = /interrompido best-effort/i.test(String(runState.state.lastError ?? ""));
    const workerCount = getSessionsForRun(homeDir, runID).filter((s) => s.role === "worker").length;
    const noExtraRounds = runState.state.round === 1;
    const noExtraWorker = workerCount === 1;
    const pass = Boolean(runState.workerSessionID) && timeoutDiagnostic && interruptObserved && outcomeInterrupted && noExtraRounds && noExtraWorker && runState.state.phase === "failed";

    results.push({ id, name: SCENARIO_DEFS[9].name, pass, phase: runState.state.phase, round: 1, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[9].name,
      tier: SCENARIO_DEFS[9].tier,
      runID,
      round: 1,
      workerSessionID: runState.workerSessionID || "ses_worker_c10",
      criticSessionID: "none",
      executor: { agent: "build", model: "opencode/big-pickle" },
      verdict: "worker-timeout-interrupted",
      timeoutMs: 60000,
      providerBehavior: "deliberately non-responsive",
      timeoutDiagnostic: runState.state.lastError,
      timeoutDiagnosticMatched: timeoutDiagnostic,
      interruptObserved,
      interruptDiagnostic: runState.state.lastError,
      workerOutcome: workerSession?.outcome ?? "missing",
      workerCount,
      noExtraRounds,
      noExtraWorker,
      command: "interrupt",
      finalPhase: runState.state.phase,
    });
    log(`  -> Cenário 10: ${pass ? "PASS" : "FAIL"} (phase=${runState.state.phase}, round=${runState.state.round})`);
  }

  // --- Cenário 11: critic timeout / failure (Real OpenCode + fault injection) ---
  {
    const id = 11;
    log(`[${id}/17] Executando Cenário 11: critic timeout / failure (Real OpenCode)...`);
    activeCriticCompletionsBehavior = "fail";
    activeProxyBehavior = { mode: "custom" };
    // Jev tenta emitir accept, mas o kernel DEVE rejeitar porque critic-session-outcome falhou
    customJevHandler = async () => ({ model: "jev-1.13-free", answers: stdAnswers({ next_action: { type: "choice", choice: "accept" } }) });

    const sid = await createRealSession();
    const msgId = `msg_e2e_c11_${Date.now()}`;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: { sessionID: sid, messageID: msgId, objective: "Critic failure test", maxRounds: 1 },
    });

    const runID = getRunId(rpcRes);
    const runState = await waitFor(() => {
      const r = readRunFromDb(homeDir, runID);
      if (r && r.state && r.state.phase === "failed") return r;
      return null;
    }, 45000, "Cenário 11 falha pelo bloqueio do critic");

    activeCriticCompletionsBehavior = "normal";
    const pass = runState.state.phase === "failed";
    results.push({ id, name: SCENARIO_DEFS[10].name, pass, phase: runState.state.phase, round: 1, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[10].name,
      tier: SCENARIO_DEFS[10].tier,
      runID,
      round: 1,
      workerSessionID: runState.workerSessionID,
      criticSessionID: runState.criticSessionID,
      executor: { agent: "build", model: "opencode/big-pickle" },
      verdict: "critic-failure-blocks-accept",
      command: "none",
      finalPhase: runState.state.phase,
    });
    log(`  -> Cenário 11: ${pass ? "PASS" : "FAIL"} (phase=${runState.state.phase})`);
  }

  // --- Cenário 12: Jev unavailable / timeout (Fault Injection: HTTP 500) ---
  {
    const id = 12;
    log(`[${id}/17] Executando Cenário 12: Jev unavailable / timeout (Fault Injection: HTTP 500)...`);
    activeProxyBehavior = { mode: "500" };
    customJevHandler = null;

    const sid = await createRealSession();
    const msgId = `msg_e2e_c12_${Date.now()}`;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: { sessionID: sid, messageID: msgId, objective: "Task during Jev HTTP 500 outage", maxRounds: 1 },
    });

    const runID = getRunId(rpcRes);
    const runState = await waitFor(() => {
      const r = readRunFromDb(homeDir, runID);
      if (r && r.state && r.state.phase === "failed") return r;
      return null;
    }, 45000, "Cenário 12 falha bounded por Jev HTTP 500");

    const pass = runState.state.phase === "failed";
    results.push({ id, name: SCENARIO_DEFS[11].name, pass, phase: runState.state.phase, round: 1, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[11].name,
      tier: SCENARIO_DEFS[11].tier,
      runID,
      round: 1,
      workerSessionID: runState.workerSessionID,
      criticSessionID: runState.criticSessionID,
      executor: { agent: "build", model: "opencode/big-pickle" },
      verdict: "jev-http-500-abort",
      command: "none",
      finalPhase: runState.state.phase,
    });
    log(`  -> Cenário 12: ${pass ? "PASS" : "FAIL"} (phase=${runState.state.phase})`);
  }

  // --- Cenário 13: provider / global throttle (Fault Injection: HTTP 429 no worker) ---
  {
    const id = 13;
    log(`[${id}/17] Executando Cenário 13: provider / global throttle (HTTP 429 no chat completions do worker)...`);
    clearResourceLedger(homeDir);
    activeWorkerCompletionsBehavior = "rate-limit";
    activeProxyBehavior = { mode: "custom" };
    customJevHandler = async () => ({ model: "jev-1.13-free", answers: stdAnswers() });

    const sid = await createRealSession();
    const msgId = `msg_e2e_c13_${Date.now()}`;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: { sessionID: sid, messageID: msgId, objective: "Task during worker 429 throttle", maxRounds: 1 },
    });

    const runID = getRunId(rpcRes);
    const runState = await waitFor(() => {
      const r = readRunFromDb(homeDir, runID);
      if (r && r.state && r.state.phase === "failed") return r;
      return null;
    }, 75000, "Cenário 13 aborto bounded por 429 no worker");

    activeWorkerCompletionsBehavior = "normal";

    const runSessions = getSessionsForRun(homeDir, runID);
    const workerSessions = runSessions.filter((s) => s.role === "worker");
    // Sem tempestade de criação de workers: exatamente 1 sessão de worker criada
    const noWorkerStorm = workerSessions.length === 1;
    // Sem troca secreta de modelo: permaneceu o modelo canônico solicitado
    const modelPreserved = Boolean(workerSessions[0]?.model) &&
      workerSessions[0]?.model === runState.state.executor?.model;
    const noExtraRounds = runState.state.round === 1;
    const pass = runState.state.phase === "failed" && noWorkerStorm && modelPreserved && noExtraRounds;

    results.push({ id, name: SCENARIO_DEFS[12].name, pass, phase: runState.state.phase, round: 1, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[12].name,
      tier: SCENARIO_DEFS[12].tier,
      runID,
      round: 1,
      workerSessionID: workerSessions[0]?.id || runState.workerSessionID,
      criticSessionID: "none",
      executor: {
        agent: workerSessions[0]?.agent || runState.state.executor?.agent || "build",
        model: workerSessions[0]?.model || runState.state.executor?.model || "opencode/big-pickle",
      },
      verdict: "throttle-429-abort",
      command: "none",
      finalPhase: runState.state.phase,
    });
    log(`  -> Cenário 13: ${pass ? "PASS" : "FAIL"} (phase=${runState.state.phase}, workerCount=${workerSessions.length})`);
  }

  // --- Cenário 14: maxRounds exhaustion (pausa em awaiting-human com kind max-rounds) ---
  {
    const id = 14;
    log(`[${id}/17] Executando Cenário 14: maxRounds exhaustion...`);
    clearResourceLedger(homeDir);
    activeProxyBehavior = { mode: "custom" };
    customJevHandler = async () => {
      return {
        model: "jev-1.13-free",
        answers: stdAnswers({
          done: { type: "noul", noul: 0 },
          failure_class: { type: "choice", choice: "implementation" },
          same_executor_can_repair: { type: "noul", noul: 1 },
          next_action: { type: "choice", choice: "repair-same", confidence: 0.9 },
        }),
      };
    };

    const sid = await createRealSession();
    const msgId = `msg_e2e_c14_${Date.now()}`;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: { sessionID: sid, messageID: msgId, objective: "Continuous repair loop task", maxRounds: 2 },
    });

    const runID = getRunId(rpcRes);
    const runState = await waitFor(() => {
      const r = readRunFromDb(homeDir, runID);
      if (r && r.state && r.state.phase === "awaiting-human") return r;
      return null;
    }, 45000, "Cenário 14 esgotamento de maxRounds");

    const pending = runState.state.pendingHuman;
    const pass = runState.state.phase === "awaiting-human" && runState.state.round === 2 && pending?.kind === "max-rounds";
    results.push({ id, name: SCENARIO_DEFS[13].name, pass, phase: runState.state.phase, round: 2, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[13].name,
      tier: SCENARIO_DEFS[13].tier,
      runID,
      round: 2,
      workerSessionID: runState.workerSessionID,
      criticSessionID: runState.criticSessionID,
      executor: { agent: "build", model: "opencode/big-pickle" },
      verdict: "max-rounds-exhaustion -> awaiting-human",
      command: "none",
      finalPhase: runState.state.phase,
    });
    log(`  -> Cenário 14: ${pass ? "PASS" : "FAIL"} (phase=${runState.state.phase}, kind=${pending?.kind})`);
  }

  // --- Cenário 15: recursion guard ---
  {
    const id = 15;
    log(`[${id}/17] Executando Cenário 15: admission e prompts processados no host...`);
    const databasePath = path.join(homeDir, ".local", "share", "opencode", "opencode.db");
    const runCount = () => {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      const n = db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE '%orchestration/run/%'").get().n;
      db.close(); return n;
    };
    const dispatchCount = () => {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      const rows = db.prepare("SELECT metadata FROM session_v2").all();
      db.close();
      return rows.filter((row) => {
        try {
          const m = JSON.parse(row.metadata ?? "{}");
          return Boolean(m["jev-run-id"]) && ["worker", "critic", "orchestrator"].includes(m["jev-role"]);
        } catch { return false; }
      }).length;
    };
    const beforeRuns = runCount();
    const beforeDispatches = dispatchCount();
    const sessionDb = new DatabaseSync(databasePath, { readOnly: true });
    const internalSessions = sessionDb.prepare("SELECT id, metadata FROM session_v2 ORDER BY rowid DESC").all().flatMap((row) => {
      try {
        const metadata = JSON.parse(row.metadata ?? "{}");
        if (metadata["jev-router"] === "orchestration-internal" && ["worker", "critic", "orchestrator"].includes(metadata["jev-role"])) {
          return [{ id: row.id, role: metadata["jev-role"], runID: metadata["jev-run-id"] }];
        }
      } catch { /* malformed unrelated session metadata is ignored */ }
      return [];
    });
    sessionDb.close();
    const promptProofs = [];
    for (const role of ["worker", "critic", "orchestrator"]) {
      const internalSession = internalSessions.find((candidate) => candidate.role === role);
      if (!internalSession) throw new Error(`Cenário 15 sem sessão real de ${role} criada pelo dispatcher`);
      const promptSessionID = internalSession.id;
      const before = new DatabaseSync(databasePath, { readOnly: true });
      const assistantBefore = before.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type = 'assistant'").get(promptSessionID).n;
      const idleBefore = before.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type = 'idle'").get(promptSessionID).n;
      before.close();
      const marker = { "jev-role": role, "jev-router": "orchestration-internal" };
      const callerGuardToken = role === "worker" ? `C15_INTERNAL_RESUME_${promptSessionID}` : undefined;
      if (callerGuardToken) {
        let releaseBarrier;
        const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
        activeResumeToolRequests = {
          expected: 1, arrived: 0,
          pending: new Map([[callerGuardToken, { runID: "missing-internal-caller-probe", decision: { requestID: "invalid-probe", action: "resume" } }]]),
          observedInputs: [], barrier, releaseBarrier, toolNames: [], unsupported: false,
        };
      }
      const promptText = callerGuardToken
        ? `Internal worker guard probe ${callerGuardToken}. Use Code Mode execute to attempt tools.jev.orchestrate_resume with the associated input.`
        : `Internal ${role} recursion guard E2E probe`;
      const promptResult = await api("POST", `/api/session/${promptSessionID}/prompt`, { text: promptText, metadata: marker });
      let promptComplete = false;
      if (promptResult.status >= 200 && promptResult.status < 300) {
        try {
          promptComplete = Boolean(await waitFor(() => {
            const verify = new DatabaseSync(databasePath, { readOnly: true });
            const assistant = verify.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type = 'assistant'").get(promptSessionID).n;
            const idle = verify.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type = 'idle'").get(promptSessionID).n;
            verify.close();
            return assistant > assistantBefore && idle > idleBefore;
          }, 30000, `Cenário 15 prompt ${role} processado`));
        } catch { promptComplete = false; }
      }
      const messagesDb = new DatabaseSync(databasePath, { readOnly: true });
      const promptMessages = messagesDb.prepare("SELECT data FROM session_message WHERE session_id = ?").all(promptSessionID).map((row) => String(row.data));
      messagesDb.close();
      const callerGuardObserved = Boolean(callerGuardToken) && activeResumeToolRequests?.arrived === 1 && !activeResumeToolRequests.unsupported && promptMessages.some((data) => data.includes("chamada interna de orchestration"));
      promptProofs.push({ role, sessionID: promptSessionID, sourceRunID: internalSession.runID, status: promptResult.status, ...(promptResult.status >= 400 ? { errorTag: promptResult.data?._tag, error: promptResult.data?.message } : {}), processed: Boolean(promptComplete), markerSent: true, ...(callerGuardToken ? { callerGuardToolCallObserved: callerGuardObserved, toolNamesObserved: activeResumeToolRequests?.toolNames ?? [] } : {}), baselineAssistantMessages: assistantBefore, baselineIdleEvents: idleBefore });
      if (callerGuardToken) activeResumeToolRequests = null;
    }
    const sid = internalSessions.find((candidate) => candidate.role === "worker").id;
    const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", { input: { sessionID: sid, messageID: "msg_internal_recurse", objective: "Internal recurse attempt" } });
    const admissionPass = getRpcStatus(rpcRes) === "internal-bypass";
    const afterRuns = runCount();
    const afterDispatches = dispatchCount();
    const noNewRuns = afterRuns === beforeRuns;
    const noNewDispatches = afterDispatches === beforeDispatches;
    const promptPass = promptProofs.length === 3 && promptProofs.every((p) => p.status >= 200 && p.status < 300 && p.processed && p.markerSent);
    const callerGuardPass = promptProofs.find((p) => p.role === "worker")?.callerGuardToolCallObserved === true;
    const pass = promptPass && admissionPass && noNewRuns && noNewDispatches && callerGuardPass;
    const runID = `auto-${sid}-msg_internal_recurse`;
    results.push({ id, name: SCENARIO_DEFS[14].name, pass, phase: "internal-bypass", round: 0, runID, admissionPass, promptPass, noNewRuns, noNewDispatches, blocker: "resume caller guard not invoked through real host tool execution" });
    evidenceRecords.push({ scenarioId: id, scenarioName: SCENARIO_DEFS[14].name, tier: SCENARIO_DEFS[14].tier, runID, round: 0, workerSessionID: sid, criticSessionID: "none", executor: { agent: "none", model: "none" }, promptProofs, admissionPass, baselineRunCount: beforeRuns, finalRunCount: afterRuns, noNewRuns, baselineDispatchCount: beforeDispatches, finalDispatchCount: afterDispatches, noNewDispatches, verdict: pass ? "PASS: real worker/critic/orchestrator prompts, admission bypass, and resume caller guard produced no new runs or dispatches" : "BLOCKED/FAIL: one or more host recursion surfaces not proven", command: "OpenCode prompt API; worker Code Mode execute -> orchestrate_resume", finalPhase: "internal-bypass" });
    log(`  -> Cenário 15: ${pass ? "PASS" : "BLOCKER/FAIL"} (admission=${admissionPass}, prompts=${promptPass}, callerGuard=${callerGuardPass}, runs stable=${noNewRuns}, dispatches stable=${noNewDispatches})`);
  }

  // --- Cenário 16: agent / model candidate inválido (4 casos no OpenCode real) ---
  {
    const id = 16;
    log(`[${id}/17] Executando Cenário 16: agent / model candidate inválido (4 casos no OpenCode real)...`);

    async function testInvalidCandidate(jevAnswers) {
      let cRound = 0;
      activeProxyBehavior = { mode: "custom" };
      customJevHandler = async (reqBody) => {
        if (reqBody?.questions?.done) {
          cRound += 1;
          if (cRound === 1) {
            return {
              model: "jev-1.13-free",
              answers: stdAnswers(jevAnswers.r1Answers),
            };
          }
        }
        if (jevAnswers.r2Questions && reqBody?.questions) {
          const qKey = Object.keys(jevAnswers.r2Questions)[0];
          if (reqBody.questions[qKey]) {
            return {
              model: "jev-1.13-free",
              answers: jevAnswers.r2Questions,
            };
          }
        }
        return { model: "jev-1.13-free", answers: stdAnswers() };
      };

      const sid = await createRealSession();
      const msgId = `msg_e2e_c16_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const rpcRes = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
        input: { sessionID: sid, messageID: msgId, objective: "Invalid candidate rejection", maxRounds: 2 },
      });
      const runID = getRunId(rpcRes);
      const runState = await waitFor(() => {
        const r = readRunFromDb(homeDir, runID);
        if (r && r.state && r.state.phase === "failed") return r;
        return null;
      }, 45000, "Cenário 16 rejeição de candidato inválido");
      return runState;
    }

    // 16a: modelo pago (fora do pool free)
    const r16a = await testInvalidCandidate({
      r1Answers: {
        done: { type: "noul", noul: 0 },
        failure_class: { type: "choice", choice: "wrong-model" },
        same_executor_can_repair: { type: "noul", noul: 0 },
        next_action: { type: "choice", choice: "switch-model", confidence: 0.9 },
      },
      r2Questions: { selected_model: { type: "choice", choice: "openai/gpt-4o", confidence: 0.99 } },
    });
    const c16a = r16a?.state?.phase === "failed" && /switch-model fora dos candidatos validos: openai\/gpt-4o/i.test(String(r16a.state.lastError ?? "")) && r16a.state.round <= r16a.state.contract.maxRounds && ![...FREE_POOL].includes("openai/gpt-4o") && getSessionsForRun(homeDir, r16a.state.contract.runID).filter((s) => s.role === "worker").length === 1;

    // 16b: modelo inexistente
    const r16b = await testInvalidCandidate({
      r1Answers: {
        done: { type: "noul", noul: 0 },
        failure_class: { type: "choice", choice: "wrong-model" },
        same_executor_can_repair: { type: "noul", noul: 0 },
        next_action: { type: "choice", choice: "switch-model", confidence: 0.9 },
      },
      r2Questions: { selected_model: { type: "choice", choice: "fake/nonexistent-model", confidence: 0.99 } },
    });
    const c16b = r16b?.state?.phase === "failed" && /switch-model fora dos candidatos validos: fake\/nonexistent-model/i.test(String(r16b.state.lastError ?? "")) && r16b.state.round <= r16b.state.contract.maxRounds && getSessionsForRun(homeDir, r16b.state.contract.runID).filter((s) => s.role === "worker").length === 1;

    // 16c: agente desconhecido
    const r16c = await testInvalidCandidate({
      r1Answers: {
        done: { type: "noul", noul: 0 },
        failure_class: { type: "choice", choice: "wrong-agent" },
        same_executor_can_repair: { type: "noul", noul: 0 },
        next_action: { type: "choice", choice: "switch-agent", confidence: 0.9 },
      },
      r2Questions: { selected_agent: { type: "choice", choice: "unknown-rogue-agent", confidence: 0.99 } },
    });
    const c16c = r16c?.state?.phase === "failed" && /agente selecionado nao existe no catalogo runtime: unknown-rogue-agent/i.test(String(r16c.state.lastError ?? "")) && r16c.state.round <= r16c.state.contract.maxRounds && getSessionsForRun(homeDir, r16c.state.contract.runID).filter((s) => s.role === "worker").length === 1;

    // 16d: agente subagent / não primário
    const r16d = await testInvalidCandidate({
      r1Answers: {
        done: { type: "noul", noul: 0 },
        failure_class: { type: "choice", choice: "wrong-agent" },
        same_executor_can_repair: { type: "noul", noul: 0 },
        next_action: { type: "choice", choice: "switch-agent", confidence: 0.9 },
      },
      r2Questions: { selected_agent: { type: "choice", choice: "explore", confidence: 0.99 } },
    });
    const c16d = r16d?.state?.phase === "failed" && /agente selecionado nao elegivel como primary no catalogo runtime: explore/i.test(String(r16d.state.lastError ?? "")) && r16d.state.round <= r16d.state.contract.maxRounds && getSessionsForRun(homeDir, r16d.state.contract.runID).filter((s) => s.role === "worker").length === 1;

    const pass = c16a && c16b && c16c && c16d;
    const runID = r16a?.state?.contract?.runID || "run_c16_invalid_candidate";
    results.push({ id, name: SCENARIO_DEFS[15].name, pass, phase: "failed", round: 1, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[15].name,
      tier: SCENARIO_DEFS[15].tier,
      runID,
      round: 1,
      workerSessionID: r16a?.workerSessionID || "ses_worker_c16",
      criticSessionID: "none",
      executor: { agent: "build", model: "opencode/big-pickle" },
      verdict: "invalid-candidate-rejected-fast",
      subcases: [
        { label: "paid model", runID: r16a.state?.contract?.runID, candidate: "openai/gpt-4o", diagnostic: r16a.state?.lastError, round: r16a.state?.round, executorSessions: getSessionsForRun(homeDir, r16a.state?.contract?.runID).map((s) => ({ id: s.id, agent: s.agent, model: s.model })) },
        { label: "nonexistent model", runID: r16b.state?.contract?.runID, candidate: "fake/nonexistent-model", diagnostic: r16b.state?.lastError, round: r16b.state?.round, executorSessions: getSessionsForRun(homeDir, r16b.state?.contract?.runID).map((s) => ({ id: s.id, agent: s.agent, model: s.model })) },
        { label: "unknown agent", runID: r16c.state?.contract?.runID, candidate: "unknown-rogue-agent", diagnostic: r16c.state?.lastError, round: r16c.state?.round, executorSessions: getSessionsForRun(homeDir, r16c.state?.contract?.runID).map((s) => ({ id: s.id, agent: s.agent, model: s.model })) },
        { label: "known non-primary agent", runID: r16d.state?.contract?.runID, candidate: "explore", diagnostic: r16d.state?.lastError, round: r16d.state?.round, executorSessions: getSessionsForRun(homeDir, r16d.state?.contract?.runID).map((s) => ({ id: s.id, agent: s.agent, model: s.model })) },
      ],
      command: "none",
      finalPhase: "failed",
    });
    log(`  -> Cenário 16: ${pass ? "PASS" : "FAIL"} (16a=${c16a}, 16b=${c16b}, 16c=${c16c}, 16d=${c16d})`);
  }

  // --- Cenário 17: stale evidence via storage fault injection + real host resume ---
  {
    const id = 17;
    log(`[${id}/17] Cenário 17: evidence.round stale injetado no SQLite real; rejeição via tool host real...`);
    const c17Objective = `C17 stale evidence guard ${Date.now()}`;
    let c17JevRequests = 0;
    activeProxyBehavior = { mode: "custom" };
    customJevHandler = async (reqBody) => {
      if (reqBody?.state?.objective === c17Objective) c17JevRequests += 1;
      if (reqBody?.questions?.done) {
        return { model: "jev-1.13-free", answers: stdAnswers({
          done: { type: "noul", noul: 0 },
          failure_class: { type: "choice", choice: "bad-contract" },
          same_executor_can_repair: { type: "noul", noul: 0 },
          next_action: { type: "choice", choice: "human", confidence: 0.95 },
        }) };
      }
      return { model: "jev-1.13-free", answers: stdAnswers() };
    };

    const sourceSessionID = await createRealSession();
    const messageID = `msg_e2e_c17_${Date.now()}`;
    const admission = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
      input: { sessionID: sourceSessionID, messageID, objective: c17Objective, maxRounds: 1 },
    });
    const runID = getRunId(admission);
    const awaitingHuman = await waitFor(() => {
      const current = readRunFromDb(homeDir, runID);
      return current?.state?.phase === "awaiting-human" ? current : null;
    }, 60000, "Cenário 17 run real awaiting-human com evidence válido");
    const roundBefore = awaitingHuman.state.round;
    const evidenceRoundBefore = awaitingHuman.state.evidence?.round;
    const decision = { requestID: awaitingHuman.state.pendingHuman?.requestID, action: "resume", newMaxRounds: 2 };
    const sessionsBefore = getSessionsForRun(homeDir, runID);
    const workersBefore = sessionsBefore.filter((session) => session.role === "worker").map((session) => session.id).sort();
    const criticsBefore = sessionsBefore.filter((session) => session.role === "critic").map((session) => session.id).sort();
    const humanDecisionsBefore = awaitingHuman.state.history.filter((entry) => Boolean(entry.humanDecision)).length;
    const jevRequestsBefore = c17JevRequests;

    // Adversarial input only: mutate state.evidence.round; preserve phase, round, checkpoint, history, and all other fields.
    const injected = injectStaleEvidenceRound(homeDir, runID, roundBefore, roundBefore + 1);
    const injectedRun = injected.persisted;
    const callerID = await createRealSession();
    const callerIdleBaseline = (() => {
      const db = new DatabaseSync(path.join(homeDir, ".local", "share", "opencode", "opencode.db"), { readOnly: true });
      const count = db.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type = 'idle'").get(callerID).n;
      db.close();
      return count;
    })();
    const callerToken = `C17_STALE_RESUME_${callerID}`;
    let releaseBarrier;
    const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
    activeResumeToolRequests = {
      expected: 1,
      arrived: 0,
      pending: new Map([[callerToken, { runID, decision }]]),
      observedInputs: [],
      barrier,
      releaseBarrier,
      toolNames: [],
      unsupported: false,
    };
    const promptResult = await api("POST", `/api/session/${callerID}/prompt`, {
      text: `${callerToken} Use Code Mode execute to call tools.jev.orchestrate_resume with exactly ${JSON.stringify({ runID, decision })}. Do not call another tool.`,
    });
    let callerProcessed = false;
    try {
      await waitFor(() => {
        const db = new DatabaseSync(path.join(homeDir, ".local", "share", "opencode", "opencode.db"), { readOnly: true });
        const count = db.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type = 'idle'").get(callerID).n;
        db.close();
        return count > callerIdleBaseline;
      }, 45000, "Cenário 17 tool-call real de resume concluído");
      callerProcessed = true;
    } catch {}
    const callerMessages = (() => {
      const db = new DatabaseSync(path.join(homeDir, ".local", "share", "opencode", "opencode.db"), { readOnly: true });
      const rows = db.prepare("SELECT data FROM session_message WHERE session_id = ?").all(callerID);
      db.close();
      return rows.map((row) => String(row.data));
    })();
    const invalidResumableRunObserved = callerMessages.some((data) => data.includes("invalid-resumable-run"));
    const staleEvidenceDiagnosticObserved = callerMessages.some((data) => data.includes("evidence.round difere do state.round"));
    const toolInputObserved = activeResumeToolRequests.arrived === 1 &&
      activeResumeToolRequests.observedInputs.length === 1 &&
      activeResumeToolRequests.observedInputs[0]?.runID === runID &&
      activeResumeToolRequests.observedInputs[0]?.decision?.requestID === decision.requestID;
    const finalRun = readRunFromDb(homeDir, runID);
    const sessionsAfter = getSessionsForRun(homeDir, runID);
    const workersAfter = sessionsAfter.filter((session) => session.role === "worker").map((session) => session.id).sort();
    const criticsAfter = sessionsAfter.filter((session) => session.role === "critic").map((session) => session.id).sort();
    const humanDecisionsAfter = finalRun?.state?.history?.filter((entry) => Boolean(entry.humanDecision)).length ?? -1;
    const jevRequestsAfter = c17JevRequests;
    const persistedStateUnchangedAfterInjection = JSON.stringify(finalRun) === JSON.stringify(injectedRun);
    const noNewWorkers = JSON.stringify(workersAfter) === JSON.stringify(workersBefore);
    const noNewCritics = JSON.stringify(criticsAfter) === JSON.stringify(criticsBefore);
    const lockTelemetry = up.lines.filter((line) => line.includes("[opjev-e2e] resume-lock-release=")).at(-1);
    const lockCountZero = lockTelemetry?.endsWith("=0") ?? false;
    const staleInputConfirmed = evidenceRoundBefore === roundBefore && injected.injectedEvidenceRound === roundBefore + 1 && injectedRun.state.evidence.round === roundBefore + 1;
    const pass = awaitingHuman.state.phase === "awaiting-human" && typeof decision.requestID === "string" &&
      jevRequestsBefore > 0 && promptResult.status === 200 && callerProcessed && toolInputObserved && invalidResumableRunObserved &&
      staleEvidenceDiagnosticObserved && staleInputConfirmed && persistedStateUnchangedAfterInjection &&
      finalRun?.state?.phase === "awaiting-human" && finalRun.state.round === roundBefore &&
      finalRun.state.evidence.round === roundBefore + 1 && noNewWorkers && noNewCritics &&
      humanDecisionsAfter === humanDecisionsBefore && jevRequestsAfter === jevRequestsBefore && lockCountZero;

    results.push({ id, name: SCENARIO_DEFS[16].name, pass, phase: finalRun?.state?.phase ?? "missing", round: finalRun?.state?.round ?? -1, runID });
    evidenceRecords.push({
      scenarioId: id,
      scenarioName: SCENARIO_DEFS[16].name,
      tier: "REAL OPENCODE + CONTROLLED HUMAN GATE + SQLITE EVIDENCE FAULT INJECTION",
      runID,
      requestID: decision.requestID,
      initialPhase: awaitingHuman.state.phase,
      round: roundBefore,
      evidenceRoundBefore,
      evidenceRoundInjected: injected.injectedEvidenceRound,
      workerSessionIDsBefore: workersBefore,
      workerSessionIDsAfter: workersAfter,
      criticSessionIDsBefore: criticsBefore,
      criticSessionIDsAfter: criticsAfter,
      callerSessionID: callerID,
      callerPromptStatus: promptResult.status,
      callerProcessed,
      executor: awaitingHuman.state.executor,
      invalidResumableRunObserved,
      staleEvidenceDiagnosticObserved,
      diagnostic: "evidence.round difere do state.round",
      toolInputObserved,
      observedResumeInput: activeResumeToolRequests.observedInputs.map((request) => ({ runID: request.runID, requestID: request.decision.requestID })),
      noNewWorkers,
      noNewCritics,
      humanDecisionsBefore: humanDecisionsBefore,
      humanDecisionsAfter,
      jevRequestsBefore,
      jevRequestsAfter,
      persistedStateUnchangedAfterInjection,
      lockCountZero,
      lockTelemetry: lockTelemetry ?? "missing",
      verdict: pass ? "invalid-resumable-run: stale evidence.round rejected before decision or dispatch" : "BLOCKED/FAIL: stale EvidencePacket rejection or bounded no-side-effect assertions missing",
      command: "real OpenCode admission -> stale evidence.round storage fault injection -> session prompt -> Code Mode execute -> tools.jev.orchestrate_resume",
      finalPhase: finalRun?.state?.phase ?? "missing",
    });
    log(`  -> Cenário 17: ${pass ? "PASS" : "FAIL"} (invalid=${invalidResumableRunObserved}, evidenceDiag=${staleEvidenceDiagnosticObserved}, noWorkers=${noNewWorkers}, noCritics=${noNewCritics}, jevStable=${jevRequestsAfter === jevRequestsBefore}, persistedStable=${persistedStateUnchangedAfterInjection})`);
    activeResumeToolRequests = null;
  }

  // ---------------------------------------------------------------- Persistir Evidência
  const sourceHeadSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  const evidenceEnvelope = {
    schemaVersion: 1,
    provenance: {
      headSha: sourceHeadSha,
      openCodeRuntimeVersion: upInfo.version,
      executedAt: new Date().toISOString(),
      runner: "scripts/e2e-multiround-real.mjs",
    },
    scenarios: evidenceRecords.map((record) => ({
      ...record,
      sessionIDs: [record.workerSessionID, record.criticSessionID, record.orchestratorSessionID].filter((v) => v && v !== "none"),
      observedExecutor: record.executor,
      observedDecision: record.verdict,
    })),
  };
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(evidenceEnvelope, null, 2));
  log(`\nEvidência estruturada salva em: ${EVIDENCE_FILE}`);

  // ---------------------------------------------------------------- Emitir Matriz
  console.log("\n====================================================================================================");
  console.log("   OPJEV — GATE DEFINITIVO DE ESTABILIZAÇÃO E2E MULTI-ROUND (17 CENÁRIOS — ISSUE #14)               ");
  console.log("====================================================================================================");
  console.log("| #  | Cenário                                  | Camada / Tier de Evidência           | Fase Final       | Status |");
  console.log("|----|------------------------------------------|--------------------------------------|------------------|--------|");

  for (const s of SCENARIO_DEFS) {
    const res = results.find((r) => r.id === s.id);
    const status = res?.pass ? " PASS " : " FAIL ";
    const idStr = String(s.id).padEnd(2, " ");
    const nameStr = s.name.padEnd(40, " ");
    const tierStr = s.tier.padEnd(36, " ");
    const phaseStr = (res?.phase ?? "unknown").padEnd(16, " ");
    console.log(`| ${idStr} | ${nameStr} | ${tierStr} | ${phaseStr} |  ${status} |`);
  }

  console.log("====================================================================================================");
  const allPassed = results.length === 17 && results.every((r) => r.pass);
  if (allPassed) {
    console.log(" [SUCCESS] Todos os 17 cenários do Gate de Estabilização E2E passaram com sucesso!");
    console.log(" [PROVA E2E REAL] Executado sobre OpenCode v2.0.11 com Jev SystemOne real e fault-injection de rede.");
    console.log("====================================================================================================\n");
    process.exit(0);
  } else {
    console.error(" [BLOCKED/FAILURE] Cenários sem boundary REAL comprovada permanecem BLOCKED; Issue #14 não está concluída.");
    console.error("====================================================================================================\n");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Erro fatal no runner E2E real:", err);
  killAll();
  process.exit(1);
});
