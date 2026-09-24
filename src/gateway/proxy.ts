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
//   - upgrade: tunel TCP bruto (bytes do handshake reescritos so no Host e
//     repassados verbatim; nunca via http.request, que emitiria um segundo
//     head e corromperia o handshake).

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
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
  // SSE (/api/event) e stream de vida longa: timeout de request o mataria em
  // gaps ociosos (churn de reconexao imposto pelo gateway). Isento por path
  // exato; o fechamento continua observado (close/error destroem o upstream).
  let isEventStream = false;
  try {
    isEventStream =
      clientReq.method === "GET" && new URL(clientReq.url ?? "/", "http://gateway").pathname === "/api/event";
  } catch {
    isEventStream = false;
  }
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

  if (!isEventStream) {
    upReq.setTimeout(opts.timeoutMs, () => {
      upReq.destroy(new Error("timeout de inatividade do upstream"));
    });
  }

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

/**
 * Tunel de upgrade: TCP bruto ate o upstream (tal qual o cliente enviou, com
 * Host reescrito). Usar http.request aqui corromperia o handshake (o client
 * HTTP emitiria o proprio head ANTES dos bytes crus do upgrade).
 */
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

  const destroyBoth = (upSocket: import("node:stream").Duplex): void => {
    try {
      upSocket.destroy();
    } catch {
      // melhor esforco
    }
    try {
      clientSocket.destroy();
    } catch {
      // melhor esforco
    }
  };

  const onConnect = (upSocket: import("node:stream").Duplex): void => {
    upSocket.write(requestHead);
    if (head && head.length > 0) upSocket.write(head);
    upSocket.pipe(clientSocket);
    clientSocket.pipe(upSocket);
    upSocket.on("close", () => {
      try {
        clientSocket.destroy();
      } catch {
        // ja fechado
      }
    });
    clientSocket.on("close", () => {
      try {
        upSocket.destroy();
      } catch {
        // ja fechado
      }
    });
  };

  const onError = (upSocket: import("node:stream").Duplex): void => {
    destroyBoth(upSocket);
  };

  let upSocket: import("node:net").Socket | import("node:tls").TLSSocket;
  if (opts.protocol === "https:") {
    upSocket = tls.connect(
      { host: opts.hostname, port: opts.port, servername: opts.hostname },
      () => onConnect(upSocket),
    );
  } else {
    upSocket = net.connect({ host: opts.hostname, port: opts.port }, () => onConnect(upSocket));
  }
  upSocket.setTimeout(opts.timeoutMs, () => destroyBoth(upSocket));
  upSocket.on("error", () => onError(upSocket));
  clientSocket.on("error", () => {
    try {
      upSocket.destroy();
    } catch {
      // ja fechado
    }
  });
}
