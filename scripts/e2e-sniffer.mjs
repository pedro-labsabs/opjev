// Sniffer transparente para o E2E da issue #24: proxy HTTP que fica entre o
// gateway e o upstream `opencode serve` e registra method/path/status/corpos
// (limitados) em JSONL para a evidencia reproduzivel.
//
// Regras:
//   - NUNCA altera, reordena ou reescreve o trafego (forward byte-identico);
//   - NUNCA loga Authorization nem credencial (so a presenca do header);
//   - SSE e repassado em streaming (sem buffering que possa atrasar eventos);
//   - corpos de request limitados a 64 KiB por log (prompt completo cabe);
//   - se o log falhar, o trafego continua (log nunca derruba o caminho).
//
// Env: E2E_SNIFF_UPSTREAM (obrig.), E2E_SNIFF_PORT (0 = efemera),
//      E2E_SNIFF_LOG (JSONL de saida).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const upstreamRaw = process.env.E2E_SNIFF_UPSTREAM ?? "";
if (upstreamRaw === "") {
  process.stderr.write("[sniffer] E2E_SNIFF_UPSTREAM obrigatorio\n");
  process.exit(2);
}
const upstream = new URL(upstreamRaw);
const listenPort = Number.parseInt(process.env.E2E_SNIFF_PORT ?? "0", 10);
const logPath =
  process.env.E2E_SNIFF_LOG ?? "/tmp/opjev-e2e/evidence/http.jsonl";
const MAX_BODY = 65536;

fs.mkdirSync(path.dirname(logPath), { recursive: true });
const sink = fs.createWriteStream(logPath, { flags: "a" });
function record(entry) {
  try {
    sink.write(`${JSON.stringify({ t: Date.now(), ...entry })}\n`);
  } catch {
    // log nunca derruba o caminho de dados
  }
}

function bounded(buf, max = 4096) {
  const s = buf.toString("utf8");
  return s.length > max ? `${s.slice(0, max)}…[capped]` : s;
}

const server = http.createServer((req, res) => {
  const hasAuth = typeof req.headers.authorization === "string";
  const chunks = [];
  let total = 0;
  req.on("data", (chunk) => {
    if (total < MAX_BODY) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  });
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers["transfer-encoding"];
    delete headers.connection;
    // Forca resposta identidade: a evidencia precisa de corpo legivel e o
    // cliente final (fetch/TUI) aceita identity igual a gzip.
    delete headers["accept-encoding"];
    if (body.byteLength > 0) {
      headers["content-length"] = String(body.byteLength);
    }
    record({
      dir: "req",
      method: req.method,
      path: req.url,
      auth: hasAuth,
      bytes: body.byteLength,
      ...(body.byteLength > 0 ? { body: bounded(body) } : {}),
    });

    const preq = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (pres) => {
        const contentType = String(pres.headers["content-type"] ?? "");
        const isSSE = contentType.includes("text/event-stream");
        res.writeHead(pres.statusCode ?? 502, pres.headers);
        if (isSSE) {
          record({
            dir: "res",
            path: req.url,
            status: pres.statusCode,
            sse: true,
          });
          pres.pipe(res);
          return;
        }
        const rchunks = [];
        pres.on("data", (chunk) => {
          if (rchunks.length < 64) rchunks.push(chunk);
          res.write(chunk);
        });
        pres.on("end", () => {
          record({
            dir: "res",
            path: req.url,
            status: pres.statusCode,
            body: bounded(Buffer.concat(rchunks), 2048),
          });
          res.end();
        });
        pres.on("error", () => res.end());
      },
    );
    preq.on("error", (err) => {
      record({ dir: "upstream-error", path: req.url, error: String(err).slice(0, 200) });
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end('{"error":"sniffer-upstream-error"}');
    });
    if (body.byteLength > 0) preq.write(body);
    preq.end();
  });
  req.on("error", () => res.destroy());
});

// Contrato publico v2.0.11 nao tem WS; registramos upgrade como anomalia.
server.on("upgrade", (req, socket) => {
  record({ dir: "upgrade", path: req.url });
  socket.destroy();
});

server.listen(listenPort, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : listenPort;
  process.stdout.write(`[sniffer] 127.0.0.1:${port} -> ${upstream.origin}\n`);
});
