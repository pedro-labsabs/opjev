// DecisionSnapshot: contexto minimo e normalizado para uma decisao do Jev.
// Centraliza a construcao do estado para que route, retry, escalate e futuras
// decisoes usem o mesmo formato (nada de history completa nem dumps enormes).

import { FREE_POOL, type RouteKind } from "./config.ts";

export interface DecisionSnapshot {
  sessionID: string;
  /** Intencao atual resumida (truncada). */
  intention: string;
  agent: string;
  model: string;
  route: RouteKind | "unknown";
  /** Modelos do FREE_POOL disponiveis no catalogo atual. */
  freeModels: string[];
  /** Agentes validos disponiveis no OpenCode. */
  agents: string[];
  attempt: number;
  /** Modelos ja tentados (cyclo de retry/escalada). */
  triedModels: string[];
  /** Modelo que falhou nesta decisao (quando houver). */
  failedModel?: string;
  /** Falha recente normalizada (quando houver). */
  lastError?: string;
  /** Decisao anterior relevante (quando houver). */
  priorDecision?: unknown;
}

export interface BuildSnapshotInput {
  ctx: any;
  sessionID: string;
  intention?: string;
  extra?: {
    attempt?: number;
    lastError?: string;
    failedModel?: string;
    priorDecision?: unknown;
  };
}

const INTENTION_MAX = 500;

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncado]` : text;
}

async function getSessionAgentModel(ctx: any, sessionID: string): Promise<{ agent?: string; model?: string }> {
  if (!ctx?.session?.get) return {};
  try {
    const s = await ctx.session.get(sessionID);
    if (!s) return {};
    const agent = String(
      (s as any)?.agent?.id ?? (s as any)?.agent ?? (s as any)?.current?.agent ?? "",
    );
    const model = String(
      (s as any)?.model?.id
        ? `${(s as any)?.model?.provider ?? "opencode"}/${(s as any)?.model?.id}`
        : (s as any)?.model?.modelID ?? (s as any)?.model ?? "",
    );
    return { agent: agent || undefined, model: model || undefined };
  } catch {
    return {};
  }
}

async function getAvailableAgents(ctx: any): Promise<string[]> {
  if (!ctx?.agent?.list) return [];
  try {
    const listed: any = await ctx.agent.list();
    const items: any[] = Array.isArray(listed) ? listed : (listed?.agents ?? listed?.data ?? []);
    return items
      .map((a: any) => String(a?.id ?? a?.name ?? "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function getFreeModels(ctx: any): Promise<string[]> {
  // Catalogo indisponivel => assume todo o FREE_POOL (o pool e a autoridade).
  if (!ctx?.model?.list) return [...FREE_POOL];
  try {
    const listed: any = await ctx.model.list();
    const items: any[] = Array.isArray(listed) ? listed : (listed?.models ?? listed?.data ?? []);
    const refs: string[] = [];
    for (const m of items) {
      const p = String(m?.providerID ?? m?.provider?.id ?? m?.provider ?? "");
      const i = String(m?.id ?? m?.modelID ?? m?.name ?? "");
      if (p && i) refs.push(`${p}/${i}`);
    }
    if (refs.length === 0) return [...FREE_POOL];
    // Snapshot carrega apenas modelos free elegiveis (FREE_POOL ∩ catalogo).
    return (FREE_POOL as readonly string[]).filter((ref) =>
      refs.some((r) => r.toLowerCase() === ref.toLowerCase()),
    );
  } catch {
    return [...FREE_POOL];
  }
}

// Ultima decisao catalogada da sessao (priorDecision), bounded: o registro ja
// foi sanitizado/bounded na escrita (buildDecisionRecord). Usada no retry para
// o Jev entender o que ja foi decidido antes desta falha.
async function getLatestDecision(ctx: any, sessionID: string): Promise<unknown> {
  if (!ctx?.storage?.scan || !ctx?.storage?.get) return undefined;
  try {
    const keys: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page: any = await ctx.storage.scan({ prefix: `decision/${sessionID}/`, after, limit: 100 });
      const entries: any[] = page?.entries ?? [];
      for (const e of entries) keys.push(e.key);
      after = page?.next;
      if (!after) break;
    }
    keys.sort();
    if (keys.length === 0) return undefined;
    return await ctx.storage.get(keys[keys.length - 1]);
  } catch {
    return undefined;
  }
}

function bounded(value: unknown, max: number): unknown {
  const json = JSON.stringify(value);
  if (!json) return value;
  if (json.length <= max) return value;
  return `${json.slice(0, max)}…[truncado pelo plugin]`;
}

/**
 * Monta o DecisionSnapshot a partir do estado real da sessao:
 * - agente/modelo reais via ctx.session.get(sessionID);
 * - rota model center armazenada via route/<sessionID> (se houver);
 * - catalogo free real via ctx.model.list() cruzado com FREE_POOL;
 * - contexto especifico da decisao via `extra` (attempt real, erro normalizado,
 *   modelo que falhou, decisao anterior) usado no retry/escalada.
 * Nunca inclui history completa nem conteudo sensivel (apenas intencao truncada).
 */
export async function buildSnapshot(
  ctx: any,
  sessionID: string,
  extra?: BuildSnapshotInput["extra"],
): Promise<DecisionSnapshot> {
  const { agent, model } = await getSessionAgentModel(ctx, sessionID);

  let route: RouteKind | "unknown" = "unknown";
  let intentText = "";
  let storedModel = "";
  let storedAgent = "";
  let retryTried: string[] = [];
  try {
    const stored = (await ctx?.storage?.get(`route/${sessionID}`)) as
      | { route?: string; model?: string; agent?: string }
      | undefined;
    if (
      stored?.route &&
      (stored.route === "fast-coding" || stored.route === "heavy-reasoning" || stored.route === "research-docs")
    ) {
      route = stored.route as RouteKind;
    }
    storedModel = stored?.model ?? "";
    storedAgent = stored?.agent ?? "";
    const intention = (await ctx?.storage?.get(`intention/${sessionID}`)) as { text?: string } | undefined;
    intentText = intention?.text ?? "";
    // Historia de retry persistida: os modelos ja tentados entram no snapshot
    // para que qualquer decisao (retry/escalada/tool) nao os repita.
    const retry = (await ctx?.storage?.get(`retry/${sessionID}`)) as { tried?: string[] } | undefined;
    retryTried = Array.isArray(retry?.tried) ? retry.tried : [];
  } catch {
    // storage indisponivel: snapshot continua com o que temos.
  }

  const freeModels = await getFreeModels(ctx);
  const agents = await getAvailableAgents(ctx);
  const resolvedModel = model || storedModel;
  const resolvedAgent = agent || storedAgent;
  const attempt = Number(extra?.attempt) || 0;
  const failedModel = extra?.failedModel ?? resolvedModel ?? "unknown";
  const priorDecision = extra?.priorDecision ?? (await getLatestDecision(ctx, sessionID));

  return {
    sessionID,
    intention: intentText ? clamp(intentText, INTENTION_MAX) : "sem intencao catalogada",
    agent: resolvedAgent || "unknown",
    model: resolvedModel || "unknown",
    route,
    freeModels,
    agents,
    attempt,
    triedModels: Array.from(new Set<string>([...retryTried, ...(resolvedModel ? [resolvedModel] : [])])),
    failedModel: failedModel === "unknown" ? undefined : failedModel,
    lastError: extra?.lastError ? clamp(String(extra.lastError).slice(0, 400), 400) : undefined,
    priorDecision: priorDecision === undefined ? undefined : bounded(priorDecision, 4000),
  };
}

export { clamp };