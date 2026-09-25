// Gateway de admission deterministico (#24): reverse proxy transparente por
// padrao com UMA interceptacao narrow — `POST /api/session/:sid/prompt`.
//
// Fluxos (semântica fechada na pesquisa docs/research/2026-09-22-...):
//   normal      -> forward transparente EXATO 1x (comportamento nativo intacto);
//   route       -> decide (router real importado) + apply (switches) + forward
//                  EXATO 1x; falha pre-efeito => fallback normal;
//   orchestrate -> persist-first (resume:false, identidade duravel msg_...) =>
//                  record + keyed lock + RPC DIRETA ao plugin (opjev.admission.v1)
//                  => NUNCA PATCH/wake, NUNCA re-encaminhar (fail-closed);
//   demais requests -> proxy transparente (SSE, catalogos, inbox, PTY, upgrade).
//
// Log: somente IDs/estados/contadores — nunca Authorization, senha ou texto
// de prompt.

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig } from "./config.ts";
import { admissionForwardFields, decideAdmissionMode, parsePromptPayload } from "./admission.ts";
import { proxyRequest, proxyUpgrade, type ProxyOptions } from "./proxy.ts";
import { UpstreamClient, UpstreamHttpError } from "./upstream.ts";
import { decideAndApplyRoute } from "./route.ts";
import { autoAdmissionRunID } from "../orchestration/admission.ts";
import { AdmissionRpc } from "../orchestration/admission-rpc.ts";
import { withKeyedLock } from "../lock.ts";
import { isInternalOrchestrationSession } from "../worker-hooks.ts";

export interface GatewayRecord {
  runID: string;
  sessionID: string;
  messageID: string;
  state: string;
}

export interface GatewayCounters {
  intercepted: number;
  forwarded: number;
  admitted: number;
  rpcDispatched: number;
  rpcSkippedDuplicate: number;
  routeApplied: number;
  routeFallback: number;
  /** Route com side effect parcial (model aplicado, agent falhou): nunca silencioso. */
  routePartial: number;
  rejected: number;
  failClosed: number;
  ambiguous: number;
}

export type GatewaySnapshot = GatewayCounters & { records: GatewayRecord[] };

export interface GatewayServerHandle {
  port: number;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
  counters(): GatewaySnapshot;
  activeSockets(): number;
}

export interface CreateGatewayDeps {
  log?: (line: string) => void;
  env?: Record<string, string | undefined>;
}

const MAX_RECORDS = 500;
const PROMPT_PATH = /^\/api\/session\/([^/]+)\/prompt$/;

function bounded(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split("\n")[0]!.slice(0, 300);
}

/**
 * Postura de auth do CLIENTE para chamadas do gateway em seu nome: a
 * Authorization recebida verbatim, ou null (anonimo). O gateway nunca
 * substitui pela senha de env nesses caminhos — o upstream decide.
 */
function clientAuthOf(req: IncomingMessage): string | null {
  const v = req.headers.authorization;
  return typeof v === "string" && v.length > 0 ? v : null;
}

type BodyResult = { kind: "ok"; body: Buffer } | { kind: "too-large" } | { kind: "aborted" };

function readBodyLimited(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (result: BodyResult) => {
      if (!done) {
        done = true;
        resolve(result);
      }
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.byteLength;
      if (total > maxBytes) {
        finish({ kind: "too-large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish({ kind: "ok", body: Buffer.concat(chunks) }));
    req.on("aborted", () => finish({ kind: "aborted" }));
    req.on("error", () => finish({ kind: "aborted" }));
  });
}

function jsonError(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code, message: message.slice(0, 300) } }));
}

export function createGatewayServer(
  config: GatewayConfig,
  deps: CreateGatewayDeps = {},
): GatewayServerHandle {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (type: string, fields: Record<string, unknown> = {}): void => {
    try {
      log(JSON.stringify({ t: Date.now(), type, ...fields }));
    } catch {
      // log nunca pode derrubar o caminho de dados
    }
  };

  const counters: GatewayCounters = {
    intercepted: 0,
    forwarded: 0,
    admitted: 0,
    rpcDispatched: 0,
    rpcSkippedDuplicate: 0,
    routeApplied: 0,
    routeFallback: 0,
    routePartial: 0,
    rejected: 0,
    failClosed: 0,
    ambiguous: 0,
  };
  const records = new Map<string, GatewayRecord>();
  function putRecord(runID: string, sessionID: string, messageID: string, state: string): void {
    if (!records.has(runID) && records.size >= MAX_RECORDS) {
      const oldest = records.keys().next().value;
      if (oldest !== undefined) records.delete(oldest);
    }
    records.set(runID, { runID, sessionID, messageID, state });
  }

  const upstreamURL = new URL(config.upstreamOrigin);
  const upstreamPort = Number.parseInt(upstreamURL.port || "", 10) || (config.upstreamProtocol === "https:" ? 443 : 80);
  // Control-plane interno (admissao, RPC, catalogos, switches, session
  // lookup): unico consumidor da senha de env. O proxy (abaixo) NUNCA recebe
  // a senha — separacao estrutural, nao apenas disciplinar.
  const upstream = new UpstreamClient({
    origin: config.upstreamOrigin,
    ...(config.upstreamPassword !== undefined ? { password: config.upstreamPassword } : {}),
    timeoutMs: config.upstreamTimeoutMs,
  });

  const proxyOpts = (bodyOverride?: Buffer): ProxyOptions => ({
    origin: config.upstreamOrigin,
    protocol: config.upstreamProtocol,
    host: config.upstreamHost,
    hostname: upstreamURL.hostname,
    port: upstreamPort,
    timeoutMs: config.proxyTimeoutMs,
    ...(bodyOverride !== undefined ? { bodyOverride } : {}),
  });

  const sockets = new Set<import("node:net").Socket>();

  async function handleIntercept(
    req: IncomingMessage,
    res: ServerResponse,
    sessionID: string,
  ): Promise<void> {
    const read = await readBodyLimited(req, config.maxBodyBytes);
    if (read.kind === "aborted") return;
    if (read.kind === "too-large") {
      counters.rejected += 1;
      emit("rejected", { sessionID, code: "payload-too-large" });
      jsonError(res, 413, "payload-too-large", `corpo do prompt excede ${config.maxBodyBytes} bytes`);
      res.once("finish", () => req.destroy());
      return;
    }
    const parsed = parsePromptPayload(read.body, config.maxBodyBytes);
    if (!parsed.ok) {
      counters.rejected += 1;
      emit("rejected", { sessionID, code: parsed.code });
      jsonError(res, parsed.status, parsed.code, parsed.message);
      return;
    }

    counters.intercepted += 1;
    const decision = decideAdmissionMode({
      text: parsed.text,
      metadata: parsed.metadata,
      rules: config.rules,
      defaultMode: config.defaultMode,
    });
    emit("intercept", { sessionID, mode: decision.mode, via: decision.via, bytes: read.body.byteLength });

    if (decision.mode === "normal") {
      counters.forwarded += 1;
      proxyRequest(req, res, proxyOpts(read.body));
      return;
    }

    if (decision.mode === "route") {
      const outcome = await decideAndApplyRoute({
        sessionID,
        text: parsed.text,
        config,
        upstream,
        clientAuth: clientAuthOf(req),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
      });
      if (outcome.applied) {
        counters.routeApplied += 1;
        emit("route", {
          sessionID,
          model: outcome.decision?.model,
          agent: outcome.decision?.agent,
          via: outcome.decision?.via,
        });
      } else if (outcome.partial !== undefined) {
        counters.routePartial += 1;
        emit("route-partial", {
          sessionID,
          modelApplied: outcome.partial.modelApplied,
          rollback: outcome.partial.rollback,
          reason: bounded(outcome.reason ?? "agent switch falhou apos model aplicado"),
        });
      } else {
        counters.routeFallback += 1;
        emit("route-fallback", { sessionID, reason: bounded(outcome.reason ?? "decisao indisponivel") });
      }
      counters.forwarded += 1;
      proxyRequest(req, res, proxyOpts(read.body));
      return;
    }

    // ---------------- orchestrate: persist-first, nunca wake ----------------
    // Guarda de papel fail-closed: o prompt-metadata ja foi filtrado na
    // decisao (internal-bypass); aqui a SESSAO-alvo precisa ser EXTERNAMENTE
    // confirmada. Papel interno => bypass normal. Papel AMBIGUO (lookup
    // falhou) => 502 session-role-unknown, nunca orchestrate. Somente 404
    // definitivo (sessao inexistente) vira passthrough nativo.
    if (decision.mode === "orchestrate") {
      let internalSession = false;
      try {
        // O lookup espelha a credencial do CLIENTE (nunca a senha de env):
        // sem credencial valida, o upstream 401/403 e nada e admitido. O
        // gateway nao confere privilegio que o upstream negaria ao cliente.
        const sess = await upstream.getSession(sessionID, clientAuthOf(req));
        internalSession = isInternalOrchestrationSession(sess.metadata);
      } catch (err) {
        if (err instanceof UpstreamHttpError && (err.status === 401 || err.status === 403)) {
          // Cliente nao autorizado pelo upstream: 401 bounded, zero efeito.
          emit("session-lookup-denied", { sessionID, status: err.status });
          jsonError(res, 401, "upstream-unauthorized", "upstream recusou a credencial do cliente; nada foi admitido");
          return;
        }
        if (err instanceof UpstreamHttpError && err.status === 404) {
          // Lookup DEFINITIVO: sessao inexistente — passthrough nativo (o
          // proprio prompt POST falharia igual), zero orchestration/wake.
          emit("session-lookup-rejected", { sessionID, status: err.status });
          res.writeHead(err.status, { "content-type": "application/json" });
          res.end(err.body);
          return;
        }
        // Papel AMBIGUO (rede/timeout/5xx no lookup): fail-closed. Papel
        // desconhecido nunca pode virar orchestrate — runner = 0.
        counters.failClosed += 1;
        emit("session-role-unknown", { sessionID, error: bounded(err) });
        jsonError(
          res,
          502,
          "session-role-unknown",
          "papel da sessao indeterminado; orchestration recusada (fail-closed)",
        );
        return;
      }
      if (internalSession) {
        emit("internal-session-bypass", { sessionID });
        counters.forwarded += 1;
        proxyRequest(req, res, proxyOpts(read.body));
        return;
      }
    }

    let admit: { status: number; body: Buffer };
    try {
      admit = await upstream.admitPrompt(sessionID, admissionForwardFields(parsed.body));
    } catch (err) {
      if (err instanceof UpstreamHttpError) {
        // erro DEFINITIVO upstream (sem admissao): passthrough nativo
        emit("admission-rejected", { sessionID, status: err.status });
        res.writeHead(err.status, { "content-type": "application/json" });
        res.end(err.body);
        return;
      }
      // AMBIGUO (timeout/rede apos envio): fail-closed, NUNCA re-tentar
      counters.ambiguous += 1;
      counters.failClosed += 1;
      emit("admission-unknown", { sessionID, error: bounded(err) });
      jsonError(
        res,
        502,
        "admission-unknown",
        "admissao upstream ambigua (timeout/rede); nenhuma re-tentativa (fail-closed)",
      );
      return;
    }

    let messageID: string | undefined;
    try {
      const body = JSON.parse(admit.body.toString("utf8")) as { data?: { id?: unknown } };
      if (typeof body?.data?.id === "string") messageID = body.data.id;
    } catch {
      messageID = undefined;
    }
    if (messageID === undefined || messageID.length < 1) {
      counters.failClosed += 1;
      emit("admission-identity-missing", { sessionID });
      jsonError(res, 502, "admission-unknown", "admissao aceita sem identidade duravel; fail-closed");
      return;
    }

    const runID = autoAdmissionRunID(sessionID, messageID);
    counters.admitted += 1;
    // Nunca faz downgrade: se uma duplicata/concorrente ja moveu o record para
    // started/completed/failed, re-gravar "admitted" reabriria um segundo dispatch.
    if (!records.has(runID)) {
      putRecord(runID, sessionID, messageID, "admitted");
    }
    emit("admitted", { sessionID, messageID, runID });

    const dispatch = await withKeyedLock(runID, async (): Promise<{ kind: string }> => {
      const prior = records.get(runID);
      if (prior !== undefined && (prior.state === "started" || prior.state === "completed")) {
        counters.rpcSkippedDuplicate += 1;
        emit("rpc-skipped", { runID, state: prior.state });
        return { kind: "skipped" };
      }
      // Nota (M5): record local "failed" NAO suprime — retry do cliente
      // re-dispara a RPC de proposito (recuperacao de falha transitoria de
      // dispatch). run<=1 continua garantido pelo record DURAVEL do plugin
      // (duplicate-ignored); o gateway pode emitir >1 RPC no wire e os
      // contadores refletem o wire, nao runs efetivos.
      try {
        const output = await upstream.rpc(
          AdmissionRpc.id,
          "orchestrate",
          { sessionID, messageID, objective: parsed.text },
          config.rpcTimeoutMs,
        );
        if (output === null || typeof output !== "object" || typeof (output as { runID?: unknown }).runID !== "string") {
          throw new Error("output da RPC sem runID");
        }
        putRecord(runID, sessionID, messageID, "started");
        counters.rpcDispatched += 1;
        emit("rpc-dispatched", { runID });
        return { kind: "dispatched" };
      } catch (err) {
        putRecord(runID, sessionID, messageID, "failed");
        counters.failClosed += 1;
        emit("rpc-failed", { runID, error: bounded(err) });
        return { kind: "failed" };
      }
    });

    if (dispatch.kind === "failed") {
      jsonError(
        res,
        502,
        "orchestration-dispatch-failed",
        "dispatch da orquestracao falhou apos admissao duravel; fail-closed (prompt permanece adimitido; nunca re-encaminhado ao parent)",
      );
      return;
    }

    // responde o shape NATIVO da admissao (dispatch ou duplicata suprimida)
    res.writeHead(admit.status, { "content-type": "application/json" });
    res.end(admit.body);
  }

  const server = http.createServer((req, res) => {
    const pathname = (() => {
      try {
        return new URL(req.url ?? "/", "http://gateway").pathname;
      } catch {
        return "";
      }
    })();
    const match = req.method === "POST" ? PROMPT_PATH.exec(pathname) : null;
    if (match !== null) {
      // Entrada HTTP invalida nunca derruba o processo: percent-encoding
      // malformado vira 400 bounded com zero efeito upstream.
      let sessionID: string;
      try {
        sessionID = decodeURIComponent(match[1]!);
      } catch {
        counters.rejected += 1;
        emit("rejected", { code: "invalid-session-path" });
        jsonError(res, 400, "invalid-session-path", "session ID com percent-encoding invalido");
        return;
      }
      handleIntercept(req, res, sessionID).catch((err) => {
        emit("gateway-error", { sessionID, error: bounded(err) });
        jsonError(res, 502, "gateway-error", bounded(err));
      });
      return;
    }
    proxyRequest(req, res, proxyOpts());
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  server.on("upgrade", (req, socket, head) => {
    proxyUpgrade(req, socket, head, {
      protocol: config.upstreamProtocol,
      hostname: upstreamURL.hostname,
      port: upstreamPort,
      host: config.upstreamHost,
      timeoutMs: config.proxyTimeoutMs,
    });
  });

  const handle: GatewayServerHandle = {
    port: 0,
    async listen(port?: number): Promise<number> {
      if (!config.enabled) {
        throw new Error(
          "gateway disabled: OPJEV_GATEWAY_ENABLED=1 para habilitar; nenhum socket aberto",
        );
      }
      const target = port ?? config.port;
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(target, config.host, () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
      const addr = server.address();
      handle.port = typeof addr === "object" && addr !== null ? addr.port : target;
      emit("listening", { host: config.host, port: handle.port, upstream: config.upstreamOrigin });
      return handle.port;
    },
    async close(): Promise<void> {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    counters(): GatewaySnapshot {
      return { ...counters, records: [...records.values()] };
    },
    activeSockets(): number {
      return sockets.size;
    },
  };
  return handle;
}
