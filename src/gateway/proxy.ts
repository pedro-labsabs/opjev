// Proxy REVERSO transparente do gateway (#24): sem framework, so node:http(s).
//
// Garantias:
//   - method/path/query preservados exatamente (clientReq.url intacto);
//   - status/headers/corpo repassados nos dois sentidos, SEM bufferizar
//     resposta (SSE streama chunk a chunk);
//   - cancelamento do cliente destrui o request upstream (e vice-versa);
//   - timeout por INATIVIDADE de socket (nao mata stream longo com trafego);
//   - headers hop-by-hop retirados; Authorization do cliente preservado;
//     Authorization proprio SO quando o cliente nao enviou (nunca logado);
//   - upgrade/WS: tunel TCP bruto (o contrato publico nao declara WS, mas o
//     proxy nao pode quebrar eventos de upgrade que um runtime venha a usar).

import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface ProxyOptions {
  origin: string;
  protocol: "http:" | "https:";
  host: string; // hostname:port do upstream
  hostname: string;
  port: number;
  timeoutMs: number;
  password?: string;
  /** Corpo ja lido (requests interceptados): reenvio byte a byte. */
  bodyOverride?: Buffer;
}

function bounded(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split("\n")[0]!.slice(0, 200);
}

function basic(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

export function proxyRequest(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  opts: ProxyOptions,
): void {
  const headers: Record<string, string | string[] | undefined> = { ...clientReq.headers };
  for (const hop of HOP_BY_HOP) delete headers[hop];
  headers.host = opts.host;
  if (opts.password !== undefined && opts.password !== "" && headers.authorization === undefined) {
    headers.authorization = basic(opts.password);
  }
  if (opts.bodyOverride !== undefined) {
    headers["content-length"] = String(opts.bodyOverride.byteLength);
  }

  const lib = opts.protocol === "https:" ? https : http;
  const upReq = lib.request(
    {
      protocol: opts.protocol,
      hostname: opts.hostname,
      port: opts.port,
      path: clientReq.url,
      method: clientReq.method,
      headers,
    },
    (upRes) => {
      const outHeaders: Record<string, string | string[] | undefined> = { ...upRes.headers };
      for (const hop of HOP_BY_HOP) delete outHeaders[hop];
      clientRes.writeHead(upRes.statusCode ?? 502, outHeaders);
      upRes.pipe(clientRes);
      upRes.on("error", () => clientRes.destroy());
    },
  );

  upReq.setTimeout(opts.timeoutMs, () => {
    upReq.destroy(new Error("timeout de inatividade do upstream"));
  });

  upReq.on("error", (err) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: { code: "upstream-unreachable", message: bounded(err) } }));
    } else {
      clientRes.destroy();
    }
  });

  // cancelamento bidirecional: cliente abortou => destrui upstream e vice-versa
  clientReq.on("aborted", () => upReq.destroy());
  clientRes.on("close", () => {
    if (!clientRes.writableFinished) upReq.destroy();
  });

  if (opts.bodyOverride !== undefined) {
    upReq.end(opts.bodyOverride);
  } else {
    clientReq.pipe(upReq);
  }
}

/** Tunel de upgrade/WS: repassa o request bruto e faz pipe bidirecional. */
export function proxyUpgrade(
  req: IncomingMessage,
  clientSocket: import("node:stream").Duplex,
  head: Buffer,
  opts: { protocol: "http:" | "https:"; hostname: string; port: number; host: string; timeoutMs: number },
): void {
  // request-line + headers originais (host reescrito para o upstream)
  const headLines: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    const value = req.rawHeaders[i + 1]!;
    if (name.toLowerCase() === "host") continue;
    headLines.push(`${name}: ${value}`);
  }
  headLines.push(`Host: ${opts.host}`);
  const requestHead = `${req.method} ${req.url} HTTP/1.1\r\n${headLines.join("\r\n")}\r\n\r\n`;

  const lib = opts.protocol === "https:" ? https : http;
  const upReq = lib.request({
    protocol: opts.protocol,
    hostname: opts.hostname,
    port: opts.port,
    method: req.method,
    path: req.url,
    headers: { host: opts.host },
  });

  upReq.on("upgrade", (upRes, upSocket, upHead) => {
    const responseLines = [
      `HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? "Switching Protocols"}`,
    ];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
      responseLines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    }
    clientSocket.write(`${responseLines.join("\r\n")}\r\n\r\n`);
    if (upHead && upHead.length > 0) clientSocket.write(upHead);
    upSocket.pipe(clientSocket);
    clientSocket.pipe(upSocket);
    const destroy = () => {
      upSocket.destroy();
      clientSocket.destroy();
    };
    upSocket.on("close", destroy);
    clientSocket.on("close", destroy);
  });
  upReq.on("response", (upRes) => {
    // upstream respondeu HTTP simples em vez de upgrade: repassa e fecha
    clientSocket.end(
      `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? ""}\r\nConnection: close\r\n\r\n`,
    );
    upRes.resume();
  });
  upReq.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upReq.destroy());
  upReq.setTimeout(opts.timeoutMs, () => upReq.destroy());
  upReq.write(requestHead);
  if (head && head.length > 0) upReq.write(head);
  upReq.end();
}
