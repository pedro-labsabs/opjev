#!/usr/bin/env node
// Exact OpenCode 2.0.11 deterministic-SHADOW runtime proof for Issue #4 Boundary B.
// The provider and tool responses are local and controlled; the installed OPJEV
// plugin, hooks, session history, and SQLite kv store are the real host runtime.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { installServerPluginToProject, installPluginToHome } from "./install-plugin.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.OPENCODE_BIN ?? "/tmp/opencode-2.0.11/package/bin/opencode";
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "opjev-context-shadow-"));
const HOME = path.join(RUN_DIR, "home");
const PROJECT = path.join(RUN_DIR, "project");
const CANARIES = {
  human: `CTX_HUMAN_${cryptoRandom()}`,
  input: `CTX_INPUT_${cryptoRandom()}`,
  result: `CTX_RESULT_${cryptoRandom()}`,
  error: `CTX_ERROR_${cryptoRandom()}`,
  assistant: `CTX_ASSISTANT_${cryptoRandom()}`,
};
const children = [];
let providerServer;

function cryptoRandom() { return Math.random().toString(36).slice(2, 12); }
function log(value) { process.stdout.write(`[e2e-context] ${value}\n`); }
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}${last ? `: ${last.message}` : ""}`);
}
function spawnHost(args, env) {
  const child = spawn(BIN, args, { cwd: PROJECT, env, stdio: ["ignore", "pipe", "pipe"] });
  const record = { child, output: "" };
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { record.output += chunk.toString("utf8"); });
  children.push(record);
  return record;
}
function stop() {
  for (const { child } of children) { try { child.kill("SIGTERM"); } catch {} }
  try { providerServer?.close(); } catch {}
}
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });
function dbRead(home, fn) {
  const db = new DatabaseSync(path.join(home, ".local/share/opencode/opencode.db"), { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
function pluginStorageKey(key) {
  const namespace = [..."jev-free-router"].map(character => character.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  return `plugin:${namespace}:${key}`;
}
function kvValue(db, suffix) {
  const row = db.prepare("SELECT key, value FROM kv WHERE key = ? OR substr(key, -length(?)) = ?").get(suffix, `:${suffix}`, `:${suffix}`);
  if (!row) return undefined;
  return { key: row.key, value: typeof row.value === "string" ? JSON.parse(row.value) : row.value };
}

function shapeOfRuntimeRows(rows) {
  const shapes = new Map();
  for (const row of rows) {
    let message;
    try { message = JSON.parse(row.data); } catch { message = {}; }
    const content = Array.isArray(message.content) ? message.content : [];
    const signature = JSON.stringify({
      type: row.type,
      topLevelKeys: Object.keys(message).sort(),
      contentParts: content.map(part => ({
        type: part?.type ?? "unknown",
        fields: Object.keys(part ?? {}).sort(),
        stateStatus: part?.state?.status ?? null,
      })),
    });
    if (!shapes.has(signature)) shapes.set(signature, JSON.parse(signature));
  }
  return [...shapes.values()];
}
function openaiShape(body) {
  return (Array.isArray(body?.messages) ? body.messages : []).map(message => ({
    role: message?.role ?? "unknown",
    contentType: typeof message?.content,
    toolCallCount: Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0,
    toolCallNames: (message?.tool_calls ?? []).map(call => call?.function?.name ?? "unknown"),
    toolCallIdsPresent: (message?.tool_calls ?? []).every(call => typeof call?.id === "string"),
    toolCallResults: message?.role === "tool",
    toolCallIdPresent: message?.role === "tool" && typeof message?.tool_call_id === "string",
  }));
}

try {
  assert.equal(fs.existsSync(BIN), true, `OpenCode binary does not exist: ${BIN}`);
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  const versionRun = spawnHost(["--version"], {
    ...process.env, HOME, OPENCODE_DATA_DIR: path.join(HOME, ".local/share/opencode"),
  });
  const version = await new Promise((resolve, reject) => {
    let output = "";
    versionRun.child.stdout.on("data", chunk => { output += chunk.toString("utf8"); });
    versionRun.child.once("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(`version command exited ${code}`)));
  });
  assert.match(version, /(?:^|\s)v?2\.0\.11(?:\s|$)/, `expected OpenCode 2.0.11, got ${version}`);
  log(`version gate: ${version}`);

  installServerPluginToProject(PROJECT, REPO);
  installPluginToHome(HOME, REPO);
  const providerPort = await freePort();
  const providerRequests = [];
  let jevRequests = 0;
  let toolCallSequence = 0;
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      if (req.url?.includes("/jev")) {
        jevRequests++;
        const questions = body.questions ?? {};
        const answers = {};
        if (questions.route) answers.route = { type: "choice", choice: "fast-coding", confidence: 0.95 };
        if (questions.agent) answers.agent = { type: "choice", choice: "build" };
        if (questions.model) answers.model = { type: "choice", choice: "opencode/big-pickle" };
        if (questions.is_risky) answers.is_risky = { type: "noul", noul: 0 };
        if (questions.complexity) answers.complexity = { type: "score", score: 0 };
        if (questions.done && questions.next_action) {
          answers.done = { type: "noul", noul: 1 };
          answers.failure_class = { type: "choice", choice: "none" };
          answers.same_executor_can_repair = { type: "noul", noul: 0 };
          answers.next_action = { type: "choice", choice: "accept" };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "jev-1.13-free", answers }));
        return;
      }
      const serialized = JSON.stringify(body.messages ?? []);
      providerRequests.push({ url: req.url, shape: openaiShape(body), messages: body.messages ?? [] });
      let message;
      let finishReason = "stop";
      if (serialized.includes("You are a verifier/critic")) {
        message = { role: "assistant", content: JSON.stringify({ findings: [] }) };
      } else {
        const previousCalls = (body.messages ?? []).reduce((count, item) => count + (item?.role === "assistant" && Array.isArray(item.tool_calls) ? item.tool_calls.length : 0), 0);
        const requestedTool = previousCalls === 0 ? "shell" : previousCalls === 1 ? "read" : undefined;
        if (requestedTool) {
          const schema = (body.tools ?? []).map(item => item?.function ?? item).find(item => item?.name === requestedTool);
          const inputKey = Object.keys(schema?.parameters?.properties ?? {}).find(key => requestedTool === "shell" ? /command/i.test(key) : /file.?path|path/i.test(key))
            ?? Object.keys(schema?.parameters?.properties ?? {})[0];
          if (!inputKey) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: `runtime did not expose ${requestedTool} schema` }));
            return;
          }
          toolCallSequence++;
          message = { role: "assistant", content: null, tool_calls: [{
            id: `call_ctx_${toolCallSequence}`, type: "function",
            function: { name: requestedTool, arguments: JSON.stringify({
              [inputKey]: requestedTool === "shell"
                ? `printf '%s' '${CANARIES.result}' # ${CANARIES.input}`
                : path.join(PROJECT, `${CANARIES.error}-missing-file`),
            }) },
          }] };
          finishReason = "tool_calls";
        } else {
          message = { role: "assistant", content: `Worker complete ${CANARIES.assistant}` };
        }
      }
      const id = `chatcmpl_ctx_${providerRequests.length}`;
      const created = Math.floor(Date.now() / 1000);
      const deltas = message.tool_calls
        ? [{ role: "assistant" }, ...message.tool_calls.map((call, index) => ({ tool_calls: [{ index, id: call.id, type: call.type, function: call.function }] }))]
        : [{ role: "assistant" }, { content: message.content }];
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const delta of deltas) res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model ?? "context-test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model ?? "context-test", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  providerServer = provider;
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(providerPort, "127.0.0.1", resolve); });

  const config = {
    $schema: "https://opencode.ai/config.json",
    permission: { read: "allow", shell: "allow" },
    provider: { opencode: { options: { baseURL: `http://127.0.0.1:${providerPort}` } } },
    model: "opencode/big-pickle",
    plugins: [{ package: "./plugins/opencode-jev-free-router", options: { enableAutoRoute: false, contextManagementStage: "deterministic-shadow", jevEndpoint: `http://127.0.0.1:${providerPort}/jev` } }],
  };
  fs.writeFileSync(path.join(PROJECT, "opencode.json"), JSON.stringify(config, null, 2));
  const hostPort = await freePort();
  const host = spawnHost(["serve", "--hostname", "127.0.0.1", "--port", String(hostPort)], {
    PATH: process.env.PATH ?? "", HOME, OPENCODE_CONFIG_DIR: path.join(HOME, ".config/opencode"),
    OPENCODE_DATA_DIR: path.join(HOME, ".local/share/opencode"), OPENCODE_API_KEY: "local-context-e2e-only",
    OPJEV_CONTEXT_MANAGEMENT_STAGE: "deterministic-shadow",
    OPJEV_JEV_ENDPOINT: `http://127.0.0.1:${providerPort}/jev`,
  });
  let password = "";
  await waitFor(() => { password = /server password (\S+)/.exec(host.output)?.[1] ?? ""; return password; }, 30000, "server password");
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const origin = `http://127.0.0.1:${hostPort}`;
  const api = async (method, route, body) => {
    const response = await fetch(`${origin}${route}`, {
      method, headers: { authorization: auth, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch {}
    return { status: response.status, data, text };
  };
  await waitFor(async () => (await api("GET", "/api/info")).status === 200, 30000, "host /api/info");
  const info = await api("GET", "/api/info");
  assert.equal(info.data?.version, "2.0.11", `host reported ${info.data?.version}`);

  const firstPrompt = `Please echo this exactly and perform one local check: ${CANARIES.human}`;
  const created = await api("POST", "/api/session", {});
  const parentSessionID = created.data?.data?.id ?? created.data?.id;
  assert.ok(parentSessionID, `parent session creation failed: ${created.text}`);
  const admission = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", {
    input: { sessionID: parentSessionID, messageID: `context-${cryptoRandom()}`, objective: firstPrompt, maxRounds: 1 },
  });
  assert.ok(admission.status >= 200 && admission.status < 300, `admission RPC failed: ${admission.status} ${admission.text}`);
  const admissionResult = admission.data?.output ?? admission.data?.data ?? admission.data;
  const runID = admissionResult?.runID;
  assert.ok(typeof runID === "string" && runID.length > 0, `admission RPC did not return runID: ${admission.text}`);
  assert.equal(admissionResult.status, "started", `unexpected admission status: ${admissionResult.status}`);
  const workerCheckpoint = await waitFor(() => dbRead(HOME, db => {
    const checkpoint = kvValue(db, `orchestration/run/${runID}`)?.value;
    return checkpoint && ["completed", "failed", "awaiting-human"].includes(checkpoint.state?.phase) ? checkpoint : undefined;
  }), 120000, "terminal orchestration checkpoint");
  const sessionID = workerCheckpoint.workerSessionID;
  assert.ok(sessionID, "real run checkpoint did not record worker session");
  const dbEvidence = dbRead(HOME, db => {
    const asset = kvValue(db, "context/asset-ledger/v1");
    const metrics = kvValue(db, "context/metrics/v1");
    const checkpoint = kvValue(db, `orchestration/run/${runID}`);
    const rows = db.prepare("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY time_created").all(sessionID).map(row => ({ type: String(row.type), data: String(row.data) }));
    const orchestrationKeys = db.prepare("SELECT key FROM kv WHERE key LIKE '%orchestration/run/%'").all().map(row => String(row.key));
    const sessionCount = db.prepare("SELECT COUNT(*) AS n FROM session_v2").get().n;
    return { asset, metrics, checkpoint, rows, orchestrationKeys, sessionCount };
  });
  assert.equal(dbEvidence.checkpoint?.value.workerSessionID, sessionID, "worker session differs from authoritative checkpoint");
  assert.equal(dbEvidence.checkpoint?.value.state?.round, 1, "E2E exceeded its single-round limit");
  assert.ok(["completed", "failed"].includes(dbEvidence.checkpoint.value.state.phase), `unexpected run phase: ${dbEvidence.checkpoint.value.state.phase}`);

  assert.ok(dbEvidence.asset, "real SQLite context asset ledger key missing");
  assert.ok(dbEvidence.metrics, "real SQLite context metrics key missing");
  const assetGroups = dbEvidence.asset.value?.groups;
  assert.ok(Array.isArray(assetGroups), "asset ledger has no groups array");
  const assetSources = assetGroups.map(group => Array.isArray(group) ? [group[2]?.[7], group[3]?.[7]].filter(Number.isInteger) : [] ).flat();
  // Compact source enums: tool-result=1 and tool-failure=2; both lifecycle outcomes are required.
  assert.ok(assetSources.includes(1), `completed tool outcome missing; observed sources=${assetSources.join(",")}`);
  assert.ok(assetSources.includes(2), `failed tool outcome missing; observed sources=${assetSources.join(",")}`);
  const contextSerialized = JSON.stringify({ ledger: dbEvidence.asset.value, metrics: dbEvidence.metrics.value });
  for (const [kind, canary] of Object.entries(CANARIES)) assert.equal(contextSerialized.includes(canary), false, `${kind} canary persisted in context records`);

  const runtimeText = dbEvidence.rows.map(row => row.data).join("\n");
  assert.ok(runtimeText.includes(CANARIES.human), "human canary missing from durable OpenCode history");
  assert.ok(runtimeText.includes(CANARIES.result), "successful tool result absent from OpenCode history");
  assert.ok(runtimeText.includes(CANARIES.error), "failed tool error absent from OpenCode history");
  const assistantText = dbEvidence.rows.map(row => { try { return JSON.parse(row.data); } catch { return {}; } })
    .flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
  assert.ok(assistantText.includes(CANARIES.assistant), "controlled assistant output missing from runtime history");

  // Replay real host observations and validate the exact worker metadata/checkpoint link.
  const { ContextLedger } = await import("../src/context-management/ledger.ts");
  const { projectContextProtection } = await import("../src/context-management/protection.ts");
  const { classifyContextGroups } = await import("../src/context-management/deterministic-pruner.ts");
  const { hashStableRef } = await import("../src/context-management/identity.ts");
  const replay = new ContextLedger();
  replay.replace(assetGroups);
  const beforeReplay = replay.size;
  for (const group of replay.snapshot()) replay.upsertGroup(group);
  assert.equal(replay.size, beforeReplay, "replaying persisted groups created duplicates");
  const groups = replay.snapshot();
  const sessionRef = hashStableRef(sessionID);
  const runRef = hashStableRef(runID);
  assert.ok(groups.length > 0, "real OpenCode context hook did not observe a tool group");
  assert.ok(groups.length <= 8, `test fixture unexpectedly exceeded the recent-group guard (${groups.length})`);
  assert.ok(groups.every(group => group.sessionRef === sessionRef && /^[a-f0-9]{64}$/.test(group.messageRef ?? "")
    && group.call.role === "worker" && group.call.runRef === runRef && group.call.round === 1),
  "ledger groups did not retain hashed message and live worker/run/round identity");
  const sessionResponse = await api("GET", `/api/session/${sessionID}`);
  const workerSession = sessionResponse.data?.data ?? sessionResponse.data;
  assert.equal(workerSession?.metadata?.["jev-router"], "orchestration-internal");
  assert.equal(workerSession?.metadata?.["jev-role"], "worker");
  assert.equal(workerSession?.metadata?.["jev-run-id"], runID);
  assert.equal(workerSession?.metadata?.["jev-round"], 1);
  assert.equal(dbEvidence.checkpoint?.value.workerSessionID, sessionID, "worker checkpoint did not come from the real dispatcher");
  const workerProtection = await projectContextProtection({
    getSessionMetadata: async () => workerSession.metadata,
    getRun: async key => key === runID ? dbEvidence.checkpoint.value : undefined,
  }, sessionID, groups);
  assert.equal(workerProtection.role, "worker");
  assert.ok(workerProtection.groups.every(item => item.state === "unknown"), "cross-process fingerprints did not fail closed");
  const actualDecisions = classifyContextGroups({ groups, protection: workerProtection });
  assert.ok(actualDecisions.every(item => item.action === "KEEP" && item.reason === "unknown-protection"), "unknown worker groups were proposed for pruning");
  const eligibleRecentGroups = groups.map(group => ({
    ...group,
    call: { ...group.call, protection: "clear" },
    terminal: { ...group.terminal, protection: "clear" },
  }));
  const eligibleRecentProtection = { ...workerProtection, groups: workerProtection.groups.map(item => ({ ...item, state: "clear" })) };
  const recentDecisions = classifyContextGroups({ groups: eligibleRecentGroups, protection: eligibleRecentProtection });
  assert.ok(recentDecisions.every(item => item.action === "KEEP" && item.reason === "recent-group"), "newest eight complete groups were not guarded");

  for (const role of ["critic", "orchestrator"]) {
    const protectedSnapshot = await projectContextProtection({
      getSessionMetadata: async () => ({ "jev-router": "orchestration-internal", "jev-role": role }),
      getRun: async () => undefined,
    }, sessionID, groups);
    const roleDecisions = classifyContextGroups({ groups, protection: protectedSnapshot });
    assert.ok(roleDecisions.every(item => item.action === "KEEP" && item.reason === "protected"), `${role} group was not protected`);
  }
  const unknownSnapshot = await projectContextProtection({
    getSessionMetadata: async () => workerSession.metadata,
    getRun: async () => ({ checkpoint: "worker-created", state: {}, workerSessionID: sessionID, updatedAt: Date.now() }),
  }, sessionID, groups);
  assert.ok(unknownSnapshot.groups.every(item => item.state === "unknown"), "malformed checkpoint linkage did not fail closed");
  assert.ok(classifyContextGroups({ groups, protection: unknownSnapshot }).every(item => item.action === "KEEP"), "unknown protection proposed pruning");
  const metric = dbEvidence.metrics.value;
  const pairing = metric?.context?.pairedGroups ?? 0;
  const requestCount = metric?.context?.requests ?? 0;
  assert.ok(requestCount >= 2, `real context hook did not observe multiple requests (${requestCount})`);
  assert.ok((metric?.tool?.completed ?? 0) >= 1, "context metrics did not observe a completed tool call");
  assert.ok((metric?.tool?.failed ?? 0) >= 1, "context metrics did not observe a failed tool call");
  assert.ok(pairing <= groups.length * requestCount, `pairing metric exceeded observed group/request bounds: ${pairing}`);
  const planned = metric?.context?.plannedGroups ?? 0;
  assert.ok(planned > 0, "exact OpenCode context hook did not classify a real persisted tool group");
  assert.ok(planned <= groups.length * requestCount, "projection proposal count exceeded request/ledger bounds");
  assert.equal((metric?.context?.proposedKeep ?? 0) + (metric?.context?.proposedTruncate ?? 0) + (metric?.context?.proposedDrop ?? 0), planned, "bounded proposals do not reconcile to planned groups");
  assert.equal(metric?.context?.proposedTruncate ?? 0, 0, "shadow proposed a payload truncation");
  assert.equal(metric?.context?.proposedDrop ?? 0, 0, "shadow proposed a drop");
  assert.equal(metric?.context?.requestSnapshotsUnchanged ?? 0, requestCount,
    "real context hook did not validate unchanged system/messages for every request");
  assert.ok((metric?.context?.estimatedRequestBytesBeforeTotal ?? 0) > 0,
    "real context hook did not measure the request before planning");
  assert.equal(metric?.context?.estimatedRequestBytesBeforeTotal, metric?.context?.estimatedRequestBytesAfterTotal,
    "real context hook request-byte estimates differed before/after deterministic SHADOW");
  log(`context diagnostic: ${JSON.stringify({ toolCompleted: metric.tool.completed, toolFailed: metric.tool.failed, contextRequests: requestCount, groups: groups.length, planned, unknownGroups: metric.context.unknownGroups, workerRoundProtected: metric.context.workerRoundProtectedGroups, checkpoint: dbEvidence.checkpoint.value.checkpoint, phase: dbEvidence.checkpoint.value.state.phase, selectionVia: dbEvidence.checkpoint.value.selection?.via, jevRequests, providerPaths: providerRequests.map(item => item.url) })}`);
  assert.ok((metric?.context?.unknownProtectionGroups ?? 0) > 0,
    "worker context groups were not conservatively protected when cross-process identity was unavailable");
  assert.ok((metric?.context?.workerRoundProtectedGroups ?? 0) <= (metric?.context?.protectedGroups ?? 0),
    "worker-round protected groups exceeded all protected groups");
  assert.equal(metric?.context?.requestShapeUnknownGroups ?? 0, 0,
    "real OpenCode context message shape was not understood by the projector");
  assert.equal(metric?.context?.requestPairMismatchGroups ?? 0, 0,
    "context tool-call/result pairing did not match current OpenCode messages");
  assert.ok(dbEvidence.sessionCount >= 3 && dbEvidence.sessionCount <= 4, `expected parent, worker, critic and optional orchestrator sessions; got ${dbEvidence.sessionCount}`);
  assert.deepEqual(dbEvidence.orchestrationKeys, [pluginStorageKey(`orchestration/run/${runID}`)], "unexpected orchestration runs were persisted");
  assert.ok(jevRequests >= 2 && jevRequests <= 3, `unexpected local Jev request count ${jevRequests}`);
  const userWire = providerRequests.flatMap(item => item.messages).filter(message => message?.role === "user").map(message => String(message.content ?? ""));
  assert.ok(userWire.some(content => content.includes(CANARIES.human)), "worker objective did not reach its provider request");

  log(`PASS OpenCode 2.0.11; run=${runID}; phase=${dbEvidence.checkpoint.value.state.phase}; rounds=1; Jev-local=${jevRequests}; contextRequests=${requestCount}; completed=${metric.tool.completed}; failed=${metric.tool.failed}; toolPairs=${metric.tool.pairedGroups}; groups=${groups.length}; planned=${planned};`);
  log("safety gates: real admission/worker binding/checkpoint; replay idempotent; SHADOW payload unchanged; cross-process protection remained fail-closed");
} catch (error) {
  log(`FAIL ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  stop();
}
