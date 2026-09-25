#!/usr/bin/env node
// E2E real da issue #24 — gateway de admission deterministico contra runtime
// OpenCode v2.0.11 AUTORITATIVO, com TUI real por tras do gateway.
//
// NAO roda em `npm test` (rede/fronteira real por design; a suíte hermetica
// continua sendo a garantia de regressao). Reproduzivel:
//
//   OPENCODE_BIN=/tmp/opencode-2.0.11/package/bin/opencode \
//     node scripts/e2e-gateway.mjs
//
// Topologia:
//   cliente (fetch/TUI real) -> GATEWAY (src/gateway/main.ts)
//                              -> SNIFFER (evidencia transparente)
//                              -> `opencode serve` v2.0.11 (+ plugin opjev)
//   gateway -> POST /api/rpc/opjev.admission.v1/orchestrate (RPC do plugin)
//
// Canaries do gate duro: intercept=1, admission=1, parent=0, RPC=1, run=1,
// worker=1, publicacao de resultado sem wake. Evidencia crua em
// $E2E_ROOT/runs/<ts>/ (logs, JSONL do sniffer, dump do PTY, resultado JSON).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.OPENCODE_BIN ?? "/tmp/opencode-2.0.11/package/bin/opencode";
const ROOT = process.env.E2E_ROOT ?? "/tmp/opjev-e2e";
const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(ROOT, "runs", RUN_TS);

const T = {
  boot: 60000,
  dispatch: 30000,
  exec: 120000,
  notice: 300000,
  tuiTotal: 540000,
};

// ---------------------------------------------------------------- utilidades
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stdout.write(`[e2e] ${msg}\n`);

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
      throw new Error(
        `timeout em '${label}' (${timeoutMs}ms)${lastErr ? `: ${lastErr.message}` : ""}`,
      );
    }
    await sleep(500);
  }
}

const results = [];
function assert(name, pass, detail = "", required = true) {
  results.push({ name, pass: Boolean(pass), required, detail: String(detail).slice(0, 600) });
  log(`${pass ? "PASS" : required ? "FAIL" : "note"} ${name}${detail ? ` — ${detail}` : ""}`);
  return Boolean(pass);
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const children = [];
function spawnCapture(cmd, args, { env, cwd, label }) {
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
    try {
      rec.child.kill("SIGTERM");
    } catch {
      // ja morto
    }
  }
}
process.on("SIGINT", () => {
  killAll();
  process.exit(130);
});

// ------------------------------------------------------------ eventos gateway
const gwEvents = [];
function pushGwLine(line) {
  if (line.trim() === "") return;
  try {
    const obj = JSON.parse(line);
    if (obj && typeof obj.type === "string") gwEvents.push(obj);
  } catch {
    // linha humana (ex.: "ouvindo em ...") — ja esta no arquivo de log
  }
}
const gwCount = (type, pred) =>
  gwEvents.filter((e) => e.type === type && (pred === undefined || pred(e))).length;
const since = (mark) => gwEvents.slice(mark);

// ------------------------------------------------------------- eventos SSE
const sseEvents = [];
async function startSseObserver(origin, auth) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const res = await fetch(`${origin}/api/event`, {
        headers: { authorization: auth, accept: "text/event-stream" },
        signal: AbortSignal.timeout(6 * 60 * 60 * 1000),
      });
      if (!res.ok || res.body === null) throw new Error(`SSE HTTP ${res.status}`);
      log(`observer SSE conectado (tentativa ${attempt})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = sseBuf.indexOf("\n\n")) >= 0) {
          const block = sseBuf.slice(0, idx);
          sseBuf = sseBuf.slice(idx + 2);
          for (const l of block.split("\n")) {
            if (l.startsWith("data:")) {
              const raw = l.slice(5).trim();
              const obj = tryParse(raw);
              if (obj && typeof obj.type === "string") {
                sseEvents.push({ t: Date.now(), raw, type: obj.type });
              }
            }
          }
        }
      }
      throw new Error("SSE fechado pelo servidor");
    } catch (err) {
      if (attempt >= 4) throw err;
      log(`SSE reconectando (${err.message})`);
      await sleep(1500);
    }
  }
}

const execStartedCount = (sessionID) =>
  sseEvents.filter(
    (e) => e.type.includes("execution.started") && e.raw.includes(`"sessionID":"${sessionID}"`),
  ).length;

// ----------------------------------------------------------------- sniffer
const sniffEvents = [];
let sniffOffset = 0;
let sniffRemain = "";
function pollSniffer(sniffLog) {
  let buf;
  try {
    buf = fs.readFileSync(sniffLog);
  } catch {
    return;
  }
  if (buf.length <= sniffOffset) return;
  const text = sniffRemain + buf.subarray(sniffOffset).toString("utf8");
  sniffOffset = buf.length;
  const parts = text.split("\n");
  sniffRemain = parts.pop() ?? "";
  for (const line of parts) {
    if (line.trim() === "") continue;
    const obj = tryParse(line);
    if (obj) sniffEvents.push(obj);
  }
}
const sniffCount = (pred) => sniffEvents.filter(pred).length;

// --------------------------------------------------------------------- API
function makeApi(origin, auth) {
  return async function api(method, apiPath, body) {
    const res = await fetch(`${origin}${apiPath}`, {
      method,
      headers: {
        authorization: auth,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    return { status: res.status, text };
  };
}

function parseDataId(text) {
  const obj = tryParse(text);
  if (obj?.data && typeof obj.data.id === "string") return obj.data.id;
  const m = /"id"\s*:\s*"(ses_[A-Za-z0-9]+)"/.exec(text);
  return m ? m[1] : null;
}

function extractMsgId(text) {
  const m = /"id"\s*:\s*"(msg_[A-Za-z0-9]+)"/.exec(text);
  return m ? m[1] : null;
}

const sesIds = (text) => [...text.matchAll(/"id"\s*:\s*"(ses_[A-Za-z0-9]+)"/g)].map((m) => m[1]);

// ==================================================================== E2E
async function main() {
  if (!fs.existsSync(BIN)) {
    log(`binario nao encontrado: ${BIN} (defina OPENCODE_BIN)`);
    process.exit(2);
  }
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const projectDir = path.join(RUN_DIR, "project");
  const homeDir = path.join(RUN_DIR, "home");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const gwLogPath = path.join(RUN_DIR, "gateway.log");
  const upLogPath = path.join(RUN_DIR, "upstream.log");
  const sniffLogPath = path.join(RUN_DIR, "http.jsonl");
  const ptyDumpPath = path.join(RUN_DIR, "pty-dump.bin");
  const tuiSpecPath = path.join(RUN_DIR, "tui-spec.json");
  const tuiCanaryPath = path.join(RUN_DIR, "tui-notice.canary");
  const resultPath = path.join(RUN_DIR, "e2e-result.json");

  fs.writeFileSync(
    path.join(projectDir, "opencode.json"),
    `${JSON.stringify({ plugins: [{ package: REPO }] }, null, 2)}\n`,
  );

  // ---------------------------------------------------- 1. upstream serve
  const upPort = await freePort();
  const upstreamEnv = {
    PATH: process.env.PATH ?? "",
    HOME: homeDir,
    ...(process.env.OPENCODE_API_KEY ? { OPENCODE_API_KEY: process.env.OPENCODE_API_KEY } : {}),
  };
  log(`subindo upstream v2.0.11 em :${upPort} (HOME ${homeDir})`);
  const up = spawnCapture(
    BIN,
    ["serve", "--hostname", "127.0.0.1", "--port", String(upPort)],
    { env: upstreamEnv, cwd: projectDir, label: "upstream" },
  );
  const upLogFd = fs.openSync(upLogPath, "a");
  let upFlushed = 0;
  const upFlush = setInterval(() => {
    const text = up.lines.join("\n");
    if (text.length > upFlushed) {
      try {
        fs.writeSync(upLogFd, text.slice(upFlushed));
        upFlushed = text.length;
      } catch {
        // melhor esforco
      }
    }
  }, 400);

  let pw = "";
  await waitFor(() => {
    const m = /server password (\S+)/.exec(up.lines.join("\n"));
    if (m) pw = m[1];
    return pw !== "";
  }, T.boot, "senha do upstream no log");

  const auth = `Basic ${Buffer.from(`opencode:${pw}`, "utf8").toString("base64")}`;
  const upOrigin = `http://127.0.0.1:${upPort}`;
  await waitFor(async () => {
    const res = await fetch(`${upOrigin}/api/info`, {
      headers: { authorization: auth },
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    return res !== null && res.status === 200;
  }, T.boot, "upstream /api/info 200");
  const upInfo = await (await fetch(`${upOrigin}/api/info`, { headers: { authorization: auth } })).json();
  assert("upstream e v2.0.11 (runtime autoritativo)", upInfo?.version === "2.0.11", `version=${upInfo?.version}`);
  clearInterval(upFlush);
  try {
    const text = up.lines.join("\n");
    if (text.length > upFlushed) fs.writeSync(upLogFd, text.slice(upFlushed));
    fs.closeSync(upLogFd);
  } catch {
    // ja fechado
  }

  // ---------------------------------------------------------- 2. sniffer
  const sniffPort = await freePort();
  const sniffer = spawnCapture(process.execPath, [path.join(REPO, "scripts", "e2e-sniffer.mjs")], {
    env: {
      ...process.env,
      E2E_SNIFF_UPSTREAM: upOrigin,
      E2E_SNIFF_PORT: String(sniffPort),
      E2E_SNIFF_LOG: sniffLogPath,
    },
    cwd: REPO,
    label: "sniffer",
  });
  await waitFor(() => sniffer.lines.some((l) => l.includes("[sniffer]")), 10000, "sniffer boot");
  setInterval(() => pollSniffer(sniffLogPath), 1000);
  log(`sniffer :${sniffPort} -> upstream`);

  // --------------------------------------------------------- 3. gateway
  const gwEnv = {
    PATH: process.env.PATH ?? "",
    HOME: homeDir,
    OPJEV_GATEWAY_ENABLED: "1",
    OPJEV_GATEWAY_UPSTREAM: `http://127.0.0.1:${sniffPort}`,
    OPJEV_GATEWAY_HOST: "127.0.0.1",
    OPJEV_GATEWAY_PORT: "0",
    OPJEV_GATEWAY_RULES: JSON.stringify([
      { prefix: "ORCH:", mode: "orchestrate" },
      { prefix: "ROUTE:", mode: "route" },
    ]),
    OPJEV_UPSTREAM_PASSWORD: pw,
    OPJEV_GATEWAY_RPC_TIMEOUT_MS: "30000",
    OPJEV_GATEWAY_ROUTE_TIMEOUT_MS: "20000",
  };
  log("subindo gateway (node src/gateway/main.ts)");
  const gw = spawnCapture(process.execPath, [path.join("src", "gateway", "main.ts")], {
    env: gwEnv,
    cwd: REPO,
    label: "gateway",
  });
  const gwLogFd = fs.openSync(gwLogPath, "a");
  let gwConsumed = 0;
  const gwPump = setInterval(() => {
    while (gw.lines.length > gwConsumed) {
      const line = gw.lines[gwConsumed];
      gwConsumed += 1;
      pushGwLine(line);
      try {
        fs.writeSync(gwLogFd, `${line}\n`);
      } catch {
        // melhor esforco
      }
    }
  }, 200);

  const listening = await waitFor(() => {
    const line = gw.lines.find((l) => l.includes('"type":"listening"'));
    if (!line) return null;
    return tryParse(line)?.port ?? null;
  }, 15000, "gateway listening");
  const gwOrigin = `http://127.0.0.1:${listening}`;
  log(`gateway em ${gwOrigin} -> sniffer :${sniffPort}`);
  const api = makeApi(gwOrigin, auth);

  // --------------------------------------- 4. probes de RPC (via gateway)
  await sleep(2500); // plugin load no boot do serve
  const ctl = await api("POST", "/api/rpc/opjev.admission.v1/__nao_existe", { input: {} });
  const probe = await api("POST", "/api/rpc/opjev.admission.v1/orchestrate", { input: {} });
  const ctlType = tryParse(ctl.text)?.type ?? "";
  const probeType = tryParse(probe.text)?.type ?? "";
  const upLogTextEarly = fs.existsSync(upLogPath) ? fs.readFileSync(upLogPath, "utf8") : up.lines.join("\n");
  const regError = upLogTextEarly.includes("rpc de admission indisponivel");
  // Diferencial provado no pre-flight: metodo desconhecido = rpc.method_not_found;
  // schema valido da def (registrada) rejeita input vazio = rpc.invalid_input.
  const registered =
    ctlType === "rpc.method_not_found" &&
    (probeType === "rpc.invalid_input" || /sessionID/.test(probe.text)) &&
    probe.text !== ctl.text &&
    !regError;
  assert(
    "RPC opjev.admission.v1 registrada no plugin (pre-flight differential)",
    registered,
    `ctl=${ctl.status}/${ctlType} probe=${probe.status}/${probeType} regError=${regError}`,
  );

  const info = await api("GET", "/api/info");
  const infoObj = tryParse(info.text);
  assert(
    "proxy transparente: /api/info via gateway = 2.0.11",
    info.status === 200 && infoObj?.version === "2.0.11",
    `status=${info.status} version=${infoObj?.version}`,
  );

  // ------------------------------------------------------ 5. observer SSE
  // Roda em BACKGROUND por design: a conexao SSE permanece aberta durante
  // todo o E2E, entao aguardar sua conclusao travaria todas as fases
  // seguintes (falsificavel: com `await`, nenhuma sessao jamais e criada).
  startSseObserver(gwOrigin, auth).catch((err) => {
    log(`observer SSE encerrado: ${err.message.slice(0, 200)}`);
  });

  // ---------------------------------------------- 6. fase NORMAL (API)
  const normal = { sid: null };
  try {
    const mk = await api("POST", "/api/session", {});
    normal.sid = parseDataId(mk.text);
    if (normal.sid === null) throw new Error(`criacao de sessao falhou: ${mk.text.slice(0, 200)}`);
    const mark = gwEvents.length;
    const r = await api("POST", `/api/session/${normal.sid}/prompt`, {
      text: "Responda somente com a palavra PONG.",
    });
    assert(
      "normal: prompt 200 com identidade msg_",
      r.status === 200 && extractMsgId(r.text) !== null,
      `status=${r.status} msg=${extractMsgId(r.text)}`,
    );
    await waitFor(
      () => since(mark).some((e) => e.type === "intercept" && e.mode === "normal"),
      15000,
      "intercept mode=normal",
    );
    const forwarded = since(mark).filter((e) => e.type === "intercept" && e.mode === "normal").length;
    assert("normal: exatamente 1 interceptacao/forward (transparente)", forwarded === 1, `intercepts=${forwarded}`);
    await waitFor(() => execStartedCount(normal.sid) >= 1, T.exec, "execucao do parent (normal)");
    assert(
      "normal: execucao NATIVA acontece (OpenCode segue funcionando)",
      execStartedCount(normal.sid) >= 1,
      `execStarted=${execStartedCount(normal.sid)}`,
    );
    const msgs = await waitFor(async () => {
      const res = await api("GET", `/api/session/${normal.sid}/message`);
      // Forma real do transcript v2.0.11 (wire): {"data":[{..., "type":"assistant", ...}]}
      return /"type"\s*:\s*"assistant"/.test(res.text) ? res : null;
    }, T.exec, "resposta nativa no transcript");
    assert(
      "normal: resposta nativa chega ao transcript",
      /"type"\s*:\s*"assistant"/.test(msgs.text),
      `assistantInTranscript=${/"type"\s*:\s*"assistant"/.test(msgs.text)}`,
    );
  } catch (err) {
    assert("fase normal", false, err.message);
  }

  // ------------------------------------------- 7. fase ORCHESTRATE (API)
  const orch = { sid: null, runID: null, notice: "", k1: 0 };
  try {
    const mark = gwEvents.length;
    const sessMark = await api("GET", "/api/session");
    const beforeIds = new Set(sesIds(sessMark.text));
    const mk = await api("POST", "/api/session", {});
    orch.sid = parseDataId(mk.text);
    if (orch.sid === null) throw new Error(`criacao de sessao falhou: ${mk.text.slice(0, 200)}`);
    const execBefore = execStartedCount(orch.sid);
    const startT = Date.now();
    const r = await api("POST", `/api/session/${orch.sid}/prompt`, {
      text: "ORCH: responda apenas com a palavra PRONTO.",
    });
    assert(
      "orchestrate: 200 com identidade duravel",
      r.status === 200 && extractMsgId(r.text) !== null,
      `status=${r.status} msg=${extractMsgId(r.text)}`,
    );

    await waitFor(
      () =>
        since(mark).some((e) => e.type === "intercept" && e.mode === "orchestrate") &&
        since(mark).some((e) => e.type === "admitted" && e.sessionID === orch.sid),
      T.dispatch,
      "intercept+admitted orchestrate",
    );
    const admittedEv = since(mark).find((e) => e.type === "admitted" && e.sessionID === orch.sid);
    orch.runID = admittedEv?.runID ?? null;
    assert(
      "orchestrate: admission registrada (intercept=1, admitted=1)",
      admittedEv !== undefined,
      `runID=${orch.runID}`,
    );
    await waitFor(() => since(mark).some((e) => e.type === "rpc-dispatched"), T.dispatch, "rpc-dispatched");
    const dispatched = since(mark).filter((e) => e.type === "rpc-dispatched").length;
    assert("orchestrate: EXATAMENTE 1 dispatch de RPC (run=1)", dispatched === 1, `dispatched=${dispatched}`);

    // persist-first: item duravel no inbox com o texto do prompt
    const inbox = await waitFor(async () => {
      const res = await api("GET", `/api/session/${orch.sid}/inbox`);
      return res.text.includes("ORCH: responda") ? res : null;
    }, 20000, "prompt persistido no inbox");
    assert("orchestrate: input preservado no inbox (persist-first)", inbox.status === 200, "texto do prompt duravel");

    // conclusao assincrona -> notice publicado sem wake
    const noticeRes = await waitFor(async () => {
      const res = await api("GET", `/api/session/${orch.sid}/inbox`);
      return /Orquestracao/.test(res.text) ? res : null;
    }, T.notice, "notice de resultado publicado");
    const nm = /Orquestracao[^"\\]{0,200}/.exec(noticeRes.text);
    orch.notice = nm ? nm[0] : "";
    assert(
      "orchestrate: resultado PUBLICADO (notice synthetic) sem wake",
      /Orquestracao/.test(orch.notice),
      orch.notice.slice(0, 160),
    );

    // parent=0: nenhuma execucao na sessao do prompt interceptado
    assert(
      "orchestrate: parent=0 (ZERO execucao na sessao parent)",
      execStartedCount(orch.sid) === execBefore && execStartedCount(orch.sid) === 0,
      `execStarted=${execStartedCount(orch.sid)}`,
    );

    // K1 = sessoes filhas criadas pela execucao do run (calibracao) + worker execs
    const sessAfter = await api("GET", "/api/session");
    const afterIds = sesIds(sessAfter.text);
    orch.k1 = afterIds.filter((id) => !beforeIds.has(id) && id !== orch.sid).length;
    const runExecs = sseEvents.filter(
      (e) =>
        e.t >= startT &&
        e.type.includes("execution.started") &&
        !e.raw.includes(`"sessionID":"${orch.sid}"`),
    ).length;
    log(`orchestrate: sessoes filhas do run (K1)=${orch.k1}, execs nao-parent na janela=${runExecs}`);
    assert(
      "orchestrate: run executou trabalho real (worker/critic >=1)",
      orch.k1 >= 1 || runExecs >= 1,
      `K1=${orch.k1} nonParentExecs=${runExecs}`,
    );
  } catch (err) {
    assert("fase orchestrate", false, err.message);
  }

  // ----------------------------------------- 8. fase DUPLICATA (id real)
  const dupBody = {
    text: "ORCH: tarefa unica de duplicata para idempotencia",
    id: "msg_e2edup00000001",
  };
  try {
    const mark = gwEvents.length;
    const mk = await api("POST", "/api/session", {});
    const sid = parseDataId(mk.text);
    if (sid === null) throw new Error("criacao de sessao falhou");
    const [ra, rb] = await Promise.all([
      api("POST", `/api/session/${sid}/prompt`, dupBody),
      api("POST", `/api/session/${sid}/prompt`, dupBody),
    ]);
    assert(
      "duplicata: ambas as submissoes 200 (contrato nativo)",
      ra.status === 200 && rb.status === 200,
      `a=${ra.status} b=${rb.status}`,
    );
    const idA = extractMsgId(ra.text);
    const idB = extractMsgId(rb.text);
    assert(
      "duplicata: identidade msg_ compartilhada (mesmo item nativo)",
      idA !== null && idA === idB,
      `a=${idA} b=${idB}`,
    );

    await waitFor(
      () => since(mark).filter((e) => e.type === "admitted").length === 2,
      20000,
      "admitted x2",
    );
    const runIds = since(mark).filter((e) => e.type === "admitted").map((e) => e.runID);
    const dispatched = since(mark).filter((e) => e.type === "rpc-dispatched");
    assert(
      "duplicata CONCORRENTE: mesmo runID + EXATAMENTE 1 dispatch (run=1)",
      runIds.length === 2 && runIds[0] === runIds[1] && dispatched.length === 1,
      `runIDs=${JSON.stringify(runIds)} dispatched=${dispatched.length}`,
    );
    await waitFor(async () => {
      const res = await api("GET", `/api/session/${sid}/inbox`);
      return /Orquestracao/.test(res.text);
    }, T.notice, "notice da duplicata");

    // replay tardio sequencial (mesma identidade)
    const mark2 = gwEvents.length;
    const rc = await api("POST", `/api/session/${sid}/prompt`, dupBody);
    await sleep(3000);
    const dispatched2 = since(mark2).filter((e) => e.type === "rpc-dispatched").length;
    const skipped2 = since(mark2).filter((e) => e.type === "rpc-skipped").length;
    assert(
      "replay tardio: 200 + NENHUM dispatch novo (idempotente)",
      rc.status === 200 && dispatched2 === 0 && skipped2 >= 1,
      `status=${rc.status} dispatched=${dispatched2} skipped=${skipped2}`,
    );
    assert("duplicata: parent=0 na sessao", execStartedCount(sid) === 0, `execStarted=${execStartedCount(sid)}`);
  } catch (err) {
    assert("fase duplicata", false, err.message);
  }

  // ---------------------------------------- 9. fase DUAS SESSOES (isolamento)
  // IDs de mensagem sao GLOBAIS por upstream (runtime real: mesmo id em outra
  // sessao => 409 ConflictError); isolamento usa MESMO texto com ids distintos.
  try {
    const mark = gwEvents.length;
    const [sa, sb] = await Promise.all([
      api("POST", "/api/session", {}),
      api("POST", "/api/session", {}),
    ]);
    const sidA = parseDataId(sa.text);
    const sidB = parseDataId(sb.text);
    if (!sidA || !sidB) throw new Error("criacao de sessoes falhou");
    const text = "ORCH: mesmo texto nas duas sessoes";
    const [ra, rb] = await Promise.all([
      api("POST", `/api/session/${sidA}/prompt`, { text, id: "msg_e2esame000000A1" }),
      api("POST", `/api/session/${sidB}/prompt`, { text, id: "msg_e2esame000000B1" }),
    ]);
    assert("duas sessoes: ambas 200", ra.status === 200 && rb.status === 200, `a=${ra.status} b=${rb.status}`);
    await waitFor(() => since(mark).filter((e) => e.type === "rpc-dispatched").length === 2, 25000, "dispatch x2");
    const dispatchRunIDs = since(mark).filter((e) => e.type === "rpc-dispatched").map((e) => e.runID);
    assert(
      "duas sessoes: locks/records isolados — 2 dispatch com runIDs DISTINTOS",
      dispatchRunIDs.length === 2 && dispatchRunIDs[0] !== dispatchRunIDs[1],
      `runIDs=${JSON.stringify(dispatchRunIDs)}`,
    );
    await waitFor(async () => {
      const [a, b] = await Promise.all([
        api("GET", `/api/session/${sidA}/inbox`),
        api("GET", `/api/session/${sidB}/inbox`),
      ]);
      return /Orquestracao/.test(a.text) && /Orquestracao/.test(b.text);
    }, T.notice, "notices das duas sessoes");
    assert(
      "duas sessoes: parent=0 em AMBAS",
      execStartedCount(sidA) === 0 && execStartedCount(sidB) === 0,
      `execA=${execStartedCount(sidA)} execB=${execStartedCount(sidB)}`,
    );
  } catch (err) {
    assert("fase duas sessoes", false, err.message);
  }

  // --------------------------------------------------- 10. fase ROUTE (API)
  try {
    const mark = gwEvents.length;
    const mk = await api("POST", "/api/session", {});
    const sid = parseDataId(mk.text);
    if (sid === null) throw new Error("criacao de sessao falhou");
    const r = await api("POST", `/api/session/${sid}/prompt`, {
      text: "ROUTE: execute um passo simples com um modelo gratuito.",
    });
    assert("route: prompt 200", r.status === 200, `status=${r.status}`);
    await waitFor(
      () => since(mark).some((e) => e.type === "intercept" && e.mode === "route"),
      15000,
      "intercept mode=route",
    );
    const applied = since(mark).filter((e) => e.type === "route").length;
    const fallback = since(mark).filter((e) => e.type === "route-fallback").length;
    assert(
      "route: decisao tomada com o router REAL (apply ou fallback documentado)",
      applied + fallback === 1,
      `applied=${applied} fallback=${fallback}`,
    );
    await waitFor(() => execStartedCount(sid) >= 1, T.exec, "exec apos route");
    assert(
      "route: exatamente 1 forward -> execucao nativa",
      execStartedCount(sid) >= 1,
      `exec=${execStartedCount(sid)}`,
    );
    const sess = await api("GET", `/api/session/${sid}`);
    const modelInfo = (/"model"\s*:\s*\{[^}]{0,120}/.exec(sess.text) ?? [""])[0];
    log(`route: sessao model=${modelInfo}`);
  } catch (err) {
    assert("fase route", false, err.message);
  }

  // ------------------------------------- 10b. fase INTERNA (anti-recursao real)
  try {
    const mark = gwEvents.length;
    const admittedBefore = gwCount("admitted");
    const rpcBefore = gwCount("rpc-dispatched");
    const mk = await api("POST", "/api/session", {});
    const sid = parseDataId(mk.text);
    if (sid === null) throw new Error("criacao de sessao falhou");
    const r = await api("POST", `/api/session/${sid}/prompt`, {
      text: "ORCH: ataque recursivo com marcador interno",
      metadata: { "jev-router": "orchestration-internal", "jev-role": "worker" },
    });
    assert("interna: prompt com marcador 200 (nativo preservado)", r.status === 200, `status=${r.status}`);
    await waitFor(
      () => since(mark).some((e) => e.type === "intercept" && e.mode === "normal"),
      15000,
      "intercept mode=normal (bypass)",
    );
    assert(
      "interna: bypass sem admissao nem dispatch (zero recursao)",
      gwCount("admitted") === admittedBefore && gwCount("rpc-dispatched") === rpcBefore,
      `admitted=${gwCount("admitted") - admittedBefore} rpc=${gwCount("rpc-dispatched") - rpcBefore}`,
    );
    await waitFor(() => execStartedCount(sid) >= 1, T.exec, "execucao nativa do bypass");
    assert(
      "interna: bypass executa via caminho nativo (sem orchestration)",
      execStartedCount(sid) >= 1,
      `exec=${execStartedCount(sid)}`,
    );
  } catch (err) {
    assert("fase interna", false, err.message);
  }

  // ------------------------------------------------- 11. fase TUI REAL
  try {
    const gwMark = gwEvents.length;
    const sessMark = await api("GET", "/api/session");
    const beforeIds = new Set(sesIds(sessMark.text));
    // Baselines ABSOLUTOS capturados ANTES do spawn (o driver espera a partir
    // deles — sem corrida entre type e leitura de baseline no wait).
    const countFileMatches = (file, regex) => {
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        return 0;
      }
      const m = text.match(new RegExp(regex, "g"));
      return m ? m.length : 0;
    };
    const NORMAL_RE = '"type":"intercept","sessionID":"[^"]+","mode":"normal"';
    const RPC_RE = '"type":"rpc-dispatched"';
    const normalBaseline = countFileMatches(gwLogPath, NORMAL_RE);
    const rpcBaseline = countFileMatches(gwLogPath, RPC_RE);
    // Ordem ESTRUTURAL: ORCH primeiro (composer livre — nada executando),
    // ping normal depois. Isso elimina a corrida em que o submit do ORCH se
    // perdia com o composer ocupado pela execucao do ping.
    const spec = {
      bin: BIN,
      args: ["--server", gwOrigin],
      cwd: projectDir,
      env: { OPENCODE_PASSWORD: pw, HOME: homeDir, PATH: process.env.PATH ?? "" },
      boot_ms: 20000,
      steps: [
        { type: "ORCH: responda apenas com a palavra PRONTO (via tui)", enter: true, after_enter_ms: 500 },
        {
          wait_log: {
            file: gwLogPath,
            regex: RPC_RE,
            baseline: rpcBaseline,
            min_extra: 1,
            timeout_ms: 180000,
          },
        },
        { wait_log: { file: tuiCanaryPath, regex: "ORCH_TUI_NOTICE", min_extra: 1, timeout_ms: 330000 } },
        { sleep_ms: 8000 },
        { type: "ping normal pelo tui atraves do gateway", enter: true, after_enter_ms: 500 },
        {
          wait_log: {
            file: gwLogPath,
            regex: NORMAL_RE,
            baseline: normalBaseline,
            min_extra: 1,
            timeout_ms: 120000,
          },
        },
        { sleep_ms: 12000 },
      ],
      tail_ms: 2000,
      dump_to: ptyDumpPath,
    };
    fs.writeFileSync(tuiSpecPath, JSON.stringify(spec, null, 2));
    fs.writeFileSync(tuiCanaryPath, "");

    const driver = spawn("python3", [path.join(REPO, "scripts", "e2e-tui.py"), tuiSpecPath], {
      env: { PATH: process.env.PATH ?? "" },
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const driverRec = { label: "driver", child: driver, lines: [], exited: false, code: null };
    children.push(driverRec);
    let driverOut = "";
    driver.stdout.on("data", (c) => (driverOut += c));
    driver.stderr.on("data", (c) => (driverOut += c));

    let driverFinished = false;
    const driverDone = new Promise((resolve) =>
      driver.on("exit", (code) => {
        driverFinished = true;
        driverRec.exited = true;
        driverRec.code = code;
        resolve(code);
      }),
    );

    let tuiSid = null;
    let execAtOrch = null;
    const watch = (async () => {
      const deadline = Date.now() + T.tuiTotal;
      let noticed = false;
      let graceUntil = null;
      while (Date.now() < deadline) {
        try {
          const intercepts = since(gwMark).filter((e) => e.type === "intercept");
          if (tuiSid === null && intercepts.length >= 1) {
            tuiSid = intercepts[0].sessionID;
            log(`TUI session detectada: ${tuiSid}`);
            const sessAfter = await api("GET", "/api/session");
            const newIds = sesIds(sessAfter.text).filter((id) => !beforeIds.has(id));
            log(`sessoes novas apos TUI boot/submit: ${JSON.stringify(newIds)}`);
          }
          const orchIntercept = intercepts.find((e) => e.mode === "orchestrate");
          if (orchIntercept !== undefined && execAtOrch === null && tuiSid !== null) {
            execAtOrch = execStartedCount(tuiSid);
            log(`TUI orchestrate interceptado (parent execs ate aqui=${execAtOrch})`);
          }
          if (tuiSid !== null && !noticed) {
            const inbox = await api("GET", `/api/session/${tuiSid}/inbox`).catch(() => null);
            if (inbox && /Orquestracao/.test(inbox.text)) {
              fs.writeFileSync(tuiCanaryPath, "ORCH_TUI_NOTICE\n");
              noticed = true;
              log("canary de notice do TUI gravado");
            }
          }
        } catch (err) {
          log(`watch: ${err.message.slice(0, 160)}`);
        }
        if (driverFinished && graceUntil === null) graceUntil = Date.now() + 10000;
        if (graceUntil !== null && Date.now() >= graceUntil) break;
        await sleep(1000);
      }
      return { noticed };
    })();

    const exitCode = await Promise.race([
      driverDone,
      sleep(T.tuiTotal + 60000).then(() => "TIMEOUT"),
    ]);
    if (exitCode === "TIMEOUT") {
      try {
        driver.kill("SIGKILL");
      } catch {
        // ja morto
      }
      assert("fase TUI: driver terminou", false, "timeout do driver TUI");
    } else {
      assert(
        "fase TUI: driver concluiu todos os passos",
        exitCode === 0,
        `exit=${exitCode} out=${driverOut.slice(-400)}`,
      );
    }
    const watchOut = await watch;

    const tuiIntercepts = since(gwMark).filter((e) => e.type === "intercept");
    const tuiNormal = tuiIntercepts.filter((e) => e.mode === "normal");
    const tuiOrch = tuiIntercepts.filter((e) => e.mode === "orchestrate");
    const tuiDispatch = since(gwMark).filter((e) => e.type === "rpc-dispatched");
    assert(
      "TUI: prompt normal do TUI interceptado (cliente real atras do gateway)",
      tuiNormal.length === 1,
      `normal=${tuiNormal.length}`,
    );
    assert(
      "TUI: ORCH do TUI -> admission + EXATAMENTE 1 dispatch",
      tuiOrch.length === 1 && tuiDispatch.length === 1,
      `orch=${tuiOrch.length} dispatch=${tuiDispatch.length}`,
    );
    assert(
      "TUI: mesma sessao no normal e no orchestrate",
      tuiNormal.length === 1 && tuiOrch.length === 1 && tuiNormal[0].sessionID === tuiOrch[0].sessionID,
      `normalSid=${tuiNormal[0]?.sessionID} orchSid=${tuiOrch[0]?.sessionID}`,
    );
    // parent=0 JANELADO (ordem ORCH-primeiro): nenhuma execution.started da
    // sessao do TUI entre a admissao do ORCH e o submit do ping normal. O ping
    // executa DEPOIS (nativo, legitimo) — wake sincrono na admissao cairia na
    // janela e seria pego. Cobertura conjunta: janela==0 (causalidade) +
    // execAtOrch==0 (nada executava na admissao) + final==1 (exatamente o
    // ping; >=2 indicaria wake tardio) + wire com ZERO PATCH em todo o run
    // (nenhum mecanismo de wake disparou em nenhuma fase).
    const tuiAdmitted = since(gwMark).find((e) => e.type === "admitted" && e.sessionID === tuiSid);
    const tuiPing = since(gwMark).find(
      (e) => e.type === "intercept" && e.mode === "normal" && e.sessionID === tuiSid,
    );
    const windowExecs = sseEvents.filter(
      (e) =>
        e.type.includes("execution.started") &&
        tuiSid !== null &&
        e.raw.includes(`"sessionID":"${tuiSid}"`) &&
        tuiAdmitted !== undefined &&
        tuiPing !== undefined &&
        e.t >= tuiAdmitted.t - 2000 &&
        e.t < tuiPing.t,
    );
    const finalExecs = tuiSid !== null ? execStartedCount(tuiSid) : -1;
    assert(
      "TUI orchestrate: parent=0 (janela admission->ping limpa, exatamente o ping no final)",
      tuiSid !== null &&
        tuiAdmitted !== undefined &&
        tuiPing !== undefined &&
        windowExecs.length === 0 &&
        execAtOrch === 0 &&
        finalExecs === 1,
      `windowExecs=${windowExecs.length} execAtOrch=${execAtOrch} finalExecs=${finalExecs}`,
    );
    assert(
      "TUI: notice da publicacao chega ao inbox da sessao do TUI",
      watchOut.noticed,
      `canary=${fs.readFileSync(tuiCanaryPath, "utf8").trim()}`,
    );
    let ptyVisible = false;
    if (fs.existsSync(ptyDumpPath)) {
      ptyVisible = fs.readFileSync(ptyDumpPath, "utf8").includes("Orquestracao");
    }
    assert(
      "TUI: publicacao VISIVEL na experiencia (dump do PTY contem o notice)",
      ptyVisible,
      ptyVisible
        ? "PASS total"
        : "PARCIAL: notice duravel no inbox (provado) mas invisivel no render do TUI — blocker documentado",
      false,
    );
    if (tuiSid !== null) {
      const tuiMsgs = await api("GET", `/api/session/${tuiSid}/message`).catch(() => ({ status: 0, text: "" }));
      log(`TUI transcript status=${tuiMsgs.status} bytes=${tuiMsgs.text.length}`);
    }
  } catch (err) {
    assert("fase TUI", false, err.message);
  }

  // --------------------------------------- 12. cross-checks de wire (sniffer)
  try {
    await sleep(1500);
    pollSniffer(sniffLogPath);
    const patchInbox = sniffCount(
      (e) => e.dir === "req" && e.method === "PATCH" && String(e.path).includes("/inbox"),
    );
    assert(
      "wire: ZERO PATCH de inbox (nenhum wake em nenhuma fase)",
      patchInbox === 0,
      `patchInbox=${patchInbox}`,
    );
    const wireRpc = sniffCount(
      (e) =>
        e.dir === "req" &&
        e.method === "POST" &&
        String(e.path).includes("/api/rpc/opjev.admission.v1/orchestrate") &&
        !String(e.body ?? "").includes('"input":{}'),
    );
    const gwRpc = gwCount("rpc-dispatched");
    assert(
      "wire: dispatches RPC no sniffer == dispatches do gateway (RPC=1 por run)",
      wireRpc === gwRpc,
      `wire=${wireRpc} gw=${gwRpc}`,
    );
    const resumeFalse = sniffCount(
      (e) => e.dir === "req" && String(e.body ?? "").includes('"resume":false'),
    );
    assert("wire: admissao persist-first com resume:false observada", resumeFalse >= 1, `occurrences=${resumeFalse}`);
    const wirePrompts = sniffCount(
      (e) => e.dir === "req" && e.method === "POST" && /\/api\/session\/[^/]+\/prompt$/.test(String(e.path)),
    );
    log(`wire: prompts encaminhados ao upstream=${wirePrompts}`);
    const pluginList = sniffEvents.find((e) => e.dir === "res" && String(e.path).includes("/api/plugin"));
    log(`wire: /api/plugin -> ${(pluginList?.body ?? "sem resposta").slice(0, 200)}`);
  } catch (err) {
    assert("cross-checks sniffer", false, err.message);
  }

  // ------------------------------------------- 13. nao-vazamento no log
  try {
    clearInterval(gwPump);
    await sleep(300);
    const gwLogText = fs.existsSync(gwLogPath) ? fs.readFileSync(gwLogPath, "utf8") : gw.lines.join("\n");
    const leaksPw = pw !== "" && gwLogText.includes(pw);
    const leaksAuth = /authorization|Basic [A-Za-z0-9+/=]{12,}/i.test(gwLogText);
    assert(
      "log do gateway: NENHUMA senha/credential vazada",
      !leaksPw && !leaksAuth,
      `pw=${leaksPw} auth=${leaksAuth}`,
    );
  } catch (err) {
    assert("checagem de vazamento", false, err.message);
  }

  // -------------------------------------------------------- 14. evidencia
  const summary = {
    t: new Date().toISOString(),
    runtime: "opencode v2.0.11",
    bin: BIN,
    gateway: gwOrigin,
    upstream: upOrigin,
    counts: {
      intercepts: gwCount("intercept"),
      byMode: {
        normal: gwCount("intercept", (e) => e.mode === "normal"),
        route: gwCount("intercept", (e) => e.mode === "route"),
        orchestrate: gwCount("intercept", (e) => e.mode === "orchestrate"),
      },
      admitted: gwCount("admitted"),
      rpcDispatched: gwCount("rpc-dispatched"),
      rpcSkipped: gwCount("rpc-skipped"),
      failClosed: gwCount("rpc-failed") + gwCount("admission-unknown"),
      rejected: gwCount("rejected"),
      execEvents: sseEvents.filter((e) => e.type.includes("execution.")).length,
      sniff: {
        reqs: sniffCount((e) => e.dir === "req"),
        patchInbox: sniffCount(
          (e) => e.dir === "req" && e.method === "PATCH" && String(e.path).includes("/inbox"),
        ),
        rpc: sniffCount((e) => e.dir === "req" && String(e.path).includes("/api/rpc/")),
      },
    },
    runIDs: gwEvents.filter((e) => e.type === "rpc-dispatched").map((e) => e.runID),
    notices: { orchestrate: orch.notice },
    results,
    eventsTail: gwEvents.slice(-400),
    artifacts: {
      gatewayLog: gwLogPath,
      upstreamLog: upLogPath,
      sniffer: sniffLogPath,
      ptyDump: ptyDumpPath,
    },
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(summary, null, 2)}\n`);
  log(`evidencia: ${resultPath}`);

  const requiredFails = results.filter((r) => r.required && !r.pass);
  const partials = results.filter((r) => !r.required && !r.pass);
  log("---- resumo ----");
  log(`total=${results.length} fail=${requiredFails.length} partial=${partials.length}`);
  for (const r of requiredFails) log(`FALHOU: ${r.name} — ${r.detail}`);

  killAll();
  await sleep(1500);
  for (const rec of children) {
    if (!rec.exited) {
      try {
        rec.child.kill("SIGKILL");
      } catch {
        // ja morto
      }
    }
  }
  return requiredFails.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`ERRO FATAL: ${err.stack ?? err.message}`);
    killAll();
    process.exit(1);
  });
