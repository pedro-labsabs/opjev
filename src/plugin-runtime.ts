import { FREE_POOL, isFreeModel, splitModelRef, type FreeModel, type RouteKind, type RouterOptions } from "./config.ts";

import { chainFor, decideGeneric, decideRoute } from "./router.ts";

import { type CriticRuntime, type DispatcherDecisions, type DispatcherDeps, type OrchestratorRuntime, type WorkerRuntime, type WorkerSessionView } from "./orchestration/dispatcher.ts";
import { OrchestrationError, type ExecutionContract } from "./orchestration/types.ts";
import { createFollowupTakeSeam } from "./orchestration/followup.ts";

import { buildCriticProviderPermissions, buildOrchestratorProviderPermissions } from "./orchestration/readonly-policy.ts";
import { registerInternalToolSession } from "./orchestration/tool-authority.ts";
import {
  buildAgentCatalog,
  primaryEligibleAgents,
  resolvePrimaryAgent,
  buildImplementerPermissionRules,
  JEV_AGENT_ROLE,
  type AgentCatalog,
  type AgentCatalogEntry,
} from "./orchestration/agent-catalog.ts";
import { attemptKey } from "./orchestration/dispatcher.ts";
import { createBoundedStorageObservationSink } from "./resource-governor/storage-sink.ts";
import { evaluateResourceBudget } from "./resource-governor/runtime-policy.ts";

import { hasInternalCriticPromptMarker, hasInternalOrchestratorPromptMarker, hasInternalPromptMarker, isInternalCriticSession, isInternalOrchestratorSession, isInternalWorkerSession } from "./worker-hooks.ts";

export interface RouteState {
  route: RouteKind;
  model: string;
  agent: string;
  chain: string[];
}

export interface IntentionRecord {
  text: string;
  route: string;
  model: string;
  agent: string;
  via: string;
  confidence: number;
  overridden?: boolean;
  at: number;
}

export function modelRefString(m: any): string | undefined {
  if (!m) return undefined;
  if (typeof m === "string") return m;
  if (m?.providerID && m?.id) return `${m.providerID}/${m.id}`;
  return undefined;
}

export async function switchToModel(ctx: any, sessionID: string, ref: string): Promise<void> {
  const { providerID, id } = splitModelRef(ref);
  // Contrato V2: switchModel exige { providerID, id } (nao modelID).
  await ctx.session.switchModel({ sessionID, model: { providerID, id } });
}

export async function switchToAgent(ctx: any, sessionID: string, agent: string): Promise<void> {
  await ctx.session.switchAgent({ sessionID, agent });
}

// G3: valida agente contra lista disponivel (ctx.agent.list).
// Lista real disponivel (mesmo vazia) => retorna exatamente o que o runtime
// expoe: o roterio so apresenta/aprova agentes que ele proprio lista.
// Lista INDISPONIVEL (ctx.agent.list lancou) => fallback seguro build/plan
// (agentes padrao do OpenCode) — nunca inventa candidatos.
export async function validAgents(ctx: any): Promise<string[]> {
  try {
    const listed: any = await ctx.agent.list();
    const items: any[] = Array.isArray(listed) ? listed : (listed?.agents ?? listed?.data ?? []);
    return items
      .map((a: any) => String(a?.id ?? a?.name ?? "").trim())
      .filter((v: string) => v.length > 0);
  } catch {
    return ["build", "plan"];
  }
}

/**
 * Candidatos de switch-model (#10): FREE_POOL ∩ catalogo runtime, menos o
 * model atual e menos pares (currentAgent, candidato) ja tentados no run.
 * Nunca paid/external (isFreeModel e necessario, nao suficiente: precisa
 * estar na lista). Nunca apresenta o que sera rejeitado depois.
 */
export async function switchModelCandidates(
  ctx: any,
  currentAgent: string,
  currentModel: string,
  attempts: Array<{ agent: string; model: string }>,
): Promise<string[]> {
  const pool = await freeCandidates(ctx);
  const tried = new Set((attempts ?? []).map((a) => attemptKey(a.agent, a.model)));
  return pool.filter((m) => m !== currentModel && !tried.has(attemptKey(currentAgent, m)));
}

/**
 * Candidatos de switch-agent (#10): Agent Catalog primaryEligible, menos o
 * agent atual e menos pares (candidato, currentModel) ja tentados. Nunca
 * subagent-only/hidden/unknown/inventado (reutiliza as regras da #9).
 */
export async function switchAgentCandidates(
  ctx: any,
  currentAgent: string,
  currentModel: string,
  attempts: Array<{ agent: string; model: string }>,
): Promise<AgentCatalogEntry[]> {
  const catalog = await discoverAgentCatalog(ctx);
  const tried = new Set((attempts ?? []).map((a) => attemptKey(a.agent, a.model)));
  const lowerCurrent = String(currentAgent ?? "").toLowerCase();
  return primaryEligibleAgents(catalog).filter(
    (e) => e.id.toLowerCase() !== lowerCurrent && !tried.has(attemptKey(e.id, currentModel)),
  );
}

export async function isAgentAvailable(ctx: any, agent: string): Promise<boolean> {
  const list = await validAgents(ctx);
  return list.some((a) => a.toLowerCase() === agent.toLowerCase());
}

/**
 * Descobre o Agent Catalog do runtime (Agent.Info real 2.0.7) e normaliza via
 * buildAgentCatalog (bounded, sem inferencia). Lista vazia => catalogo vazio
 * (nunca inventa agents). API indisponivel (throw) => fallback seguro dos
 * built-ins comprovados build/plan (primary) — nunca IDs arbitrarios.
 * Usado SOMENTE pelo selectExecutor da orchestration; o roteamento dos hooks
 * interativos continua em validAgents (fora do escopo da #9).
 */
export async function discoverAgentCatalog(ctx: any): Promise<AgentCatalog> {
  try {
    const listed: any = await ctx.agent.list();
    const items: any[] = Array.isArray(listed) ? listed : (listed?.agents ?? listed?.data ?? []);
    return buildAgentCatalog(items, "discovery");
  } catch {
    return buildAgentCatalog(
      [
        { id: "build", name: "Build", mode: "primary", hidden: false, native: true },
        { id: "plan", name: "Plan", mode: "primary", hidden: false, native: true },
      ],
      "fallback",
    );
  }
}

export function isContextOverflow(error: any): boolean {
  const text = `${String(error?.type ?? "")} ${String(error?.message ?? "")}`.toLowerCase();
  return text.includes("context") || text.includes("overflow") || text.includes("too large") || text.includes("token limit");
}

// G2: throttle global do gateway Zen (todos os free compartilham a mesma
// entrada). 429/529/rate-limit -> trocar de modelo nao resolve; o retry
// apenas aguarda com backoff.
export function isGlobalThrottle(error: any): boolean {
  const code = Number(error?.status ?? error?.statusCode ?? error?.code ?? 0);
  const text = `${String(error?.type ?? "")} ${String(error?.message ?? "")}`.toLowerCase();
  return code === 429 || code === 529 || text.includes("rate limit") || text.includes("overload") || text.includes("too many requests");
}

/**
 * Trace DIAGNOSTICO opcional da apresentacao (off por padrao): append de uma
 * linha JSON por evento. Habilitado apenas por OPJEV_TUI_TRACE=<arquivo>.
 * Nao altera comportamento — existe para tornar a prova de apresentacao
 * auditavel quando o canario do E2E falha (ver tui.ts, lado cliente).
 */
export function tracePresentation(event: string, detail?: Record<string, unknown>): void {
  try {
    const path = process.env?.OPJEV_TUI_TRACE;
    if (!path) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    fs.appendFileSync(path, `${JSON.stringify({ t: Date.now(), side: "server", event, ...detail })}\n`);
  } catch {
    // trace nunca pode derrubar a admissao
  }
}

// G1: detecta follow-up trivial (continuacao sem mudanca de intencao).
// Curto e composto so por palavras de continuacao -> nao re-rerrota.
const FOLLOW_UP_RE =
  /^(ok|okay|sim|nao|não|ja|já|continua?|continue|continuar|vai|vamos|pode|podes|por favor|obrigad|valeu|perfeito|excelente|bom|legal|entendido|show|top|manda|manda ver|só isso|so isso|de novo|repete|repita)\b/i;

export function isTrivialFollowUp(text: string): boolean {
  const t = text.trim();
  if (t.length <= 2) return true;
  if (t.length > 96) return false;
  return FOLLOW_UP_RE.test(t);
}

// G3: valida o ref contra o catalogo de modelos disponiveis (ctx.model.list()).
// Se o catalogo estiver indisponivel, assume OK (nao bloqueia o roteamento).
export async function isModelAvailable(ctx: any, ref: string): Promise<boolean> {
  try {
    const listed: any = await ctx.model.list();
    const items: any[] = Array.isArray(listed)
      ? listed
      : (listed?.models ?? listed?.data ?? []);
    if (items.length === 0) return true;
    const { providerID, id } = splitModelRef(ref);
    const lowerP = providerID.toLowerCase();
    const lowerId = id.toLowerCase();
    return items.some((m: any) => {
      const p = String(m?.providerID ?? m?.provider?.id ?? m?.provider ?? "").toLowerCase();
      const i = String(m?.id ?? m?.modelID ?? m?.name ?? "").toLowerCase();
      // Aceita 3 formas: provider/id completo, provider sem sufixo, ou id puro.
      return (
        p === lowerP && i === lowerId ||
        p === lowerP && (i.startsWith(lowerId) || lowerId.startsWith(i)) ||
        i === lowerId
      );
    });
  } catch {
    return true;
  }
}

export async function safeStorageGet(ctx: any, key: string): Promise<any | undefined> {
  try {
    return await ctx.storage.get(key);
  } catch {
    return undefined;
  }
}

// Candidatos free para decisao: FREE_POOL ∩ catalogo disponivel.
// Catalogo indisponivel (ou vazio) => assume todo o pool (guardrail FREE_POOL
// continua valido; so o catalogo nao pode ser consultado).
export async function freeCandidates(ctx: any): Promise<FreeModel[]> {
  let catalogUnavailable = false;
  try {
    const listed: any = await ctx.model.list();
    const items: any[] = Array.isArray(listed) ? listed : (listed?.models ?? listed?.data ?? []);
    if (items.length === 0) catalogUnavailable = true;
  } catch {
    catalogUnavailable = true;
  }
  if (catalogUnavailable) return [...FREE_POOL];
  const found: FreeModel[] = [];
  for (const m of FREE_POOL) {
    if (await isModelAvailable(ctx, m)) found.push(m);
  }
  return found;
}

// G3: primeiro modelo da lista (na ordem dada) disponivel no catalogo.
export async function firstAvailable(ctx: any, candidates: string[]): Promise<string | undefined> {
  for (const c of candidates) {
    if (await isModelAvailable(ctx, c)) return c;
  }
  return undefined;
}

export interface SwitchExecResult {
  ok: boolean;
  model: string;
  agent: string;
  /** "model-unavailable" => nenhum candidato da cadeia esta no catalogo. */
  reason?: "model-unavailable" | "switch-failed";
  error?: unknown;
  rollbackFailed?: boolean;
}

/**
 * Troca transactional modelo+agente (nucleo unico; usado por applySwitch e
 * pela recuperacao de erros de tool — nenhuma via make-switch foge dele):
 * 1. valida tudo ANTES de mutar (catalogo free + agente valido);
 * 2. aplica em ordem segura (modelo depois agente);
 * 3. em falha parcial, rollback best-effort para o estado anterior.
 * NAO persiste route/* — o chamador persiste apenas quando ok === true.
 */
export async function switchExecutor(
  ctx: any,
  sessionID: string,
  route: RouteKind,
  model: string,
  agent: string,
  eligibleModels?: string[],
): Promise<SwitchExecResult> {
  let validModel = model;
  if (!(await isModelAvailable(ctx, validModel))) {
    // Callers with a tried/failed allowlist keep that boundary through the
    // final availability check; this helper must not widen it back to a lane.
    const alt = await firstAvailable(ctx, (eligibleModels ?? chainFor(route)).filter((m) => m !== validModel));
    if (!alt) return { ok: false, model: validModel, agent, reason: "model-unavailable" };
    validModel = alt;
  }
  let validAgent = agent;
  if (!(await isAgentAvailable(ctx, validAgent))) {
    validAgent = "build";
  }

  // Estado anterior (para rollback best-effort do modelo).
  let beforeModel: string | undefined;
  try {
    const s: any = await ctx.session.get(sessionID);
    beforeModel = modelRefString(s?.model);
  } catch {
    // sem estado anterior conhecido: rollback indisponivel (best-effort).
  }

  try {
    await switchToModel(ctx, sessionID, validModel);
    try {
      await switchToAgent(ctx, sessionID, validAgent);
    } catch (agentErr) {
      // Rollback best-effort do modelo ja trocado.
      let rollbackFailed = false;
      if (beforeModel && beforeModel !== validModel) {
        try {
          await switchToModel(ctx, sessionID, beforeModel);
        } catch {
          rollbackFailed = true;
        }
      }
      return { ok: false, model: validModel, agent: validAgent, reason: "switch-failed", error: agentErr, rollbackFailed };
    }
  } catch (modelErr) {
    return { ok: false, model: validModel, agent: validAgent, reason: "switch-failed", error: modelErr };
  }

  return { ok: true, model: validModel, agent: validAgent };
}

/**
 * applySwitch = switchExecutor + persistencia consistente:
 * - route/* e gravado somente apos transicao bem-sucedida (nunca fica mentindo);
 * - em falha, persiste apenas intention/* + metadata de diagnostico.
 */
export async function applySwitch(
  ctx: any,
  sessionID: string,
  route: RouteKind,
  model: string,
  agent: string,
  via: string,
  intention: IntentionRecord,
  event: any,
): Promise<{ ok: boolean; model: string; agent: string }> {
  const exec = await switchExecutor(ctx, sessionID, route, model, agent);
  if (!exec.ok) {
    await ctx.storage.set(`intention/${sessionID}`, intention);
    const tag = exec.reason === "model-unavailable" ? "model-unavailable" : "switch-failed";
    event.metadata = {
      ...event.metadata,
      "jev-router": tag,
      "jev-route": route,
      "jev-error":
        exec.error instanceof Error
          ? exec.error.message
          : tag === "model-unavailable"
            ? `nenhum modelo da rota ${route} disponivel no catalogo`
            : String(exec.error ?? "switch falhou"),
      ...(tag === "model-unavailable" ? { "jev-model-unavailable": model } : {}),
      ...(exec.rollbackFailed
        ? {
            "jev-rollback": "failed",
            "jev-partial-model": exec.model,
          }
        : {}),
    };
    return { ok: false, model, agent };
  }

  // 4. So agora route/* e o estado definitivo.
  const modelUnavailable = exec.model !== model;
  await ctx.storage.set(`route/${sessionID}`, {
    route,
    model: exec.model,
    agent: exec.agent,
    chain: chainFor(route),
  });
  await ctx.storage.set(`intention/${sessionID}`, intention);
  event.metadata = {
    ...event.metadata,
    "jev-router": modelUnavailable ? "routed-alt" : "routed",
    "jev-route": route,
    "jev-model": exec.model,
    "jev-agent": exec.agent,
    "jev-via": via,
    "jev-confidence": intention.confidence,
    ...(intention.overridden ? { "jev-overridden": true } : {}),
    ...(modelUnavailable ? { "jev-model-unavailable": model } : {}),
  };
  return { ok: true, model: exec.model, agent: exec.agent };
}

export async function pruneKeys(ctx: any, sessionID: string, prefix: string, max: number): Promise<void> {
  try {
    const keys: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page: any = await ctx.storage.scan({ prefix, after, limit: 100 });
      const entries: any[] = page?.entries ?? [];
      for (const e of entries) keys.push(e.key);
      after = page?.next;
      if (!after) break;
    }
    keys.sort();
    if (keys.length > max) {
      const toRemove = keys.slice(0, keys.length - max);
      for (const k of toRemove) {
        await ctx.storage.remove(k);
      }
    }
  } catch {
    // Best-effort only; non-fatal.
  }
}

// ───────────────────────── orchestration dispatcher (runtime real) ─────────────────────────
//
// Adaptadores do Dispatcher do Orchestration Kernel v1:
//  - runtime: WorkerRuntime implementado com ctx.session.* (contratos reais);
//  - decisions: DispatcherDecisions com decideRoute (selecao) + decideGeneric (julgamento);
//  - persist: storage bounded em orchestration/run/<runID> (best-effort, nunca corrompe).
// O dispatcher core NAO conhece ctx: aqui so se constroem os adaptadores.

export function orchestrationDirectory(ctx: any): string | undefined {
  const loc = ctx?.location;
  if (!loc) return undefined;
  if (typeof loc === "string") return loc;
  return typeof loc?.directory === "string" ? loc.directory : undefined;
}

export function orchestrationAgentOf(info: any): string | undefined {
  if (!info) return undefined;
  const a = info?.agent;
  if (typeof a === "string" && a.trim()) return a.trim();
  if (a && typeof a?.id === "string" && a.id.trim()) return a.id.trim();
  return undefined;
}

export function orchestrationModelOf(info: any): string | undefined {
  const m = info?.model;
  if (!m) return undefined;
  if (typeof m === "string" && m.trim()) return m.trim();
  if (typeof m?.providerID === "string" && typeof m?.id === "string") return `${m.providerID}/${m.id}`;
  return undefined;
}

/** Papel interno de orchestration (worker|critic|null). Marker confiavel: metadata da sessao OU do prompt. */
export async function orchestrationRoleOf(ctx: any, sessionID: string, event: any): Promise<"worker" | "critic" | "orchestrator" | null> {
  if (hasInternalPromptMarker(event?.metadata) || hasInternalPromptMarker(event?.prompt?.metadata)) return "worker";
  if (hasInternalCriticPromptMarker(event?.metadata) || hasInternalCriticPromptMarker(event?.prompt?.metadata)) return "critic";
  if (hasInternalOrchestratorPromptMarker(event?.metadata) || hasInternalOrchestratorPromptMarker(event?.prompt?.metadata)) return "orchestrator";
  if (!sessionID) return null;
  try {
    const info: any = await ctx.session.get({ sessionID });
    if (isInternalWorkerSession(info?.metadata)) return "worker";
    if (isInternalCriticSession(info?.metadata)) return "critic";
    if (isInternalOrchestratorSession(info?.metadata)) return "orchestrator";
    return null;
  } catch {
    return null;
  }
}

export function makeWorkerRuntime(ctx: any): WorkerRuntime {
  return {
    async createWorker(input) {
      const info: any = await ctx.session.create({
        agent: input.agent,
        model: input.model,
        location: input.location,
        // Logical role separada de jev-role (session kind continua worker):
        // toda worker do dispatcher atua como implementer do ExecutionContract.
        metadata: { ...input.metadata, [JEV_AGENT_ROLE]: "implementer" },
        // Implementer executa, nao delega: nega spawn arbitrario de subagents
        // sem tocar nas demais permissoes da sessao (V2: "subagent").
        permissions: buildImplementerPermissionRules(),
      });
      const sessionID = String(info?.id ?? "");
      if (!sessionID) {
        throw new OrchestrationError("worker-create-failed", "ctx.session.create nao retornou id");
      }
      registerInternalToolSession(sessionID, "worker");
      return { sessionID };
    },
    async prompt({ sessionID, text, metadata }) {
      await ctx.session.prompt({ sessionID, text, metadata });
    },
    async wait({ sessionID }) {
      await ctx.session.wait({ sessionID });
    },
    async get({ sessionID }): Promise<WorkerSessionView> {
      const info: any = await ctx.session.get({ sessionID });
      return {
        agent: orchestrationAgentOf(info),
        model: orchestrationModelOf(info),
        outcome: info?.outcome,
        metadata: info?.metadata,
        usage: info?.usage ?? info?.tokens,
      };
    },
    async context({ sessionID }) {
      const out: any = await ctx.session.context({ sessionID });
      return Array.isArray(out) ? out : [];
    },
    async interrupt({ sessionID }) {
      await ctx.session.interrupt?.({ sessionID });
    },
  };
}

/**
 * Runtime do critic: anuncia toolset compativel ao provider. A autoridade
 * read-only e aplicada localmente por `tool.execute.before`, que verifica
 * metadata de role criada pelo dispatcher antes de qualquer tool side effect.
 * Worker continua com sua permission boundary propria.
 */
export function makeCriticRuntime(ctx: any): CriticRuntime {
  return {
    async createCritic(input) {
      const info: any = await ctx.session.create({
        agent: input.agent,
        model: input.model,
        location: input.location,
        // Critic logico: mesma sessao kind critic, papel auditavel separado.
        metadata: { ...input.metadata, [JEV_AGENT_ROLE]: "critic" },
        permissions: buildCriticProviderPermissions(),
      });
      const sessionID = String(info?.id ?? "");
      if (!sessionID) {
        throw new OrchestrationError("critic-create-failed", "ctx.session.create nao retornou id (critic)");
      }
      registerInternalToolSession(sessionID, "critic");
      return { sessionID };
    },
    async prompt({ sessionID, text, metadata }) {
      await ctx.session.prompt({ sessionID, text, metadata });
    },
    async wait({ sessionID }) {
      await ctx.session.wait({ sessionID });
    },
    async get({ sessionID }): Promise<WorkerSessionView> {
      const info: any = await ctx.session.get({ sessionID });
      return {
        agent: orchestrationAgentOf(info),
        model: orchestrationModelOf(info),
        outcome: info?.outcome,
        metadata: info?.metadata,
        usage: info?.usage ?? info?.tokens,
      };
    },
    async context({ sessionID }) {
      const out: any = await ctx.session.context({ sessionID });
      return Array.isArray(out) ? out : [];
    },
    async interrupt({ sessionID }) {
      await ctx.session.interrupt?.({ sessionID });
    },
  };
}

/**
 * Runtime do orchestrator (#11): sessao dedicada de logical role orchestrator.
 * Canonical agent/model vindos do dispatcher (nunca selection hardcoded, nunca
 * escolha do planner); location atual; read-only (mesmo envelope do critic,
 * com execute=deny contra tools.jev.* e recursao); metadata com jev-role
 * orchestrator + jev-agent-role orchestrator. Nao registra agent novo. O
 * provider recebe o toolset compativel; enforcement read-only e local.
 */
export function makeOrchestratorRuntime(ctx: any): OrchestratorRuntime {
  return {
    async createOrchestrator(input) {
      const info: any = await ctx.session.create({
        agent: input.agent,
        model: input.model,
        location: input.location,
        metadata: { ...input.metadata, [JEV_AGENT_ROLE]: "orchestrator" },
        permissions: buildOrchestratorProviderPermissions(),
      });
      const sessionID = String(info?.id ?? "");
      if (!sessionID) {
        throw new OrchestrationError("orchestrator-create-failed", "ctx.session.create nao retornou id (orchestrator)");
      }
      registerInternalToolSession(sessionID, "orchestrator");
      return { sessionID };
    },
    async prompt({ sessionID, text, metadata }) {
      await ctx.session.prompt({ sessionID, text, metadata });
    },
    async wait({ sessionID }) {
      await ctx.session.wait({ sessionID });
    },
    async get({ sessionID }) {
      const info: any = await ctx.session.get({ sessionID });
      return {
        agent: orchestrationAgentOf(info),
        model: orchestrationModelOf(info),
        outcome: info?.outcome,
        metadata: info?.metadata,
        usage: info?.usage ?? info?.tokens,
      };
    },
    async context({ sessionID }) {
      const out: any = await ctx.session.context({ sessionID });
      return Array.isArray(out) ? out : [];
    },
    async interrupt({ sessionID }) {
      await ctx.session.interrupt?.({ sessionID });
    },
  };
}

export function makeDispatcherDecisions(ctx: any, opts: Required<RouterOptions>, getKey: () => Promise<string | undefined>): DispatcherDecisions {
  return {
    // dispatch(initial): Jev escolhe executor (agent + free model). Nunca
    // inventado pelo dispatcher: decideRoute restringe aos candidatos validos
    // e possui fallback deterministico (via = heuristic).
    async selectExecutor({ contract }) {
      // #9: o Jev escolhe SOMENTE entre primary-eligiveis do catalogo runtime
      // (mode primary|all, nunca hidden/subagent-only). Catalogo vazio =>
      // bounded failure antes do Jev (nunca inventa agents).
      const catalog = await discoverAgentCatalog(ctx);
      const primaryIds = primaryEligibleAgents(catalog).map((e) => e.id);
      if (primaryIds.length === 0) {
        throw new OrchestrationError(
          "invalid-selection",
          `nenhum agente primary elegivel no catalogo runtime (entries=${catalog.entries.length}, source=${catalog.source}): Jev nao e consultado e nenhum worker e criado`,
        );
      }
      const candidates = await freeCandidates(ctx);
      const d = await decideRoute({
        prompt: contract.objective,
        agent: undefined,
        model: undefined,
        validAgents: primaryIds,
        freeCandidates: candidates,
        route: "unknown",
        jevModel: opts.jevModel,
        jevEndpoint: opts.jevEndpoint,
        apiKey: await getKey(),
        confidenceThreshold: opts.confidenceThreshold,
        timeoutMs: opts.jevTimeoutMs,
      });
      // Guardrail pos-fallback (Blocker B): a saida FINAL do decideRoute e
      // revalidada contra o catalogo runtime REAL. decideRoute() continua sendo
      // a decision boundary; o adapter apenas aplica guardrails. Se o Jev
      // falhou, heuristicRoute() pode ter escolhido modelo/agente fora do
      // catalogo — nunca se deixa isso chegar ao createWorker. Nenhuma escolha
      // alternativa e inventada aqui: selecao nao elegivel => erro bounded, o
      // kernel falha a rodada antes de criar qualquer worker.
      if (!isFreeModel(d.model) || !candidates.includes(d.model)) {
        throw new OrchestrationError(
          "invalid-selection",
          `modelo selecionado nao elegivel no catalogo runtime: ${d.model}`,
        );
      }
      // Catalogo como autoridade final (pos-fallback Blocker B + #9): o agent
      // final precisa existir no catalogo E ser primary. Se o Jev tentou um
      // candidato conhecido-mas-inelegivel (ex: subagent-only), rejeita A
      // TENTATIVA com diagnostico preciso — nunca o lane-default que a
      // substituiu. Retorna o ID canonico do runtime (case preservado). Sem
      // switch-agent, sem escolha alternativa — inelegivel => erro bounded.
      const attempted: unknown = (d as { attemptedAgent?: unknown }).attemptedAgent;
      if (typeof attempted === "string" && attempted.trim()) {
        // Caso A — escolha EXPLICITA do Jev rejeitada pelo router: valida A
        // TENTATIVA contra o catalogo (unknown ou inelegivel => erro bounded).
        // Nunca mascara com o lane-default que a substituiu. Sem attemptedAgent
        // (Caso B — heuristic apos Jev indisponivel), valida-se o final abaixo.
        resolvePrimaryAgent(catalog, attempted);
      }
      const entry = resolvePrimaryAgent(catalog, d.agent);
      return {
        agent: entry.id,
        model: d.model,
        via: d.via,
        route: d.route,
        explanation: d.explanation,
        confidence: d.confidence,
        ...(d.overridden !== undefined ? { overridden: d.overridden } : {}),
        ...(d.error ? { error: d.error } : {}),
      };
    },
    // judgeRound: o Jev julga a evidencia da rodada (SystemOne, nao-generativo).
    async judgeRound({ state, questions }) {
      return await decideGeneric({
        state,
        questions,
        jevModel: opts.jevModel,
        jevEndpoint: opts.jevEndpoint,
        apiKey: await getKey(),
        timeoutMs: opts.jevTimeoutMs,
      });
    },
    // selectModel (#10): Jev escolhe UM novo modelo entre candidatos validos
    // via decideGeneric ESTRITO (sem heuristic fallback). Jev indisponivel /
    // resposta fora dos candidates / paid / repetido => erro bounded; o
    // scheduler falha sem criar worker. Dispatcher nao escolhe nada local.
    async selectModel(input) {
      const current = { agent: String(input.current?.agent ?? ""), model: String(input.current?.model ?? "") };
      const attempts = Array.isArray(input.attempts) ? input.attempts : [];
      const candidates = await switchModelCandidates(ctx, current.agent, current.model, attempts);
      if (candidates.length === 0) {
        throw new OrchestrationError(
          "no-model-candidates",
          `switch-model sem candidatos validos (FREE_POOL ∩ catalogo − atual − tentados, attempts=${attempts.length})`,
        );
      }
      const criteria: Record<string, string> = {};
      for (const m of candidates) criteria[m] = `Eligible FREE model for the next round (${m})`;
      const answers = await decideGeneric({
        state: {
          objective: String(input.contract?.objective ?? "").slice(0, 2000),
          round: input.round,
          maxRounds: input.contract?.maxRounds,
          current,
          failureClass: input.failureClass,
          resultSummary: String(input.resultSummary ?? "").slice(0, 500),
          attempts: attempts.length,
        },
        questions: {
          selected_model: {
            type: "choice",
            instructions: "Which eligible FREE model should execute the next round? Choose ONLY one of the presented candidates.",
            criteria,
          },
        },
        jevModel: opts.jevModel,
        jevEndpoint: opts.jevEndpoint,
        apiKey: await getKey(),
        timeoutMs: opts.jevTimeoutMs,
      });
      const ans: any = answers["selected_model"];
      const model = ans && ans.type === "choice" && typeof ans.choice === "string" ? ans.choice.trim() : "";
      if (!model || !isFreeModel(model) || !candidates.includes(model)) {
        throw new OrchestrationError(
          "invalid-selection",
          `switch-model fora dos candidatos validos: ${model || "(vazio)"} (candidates=${candidates.length})`,
        );
      }
      const tried = new Set(attempts.map((a) => attemptKey(a.agent, a.model)));
      if (tried.has(attemptKey(current.agent, model))) {
        throw new OrchestrationError(
          "invalid-selection",
          `switch-model repetido neste run: ${current.agent}/${model} ja tentado`,
        );
      }
      return { model };
    },
    // selectAgent (#10): espelho de selectModel sobre o Agent Catalog (#9).
    // Somente primaryEligible; subagent-only/hidden/unknown/inventado nunca
    // sao apresentados nem aceitos (resolvePrimaryAgent). Sem heuristic.
    async selectAgent(input) {
      const current = { agent: String(input.current?.agent ?? ""), model: String(input.current?.model ?? "") };
      const attempts = Array.isArray(input.attempts) ? input.attempts : [];
      const candidates = await switchAgentCandidates(ctx, current.agent, current.model, attempts);
      if (candidates.length === 0) {
        throw new OrchestrationError(
          "no-agent-candidates",
          `switch-agent sem candidatos validos (primary − atual − tentados, attempts=${attempts.length})`,
        );
      }
      const catalog = await discoverAgentCatalog(ctx);
      const criteria: Record<string, string> = {};
      for (const e of candidates) criteria[e.id] = e.description || `Eligible primary agent for the next round (${e.id})`;
      const answers = await decideGeneric({
        state: {
          objective: String(input.contract?.objective ?? "").slice(0, 2000),
          round: input.round,
          maxRounds: input.contract?.maxRounds,
          current,
          failureClass: input.failureClass,
          resultSummary: String(input.resultSummary ?? "").slice(0, 500),
          attempts: attempts.length,
        },
        questions: {
          selected_agent: {
            type: "choice",
            instructions: "Which eligible primary agent should execute the next round? Choose ONLY one of the presented candidates.",
            criteria,
          },
        },
        jevModel: opts.jevModel,
        jevEndpoint: opts.jevEndpoint,
        apiKey: await getKey(),
        timeoutMs: opts.jevTimeoutMs,
      });
      const ans: any = answers["selected_agent"];
      const agent = ans && ans.type === "choice" && typeof ans.choice === "string" ? ans.choice.trim() : "";
      if (!agent) {
        throw new OrchestrationError("invalid-selection", "switch-agent sem agent valido na resposta do Jev");
      }
      const entry = resolvePrimaryAgent(catalog, agent);
      const tried = new Set(attempts.map((a) => attemptKey(a.agent, a.model)));
      if (tried.has(attemptKey(entry.id, current.model))) {
        throw new OrchestrationError(
          "invalid-selection",
          `switch-agent repetido neste run: ${entry.id}/${current.model} ja tentado`,
        );
      }
      return { agent: entry.id };
    },
  };
}

/** Persistencia minima bounded: orchestration/run/<runID>. Best-effort. */
export async function persistOrchestrationRun(
  ctx: any,
  input: {
    kind: string;
    runID: string;
    workerSessionID?: string;
    criticSessionID?: string;
    orchestratorSessionID?: string;
    state: any;
    at: number;
  },
): Promise<void> {
  const key = `orchestration/run/${input.runID}`;
  const prior: any = await safeStorageGet(ctx, key);
  await ctx.storage.set(key, {
    ...(prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {}),
    checkpoint: input.kind,
    state: input.state,
    workerSessionID: input.workerSessionID,
    criticSessionID: input.criticSessionID,
    orchestratorSessionID: input.orchestratorSessionID,
    updatedAt: input.at,
  });
}

export function makeOrchestrationDeps(ctx: any, opts: Required<RouterOptions>, getKey: () => Promise<string | undefined>): DispatcherDeps {
  const dir = orchestrationDirectory(ctx);
  return {
    runtime: makeWorkerRuntime(ctx),
    critic: makeCriticRuntime(ctx),
    orchestrator: makeOrchestratorRuntime(ctx),
    decisions: makeDispatcherDecisions(ctx, opts, getKey),
    persist: (p) => persistOrchestrationRun(ctx, p),
    resourceBudget: (input) => evaluateResourceBudget(ctx.storage, input),
    observeResource: createBoundedStorageObservationSink(ctx, {
      get: async (key) => await safeStorageGet(ctx, key),
      set: async (key, value) => await ctx.storage.set(key, value),
    }),
    storage: {
      get: async (key: string) => {
        return await ctx.storage.get(key);
      },
      set: async (key: string, value: unknown) => {
        await ctx.storage.set(key, value);
      },
    },
    // Consumo de follow-ups (#13): o mesmo storage de admission alimenta o
    // boundary de rodada. Consumo exactly-once (registro consumido no record);
    // storage indisponivel => fail-closed.
    followups: createFollowupTakeSeam({
      storage: {
        get: async (key: string) => {
          return await ctx.storage.get(key);
        },
        set: async (key: string, value: unknown) => {
          await ctx.storage.set(key, value);
        },
      },
    }),
    ...(dir !== undefined ? { location: { directory: dir } } : {}),
  };
}

export function recordRuntimeResource(ctx: any, observation: Record<string, unknown>): Promise<void> {
  // Ordinary retry telemetry is best effort; hard policy branches may await this bounded sink.
  return createBoundedStorageObservationSink(ctx, {
    get: async (key) => await safeStorageGet(ctx, key),
    set: async (key, value) => await ctx.storage.set(key, value),
  })(observation).catch(() => {});
}

export function errorClassOf(s: string): string {
  const clean = s.split("\n")[0]?.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) || "unknown";
  return clean || "unknown";
}

// Locale: janela de repeticao para erros materiais de tool.
export const TOOL_ERROR_WINDOW_MS = 5 * 60 * 1000; // 5 min
export const TOOL_ERROR_REPEAT_THRESHOLD = 2;
export const TOOL_DECIDE_COOLDOWN_MS = 90 * 1000; // nao consulta o Jev em loop pela mesma assinatura
export const SWITCH_COOLDOWN_MS = 2 * 60 * 1000;

// Acoes de recuperacao NAO executadas pelo plugin (entregues como recomendacao
// one-shot ao proximo context do agente). switch-model/switch-agent ficam fora:
// essas o plugin executa direto (nao-destrutivas, dentro do runtime).
export const RECOVERY_ACTIONS: string[] = ["retry", "replan", "stop", "escalate"];

export function toolErrorMayBeUnviable(errorMessage: string): boolean {
  const t = errorMessage.toLowerCase();
  // Estratégia inviável = o fluxo/modelo está travado. Erros de permissao NAO
  // contam aqui: sao politica do runtime (trocar modelo nao resolve), entao
  // ficam sob a regra de repeticao (count >= limiar).
  return (
    t.includes("invalid tool") ||
    t.includes("tool not found") ||
    t.includes("session is stuck") ||
    t.includes("no candidates") ||
    t.includes("repeated identical failure")
  );
}

// Observa erros materiais de tools (execute.after). Nunca consulta o Jev
// apos tool bem-sucedida. Em erro material (repeticao ou inviavel), pergunta
// ao Jev qual acao recomendar e aplica apenas acoes nao-destrutivas.
