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
  secondHuman: `CTX_SECOND_HUMAN_${cryptoRandom()}`,
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
function dbWrite(home, fn) {
  const db = new DatabaseSync(path.join(home, ".local/share/opencode/opencode.db"));
  try { return fn(db); } finally { db.close(); }
}
function pluginStorageKey(key) {
  const namespace = [..."jev-free-router"].map(character => character.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  return `plugin:${namespace}:${key}`;
}
function setPluginValue(home, key, value) {
  const now = Date.now();
  dbWrite(home, db => db.prepare(
    "INSERT INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, time_updated = excluded.time_updated",
  ).run(pluginStorageKey(key), JSON.stringify(value), now, now));
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
  let providerRequests = [];
  let toolCallSequence = 0;
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      providerRequests.push({ url: req.url, shape: openaiShape(body), messages: body.messages ?? [] });
      const previousCalls = (body.messages ?? []).reduce((count, message) => count + (message?.role === "assistant" && Array.isArray(message.tool_calls) ? message.tool_calls.length : 0), 0);
      const hasSecondPrompt = JSON.stringify(body.messages ?? []).includes(CANARIES.secondHuman);
      const requestedTool = !hasSecondPrompt && previousCalls === 1 ? "read" : "shell";
      const schema = (body.tools ?? []).map(item => item?.function ?? item).find(item => item?.name === requestedTool);
      if (!schema) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `runtime did not expose ${requestedTool} tool` }));
        return;
      }
      const inputKey = Object.keys(schema.parameters?.properties ?? {}).find(key => requestedTool === "shell" ? /command/i.test(key) : /file.?path|path/i.test(key))
        ?? Object.keys(schema.parameters?.properties ?? {})[0];
      if (!inputKey) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `runtime ${requestedTool} schema had no argument property` }));
        return;
      }
      let message;
      let finishReason = "stop";
      if (!hasSecondPrompt && previousCalls === 0) {
        toolCallSequence++;
        message = { role: "assistant", content: null, tool_calls: [{
          id: `call_ctx_success_${toolCallSequence}`, type: "function",
          function: { name: "shell", arguments: JSON.stringify({ [inputKey]: `printf '%s' '${CANARIES.result}' # ${CANARIES.input}` }) },
        }] };
        finishReason = "tool_calls";
      } else if (!hasSecondPrompt && previousCalls === 1) {
        toolCallSequence++;
        message = { role: "assistant", content: null, tool_calls: [{
          id: `call_ctx_failure_${toolCallSequence}`, type: "function",
          function: { name: "read", arguments: JSON.stringify({ [inputKey]: path.join(PROJECT, `${CANARIES.error}-missing-file`) }) },
        }] };
        finishReason = "tool_calls";
      } else {
        message = { role: "assistant", content: hasSecondPrompt ? `Second turn ${CANARIES.assistant}` : `First turn complete ${CANARIES.assistant}` };
      }
      const id = `chatcmpl_ctx_${providerRequests.length}`;
      const created = Math.floor(Date.now() / 1000);
      const deltas = message.tool_calls
        ? [{ role: "assistant" }, ...message.tool_calls.map((call, index) => ({ tool_calls: [{ index, id: call.id, type: call.type, function: call.function }] }))]
        : [{ role: "assistant" }, { content: message.content }];
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const delta of deltas) {
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model ?? "context-test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      }
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

  const runID = `e2e-context-${cryptoRandom()}`;
  const sessionMetadata = {
    "jev-router": "orchestration-internal", "jev-role": "worker", "jev-agent-role": "implementer",
    "jev-run-id": runID, "jev-round": 1,
  };
  const created = await api("POST", "/api/session", { metadata: sessionMetadata });
  const sessionID = created.data?.data?.id ?? created.data?.id;
  assert.ok(sessionID, `session creation failed: ${created.text}`);
  // One E2E-owned checkpoint fixture exercises the real internal-session projector without dispatching a run.
  const workerCheckpoint = {
    checkpoint: "worker-created",
    state: {
      contract: {
        runID, sessionID, objective: "E2E protection fixture",
        acceptanceCriteria: ["project real worker groups in SHADOW"],
        constraints: [], requiredEvidence: ["OpenCode tool group"], maxRounds: 3,
      },
      phase: "running", round: 1, executor: { agent: "build", model: "opencode/big-pickle", sessionID }, history: [],
    },
    workerSessionID: sessionID,
    updatedAt: Date.now() + 60_000,
  };
  setPluginValue(HOME, `orchestration/run/${runID}`, workerCheckpoint);
  const firstPrompt = `Please echo this exactly and perform one local check: ${CANARIES.human}`;
  const secondPrompt = `Second independent turn. Preserve this text exactly: ${CANARIES.secondHuman}`;
  const prompt = async text => {
    const idleBefore = dbRead(HOME, db => db.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type = 'idle'").get(sessionID).n);
    const result = await api("POST", `/api/session/${sessionID}/prompt`, { text });
    assert.ok(result.status >= 200 && result.status < 300, `prompt rejected with ${result.status}`);
    await waitFor(async () => {
      const idle = dbRead(HOME, db => db.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type = 'idle'").get(sessionID).n > idleBefore);
      if (idle) return true;
      const pending = await api("GET", `/api/session/${sessionID}/permission`);
      const requests = Array.isArray(pending.data) ? pending.data : Array.isArray(pending.data?.data) ? pending.data.data : [];
      for (const request of requests) {
        const onlyProjectResource = Array.isArray(request.resources) && request.resources.length > 0 && request.resources.every(resource => String(resource).startsWith(PROJECT));
        if (["read", "shell"].includes(request.action) || (request.action === "external_directory" && onlyProjectResource)) {
          await api("POST", `/api/session/${sessionID}/permission/${encodeURIComponent(request.id)}/reply`, { decision: "once" });
        }
      }
      return false;
    }, 60000, "prompt idle event");
  };
  await prompt(firstPrompt);
  await prompt(secondPrompt);

  const dbEvidence = dbRead(HOME, db => {
    const asset = kvValue(db, "context/asset-ledger/v1");
    const metrics = kvValue(db, "context/metrics/v1");
    const checkpoint = kvValue(db, `orchestration/run/${runID}`);
    const rows = db.prepare("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY time_created").all(sessionID).map(row => ({ type: String(row.type), data: String(row.data) }));
    const orchestrationKeys = db.prepare("SELECT key FROM kv WHERE key LIKE '%orchestration/run/%'").all().map(row => String(row.key));
    const sessionCount = db.prepare("SELECT COUNT(*) AS n FROM session_v2").get().n;
    return { asset, metrics, checkpoint, rows, orchestrationKeys, sessionCount };
  });
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
  for (const canary of [CANARIES.human, CANARIES.secondHuman]) assert.ok(runtimeText.includes(canary), "human canary missing from durable OpenCode history");
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
  assert.deepEqual(workerSession?.metadata, sessionMetadata, "OpenCode session metadata lost canonical worker linkage");
  assert.deepEqual(dbEvidence.checkpoint?.value, workerCheckpoint, "worker checkpoint fixture was not readable from OpenCode plugin storage");
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
    getSessionMetadata: async () => sessionMetadata,
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
  assert.ok(pairing >= 2, `tool call/result pairing coverage below expected: ${pairing}`);
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
  assert.ok((metric?.context?.protectedGroups ?? 0) > 0,
    "host-side projector did not select worker-round protection for real groups");
  assert.ok((metric?.context?.workerRoundProtectedGroups ?? 0) > 0,
    "host-side projector did not record worker-round-evidence as the protection reason");
  assert.equal(metric?.context?.requestShapeUnknownGroups ?? 0, 0,
    "real OpenCode context message shape was not understood by the projector");
  assert.equal(metric?.context?.requestPairMismatchGroups ?? 0, 0,
    "real OpenCode call/result identity did not reconcile with the ledger");
  log(`hook evidence: unchanged=${metric.context.requestSnapshotsUnchanged}; worker-round-protected=${metric.context.workerRoundProtectedGroups}; protected=${metric.context.protectedGroups}; unknown-protection=${metric.context.unknownProtectionGroups}; request-shape-unknown=${metric.context.requestShapeUnknownGroups}; pair-mismatch=${metric.context.requestPairMismatchGroups}; payload-mismatch=${metric.context.requestPayloadMismatchGroups}`);
  assert.equal(dbEvidence.sessionCount, 1, "Context Management created an additional session");
  assert.deepEqual(dbEvidence.orchestrationKeys, [pluginStorageKey(`orchestration/run/${runID}`)], "Context Management created state beyond the E2E's explicit worker checkpoint fixture");
  assert.ok(providerRequests.every(item => !String(item.url).includes("/jev")), "unexpected Jev request from context path");
  const requestShape = providerRequests.map(item => item.shape);
  const userWire = providerRequests.flatMap(item => item.messages).filter(message => message?.role === "user").map(message => String(message.content ?? ""));
  assert.ok(userWire.includes(firstPrompt), "outgoing first human text missing or changed before provider request");
  assert.ok(userWire.includes(secondPrompt), "outgoing second human text missing or changed before provider request");
  assert.ok(providerRequests.flatMap(item => item.messages).some(message => message?.role === "assistant" && message.content === `First turn complete ${CANARIES.assistant}`), "assistant content did not reach a subsequent provider request unchanged");

  log(`PASS OpenCode 2.0.11 deterministic-shadow; plugin loaded; turns=2; requests=${requestCount}; pairedGroups=${pairing}; groups=${groups.length}; planned=${planned}`);
  log(`observed host session_message shape=${JSON.stringify(shapeOfRuntimeRows(dbEvidence.rows))}`);
  log(`observed provider request shape=${JSON.stringify(requestShape)}`);
  log("safety gates: replay idempotent; only explicit harness worker checkpoint fixture; no context-created session/dispatch/round/recovery or Jev pruning");
} catch (error) {
  log(`FAIL ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  stop();
}
