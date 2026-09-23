// Configuracao BOUNDED do gateway (#24): opt-in explicito, envs nomeadas,
// limites por campo, sem hardcode de porta de usuario nem de credencial.
//
// Regras da spec atendidas aqui:
//   - enable/disable explicito (desligado = nenhum socket aberto);
//   - upstream URL + listen host/port explicitos e validados;
//   - timeouts bounded (proxy / chamadas proprias / RPC / decisao de rota);
//   - corpo de prompt com teto de bytes (rejeicao bounded antes de qualquer efeito);
//   - senha upstream SOMENTE de env, nunca em config logada.

export type AdmissionMode = "normal" | "route" | "orchestrate";

export interface AdmissionRule {
  prefix: string;
  mode: AdmissionMode;
}

export interface GatewayConfig {
  enabled: boolean;
  upstreamOrigin: string;
  upstreamProtocol: "http:" | "https:";
  upstreamHost: string;
  host: string;
  port: number;
  proxyTimeoutMs: number;
  upstreamTimeoutMs: number;
  rpcTimeoutMs: number;
  routeDecisionTimeoutMs: number;
  maxBodyBytes: number;
  defaultMode: AdmissionMode;
  rules: AdmissionRule[];
  /** Vem de env; NUNCA serializada em log. */
  upstreamPassword?: string;
}

const MODES = new Set<AdmissionMode>(["normal", "route", "orchestrate"]);
const MAX_RULES = 10;
const MAX_PREFIX = 200;

function fail(msg: string): never {
  throw new Error(`config do gateway invalida: ${msg}`);
}

function asBool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

function asInt(value: unknown, name: string, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    fail(`${name} deve ser inteiro em [${min}, ${max}] (recebido: ${String(value)})`);
  }
  return n;
}

function asMode(value: unknown, name: string, fallback: AdmissionMode): AdmissionMode {
  if (value === undefined || value === null || value === "") return fallback;
  const s = String(value) as AdmissionMode;
  if (!MODES.has(s)) fail(`${name} deve ser normal|route|orchestrate (recebido: ${String(value)})`);
  return s;
}

function asRules(value: unknown): AdmissionRule[] {
  if (value === undefined || value === null || value === "") return [];
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      fail("rules deve ser JSON valido [{prefix,mode}]");
    }
  }
  if (!Array.isArray(parsed)) fail("rules deve ser array");
  if (parsed.length > MAX_RULES) fail(`rules aceita no maximo ${MAX_RULES} entradas`);
  return parsed.map((entry, idx) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`rules[${idx}] deve ser objeto {prefix,mode}`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.prefix !== "string" || e.prefix.length < 1 || e.prefix.length > MAX_PREFIX) {
      fail(`rules[${idx}].prefix deve ser string de 1..${MAX_PREFIX} chars`);
    }
    return { prefix: e.prefix, mode: asMode(e.mode, `rules[${idx}].mode`, "normal") };
  });
}

function parseUpstream(value: unknown): { origin: string; protocol: "http:" | "https:"; host: string } {
  const raw = String(value ?? "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`upstream deve ser URL http(s) valida (recebido: ${raw.slice(0, 60)})`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`upstream deve ser http(s) (recebido: ${url.protocol})`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    fail("upstream deve ser origem sem path (ex.: http://127.0.0.1:4511)");
  }
  return { origin: url.origin, protocol: url.protocol, host: url.host };
}

/**
 * Resolve e valida a config bounded. `enabled=false` nunca abre socket e
 * relaxa a exigencia de upstream/porta (placeholders internos); `enabled=true`
 * exige upstream URL e porta explicitas e valida TODOS os limites.
 */
export function resolveGatewayConfig(raw: Record<string, unknown>): GatewayConfig {
  const enabled = asBool(raw.enabled, false);

  const upstreamRaw = raw.upstream;
  const upstream =
    enabled || (upstreamRaw !== undefined && upstreamRaw !== "")
      ? parseUpstream(upstreamRaw)
      : { origin: "http://127.0.0.1:1", protocol: "http:" as const, host: "127.0.0.1:1" };

  let port: number;
  if (raw.port === undefined || raw.port === null || raw.port === "") {
    if (enabled) fail("port e obrigatoria quando enabled=true (OPJEV_GATEWAY_PORT)");
    port = 0;
  } else {
    port = asInt(raw.port, "port", 0, 65535);
  }

  const host = raw.host === undefined || raw.host === "" ? "127.0.0.1" : String(raw.host);
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) fail(`host invalido: ${host.slice(0, 40)}`);

  const config: GatewayConfig = {
    enabled,
    upstreamOrigin: upstream.origin,
    upstreamProtocol: upstream.protocol,
    upstreamHost: upstream.host,
    host,
    port,
    proxyTimeoutMs: asInt(raw.proxyTimeoutMs ?? 30000, "proxyTimeoutMs", 100, 120000),
    upstreamTimeoutMs: asInt(raw.upstreamTimeoutMs ?? 30000, "upstreamTimeoutMs", 100, 120000),
    rpcTimeoutMs: asInt(raw.rpcTimeoutMs ?? 15000, "rpcTimeoutMs", 100, 120000),
    routeDecisionTimeoutMs: asInt(raw.routeDecisionTimeoutMs ?? 15000, "routeDecisionTimeoutMs", 50, 120000),
    maxBodyBytes: asInt(raw.maxBodyBytes ?? 1048576, "maxBodyBytes", 1024, 16777216),
    defaultMode: asMode(raw.defaultMode, "defaultMode", "normal"),
    rules: asRules(raw.rules),
  };
  const password = raw.upstreamPassword;
  if (typeof password === "string" && password.length > 0) {
    config.upstreamPassword = password;
  }
  return config;
}

/**
 * Le a config das envs nomeadas (#24). Credencial: somente de env
 * (OPJEV_UPSTREAM_PASSWORD > OPENCODE_PASSWORD > OPENCODE_SERVER_PASSWORD),
 * fora do objeto logavel por construcao (o logger nunca recebe esta chave).
 */
export function gatewayConfigFromEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  return {
    enabled: env.OPJEV_GATEWAY_ENABLED,
    upstream: env.OPJEV_GATEWAY_UPSTREAM,
    host: env.OPJEV_GATEWAY_HOST,
    port: env.OPJEV_GATEWAY_PORT,
    proxyTimeoutMs: env.OPJEV_GATEWAY_PROXY_TIMEOUT_MS,
    upstreamTimeoutMs: env.OPJEV_GATEWAY_UPSTREAM_TIMEOUT_MS,
    rpcTimeoutMs: env.OPJEV_GATEWAY_RPC_TIMEOUT_MS,
    routeDecisionTimeoutMs: env.OPJEV_GATEWAY_ROUTE_TIMEOUT_MS,
    maxBodyBytes: env.OPJEV_GATEWAY_MAX_BODY_BYTES,
    defaultMode: env.OPJEV_GATEWAY_DEFAULT_MODE,
    rules: env.OPJEV_GATEWAY_RULES,
    upstreamPassword:
      env.OPJEV_UPSTREAM_PASSWORD || env.OPENCODE_PASSWORD || env.OPENCODE_SERVER_PASSWORD || undefined,
  };
}
