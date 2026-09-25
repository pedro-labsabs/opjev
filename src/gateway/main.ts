// Entrypoint CLI do gateway (#24): `node src/gateway/main.ts` com env explicita.
// Disabled = nenhum socket aberto (comportamento atual preservado). A senha
// upstream vem de env e nunca e impressa.

import { gatewayConfigFromEnv, resolveGatewayConfig } from "./config.ts";
import { createGatewayServer } from "./server.ts";

function parseArgv(argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === "--enabled" && next !== undefined) {
      out.enabled = next;
      i += 1;
    } else if (arg === "--upstream" && next !== undefined) {
      out.upstream = next;
      i += 1;
    } else if (arg === "--host" && next !== undefined) {
      out.host = next;
      i += 1;
    } else if (arg === "--port" && next !== undefined) {
      out.port = next;
      i += 1;
    } else if (arg === "--max-body-bytes" && next !== undefined) {
      out.maxBodyBytes = next;
      i += 1;
    } else {
      process.stderr.write(`[opjev-gateway] argumento desconhecido: ${arg.slice(0, 60)}\n`);
      process.exit(2);
    }
  }
  return out;
}

const raw = { ...gatewayConfigFromEnv(process.env), ...parseArgv(process.argv.slice(2)) };

let config;
try {
  config = resolveGatewayConfig(raw);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[opjev-gateway] ${msg.slice(0, 300)}\n`);
  process.exit(2);
}

if (!config.enabled) {
  process.stderr.write(
    "[opjev-gateway] gateway disabled/desabilitado (OPJEV_GATEWAY_ENABLED=1); nenhum socket aberto.\n",
  );
  process.exit(2);
}

const gw = createGatewayServer(config);
const port = await gw.listen();
process.stdout.write(
  `[opjev-gateway] ouvindo em http://${config.host}:${port} -> ${config.upstreamOrigin}\n`,
);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await gw.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
