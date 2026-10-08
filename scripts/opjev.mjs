#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installPluginToHome } from "./install-plugin.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(os.homedir(), ".local", "share", "opjev-dogfood");
const PROFILE = path.join(ROOT, "profile");
const CONFIG_DIR = path.join(PROFILE, ".config", "opencode");
const PROFILE_HOME = PROFILE;
const DATA_DIR = path.join(PROFILE, ".local", "share", "opencode");
const DB_PATH = path.join(DATA_DIR, "opencode.db");
const PLUGIN_DIR = path.join(CONFIG_DIR, "plugins", "opjev");
const RUNTIME = path.join(ROOT, "runtime", "opencode-2.0.11");
const RUNTIME_SHA256 = "0ed7d8546cf24acc41e6371ec30928ed931ec1474e1a54bbecdde8e0dd801d2f";
const RUNTIME_VERSION = "2.0.11";
const JEV_ENDPOINT = "https://opencode.ai/zen/v1/systemone";
const JEV_MODEL = "jev-1.13-free";
const LOCK_PATH = path.join(ROOT, "active.json");
const SERVER_RPC = "opjev.admission.v1";

class LaunchError extends Error {}

export function parseSessionArgs(args) {
  const out = [];
  let selected = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--continue" || arg === "-c") {
      if (selected) throw new Error("--continue and --session cannot be combined");
      selected = true;
      out.push("--continue");
    } else if (arg === "--session" || arg === "-s") {
      if (selected) throw new Error("--continue and --session cannot be combined");
      const id = args[i + 1];
      if (!id || id.startsWith("-")) throw new Error("--session requires a session ID");
      selected = true;
      out.push("--session", id);
      i += 1;
    } else {
      throw new Error("unsupported OpenCode argument; only --continue and --session are accepted");
    }
  }
  return out;
}

function assertNoSymlinkPath(targetDir) {
  const target = path.resolve(targetDir);
  const filesystemRoot = path.parse(target).root;
  let current = filesystemRoot;
  for (const part of target.slice(filesystemRoot.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new LaunchError("Isolated OPJEV path contains a symlink or non-directory; no external state was accessed.");
      }
    } catch (err) {
      if (err instanceof LaunchError) throw err;
      if (err?.code === "ENOENT") return false;
      throw new LaunchError("Could not safely inspect the isolated OPJEV path.");
    }
  }
  return true;
}

function launcherRootExists() {
  if (!assertNoSymlinkPath(ROOT)) return false;
  const stat = fs.lstatSync(ROOT);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new LaunchError("Dedicated OPJEV root is not user-owned; no state was accessed.");
  }
  return true;
}

function privateDirectory(dir) {
  try {
    assertNoSymlinkPath(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!assertNoSymlinkPath(dir)) throw new LaunchError("Could not create the isolated profile directory.");
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new LaunchError("Dedicated profile path is not a user-owned directory; it was left unchanged.");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new LaunchError("Dedicated profile permissions are broader than owner-only; no permissions were changed.");
    }
  } catch (err) {
    if (err instanceof LaunchError) throw err;
    throw new LaunchError("Could not create the isolated profile directories.");
  }
}

function ownedProfileDirectory(dir) {
  try {
    assertNoSymlinkPath(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!assertNoSymlinkPath(dir)) throw new LaunchError("Could not create the isolated plugin parent.");
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new LaunchError("OPJEV plugin parent is not a user-owned directory; it was left unchanged.");
    }
  } catch (err) {
    if (err instanceof LaunchError) throw err;
    throw new LaunchError("Could not safely create the isolated plugin parent.");
  }
}

function profileConfig() {
  return {
    $schema: "https://opencode.ai/config.json",
    plugins: [{
      package: PLUGIN_DIR,
      options: {
        jevModel: JEV_MODEL,
        jevEndpoint: JEV_ENDPOINT,
        apiKeyEnv: "OPENCODE_API_KEY",
        confidenceThreshold: 0.55,
        enableAutoRoute: false,
        jevTimeoutMs: 15000,
        contextManagementStage: "observe",
      },
    }],
  };
}

function verifyProfileConfig() {
  const configPath = path.join(CONFIG_DIR, "opencode.json");
  const expected = profileConfig();
  try {
    const stat = fs.lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new LaunchError("Isolated OpenCode config is not a private regular file; it was left unchanged.");
    }
    let actual;
    try {
      actual = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      throw new LaunchError("Isolated OpenCode config is not valid JSON; it was left unchanged.");
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new LaunchError("Isolated OpenCode config differs from the managed dogfood config; it was left unchanged.");
    }
    return;
  } catch (err) {
    if (err instanceof LaunchError) throw err;
    if (err?.code !== "ENOENT") throw new LaunchError("Could not inspect the isolated OpenCode config.");
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(expected, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (err?.code === "EEXIST") return verifyProfileConfig();
    throw new LaunchError("Could not create the isolated OpenCode config.");
  }
}

function baseEnvironment() {
  const names = [
    "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ", "TERM", "COLORTERM", "TMPDIR", "TMP", "TEMP",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE", "LD_LIBRARY_PATH",
  ];
  const env = Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  env.PATH ??= "/usr/bin:/bin";
  env.HOME = PROFILE_HOME;
  env.XDG_CONFIG_HOME = path.join(PROFILE_HOME, ".config");
  env.XDG_DATA_HOME = path.join(PROFILE_HOME, ".local", "share");
  env.XDG_CACHE_HOME = path.join(PROFILE_HOME, ".cache");
  env.XDG_STATE_HOME = path.join(PROFILE_HOME, ".local", "state");
  env.OPENCODE_CONFIG_DIR = CONFIG_DIR;
  return env;
}

function readZenKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  const envPath = path.join(os.homedir(), ".config", "opencode", "env");
  let stat;
  let content;
  try {
    stat = fs.lstatSync(envPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new LaunchError("Zen credential file must be a private regular file; no credential was read.");
    }
    content = fs.readFileSync(envPath, "utf8");
  } catch (err) {
    if (err instanceof LaunchError) throw err;
    if (err?.code === "ENOENT") throw new LaunchError("Zen credential is unavailable; set OPENCODE_API_KEY or provide the existing private env file.");
    throw new LaunchError("Could not safely read the existing Zen credential file.");
  }
  const lines = content.split(/\r?\n/).filter(line => /^\s*export\s+OPENCODE_API_KEY\s*=/.test(line));
  if (lines.length !== 1) throw new LaunchError("Zen env file must contain exactly one single-line OPENCODE_API_KEY export.");
  const match = /^\s*export\s+OPENCODE_API_KEY\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#'"`]+))\s*(?:#.*)?$/.exec(lines[0]);
  const key = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!key) throw new LaunchError("Zen credential line has an unsupported format; its contents were not displayed.");
  return key;
}

async function verifyJev(apiKey) {
  let response;
  try {
    response = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        state: { prompt: "OPJEV startup connectivity probe.", agent: "unknown", model: "unknown" },
        model: JEV_MODEL,
        questions: { connectivity: {
          type: "choice",
          instructions: "Select the only available option.",
          criteria: { connected: "The authenticated SystemOne request reached Jev successfully." },
        } },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new LaunchError("Jev live check failed (network or timeout); OpenCode was not started.");
  }
  if (!response.ok) throw new LaunchError(`Jev live check failed (HTTP ${response.status}); OpenCode was not started.`);
  let result;
  try { result = await response.json(); } catch {
    throw new LaunchError("Jev live check returned invalid JSON; OpenCode was not started.");
  }
  const answer = result?.answers?.connectivity;
  if (
    !result || typeof result.model !== "string" || !result.model ||
    !answer || answer.type !== "choice" || answer.choice !== "connected" ||
    typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1
  ) throw new LaunchError("Jev live check returned an invalid structured response; OpenCode was not started.");
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyRuntime() {
  let tempHome;
  try {
    const stat = fs.lstatSync(RUNTIME);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    fs.accessSync(RUNTIME, fs.constants.X_OK);
    if (await sha256File(RUNTIME) !== RUNTIME_SHA256) throw new Error();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "opjev-runtime-check-"));
    const output = execFileSync(RUNTIME, ["--version"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tempHome },
      timeout: 10000,
    }).trim();
    const version = /^opencode v(\d+\.\d+\.\d+)$/.exec(output)?.[1];
    if (version !== RUNTIME_VERSION) throw new Error();
  } catch {
    throw new LaunchError("Pinned OpenCode runtime failed version or SHA-256 verification; no global executable was used.");
  } finally {
    if (tempHome) {
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* private version-check temp dir */ }
    }
  }
}

function basicAuth(password) {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

async function freeLoopbackPort() {
  const server = net.createServer();
  return await new Promise((resolve, reject) => {
    server.once("error", () => reject(new LaunchError("Could not reserve a loopback port for the OpenCode server.")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(error => error ? reject(new LaunchError("Could not release the temporary loopback port.")) : resolve(port));
    });
  });
}

const counters = { intercept: 0, admitted: 0, dispatched: 0, duplicates: 0, failClosed: 0 };
function consumeGatewayLine(line, onReady) {
  const match = /^\[opjev-gateway\] ouvindo em http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
  if (match) onReady(Number(match[1]));
  try {
    const event = JSON.parse(line);
    if (event.type === "intercept" && event.mode === "orchestrate") counters.intercept += 1;
    else if (event.type === "admitted") counters.admitted += 1;
    else if (event.type === "rpc-dispatched") counters.dispatched += 1;
    else if (event.type === "rpc-skipped" || event.type === "rpc-duplicate-ignored") counters.duplicates += 1;
    else if (["rpc-failed", "admission-unknown", "session-role-unknown"].includes(event.type)) counters.failClosed += 1;
  } catch {
    // Process output is deliberately discarded unless it is a safe startup line.
  }
}

function spawnCaptured(command, args, options, onLine) {
  let errorSeen = false;
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", () => { errorSeen = true; });
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", chunk => {
      pending = (pending + chunk).slice(-65536);
      for (;;) {
        const at = pending.indexOf("\n");
        if (at < 0) break;
        const line = pending.slice(0, at).replace(/\r$/, "");
        pending = pending.slice(at + 1);
        onLine(line);
      }
    });
  }
  Object.defineProperty(child, "spawnErrorSeen", { get: () => errorSeen });
  return child;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; }
}

function readLock(lockPath = LOCK_PATH) {
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { invalid: true };
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return value && Number.isInteger(value.pid) ? value : { invalid: true };
  } catch (err) {
    return err?.code === "ENOENT" ? null : { invalid: true };
  }
}

export function acquireLock(lockPath = LOCK_PATH) {
  const record = { pid: process.pid, startedAt: Date.now(), serverPid: null, gatewayPid: null, serverPort: null, gatewayPort: null };
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(record));
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* lock descriptor cleanup */ }
      try { fs.unlinkSync(lockPath); } catch { /* only this invocation created the lock */ }
    }
    if (err?.code !== "EEXIST") throw new LaunchError("Could not create the dedicated OPJEV process lock.");
    const existing = readLock(lockPath);
    if (!existing || existing.invalid) throw new LaunchError("OPJEV lock is unreadable; it was preserved to avoid a duplicate process.");
    if (pidAlive(existing.pid)) throw new LaunchError(`OPJEV is already active (launcher PID ${existing.pid}); refusing a duplicate.`);
    const childPids = [existing.gatewayPid, existing.serverPid].filter(pidAlive);
    if (childPids.length) throw new LaunchError("A previous OPJEV launcher left a managed child process active; refusing to start a duplicate.");
    throw new LaunchError("A stale OPJEV lock remains; no process was started. Verify managed processes are stopped before removing it.");
  }
  return {
    update(patch) {
      Object.assign(record, patch, { updatedAt: Date.now() });
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, JSON.stringify(record), 0, "utf8");
    },
    release() {
      try {
        const current = readLock(lockPath);
        if (current?.pid === process.pid) fs.unlinkSync(lockPath);
      } catch { /* managed lock cleanup is best effort */ }
      try { fs.closeSync(fd); } catch { /* already closed */ }
    },
  };
}

function updateLock(lock, patch) {
  try { lock.update(patch); } catch { throw new LaunchError("Could not update the OPJEV process lock."); }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.spawnErrorSeen) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: 1, signal: null }));
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.spawnErrorSeen) return;
  try { child.kill("SIGTERM"); } catch { return; }
  await Promise.race([waitForExit(child), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch { /* child already exited */ }
    await waitForExit(child);
  }
}

async function waitFor(test, child, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.spawnErrorSeen || child.exitCode !== null || child.signalCode !== null) {
      throw new LaunchError(`${label} stopped before becoming ready.`);
    }
    if (await test()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new LaunchError(`${label} did not become ready before timeout.`);
}

async function serverInfo(origin, auth) {
  try {
    const response = await fetch(`${origin}/api/info`, { headers: { authorization: auth }, signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

async function verifyPluginRpc(origin, auth) {
  async function probe(method) {
    const response = await fetch(`${origin}/api/rpc/${SERVER_RPC}/${method}`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: '{"input":{}}',
      signal: AbortSignal.timeout(3000),
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = {}; }
    return { status: response.status, type: body?.type, fieldDiagnostic: /sessionID/.test(text) };
  }
  let missing;
  let registered;
  try {
    missing = await probe("__opjev_missing_method__");
    registered = await probe("orchestrate");
  } catch { throw new LaunchError("OPJEV server RPC probe failed."); }
  if (
    missing.type !== "rpc.method_not_found" ||
    !(registered.type === "rpc.invalid_input" || registered.fieldDiagnostic)
  ) throw new LaunchError("OPJEV admission RPC is not registered on the isolated OpenCode server.");
}

function createGatewayEnv(base, serverPassword, upstream) {
  return {
    ...base,
    OPJEV_GATEWAY_ENABLED: "1",
    OPJEV_GATEWAY_UPSTREAM: upstream,
    OPJEV_GATEWAY_HOST: "127.0.0.1",
    OPJEV_GATEWAY_PORT: "0",
    OPJEV_GATEWAY_DEFAULT_MODE: "orchestrate",
    OPJEV_GATEWAY_RULES: "[]",
    OPJEV_UPSTREAM_PASSWORD: serverPassword,
  };
}

function safeAggregateName(value) {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/.test(value)
    ? value
    : undefined;
}

const AUDIT_PHASES = new Set(["planning", "ready", "running", "evaluating", "repairing", "awaiting-human", "completed", "stopped", "failed"]);
const OPJEV_PLUGIN_ID = "jev-free-router";
const OPJEV_STORAGE_NAMESPACE = [...OPJEV_PLUGIN_ID]
  .map(character => character.charCodeAt(0).toString(16).padStart(4, "0"))
  .join("");
const RESOURCE_LEDGER_KEY = "resource/usage-ledger/v1";


export function summarizeAudit(db) {
  const expectedLedgerKey = `plugin:${OPJEV_STORAGE_NAMESPACE}:${RESOURCE_LEDGER_KEY}`;
  const ledger = db.prepare("SELECT key, value FROM kv WHERE key = ?").get(expectedLedgerKey);
  if (!ledger) throw new LaunchError("Canonical resource/usage-ledger/v1 is absent.");
  const ledgerKey = ledger.key;
  const ledgerSuffix = RESOURCE_LEDGER_KEY;
  if (typeof ledgerKey !== "string" || !ledgerKey.endsWith(ledgerSuffix)) {
    throw new LaunchError("Canonical usage ledger key has an invalid namespace.");
  }
  const storagePrefix = ledgerKey.slice(0, -ledgerSuffix.length);
  const runPrefix = `${storagePrefix}orchestration/run/`;
  const stored = typeof ledger.value === "string" ? JSON.parse(ledger.value) : ledger.value;
  if (
    !stored || stored.schema !== 1 || !Array.isArray(stored.observations) ||
    stored.capacity !== 2048 || stored.observations.length > stored.capacity
  ) throw new LaunchError("Canonical usage ledger has an invalid schema or capacity.");

  const observations = stored.observations;
  const runExists = db.prepare("SELECT 1 FROM kv WHERE key = ? LIMIT 1");
  const rows = db.prepare("SELECT key, value, time_updated FROM kv WHERE key LIKE ? ORDER BY time_updated DESC, rowid DESC LIMIT 100")
    .all(`${runPrefix}%`);
  const readRuns = [];
  let invalidRunRecords = 0;
  for (const row of rows) {
    let record;
    try { record = typeof row.value === "string" ? JSON.parse(row.value) : row.value; } catch {
      invalidRunRecords += 1;
      continue;
    }
    if (!record || typeof record !== "object" || !record.state) {
      invalidRunRecords += 1;
      continue;
    }
    if (!row.key.startsWith(runPrefix)) {
      invalidRunRecords += 1;
      continue;
    }
    const runID = row.key.slice(runPrefix.length);
    if (!runID) {
      invalidRunRecords += 1;
      continue;
    }
    const state = record.state;
    if (state.contract?.runID !== runID) {
      invalidRunRecords += 1;
      continue;
    }
    if (!AUDIT_PHASES.has(state.phase)) {
      invalidRunRecords += 1;
      continue;
    }
    // ponytail: at most 100 runs × 2,048 observations (204,800 checks); index only if either bound grows.
    const runObservations = observations.filter(item => item?.runID === runID);
    const evidence = state.evidence;
    const worker = evidence?.executor;
    const workerRound = evidence?.round;
    const workerSessionID = typeof record.workerSessionID === "string" ? record.workerSessionID :
      typeof state.executor?.sessionID === "string" ? state.executor.sessionID : undefined;
    const evidenceSessionID = typeof worker?.sessionID === "string" ? worker.sessionID : undefined;
    const evidenceCurrent = evidence && evidence.round === state.round;
    const workerSessionConsistent = typeof workerSessionID === "string" && workerSessionID.length > 0 &&
      evidenceSessionID === workerSessionID &&
      (typeof record.workerSessionID !== "string" || typeof state.executor?.sessionID !== "string" || record.workerSessionID === state.executor.sessionID);
    const criticCheck = Array.isArray(evidence?.deterministicChecks)
      ? evidence.deterministicChecks.find(check => check?.name === "critic-session-outcome")
      : undefined;
    const workerRoundFacts = runObservations.filter(item =>
      item?.role === "worker" && ["round", "request", "outcome"].includes(item.kind));
    const workerRoundGroups = new Map();
    let malformedWorkerRoundFact = false;
    for (const item of workerRoundFacts) {
      if (!Number.isInteger(item.round) || typeof item.sessionID !== "string" || !item.sessionID) {
        malformedWorkerRoundFact = true;
        continue;
      }
      const key = JSON.stringify([item.round, item.sessionID]);
      const group = workerRoundGroups.get(key) ?? { roundNumber: item.round, counts: { round: 0, request: 0, outcome: 0 } };
      group[item.kind] = item;
      group.counts[item.kind] += 1;
      workerRoundGroups.set(key, group);
    }
    const hasCompleteWorkerRound = group => !!group.round && !!group.request && !!group.outcome &&
      group.counts.round === 1 && group.counts.request === 1 && group.counts.outcome === 1 &&
      typeof group.round.model === "string" && typeof group.round.agent === "string" &&
      group.round.model === group.request.model && group.round.agent === group.request.agent &&
      group.round.route === group.request.route &&
      typeof group.outcome.model === "string" && typeof group.outcome.agent === "string" &&
      typeof group.outcome.acceptance === "boolean" && typeof group.outcome.failureClass === "string";
    const workerRounds = [...new Set([...workerRoundGroups.values()].map(group => group.roundNumber))];
    const groupsByRound = round => [...workerRoundGroups.values()].filter(group => group.roundNumber === round);
    const duplicateWorkerRound = workerRounds.some(round => groupsByRound(round).length !== 1);
    const historicalRoundNumbers = Number.isInteger(state.round) && state.round > 1
      ? workerRounds.filter(round => round >= 1 && round < state.round)
      : [];
    const incompleteHistoricalRound = Number.isInteger(state.round) && state.round > 1 &&
      (historicalRoundNumbers.length !== state.round - 1 ||
        [...workerRoundGroups.values()].some(group => group.roundNumber < state.round && !hasCompleteWorkerRound(group)));
    const history = Array.isArray(state.history) ? state.history : [];
    const historyMismatch = history.some(entry => {
      if (!entry || !Number.isInteger(entry.round)) return true;
      if (!entry.verdict && !entry.outcome && !entry.executor) return false;
      const groups = groupsByRound(entry.round);
      const group = groups[0];
      return groups.length !== 1 || !hasCompleteWorkerRound(group ?? {}) ||
        !entry.executor || !entry.outcome || !entry.verdict ||
        entry.executor.agent !== group.round.agent ||
        entry.executor.agent !== group.outcome.agent || entry.executor.model !== group.outcome.model ||
        group.outcome.acceptance !== (entry.verdict.nextAction === "accept") ||
        group.outcome.failureClass !== entry.verdict.failureClass;
    });
    const workerRoundsLinked = !malformedWorkerRoundFact && !duplicateWorkerRound && workerRoundGroups.size > 0 &&
      !incompleteHistoricalRound && !historyMismatch && [...workerRoundGroups.values()].every(hasCompleteWorkerRound);
    const finalRoundGroup = Number.isInteger(workerRound) && typeof workerSessionID === "string"
      ? workerRoundGroups.get(JSON.stringify([workerRound, workerSessionID]))
      : undefined;
    const currentEvidenceRoundGroup = Number.isInteger(workerRound) && typeof evidenceSessionID === "string"
      ? workerRoundGroups.get(JSON.stringify([workerRound, evidenceSessionID]))
      : undefined;
    // OpenCode may substitute the observed model; the scheduled round and request must agree with each other.
    const currentEvidenceRoundFactsLinked = !!worker && workerSessionConsistent &&
      !!currentEvidenceRoundGroup &&
      currentEvidenceRoundGroup.counts.round === 1 &&
      currentEvidenceRoundGroup.counts.request === 1 &&
      currentEvidenceRoundGroup.counts.outcome === 0 &&
      currentEvidenceRoundGroup.round.agent === worker.agent &&
      currentEvidenceRoundGroup.request.agent === worker.agent &&
      currentEvidenceRoundGroup.round.model === currentEvidenceRoundGroup.request.model &&
      currentEvidenceRoundGroup.round.agent === currentEvidenceRoundGroup.request.agent &&
      currentEvidenceRoundGroup.round.route === currentEvidenceRoundGroup.request.route;
    const linked = !!worker && evidenceCurrent && Number.isInteger(workerRound) && typeof workerSessionID === "string" &&
      workerSessionConsistent && workerRoundsLinked &&
      hasCompleteWorkerRound(finalRoundGroup ?? {}) &&
      finalRoundGroup.outcome.model === worker.model && finalRoundGroup.outcome.agent === worker.agent;
    const persistedWorkerSessionID = typeof record.workerSessionID === "string" ? record.workerSessionID || undefined :
      typeof state.executor?.sessionID === "string" && state.executor.sessionID ? state.executor.sessionID : undefined;
    const currentRoundSessions = new Set(workerRoundFacts
      .filter(item => item.round === state.round && typeof item.sessionID === "string" && item.sessionID.length > 0)
      .map(item => item.sessionID));
    const failureKinds = ["provider-error", "throttle", "quota-limit", "context-overflow", "operational-failure"];
    const failureDomains = ["provider", "quota", "context", "execution", "operational"];
    const currentRoundFailureObservations = runObservations.filter(item =>
      item.role === "worker" && item.round === state.round &&
      failureKinds.includes(item.kind) && failureDomains.includes(item.failureDomain));
    const currentRoundWorkerSessions = new Set([
      ...currentRoundSessions,
      ...currentRoundFailureObservations
        .filter(item => typeof persistedWorkerSessionID === "string" && persistedWorkerSessionID.length > 0 &&
          typeof item.sessionID === "string" && item.sessionID.length > 0 && item.sessionID === persistedWorkerSessionID)
        .map(item => item.sessionID),
    ]);
    const priorRoundSessions = new Set(workerRoundFacts
      .filter(item => item.round < state.round && typeof item.sessionID === "string" && item.sessionID.length > 0)
      .map(item => item.sessionID));
    const persistedSessionIsPrior = typeof persistedWorkerSessionID === "string" &&
      priorRoundSessions.has(persistedWorkerSessionID);
    const currentWorkerSessionID = evidenceCurrent && typeof evidenceSessionID === "string"
      ? evidenceSessionID
      : currentRoundWorkerSessions.size === 1
        ? [...currentRoundWorkerSessions][0]
        : currentRoundWorkerSessions.size === 0 && typeof persistedWorkerSessionID === "string" &&
          (!persistedSessionIsPrior || state.phase === "running" && record.checkpoint === "run-failed")
          ? persistedWorkerSessionID
          : undefined;
    const currentWorkerStarted = !!evidenceCurrent || currentRoundWorkerSessions.size > 0 ||
      currentRoundFailureObservations.length > 0 || typeof currentWorkerSessionID === "string";
    const expectedAgent = state.executor?.agent ?? record.selection?.agent;
    const expectedModel = state.executor?.model ?? record.selection?.model;
    const hasGovernedFailure = currentRoundFailureObservations.some(item =>
      typeof persistedWorkerSessionID === "string" && persistedWorkerSessionID.length > 0 &&
      typeof item.sessionID === "string" && item.sessionID.length > 0 &&
      typeof currentWorkerSessionID === "string" && currentWorkerSessionID.length > 0 &&
      item.sessionID === persistedWorkerSessionID && item.sessionID === currentWorkerSessionID &&
      item.agent === expectedAgent && item.model === expectedModel);
    const unlinkedCurrentRoundFailure = currentRoundFailureObservations.some(item =>
      typeof persistedWorkerSessionID !== "string" || !persistedWorkerSessionID ||
      typeof item.sessionID !== "string" || !item.sessionID ||
      item.sessionID !== persistedWorkerSessionID);
    const ambiguousInterrupt = runObservations.some(item =>
      ["worker", "critic", "orchestrator"].includes(item.role) && item.errorCode === "interrupt-unconfirmed");
    const currentVerdictApplied = history.some(entry => entry?.round === state.round && entry.verdict) ||
      (!history.length && !!state.lastVerdict);
    const terminal = ["completed", "stopped", "awaiting-human"].includes(state.phase);
    const preEvidenceFailure = state.phase === "failed" && currentWorkerStarted && !evidenceCurrent &&
      hasGovernedFailure && !ambiguousInterrupt;
    const postEvidencePreVerdict = state.phase === "failed" && !!evidenceCurrent &&
      !currentVerdictApplied && !ambiguousInterrupt;
    const ambiguousRunState = state.phase === "running" && record.checkpoint === "run-failed" && currentWorkerStarted;
    const pending = ["planning", "ready", "running", "evaluating", "repairing"].includes(state.phase) && !ambiguousRunState;
    const evidenceInconsistency = unlinkedCurrentRoundFailure ||
      malformedWorkerRoundFact || incompleteHistoricalRound || historyMismatch || duplicateWorkerRound ||
      terminal && (!evidenceCurrent || !currentVerdictApplied || !linked) ||
      state.phase === "failed" && currentWorkerStarted && !evidenceCurrent &&
        !hasGovernedFailure && !ambiguousInterrupt ||
      state.phase === "failed" && !!evidenceCurrent && !currentVerdictApplied && !ambiguousInterrupt &&
        !currentEvidenceRoundFactsLinked ||
      state.phase === "failed" && !!evidenceCurrent && currentVerdictApplied && !linked;
    const maxObservedRound = workerRounds.length ? Math.max(...workerRounds) : 0;
    readRuns.push({
      phase: state.phase,
      checkpoint: record.checkpoint,
      workerStarted: currentWorkerStarted,
      incompleteHistoricalRound,
      selectionVia: record.selection?.via,
      model: safeAggregateName(worker?.model) ?? safeAggregateName(record.selection?.model),
      agent: safeAggregateName(worker?.agent) ?? safeAggregateName(record.selection?.agent),
      route: safeAggregateName(runObservations.find(item => item.kind === "outcome" || item.kind === "request")?.route) ??
        safeAggregateName(record.selection?.route),
      evidence: !!evidenceCurrent,
      critic: typeof record.criticSessionID === "string" && !!criticCheck,
      criticStatus: criticCheck?.status,
      verdict: currentVerdictApplied,
      linked,
      accepted: state.phase === "completed" && state.lastVerdict?.nextAction === "accept",
      budgetExceeded: Number.isInteger(state.contract?.maxRounds) && maxObservedRound > state.contract.maxRounds,
      roundViolation: malformedWorkerRoundFact || incompleteHistoricalRound || historyMismatch || duplicateWorkerRound,
      preEvidenceFailure,
      postEvidencePreVerdict,
      ambiguousRunState,
      pending,
      ambiguousInterrupt,
      evidenceInconsistency,
    });
  }

  const terminalMissing = readRuns.filter(run => run.evidenceInconsistency).length;
  const observedRunIDs = new Set(observations.map(item => item?.runID).filter(value => typeof value === "string" && value.length > 0));
  const orphanedRunLinks = [...observedRunIDs]
    .filter(runID => !runExists.get(`${runPrefix}${runID}`)).length;
  const preWorkerFailures = readRuns.filter(run => run.phase === "failed" && !run.workerStarted && !run.evidence).length;
  const governedPreEvidenceFailures = readRuns.filter(run => run.preEvidenceFailure).length;
  const postEvidencePreVerdictFailures = readRuns.filter(run => run.postEvidencePreVerdict).length;
  const pendingRuns = readRuns.filter(run => run.pending).length;
  const ambiguousInterruptions = readRuns.filter(run => run.ambiguousInterrupt).length;
  const ambiguousRuns = readRuns.filter(run => run.ambiguousRunState).length;
  const evidenceInconsistencies = terminalMissing;
  const roundViolations = readRuns.filter(run => run.roundViolation).length;
  const missingLinks = evidenceInconsistencies + orphanedRunLinks + invalidRunRecords;
  const roundLimitViolations = readRuns.filter(run => run.budgetExceeded).length;
  const phases = Object.fromEntries(Object.entries(Object.groupBy(readRuns, run => run.phase ?? "unknown")).map(([phase, runs]) => [phase, runs.length]));
  const agents = [...new Set(readRuns.map(run => run.agent).filter(Boolean))].sort();
  const models = [...new Set(readRuns.map(run => run.model).filter(Boolean))].sort();
  const routes = [...new Set(readRuns.map(run => run.route).filter(Boolean))].sort();
  const sessions = new Set(observations.map(item => item?.sessionID).filter(value => typeof value === "string")).size;
  const viaJev = readRuns.filter(run => run.selectionVia === "jev").length;
  const viaHeuristic = readRuns.filter(run => run.selectionVia === "heuristic").length;
  const tokenEntries = observations.filter(item => item?.kind === "token-usage" && item.tokens);
  const tokenTotals = {};
  for (const item of tokenEntries) {
    for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite"]) {
      const value = item.tokens[key];
      if (Number.isSafeInteger(value) && value >= 0) tokenTotals[key] = (tokenTotals[key] ?? 0) + value;
    }
  }
  const outcomes = observations.filter(item => item?.kind === "outcome");
  const acceptanceTrue = outcomes.filter(item => item.acceptance === true).length;
  const acceptanceFalse = outcomes.filter(item => item.acceptance === false).length;
  const failureClasses = ["none", "implementation", "reasoning", "missing-context", "wrong-agent", "wrong-model", "environment", "bad-contract"]
    .map(name => `${name}:${outcomes.filter(item => item.failureClass === name).length}`)
    .filter(item => !item.endsWith(":0"));
  const observationCount = kind => observations.filter(item => item?.kind === kind).length;
  const criticCounts = ["pass", "fail", "unknown"]
    .map(status => `${status}:${readRuns.filter(run => run.critic && run.criticStatus === status).length}`)
    .filter(item => !item.endsWith(":0"));
  return {
    schema: stored.schema,
    capacity: stored.capacity,
    observations: observations.length,
    canonicalRunsInspected: readRuns.length,
    invalidRunRecords,
    phases,
    viaJev,
    viaHeuristic,
    evidencePackets: readRuns.filter(run => run.evidence).length,
    criticChecks: readRuns.filter(run => run.critic).length,
    criticCounts,
    verdicts: readRuns.filter(run => run.verdict).length,
    linked: readRuns.filter(run => run.linked).length,
    missingLinks,
    preWorkerFailures,
    governedPreEvidenceFailures,
    postEvidencePreVerdictFailures,
    pendingRuns,
    ambiguousInterruptions,
    ambiguousRuns,
    evidenceInconsistencies,
    roundViolations,
    orphanedRunLinks,
    roundLimitViolations,
    rounds: observationCount("round"),
    requests: observationCount("request"),
    outcomes: outcomes.length,
    recoveries: observationCount("recovery"),
    providerFailures: observationCount("provider-error"),
    operationalFailures: observationCount("operational-failure"),
    acceptanceTrue,
    acceptanceFalse,
    failureClasses,
    accepted: readRuns.filter(run => run.accepted).length,
    sessions,
    agents,
    models,
    routes,
    tokenEntries: tokenEntries.length,
    tokenTotals,
    auditFailed: missingLinks > 0 || roundLimitViolations > 0 || roundViolations > 0 || ambiguousInterruptions > 0 || ambiguousRuns > 0,
  };
}

async function audit() {
  let db;
  try {
    if (!launcherRootExists()) throw new LaunchError("Dedicated dogfood profile is unavailable; no database was read.");
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    const summary = summarizeAudit(db);
    console.log(`[opjev] read-only ledger: observations=${summary.observations}/${summary.capacity}; canonical runs inspected=${summary.canonicalRunsInspected} (latest 100); schema=${summary.schema}`);
    console.log(`[opjev] runs: completed=${summary.phases.completed ?? 0}; failed=${summary.phases.failed ?? 0}; pre-worker-failures=${summary.preWorkerFailures}; awaiting-human=${summary.phases["awaiting-human"] ?? 0}; jev-live-selection=${summary.viaJev}; heuristic-selection=${summary.viaHeuristic}`);
    console.log(`[opjev] failures: governed-pre-evidence=${summary.governedPreEvidenceFailures}; post-evidence-pre-verdict=${summary.postEvidencePreVerdictFailures}; pending=${summary.pendingRuns}; ambiguous-interruptions=${summary.ambiguousInterruptions}; ambiguous-runs=${summary.ambiguousRuns}; evidence-inconsistencies=${summary.evidenceInconsistencies}; round-violations=${summary.roundViolations}`);
    console.log(`[opjev] evidence: packets=${summary.evidencePackets}; critic-checks=${summary.criticChecks}; critic-status={${summary.criticCounts.join(",") || "none"}}; verdicts=${summary.verdicts}; ledger-linked=${summary.linked}; missing-link=${summary.missingLinks}; orphaned-run-links=${summary.orphanedRunLinks}; invalid-run-records=${summary.invalidRunRecords}; round-limit-violations=${summary.roundLimitViolations}`);
    console.log(`[opjev] facts: rounds=${summary.rounds}; requests=${summary.requests}; outcomes=${summary.outcomes}; recovery=${summary.recoveries}; provider-failures=${summary.providerFailures}; operational-failures=${summary.operationalFailures}`);
    console.log(`[opjev] outcome facts: acceptance=true:${summary.acceptanceTrue},false:${summary.acceptanceFalse},unknown:${summary.outcomes - summary.acceptanceTrue - summary.acceptanceFalse}; failure-class={${summary.failureClasses.join(",") || "none"}}`);
    console.log(`[opjev] accepted=${summary.accepted}; recoveries=${summary.recoveries}; sessions=${summary.sessions}; agents=${summary.agents.join(",") || "none"}; models=${summary.models.join(",") || "none"}; routes=${summary.routes.join(",") || "none"}; token-usage-records=${summary.tokenEntries}; tokens=${Object.keys(summary.tokenTotals).length ? JSON.stringify(summary.tokenTotals) : "not reported by runtime"}`);
    if (summary.auditFailed) process.exitCode = 1;
  } catch (err) {
    console.error(`[opjev] audit blocked: ${err instanceof LaunchError ? err.message : "database unavailable or schema mismatch; raw storage was not displayed"}`);
    process.exitCode = 1;
  } finally {
    try { db?.close(); } catch { /* read-only connection cleanup */ }
  }
}

function status() {
  if (!launcherRootExists()) { console.log("[opjev] stopped; no active launcher"); return; }
  const record = readLock();
  if (!record) { console.log("[opjev] stopped; no active launcher"); return; }
  if (record.invalid) { console.error("[opjev] process lock unreadable; it was preserved"); process.exitCode = 1; return; }
  if (pidAlive(record.pid)) {
    console.log(`[opjev] running: launcher=${record.pid}; server=${record.serverPort ?? "starting"}; gateway=${record.gatewayPort ?? "starting"}`);
    return;
  }
  const children = [record.gatewayPid, record.serverPid].filter(pidAlive);
  if (children.length) {
    console.error("[opjev] orphaned managed child process detected; no process was stopped or started");
    process.exitCode = 1;
    return;
  }
  console.log(`[opjev] stopped; stale lock remains (${LOCK_PATH}); no process was started. Remove it only after verifying every managed PID is absent.`);
}

function help() {
  console.log("Usage: opjev [--continue | --session ID] | opjev status | opjev audit");
  console.log("Run from the project directory. User prompts always connect through the isolated OPJEV gateway.");
}

async function launch(sessionArgs) {
  if (!launcherRootExists()) throw new LaunchError("Dedicated OPJEV install root is unavailable; no lock was created.");
  const lock = acquireLock();
  let server;
  let gateway;
  let tui;
  let gatewayPort;
  let signalCode = 0;
  let shutdownPromise;
  const shutdown = () => shutdownPromise ??= (async () => {
    await stopChild(tui);
    await stopChild(gateway);
    await stopChild(server);
  })();
  const onSignal = signal => {
    signalCode = signal === "SIGINT" ? 130 : 143;
    void shutdown();
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const apiKey = readZenKey();
    const base = baseEnvironment();
    await verifyRuntime();
    await verifyJev(apiKey);
    if (signalCode) throw new LaunchError("Startup interrupted; no OpenCode session was started.");

    privateDirectory(PROFILE_HOME);
    privateDirectory(path.join(PROFILE_HOME, ".config"));
    privateDirectory(CONFIG_DIR);
    ownedProfileDirectory(path.join(CONFIG_DIR, "plugins"));
    privateDirectory(path.join(PROFILE_HOME, ".cache"));
    privateDirectory(path.join(PROFILE_HOME, ".local"));
    privateDirectory(path.join(PROFILE_HOME, ".local", "share"));
    privateDirectory(DATA_DIR);
    privateDirectory(path.join(PROFILE_HOME, ".local", "state"));
    verifyProfileConfig();
    try { installPluginToHome(PROFILE_HOME, REPO); } catch {
      throw new LaunchError("Could not safely install OPJEV into its isolated profile; preexisting destinations were preserved.");
    }

    const password = crypto.randomBytes(32).toString("base64url");
    const serverPort = await freeLoopbackPort();
    if (signalCode) throw new LaunchError("Startup interrupted; no OpenCode session was started.");
    const serverOrigin = `http://127.0.0.1:${serverPort}`;
    const serverEnv = { ...base, OPENCODE_SERVER_PASSWORD: password, OPENCODE_API_KEY: apiKey };
    server = spawnCaptured(RUNTIME, ["serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], {
      cwd: process.cwd(), env: serverEnv,
    }, () => {});
    updateLock(lock, { serverPid: server.pid, serverPort });
    const serverAuth = basicAuth(password);
    await waitFor(async () => (await serverInfo(serverOrigin, serverAuth))?.version === RUNTIME_VERSION, server, 45000, "OpenCode 2.0.11 server");
    if (signalCode) throw new LaunchError("Startup interrupted; no OpenCode session was started.");
    await verifyPluginRpc(serverOrigin, serverAuth);
    if (signalCode) throw new LaunchError("Startup interrupted; no OpenCode session was started.");

    let readyPort;
    gateway = spawnCaptured(process.execPath, [path.join(REPO, "src", "gateway", "main.ts")], {
      cwd: REPO,
      env: createGatewayEnv(base, password, serverOrigin),
    }, line => consumeGatewayLine(line, port => { readyPort = port; }));
    updateLock(lock, { gatewayPid: gateway.pid, serverPid: server.pid, serverPort });
    await waitFor(async () => readyPort !== undefined, gateway, 15000, "OPJEV gateway");
    gatewayPort = readyPort;
    updateLock(lock, { gatewayPid: gateway.pid, serverPid: server.pid, serverPort, gatewayPort });
    const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
    await waitFor(async () => (await serverInfo(gatewayOrigin, serverAuth))?.version === RUNTIME_VERSION, gateway, 15000, "gateway to OpenCode 2.0.11 connection");

    if (signalCode) throw new LaunchError("Startup interrupted; no OpenCode session was started.");
    console.log(`[opjev] active: OpenCode CLI/server ${RUNTIME_VERSION}; isolated OPJEV server/TUI plugin; default admission=orchestrate; Jev live authenticated.`);
    console.log("[opjev] All interactive prompts in this TUI use the local gateway; user project/global OpenCode config was not changed.");
    const tuiEnv = { ...base, OPENCODE_PASSWORD: password, OPENCODE_API_KEY: apiKey };
    let tuiSpawnError = false;
    tui = spawn(RUNTIME, ["--server", gatewayOrigin, ...sessionArgs], {
      cwd: process.cwd(), env: tuiEnv, stdio: "inherit",
    });
    tui.on("error", () => { tuiSpawnError = true; });
    Object.defineProperty(tui, "spawnErrorSeen", { get: () => tuiSpawnError });
    updateLock(lock, { gatewayPid: gateway.pid, serverPid: server.pid, serverPort, gatewayPort, tuiPid: tui.pid });
    const result = await waitForExit(tui);
    if (result.code !== 0 && !signalCode) throw new LaunchError("OpenCode TUI exited with an error; process output was not copied to a log.");
  } finally {
    await shutdown();
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    lock.release();
    if (gateway) {
      console.log(`[opjev] gateway counters: orchestrate-intercept=${counters.intercept}; admission=${counters.admitted}; dispatch=${counters.dispatched}; duplicate-suppressed=${counters.duplicates}; fail-closed=${counters.failClosed}`);
    }
  }
  if (signalCode) process.exitCode = signalCode;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) return launch([]);
  if (args[0] === "--help" || args[0] === "-h") return help();
  if (args[0] === "status" && args.length === 1) return status();
  if (args[0] === "audit" && args.length === 1) return audit();
  if (args[0] === "install" || args[0] === "restore" || args[0] === "serve") {
    throw new LaunchError("This launcher manages one foreground session only; use the documented status/audit commands.");
  }
  let sessionArgs;
  try { sessionArgs = parseSessionArgs(args); } catch (err) { throw new LaunchError(err.message); }
  await launch(sessionArgs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(err => {
    console.error(`[opjev] BLOCKED: ${err instanceof LaunchError ? err.message : "unexpected startup error; no raw credential, prompt, output, or child log was displayed"}`);
    process.exitCode = 1;
  });
}
