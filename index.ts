import { Plugin } from "@opencode/plugin";
import { FREE_POOL, isFreeModel, resolveOptions, splitModelRef, type FreeModel, type RouteKind, type RouterOptions } from "./src/config.ts";
import { resolveApiKey } from "./src/auth.ts";
import {
  chainFor,
  decideEscalation,
  decideGeneric,
  decideRoute,
  nextFallback,
} from "./src/router.ts";
import { buildSnapshot, type DecisionSnapshot } from "./src/snapshot.ts";
import { buildDecisionRecord, sanitizeState } from "./src/sanitize.ts";
import { buildToolRecoverQuestions } from "./src/jev-client.ts";
import {
  runOrchestrationOnce,
  type CriticRuntime,
  type DispatcherDecisions,
  type DispatcherDeps,
  type OrchestrationRunResult,
  type WorkerRuntime,
  type WorkerSessionView,
} from "./src/orchestration/dispatcher.ts";
import { OrchestrationError, validateExecutionContract, type ExecutionContract } from "./src/orchestration/types.ts";
import { buildCriticPermissionRules } from "./src/orchestration/readonly-policy.ts";
import {
  buildAgentCatalog,
  primaryEligibleAgents,
  resolvePrimaryAgent,
  buildImplementerPermissionRules,
  JEV_AGENT_ROLE,
  type AgentCatalog,
} from "./src/orchestration/agent-catalog.ts";
import {
  buildCriticContextInstruction,
  buildWorkerContextInstruction,
  hasInternalCriticPromptMarker,
  hasInternalPromptMarker,
  isInternalCriticSession,
  isInternalWorkerSession,
} from "./src/worker-hooks.ts";

// Jev como juiz-roteador (System One, nao-generativo) via OpenCode Zen,
// para os free models do Zen. Endpoint: /zen/v1/systemone com a mesma
// API key do Zen (env OPENCODE_API_KEY ou credential do `/connect`).
// As tools vivem no namespace `jev` em Code Mode (codemode: true); a chamada
// real e via tool `execute`: tools.jev.decide/route/escalate. Nao existem
// tools globais `jev_decide`/`jev_route`/`jev_escalate`.
// - `tools.jev.route`: agentes perguntam ao Jev qual lane/agente/modelo free usar.
// - `tools.jev.escalate`: o Jev escolhe outro free capaz apos falha.
// - `tools.jev.decide`: decisao generica — qualquer pergunta SystemOne
//   (choice/noul/score) sobre qualquer estado. E o juiz da equipe.
// - Hook `prompt`: intencao original catalogada (intention/* + route/*)
//   e distribuida (switch + metadados) quando enableAutoRoute=true.
// - Hook `context`: instrucao enxuta para os agentes consultarem o Jev
//   apenas em decision boundaries (nao em toda operacao). Roda na montagem
//   do contexto do agent loop, inclusive em continuacoes. Tambem entrega a
//   recomendacao de recuperacao one-shot (pending-recovery) do Jev apos erro
//   material de tool, consumindo-a na mesma hora.
// - Hook `retry`: fallback em cadeia automatico; o Jev participa quando a
//   falha e material (snapshot enriquecido: intencao, agente/modelo reais,
//   rota, attempt real do evento, modelo que falhou, modelos tentados,
//   candidatos free, erro normalizado e decisao anterior).
// - Hook `tool.execute.after`: observa erros materiais de tools e consulta
//   o Jev somente nesses eventos (nunca depois de tool bem-sucedida).
//   Acoes nao executadas (retry/replan/stop/escalate) viram recomendacao
//   one-shot entregue ao proximo context do agente (nunca execucao
//   destrutiva automatica).
//
// Guardrail absoluto: somente modelos do FREE_POOL disponiveis no catalogo
// atual podem ser selecionados. Nenhuma resposta do Jev escapa disso.
// O Jev decide; o runtime applica permissoes e politicas.

interface RouteState {
  route: RouteKind;
  model: string;
  agent: string;
  chain: string[];
}

interface IntentionRecord {
  text: string;
  route: string;
  model: string;
  agent: string;
  via: string;
  confidence: number;
  overridden?: boolean;
  at: number;
}

function modelRefString(m: any): string | undefined {
  if (!m) return undefined;
  if (typeof m === "string") return m;
  if (m?.providerID && m?.id) return `${m.providerID}/${m.id}`;
  return undefined;
}

async function switchToModel(ctx: any, sessionID: string, ref: string): Promise<void> {
  const { providerID, id } = splitModelRef(ref);
  // Contrato V2: switchModel exige { providerID, id } (nao modelID).
  await ctx.session.switchModel({ sessionID, model: { providerID, id } });
}

async function switchToAgent(ctx: any, sessionID: string, agent: string): Promise<void> {
  await ctx.session.switchAgent({ sessionID, agent });
}

// G3: valida agente contra lista disponivel (ctx.agent.list).
// Lista real disponivel (mesmo vazia) => retorna exatamente o que o runtime
// expoe: o roterio so apresenta/aprova agentes que ele proprio lista.
// Lista INDISPONIVEL (ctx.agent.list lancou) => fallback seguro build/plan
// (agentes padrao do OpenCode) — nunca inventa candidatos.
async function validAgents(ctx: any): Promise<string[]> {
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

async function isAgentAvailable(ctx: any, agent: string): Promise<boolean> {
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
async function discoverAgentCatalog(ctx: any): Promise<AgentCatalog> {
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

function isContextOverflow(error: any): boolean {
  const text = `${String(error?.type ?? "")} ${String(error?.message ?? "")}`.toLowerCase();
  return text.includes("context") || text.includes("overflow") || text.includes("too large") || text.includes("token limit");
}

// G2: throttle global do gateway Zen (todos os free compartilham a mesma
// entrada). 429/529/rate-limit -> trocar de modelo nao resolve; o retry
// apenas aguarda com backoff.
function isGlobalThrottle(error: any): boolean {
  const code = Number(error?.status ?? error?.statusCode ?? error?.code ?? 0);
  const text = `${String(error?.type ?? "")} ${String(error?.message ?? "")}`.toLowerCase();
  return code === 429 || code === 529 || text.includes("rate limit") || text.includes("overload") || text.includes("too many requests");
}

// G1: detecta follow-up trivial (continuacao sem mudanca de intencao).
// Curto e composto so por palavras de continuacao -> nao re-rerrota.
const FOLLOW_UP_RE =
  /^(ok|okay|sim|nao|não|ja|já|continua?|continue|continuar|vai|vamos|pode|podes|por favor|obrigad|valeu|perfeito|excelente|bom|legal|entendido|show|top|manda|manda ver|só isso|so isso|de novo|repete|repita)\b/i;

function isTrivialFollowUp(text: string): boolean {
  const t = text.trim();
  if (t.length <= 2) return true;
  if (t.length > 96) return false;
  return FOLLOW_UP_RE.test(t);
}

// G3: valida o ref contra o catalogo de modelos disponiveis (ctx.model.list()).
// Se o catalogo estiver indisponivel, assume OK (nao bloqueia o roteamento).
async function isModelAvailable(ctx: any, ref: string): Promise<boolean> {
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

async function safeStorageGet(ctx: any, key: string): Promise<any | undefined> {
  try {
    return await ctx.storage.get(key);
  } catch {
    return undefined;
  }
}

// Candidatos free para decisao: FREE_POOL ∩ catalogo disponivel.
// Catalogo indisponivel (ou vazio) => assume todo o pool (guardrail FREE_POOL
// continua valido; so o catalogo nao pode ser consultado).
async function freeCandidates(ctx: any): Promise<FreeModel[]> {
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
async function firstAvailable(ctx: any, candidates: string[]): Promise<string | undefined> {
  for (const c of candidates) {
    if (await isModelAvailable(ctx, c)) return c;
  }
  return undefined;
}

interface SwitchExecResult {
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
async function switchExecutor(
  ctx: any,
  sessionID: string,
  route: RouteKind,
  model: string,
  agent: string,
): Promise<SwitchExecResult> {
  let validModel = model;
  if (!(await isModelAvailable(ctx, validModel))) {
    const alt = await firstAvailable(ctx, chainFor(route).filter((m) => m !== validModel));
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
async function applySwitch(
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

async function pruneKeys(ctx: any, sessionID: string, prefix: string, max: number): Promise<void> {
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

function orchestrationDirectory(ctx: any): string | undefined {
  const loc = ctx?.location;
  if (!loc) return undefined;
  if (typeof loc === "string") return loc;
  return typeof loc?.directory === "string" ? loc.directory : undefined;
}

function orchestrationAgentOf(info: any): string | undefined {
  if (!info) return undefined;
  const a = info?.agent;
  if (typeof a === "string" && a.trim()) return a.trim();
  if (a && typeof a?.id === "string" && a.id.trim()) return a.id.trim();
  return undefined;
}

function orchestrationModelOf(info: any): string | undefined {
  const m = info?.model;
  if (!m) return undefined;
  if (typeof m === "string" && m.trim()) return m.trim();
  if (typeof m?.providerID === "string" && typeof m?.id === "string") return `${m.providerID}/${m.id}`;
  return undefined;
}

/** Papel interno de orchestration (worker|critic|null). Marker confiavel: metadata da sessao OU do prompt. */
async function orchestrationRoleOf(ctx: any, sessionID: string, event: any): Promise<"worker" | "critic" | null> {
  if (hasInternalPromptMarker(event?.metadata) || hasInternalPromptMarker(event?.prompt?.metadata)) return "worker";
  if (hasInternalCriticPromptMarker(event?.metadata) || hasInternalCriticPromptMarker(event?.prompt?.metadata)) return "critic";
  if (!sessionID) return null;
  try {
    const info: any = await ctx.session.get({ sessionID });
    if (isInternalWorkerSession(info?.metadata)) return "worker";
    if (isInternalCriticSession(info?.metadata)) return "critic";
    return null;
  } catch {
    return null;
  }
}

function makeWorkerRuntime(ctx: any): WorkerRuntime {
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
 * Runtime do critic: mesma API de sessao, mas a criacao injeta as permission
 * rules read-only (buildCriticPermissionRules) no `ctx.session.create` do
 * critic. Enforcement e do runtime OpenCode; o adapter apenas declara a
 * policy. O worker (makeWorkerRuntime) NUNCA recebe permission rules —
 * cria sem o campo, entao nao herda restricao do critic.
 */
function makeCriticRuntime(ctx: any): CriticRuntime {
  return {
    async createCritic(input) {
      const info: any = await ctx.session.create({
        agent: input.agent,
        model: input.model,
        location: input.location,
        // Critic logico: mesma sessao kind critic, papel auditavel separado.
        metadata: { ...input.metadata, [JEV_AGENT_ROLE]: "critic" },
        permissions: buildCriticPermissionRules(),
      });
      const sessionID = String(info?.id ?? "");
      if (!sessionID) {
        throw new OrchestrationError("critic-create-failed", "ctx.session.create nao retornou id (critic)");
      }
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

function makeDispatcherDecisions(ctx: any, opts: Required<RouterOptions>, getKey: () => Promise<string | undefined>): DispatcherDecisions {
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
  };
}

/** Persistencia minima bounded: orchestration/run/<runID>. Best-effort. */
async function persistOrchestrationRun(
  ctx: any,
  input: { kind: string; runID: string; workerSessionID?: string; criticSessionID?: string; state: any; at: number },
): Promise<void> {
  const key = `orchestration/run/${input.runID}`;
  const prior: any = await safeStorageGet(ctx, key);
  await ctx.storage.set(key, {
    ...(prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {}),
    state: input.state,
    workerSessionID: input.workerSessionID,
    criticSessionID: input.criticSessionID,
    updatedAt: input.at,
  });
}

function makeOrchestrationDeps(ctx: any, opts: Required<RouterOptions>, getKey: () => Promise<string | undefined>): DispatcherDeps {
  const dir = orchestrationDirectory(ctx);
  return {
    runtime: makeWorkerRuntime(ctx),
    critic: makeCriticRuntime(ctx),
    decisions: makeDispatcherDecisions(ctx, opts, getKey),
    persist: (p) => persistOrchestrationRun(ctx, p),
    ...(dir !== undefined ? { location: { directory: dir } } : {}),
  };
}

function errorClassOf(s: string): string {
  const clean = s.split("\n")[0]?.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) || "unknown";
  return clean || "unknown";
}

// Locale: janela de repeticao para erros materiais de tool.
const TOOL_ERROR_WINDOW_MS = 5 * 60 * 1000; // 5 min
const TOOL_ERROR_REPEAT_THRESHOLD = 2;
const TOOL_DECIDE_COOLDOWN_MS = 90 * 1000; // nao consulta o Jev em loop pela mesma assinatura
const SWITCH_COOLDOWN_MS = 2 * 60 * 1000;

// Acoes de recuperacao NAO executadas pelo plugin (entregues como recomendacao
// one-shot ao proximo context do agente). switch-model/switch-agent ficam fora:
// essas o plugin executa direto (nao-destrutivas, dentro do runtime).
const RECOVERY_ACTIONS: string[] = ["retry", "replan", "stop", "escalate"];

function toolErrorMayBeUnviable(errorMessage: string): boolean {
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
async function observeToolError(ctx: any, event: any, opts: { timeoutMs: number; getKey: () => Promise<string | undefined>; jevModel: string; jevEndpoint: string }): Promise<void> {
  if (event?.status !== "error") return;
  const sessionID = String(event?.sessionID ?? "");
  if (!sessionID) return;
  const tool = String(event?.tool ?? "unknown");
  const message = String(event?.error?.message ?? event?.error ?? "");
  const errorClass = errorClassOf(message);

  const counterKey = `tool-errors/${sessionID}/${tool}/${errorClass}`;
  const counter: any = (await safeStorageGet(ctx, counterKey)) ?? { count: 0, lastAt: 0, tool };
  // Janela: se a ultima ocorrencia da mesma assinatura foi ha muito tempo,
  // reinicia a contagem (padrao novo, nao repeticao).
  if (Date.now() - (counter.lastAt ?? 0) > TOOL_ERROR_WINDOW_MS) {
    counter.count = 0;
  }
  counter.count = (counter.count ?? 0) + 1;
  counter.lastAt = Date.now();
  counter.tool = tool;
  counter.errorClass = errorClass;
  await ctx.storage.set(counterKey, counter);
  await pruneKeys(ctx, sessionID, `tool-errors/${sessionID}/`, 400);

  const material =
    counter.count >= TOOL_ERROR_REPEAT_THRESHOLD || toolErrorMayBeUnviable(message);
  if (!material) return;

  // Cooldown: mesma assinatura decidida recentemente nao re-consulta o Jev.
  const decidedKey = `tool-decided/${sessionID}/${tool}/${errorClass}`;
  const lastDecided: any = await safeStorageGet(ctx, decidedKey);
  if (lastDecided && Date.now() - (lastDecided.at ?? 0) < TOOL_DECIDE_COOLDOWN_MS) return;
  await ctx.storage.set(decidedKey, { at: Date.now(), action: "pending" });
  await pruneKeys(ctx, sessionID, `tool-decided/${sessionID}/`, 200);

  // Snapshot enriquecido para a decisao de recuperacao: attempt real (repeticao
  // da ferramenta), erro normalizado/bounded e decisao anterior (quando houver).
  // failedModel default: modelo real resolvido da sessao.
  const errSummary = message.slice(0, 400);
  const snapshot = await buildSnapshot(ctx, sessionID, {
    attempt: counter.count,
    lastError: errSummary,
  });
  try {
    const answers = await decideGeneric({
      state: {
        session: {
          intention: snapshot.intention,
          agent: snapshot.agent,
          model: snapshot.model,
          route: snapshot.route,
          attempt: snapshot.attempt,
        },
        failure: {
          tool,
          errorClass,
          error: snapshot.lastError ?? "",
          repeats: counter.count,
          attempt: snapshot.attempt,
          material: true,
        },
      },
      questions: buildToolRecoverQuestions(),
      jevModel: opts.jevModel,
      jevEndpoint: opts.jevEndpoint,
      apiKey: await opts.getKey(),
      timeoutMs: opts.timeoutMs,
    });
    const action = answers["action"];
    const choice = action?.type === "choice" ? action.choice : undefined;

    // Persiste a decisao (sanitizada e bounded).
    await ctx.storage.set(
      `decision/${sessionID}/${Date.now()}`,
      buildDecisionRecord(
        { tool, errorClass, repeats: counter.count },
        { action: choice, keep_model: answers["keep_model"] },
      ),
    );
    await pruneKeys(ctx, sessionID, `decision/${sessionID}/`, 50);

    // Acoes permitidas (nao-destrutivas, via API publica, dentro do runtime).
    const route: any = await safeStorageGet(ctx, `route/${sessionID}`);
    const routeKind: RouteKind = route?.route && ["fast-coding", "heavy-reasoning", "research-docs"].includes(route.route)
      ? route.route
      : "fast-coding";
    const recentSwitch: any = await safeStorageGet(ctx, `last-tool-switch/${sessionID}`);
    const canSwitch = !recentSwitch || Date.now() - (recentSwitch.at ?? 0) > SWITCH_COOLDOWN_MS;
    const candidates = chainFor(routeKind);

    if (choice === "switch-model" && canSwitch) {
      const failedRef = modelRefString(snapshot.model && snapshot.model !== "unknown" ? snapshot.model : undefined) ?? route?.model;
      const tried = snapshot.triedModels.filter((m) => m !== failedRef);
      const esk = await decideEscalation({
        failedModel: failedRef ?? candidates[0],
        reason: `tool ${tool} failed (${errorClass})`,
        candidates,
        triedModels: tried,
        snapshot,
        jevModel: opts.jevModel,
        jevEndpoint: opts.jevEndpoint,
        apiKey: await opts.getKey(),
        timeoutMs: opts.timeoutMs,
      });
      const currentAgent = route?.agent ?? (snapshot.agent === "unknown" ? "build" : snapshot.agent);
      if (esk.model) {
        const target = await firstAvailable(ctx, [esk.model, ...candidates]);
        if (target) {
          // Mesma transacao do switch normal (valida antes, rollback best-effort).
          const exec = await switchExecutor(ctx, sessionID, routeKind, target, currentAgent);
          if (exec.ok) {
            await ctx.storage.set(`route/${sessionID}`, { route: routeKind, model: exec.model, agent: exec.agent, chain: candidates });
            await ctx.storage.set(`last-tool-switch/${sessionID}`, { at: Date.now(), tool, target: exec.model });
            await ctx.storage.set(decidedKey, { at: Date.now(), action: `switch-model:${exec.model}` });
          } else {
            await ctx.storage.set(decidedKey, { at: Date.now(), action: "switch-model-failed" });
          }
        }
      }
    } else if (choice === "switch-agent" && canSwitch) {
      const agents = await validAgents(ctx);
      const current = snapshot.agent === "unknown" ? route?.agent ?? "build" : snapshot.agent;
      // Qualquer agente que o runtime expose (ctx.agent.list) e elegivel.
      const next = agents.find((a) => a !== current);
      if (next) {
        const currentModel = route?.model ?? (snapshot.model === "unknown" ? candidates[0] : snapshot.model);
        const exec = await switchExecutor(ctx, sessionID, routeKind, currentModel, next);
        if (exec.ok) {
          await ctx.storage.set(`route/${sessionID}`, { route: routeKind, model: exec.model, agent: exec.agent, chain: candidates });
          await ctx.storage.set(`last-tool-switch/${sessionID}`, { at: Date.now(), tool, target: exec.agent });
          await ctx.storage.set(decidedKey, { at: Date.now(), action: `switch-agent:${exec.agent}` });
        } else {
          await ctx.storage.set(decidedKey, { at: Date.now(), action: "switch-agent-failed" });
        }
      }
    } else {
      // retry/replan/stop/escalate: acoes nao executadas pelo plugin (sem
      // execucao destrutiva automatica). A recomendacao do Jev vira uma
      // mensagem ONE-SHOT no proximo context do agente e e consumida/removida
      // depois de entregue (nunca cresce um backlog nem roda em loop).
      if (choice && RECOVERY_ACTIONS.includes(choice)) {
        const pending: any = {
          action: choice,
          tool,
          errorClass,
          repeats: counter.count,
          at: Date.now(),
          keep_model:
            answers["keep_model"]?.type === "noul" ? answers["keep_model"].noul : undefined,
        };
        await ctx.storage.set(`pending-recovery/${sessionID}`, pending);
        await pruneKeys(ctx, sessionID, `pending-recovery/${sessionID}`, 5);
      }
      await ctx.storage.set(decidedKey, { at: Date.now(), action: choice ?? "none" });
    }
  } catch (err) {
    await ctx.storage.set(decidedKey, { at: Date.now(), action: "jev-unavailable" });
    // Jev indisponivel: fallback determinístico — apenas registra; nao vira acao.
  }
}

// Recomendacao de recuperacao one-shot: se existe `pending-recovery/<sessionID>`
// (decisao do Jev apos erro material, nao executada pelo plugin), injeta uma
// mensagem ENXUTA no proximo context do agente e CONSONE a chave na hora —
// chega uma unica vez, nunca cresce, nunca roda em loop. Sem acao destrutiva
// automatica: o agente decide se segue a recomendacao.
async function injectPendingRecovery(ctx: any, sessionID: string, event: any): Promise<void> {
  if (!sessionID || !event?.system || !Array.isArray(event.system)) return;
  try {
    const pending: any = await ctx.storage.get(`pending-recovery/${sessionID}`);
    if (!pending) return;
    const action = String(pending.action ?? "none");
    const keep = pending.keep_model !== undefined
      ? ` (manter modelo: ${String(pending.keep_model).slice(0, 80)})`
      : "";
    event.system.push({
      type: "text",
      text:
        `[jev-router] Apos falha material na tool ${String(pending.tool ?? "?").slice(0, 40)}, ` +
        `o Jev recomenda: ${action}${keep}. Nada foi executado automaticamente; ` +
        "aplique apenas se fizer sentido para a tarefa.",
    });
    // Consome a recomendacao: o proximo context NAO a recebe de novo.
    await ctx.storage.remove(`pending-recovery/${sessionID}`);
  } catch {
    // Best-effort: storage indisponivel nao pode quebrar o context hook.
  }
}

export default Plugin.define({
  id: "jev-free-router",
  async setup(ctx: any) {
    const opts = resolveOptions(ctx.options ?? {});
    // Resolve por chamada (nao so no setup) para captar `export` ou
    // `/connect` feitos apos o load. resolveApiKey le a env primeiro.
    const getKey = () => resolveApiKey(ctx, opts.apiKeyEnv);

    await ctx.tool.transform((editor: any) => {
      editor.namespace({
        name: "jev",
        description: "Jev juiz-roteador para free models do Zen",
      });
      editor.add({
        name: "route",
        description:
          "Pergunta ao Jev (SystemOne choice+confidence) qual lane+agent+model free usar entre os candidatos permitidos (FREE_POOL ∩ catalogo). Retorna rota, modelo, agente e cadeia de fallback.",
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Tarefa a rotear" },
            agent: { type: "string", description: "Agente atual da sessao" },
            sessionID: { type: "string", description: "Sessao OpenCode (para memoria de fallback)" },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        options: { namespace: "jev", codemode: true },
        execute: async (input: any) => {
          const sessionID = String(input.sessionID ?? "");
          const candidates = await freeCandidates(ctx);
          const agents = await validAgents(ctx);
          let snapshot: DecisionSnapshot | undefined;
          if (sessionID) {
            snapshot = await buildSnapshot(ctx, sessionID);
          }
          const d = await decideRoute({
            prompt: String(input.prompt ?? ""),
            agent: snapshot?.agent ?? input.agent,
            model: snapshot?.model,
            validAgents: agents,
            freeCandidates: candidates,
            route: snapshot?.route ?? "unknown",
            jevModel: opts.jevModel,
            jevEndpoint: opts.jevEndpoint,
            apiKey: await getKey(),
            confidenceThreshold: opts.confidenceThreshold,
            timeoutMs: opts.jevTimeoutMs,
          });
          if (sessionID) {
            const intention: IntentionRecord = {
              text: String(input.prompt ?? "").slice(0, 4000),
              route: d.route,
              model: d.model,
              agent: d.agent,
              via: d.via,
              confidence: d.confidence,
              overridden: d.overridden,
              at: Date.now(),
            };
            const res = await applySwitch(ctx, sessionID, d.route, d.model, d.agent, d.via, intention, { metadata: {} });
            if (!res.ok) {
              // Sem switch (indisponivel/falha). A decisao do Jev segue valida
              // como recomendacao; nada de route/* mentiroso.
            } else {
              // Somente reporta o estado efetivamente aplicado.
              d.model = res.model as FreeModel;
              d.agent = res.agent;
            }
          }
          return {
            content: JSON.stringify({
              route: d.route,
              model: d.model,
              agent: d.agent,
              confidence: d.confidence,
              risky: d.risky,
              complexity: d.complexity,
              via: d.via,
              overridden: d.overridden,
              chain: chainFor(d.route),
              ...(d.error ? { jevError: d.error } : {}),
            }),
          };
        },
      });

      editor.add({
        name: "escalate",
        description:
          "O Jev escolhe outro free model capaz apos falha (proximo da cadeia ou override explícito dentro do pool free).",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string" },
            toModel: { type: "string", description: "Override opcional dentro do pool free, ex: opencode/big-pickle" },
            reason: { type: "string" },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        options: { namespace: "jev", codemode: true },
        execute: async (input: any) => {
          const sessionID = String(input.sessionID ?? "");
          if (!sessionID) return { content: "sessionID e obrigatorio" };
          const override = input.toModel as string | undefined;
          if (override !== undefined && !isFreeModel(override)) {
            return { content: `override ${override} fora do pool free; escolha um de: ${chainFor("fast-coding").join(", ")} (ou outra lane)` };
          }
          const stored = (await safeStorageGet(ctx, `route/${sessionID}`)) as RouteState | undefined;
          const failed = stored?.model;
          const routeKind: RouteKind = stored?.route && (stored.route === "heavy-reasoning" || stored.route === "research-docs") ? stored.route : "fast-coding";
          const chain = chainFor(routeKind);
          const snapshot = await buildSnapshot(ctx, sessionID);
          const tried = snapshot.triedModels;
          let next: string | undefined = override;
          let via: "override" | "jev" | "chain" | "override-alt" = "override";
          if (!next) {
            const esk = await decideEscalation({
              failedModel: failed ?? snapshot.model,
              reason: input.reason as string | undefined,
              candidates: chain.filter((m) => m !== failed),
              triedModels: tried,
              jevModel: opts.jevModel,
              jevEndpoint: opts.jevEndpoint,
              apiKey: await getKey(),
              timeoutMs: opts.jevTimeoutMs,
            });
            if (esk.model) {
              via = esk.via === "jev" ? "jev" : "chain";
              next = esk.model;
            } else {
              via = "chain";
              next = failed ? nextFallback(routeKind, failed) : chain[0];
            }
          }
          if (!next) return { content: "cadeia de fallback esgotada" };
          // G3: valida o candidato escolhido (Jev/override/chain) no catalogo.
          // Se nao estiver disponivel, usa o primeiro da cadeia que estiver.
          const available = await firstAvailable(ctx, [next, ...chain]);
          if (!available) {
            return { content: `nenhum modelo da rota ${routeKind} disponivel no catalogo (${next} indisponivel)` };
          }
          if (available !== next) {
            via = via === "override" ? "override-alt" : via;
          }
          // Mesma transacao do switch normal (valida antes, rollback best-effort).
          const currentAgent = stored?.agent ?? (snapshot.agent === "unknown" ? "build" : snapshot.agent);
          const exec = await switchExecutor(ctx, sessionID, routeKind, available, currentAgent);
          if (!exec.ok) {
            const reason = exec.reason === "model-unavailable" ? "indisponivel no catalogo" : "switch-failed";
            return {
              content: `falha ao trocar para ${available} (${reason}): ${
                exec.error instanceof Error ? exec.error.message : "nenhum candidato da rota disponivel"
              }`,
            };
          }
          await ctx.storage.set(`route/${sessionID}`, { route: routeKind, model: exec.model, agent: exec.agent, chain });
          return { content: `escalado para ${exec.model} (via ${via})${input.reason ? `: ${input.reason}` : ""}` };
        },
      });

      editor.add({
        name: "decide",
        description:
          "Juiz generico da equipe: envia qualquer estado + perguntas SystemOne (choice/noul/score) ao Jev e retorna as respostas. Use quando precisar decidir algo (modelo, prioridade, trade-off, proximo passo) em vez de adivinhar ou pedir ao usuario.",
        input: {
          type: "object",
          properties: {
            state: {
              description: "Estado/fatos para o Jev julgar (objeto ou texto, nunca null; ex: {} ou \"contexto\")",
              anyOf: [{ type: "object" }, { type: "string" }],
            },
            questions: {
              type: "object",
              description:
                "Objeto/mapa com 1-8 perguntas. Cada CHAVE e um nome escolhido por voce para a pergunta. " +
                "Cada VALOR e { type, instructions, criteria }. " +
                "type: 'choice' (criteria = objeto { chave: descricao }), " +
                "'noul' (criteria = objeto { true: ..., false: ... }), " +
                "'score' (criteria = array [legenda, ...]). " +
                'Exemplo: { "opcao": { type: "choice", instructions: "Qual vem primeiro?", criteria: { alpha: "Option alpha", beta: "Option beta" } } }',
              minProperties: 1,
              maxProperties: 8,
              additionalProperties: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["choice", "noul", "score"],
                    description: "Tipo da pergunta SystemOne",
                  },
                  instructions: {
                    type: "string",
                    description: "Pergunta/instrucao para o Jev (nao vazia)",
                  },
                  criteria: {
                    description:
                      "choice/noul: objeto { chave: descricao } (strings nao vazias). " +
                      "score: array de legendas (strings nao vazias).",
                    anyOf: [
                      { type: "object", additionalProperties: { type: "string" } },
                      { type: "array", items: { type: "string" } },
                    ],
                  },
                },
                required: ["type", "instructions", "criteria"],
                additionalProperties: false,
              },
            },
            sessionID: { type: "string", description: "Sessao OpenCode (para catalogar a decisao)" },
          },
          required: ["state", "questions"],
          additionalProperties: false,
        },
        options: { namespace: "jev", codemode: true },
        execute: async (input: any) => {
          try {
            const answers = await decideGeneric({
              state: input.state,
              questions: input.questions as Record<string, unknown>,
              jevModel: opts.jevModel,
              jevEndpoint: opts.jevEndpoint,
              apiKey: await getKey(),
              timeoutMs: opts.jevTimeoutMs,
            });
            if (input.sessionID) {
              // Persistencia bounded e sanitizada: nunca o input.state bruto.
              await ctx.storage.set(
                `decision/${input.sessionID}/${Date.now()}`,
                buildDecisionRecord(input.state, answers),
              );
            }
            await pruneKeys(ctx, String(input.sessionID ?? ""), `decision/${input.sessionID}/`, 50);
            return { content: JSON.stringify({ answers, via: "jev" }) };
          } catch (err) {
            await pruneKeys(ctx, String(input.sessionID ?? ""), `decision/${input.sessionID}/`, 50);
            return { content: `jev decide falhou: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });

      editor.add({
        name: "orchestrate_once",
        description:
          "Runtime entrypoint EXPLICITO do dispatcher de orquestracao (scheduler multi-round bounded): o Jev seleciona o " +
          "executor UMA vez, cria a worker session OpenCode real, executa o ExecutionContract com EvidencePacket e o Jev julga " +
          "cada rodada (JevVerdict). Apos verdict repair-same/fresh-same, uma NOVA rodada e executada automaticamente " +
          "(repair-same reutiliza a MESMA worker session; fresh-same cria sessao NOVA, mesmo agent/model), sempre com critic " +
          "novo, ate accept/stop ou o limite maxRounds (kernel). Demais acoes (switch-model/switch-agent/replan/human) param " +
          "no boundary e voltam como pendingCommands. Test seam explicito — NUNCA e chamada automaticamente pelo prompt hook. " +
          "Contract invalido e rejeitado localmente (validateExecutionContract).",
        input: {
          type: "object",
          properties: {
            contract: {
              type: "object",
              description:
                "ExecutionContract bounded da rodada: runID, objective, scope (include/exclude), constraints, " +
                "acceptanceCriteria, requiredEvidence e maxRounds.",
              properties: {
                runID: { type: "string", description: "Identificador unico da execucao (max 200 chars)" },
                objective: { type: "string", description: "Objetivo da rodada (max 2000 chars)" },
                scope: {
                  type: "object",
                  description: "Escopo da tarefa",
                  properties: {
                    include: { type: "array", items: { type: "string" }, description: "Caminhos/areas incluidas" },
                    exclude: { type: "array", items: { type: "string" }, description: "Caminhos/areas excluidas" },
                  },
                  additionalProperties: false,
                },
                constraints: {
                  type: "array",
                  items: { type: "string" },
                  description: "Restricoes da execucao (max 50 itens, 500 chars cada)",
                },
                acceptanceCriteria: {
                  type: "array",
                  items: { type: "string" },
                  description: "Criterios de aceite — obrigatorio, pelo menos 1",
                },
                requiredEvidence: {
                  type: "array",
                  items: { type: "string" },
                  description: "Evidencia exigida da rodada",
                },
                maxRounds: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                  description:
                    "Limite de rodadas do scheduler (kernel e a autoridade): repair-same/fresh-same executam rounds " +
                    "internos enquanto round+1 <= maxRounds; alem do limite, o kernel emite awaiting-human + request-human.",
                },
              },
              required: ["runID", "objective", "acceptanceCriteria", "maxRounds"],
              additionalProperties: false,
            },
          },
          required: ["contract"],
          additionalProperties: false,
        },
        options: { namespace: "jev", codemode: true },
        execute: async (input: any) => {
          try {
            validateExecutionContract(input?.contract);
          } catch (err) {
            return { content: `orchestrate_once: contract invalido: ${err instanceof Error ? err.message : String(err)}` };
          }
          try {
            const result: OrchestrationRunResult = await runOrchestrationOnce(
              input.contract as ExecutionContract,
              makeOrchestrationDeps(ctx, opts, getKey),
            );
            return { content: JSON.stringify(result) };
          } catch (err) {
            return {
              content: `orchestrate_once falhou: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });
    });

    // Erros materiais de tools entram no loop de decisao (observeToolError).
    await ctx.tool.hook("execute.after", async (event: any) => {
      await observeToolError(ctx, event, {
        timeoutMs: opts.jevTimeoutMs,
        getKey,
        jevModel: opts.jevModel,
        jevEndpoint: opts.jevEndpoint,
      });
    });

    // Fallback em cadeia: quando o provider falha, o Jev participa da escolha
    // do proximo executor (com estado real). Deterministico para:
    // - overflow de contexto -> compaction resolve (sem troca);
    // - throttle global (429/529/rate-limit) -> backoff sem trocar modelo;
    // - nenhum candidato restante -> parar corretamente.
    // Jev indisponivel -> fallback determinístico (cadeia) bounded.
    await ctx.session.hook("retry", async (event: any) => {
      if (isContextOverflow(event?.error)) return;
      if (isGlobalThrottle(event?.error)) {
        event.decision = { retry: true, delay: 5000 };
        return;
      }
      const sessionID = String(event?.sessionID ?? "");
      if (!sessionID) return;
      const stored = (await safeStorageGet(ctx, `route/${sessionID}`)) as RouteState | undefined;
      // O modelo que REALMENTE falhou: o retry hook dispara imediatamente apos
      // a falha do modelo ativo, entao event.model (Model.Ref) e a fonte exata;
      // o route/* e apenas fallback quando o evento nao o carrega.
      const failedRef =
        modelRefString(event?.model) ?? (event?.model?.providerID && event?.model?.id
          ? `${event.model.providerID}/${event.model.id}`
          : stored?.model);
      if (!failedRef) return;

      // Estado de retry persistido: evita repetir modelos ja tentados (sem loop).
      const retryState: any = (await safeStorageGet(ctx, `retry/${sessionID}`)) ?? { tried: [] };
      const tried = Array.from(new Set<string>([...(retryState.tried ?? []), failedRef]));

      const snapshot = await buildSnapshot(ctx, sessionID, {
        attempt: Number(event?.attempt) || tried.length,
        lastError: `${String(event?.error?.type ?? "")}: ${String(event?.error?.message ?? "").slice(0, 300)}`,
        failedModel: failedRef,
      });
      const routeKind: RouteKind = snapshot.route !== "unknown"
        ? snapshot.route
        : stored?.route && (stored.route === "heavy-reasoning" || stored.route === "research-docs")
          ? stored.route
          : "fast-coding";
      const chain = chainFor(routeKind);
      const esk = (await decideEscalation({
        failedModel: failedRef,
        reason: `${String(event?.error?.type ?? "")}: ${String(event?.error?.message ?? "").slice(0, 300)}`,
        candidates: chain,
        triedModels: tried,
        snapshot,
        jevModel: opts.jevModel,
        jevEndpoint: opts.jevEndpoint,
        apiKey: await getKey(),
        timeoutMs: opts.jevTimeoutMs,
      })) as { via: string; model?: string; error?: string };

      if (esk.via === "stop" || !esk.model) {
        // nenhum candidato restante: para corretamente (sem loop).
        await ctx.storage.set(`retry/${sessionID}`, { tried, at: Date.now() });
        event.decision = { retry: false };
        return;
      }
      // Guardrail: so troca para modelo disponivel no catalogo.
      const candidates = [esk.model, ...chain];
      const valid = await firstAvailable(ctx, candidates);
      if (!valid) {
        await ctx.storage.set(`retry/${sessionID}`, { tried, at: Date.now() });
        event.decision = { retry: false };
        return;
      }
      try {
        await switchToModel(ctx, sessionID, valid);
        await ctx.storage.set(`route/${sessionID}`, {
          route: routeKind,
          model: valid,
          agent: stored?.agent ?? (snapshot.agent === "unknown" ? "build" : snapshot.agent),
          chain,
        });
        await ctx.storage.set(`retry/${sessionID}`, {
          tried: [...tried, valid].slice(-12),
          at: Date.now(),
          via: esk.via,
        });
        // registra a decisao (sanitizada) para diagnostico
        await ctx.storage.set(
          `decision/${sessionID}/${Date.now()}`,
          buildDecisionRecord(
            { failedModel: failedRef, reasonSnippet: String(event?.error?.message ?? "").slice(0, 200) },
            { via: esk.via, model: valid },
          ),
        );
        await pruneKeys(ctx, sessionID, `decision/${sessionID}/`, 50);
        event.decision = { retry: true, delay: 1000 };
      } catch {
        event.decision = { retry: true, delay: 2000 };
      }
    });

    // Intencao original catalogada e distribuida: consulta o Jev na admissao
    // do prompt, persiste intention/* (o que o usuario quis) + route/*
    // (o que o Jev decidiu) e distribui via switch + metadados.
    // Falhas nunca bloqueiam o prompt.
    if (opts.enableAutoRoute) {
      await ctx.session.hook("prompt", async (event: any) => {
        const sessionID = String(event?.sessionID ?? "");
        const text = String(event?.prompt?.text ?? "");

        // Sessao interna de orchestration: bypass TOTAL do auto-routing.
        // Worker e critic ja tem papel definido pelo dispatcher; nunca rerrotear.
        const orchestrationRole = await orchestrationRoleOf(ctx, sessionID, event);
        if (orchestrationRole) {
          event.metadata = {
            ...event.metadata,
            "jev-router": "orchestration-internal",
            "jev-role": orchestrationRole,
          };
          return;
        }

        if (!text.trim()) {
          event.metadata = { ...event.metadata, "jev-router": "skipped-empty" };
          return;
        }
        const prior: RouteState | undefined = await safeStorageGet(ctx, `route/${sessionID}`);

        // G1: sessao ja roteada e prompt e follow-up trivial (ok, continua...)
        // -> mantem rota e modelo, apenas cataloga a continuacao. Sem chamada
        // ao Jev, sem troca de modelo no meio da tarefa.
        if (prior && isTrivialFollowUp(text)) {
          await ctx.storage.set(`intention/${sessionID}`, {
            text: text.slice(0, 4000),
            route: prior.route,
            model: prior.model,
            agent: prior.agent,
            via: "continuation",
            confidence: 0,
            at: Date.now(),
          });
          event.metadata = {
            ...event.metadata,
            "jev-router": "continuation",
            "jev-route": prior.route,
            "jev-model": prior.model,
            "jev-agent": prior.agent,
            "jev-via": "continuation",
          };
          return;
        }

        try {
          // Problema 1: agente/modelo reais da sessao (via ctx.session.get),
          // nao event?.agent (que nao existe no contrato do prompt hook).
          const snapshot = await buildSnapshot(ctx, sessionID);
          const candidates = await freeCandidates(ctx);
          const agents = await validAgents(ctx);
          const d = await decideRoute({
            prompt: text,
            agent: snapshot.agent,
            model: snapshot.model !== "unknown" ? snapshot.model : undefined,
            validAgents: agents,
            freeCandidates: candidates,
            route: snapshot.route,
            jevModel: opts.jevModel,
            jevEndpoint: opts.jevEndpoint,
            apiKey: await getKey(),
            confidenceThreshold: opts.confidenceThreshold,
            timeoutMs: opts.jevTimeoutMs,
          });
          const intention: IntentionRecord = {
            text: text.slice(0, 4000),
            route: d.route,
            model: d.model,
            agent: d.agent,
            via: d.via,
            confidence: d.confidence,
            overridden: d.overridden,
            at: Date.now(),
          };
          // Mesma rota+modelo+agente da sessao -> sem switch desnecessario.
          if (prior && prior.route === d.route && prior.model === d.model && prior.agent === d.agent) {
            await ctx.storage.set(`intention/${sessionID}`, intention);
            event.metadata = {
              ...event.metadata,
              "jev-router": "routed",
              "jev-route": d.route,
              "jev-model": d.model,
              "jev-agent": d.agent,
              "jev-via": d.via,
              "jev-confidence": d.confidence,
              ...(d.overridden ? { "jev-overridden": true } : {}),
            };
            return;
          }
          await applySwitch(ctx, sessionID, d.route, d.model, d.agent, d.via, intention, event);
        } catch (err) {
          event.metadata = {
            ...event.metadata,
            "jev-router": "route-failed",
            "jev-error": err instanceof Error ? err.message : String(err),
          };
        }
      });

      // Agentes chamam o Jev sozinhos: instrucao ENXUTA injetada no contexto.
      // As tools Jev vivem no namespace `jev` em Code Mode (codemode: true):
      // nao existem tools globais `jev_decide`/`jev_route`/`jev_escalate`.
      // A chamada real e via tool `execute`: tools.jev.decide/route/escalate.
      // Objetivo: Jev em decision boundaries (nova intencao, escolha de
      // executor, duvida objetiva, falha material, repeticacao, escalada),
      // nunca em toda operacao. Sem bloco grande a cada chamada.
      // Observacao: o hook `context` roda na montagem do contexto do agent
      // loop, inclusive em CONTINUACOES da sessao (nao so no turno do usuario).
      await ctx.session.hook("context", async (event: any) => {
        const sessionID = String(event?.sessionID ?? "");

        // Sessao interna de orchestration recebe instrucao especifica do papel.
        // Worker executa; critic verifica read-only. Nenhum deles rerroteia.
        const orchestrationRole = await orchestrationRoleOf(ctx, sessionID, event);
        if (orchestrationRole === "worker") {
          event.system.push({
            type: "text",
            text: buildWorkerContextInstruction(),
          });
          return;
        }
        if (orchestrationRole === "critic") {
          event.system.push({
            type: "text",
            text: buildCriticContextInstruction(),
          });
          return;
        }

        // Instrucao normal para sessoes de usuario (texto atual preservado):
        // Jev em decision boundaries, via tool `execute` em Code Mode.
        event.system.push({
          type: "text",
          text:
            "O Jev (SystemOne) e a camada de decisao: consulte-o so em decision boundaries " +
            "(nova intencao, escolher executor, duvida objetiva entre alternativas, falha material, " +
            "erro repetido ou escalada). Nao chame `jev.decide`/`tools.jev.decide` como tool direta " +
            "(nao existe no catalogo). Use SEMPRE a tool `execute` em Code Mode: dentro dela escreva JavaScript " +
            "(sem import/export) e retorne a chamada, ex: `return await tools.jev.decide({...})`. " +
            "O mesmo vale para `tools.jev.route(...)` e `tools.jev.escalate(...)`. " +
            "Nao pare o servico nem peca ao usuario; invoque o tool. Fora desses momentos, siga sem o Jev.",
        });
        // Recomendacao de recuperacao do Jev (erro material em tool): entregue
        // uma unica vez e removida logo em seguida (one-shot, sem loop).
        await injectPendingRecovery(ctx, sessionID, event);
      });
    }
  },
});

// Reexporta utilitarios para testes comportamentais.
export { sanitizeState, buildDecisionRecord, errorClassOf, isTrivialFollowUp, isContextOverflow, isGlobalThrottle, freeCandidates, validAgents };
