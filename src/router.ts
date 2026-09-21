import {
  FREE_POOL,
  FALLBACK_CHAIN,
  isFreeModel,
  type FreeModel,
  type RouteKind,
} from "./config.ts";
import {
  buildEscalateQuestions,
  buildRouterQuestions,
  callJevSystemOne,
  type JevChoiceAnswer,
  type JevNoulAnswer,
  type JevResponse,
  type JevScoreAnswer,
} from "./jev-client.ts";
import type { DecisionSnapshot } from "./snapshot.ts";

export interface RouteDecision {
  route: RouteKind;
  agent: string;
  model: FreeModel;
  confidence: number;
  risky: boolean;
  complexity: number;
  via: "jev" | "heuristic";
  error?: string;
  overridden?: boolean;
  /** Escolha bruta do Jev quando rejeitada pelos guardrails (auditoria). */
  attemptedAgent?: string;
}

const ROUTES: RouteKind[] = ["fast-coding", "heavy-reasoning", "research-docs"];

function isRoute(v: string): v is RouteKind {
  return (ROUTES as string[]).includes(v);
}
function isAgent(v: string, validAgents: string[]): boolean {
  // Se a lista de agentes disponiveis vier disponível e não vazia,
  // só aceitamos agentes que ela efetivamente lista.
  // Se a lista estiver indisponível/vazia, aceitamos apenas build/plan.
  const fallback: string[] = ["build", "plan"];
  if (validAgents.length > 0) {
    return validAgents.some((a) => a.toLowerCase() === v.toLowerCase());
  }
  // fallback: agente indisponível -> só build|plan
  return fallback.some((a) => a.toLowerCase() === v.toLowerCase());
}
function isFreeCandidate(model: string, freeCandidates: string[]): model is FreeModel {
  return isFreeModel(model) && freeCandidates.includes(model);
}

export function heuristicRoute(prompt: string): RouteDecision {
  const p = prompt.toLowerCase();
  const heavy = /arquitet|architecture|refactor grande|race|concorr|algoritmo|algorithm|debug.*dif|trade-?off|multi-?file|multi-file|design|performance critic|performance critical|system design/.test(p);
  const research = /pesquis|doc(s|umenta)|documentation|como funciona|how does|how to|investigate|find out|research|compare|compar|explore|analyze|which lib|qual lib|tutorial|explic|explain/.test(p);
  const route: RouteKind = heavy ? "heavy-reasoning" : research ? "research-docs" : "fast-coding";
  const agent: string = route === "fast-coding" ? "build" : "plan";
  return {
    route,
    agent,
    model: FALLBACK_CHAIN[route][0],
    confidence: 0.5,
    risky: /delet|drop|prod(ucao|uction)|auth|secret|infra|migrat/.test(p),
    complexity: heavy ? 2 : research ? 1 : 0,
    via: "heuristic",
  };
}

export async function decideRoute(input: {
  prompt: string;
  /** Agent atual da sessao (estado real). */
  agent?: string;
  /** Modelo atual da sessao (estado real). */
  model?: string;
  /** Agent disponiveis no runtime (ctx.agent.list()). Vazio = confia em build/plan. */
  validAgents: string[];
  /** Candidatos free: FREE_POOL ∩ catalogo disponivel. */
  freeCandidates: FreeModel[];
  route: RouteKind | "unknown";
  jevModel: string;
  jevEndpoint: string;
  apiKey: string | undefined;
  confidenceThreshold: number;
  timeoutMs?: number;
}): Promise<RouteDecision> {
  // Candidates free elegiveis. Se o chamador nao passou nenhum (apenas em uso
  // fora do plugin), usa o FREE_POOL oficial — nunca lista hardcoded avulsa.
  const candidates = input.freeCandidates.length > 0
    ? input.freeCandidates.filter(isFreeModel)
    : ([...FREE_POOL] as FreeModel[]);
  // Os agentes apresentados ao Jev sao exatamente os aceitos pelo validador
  // (nunca apresentar candidato que isAgent rejeita). Lista real vazia ou
  // indisponivel => fallback seguro build/plan; nunca lista arbitraria.
  const validAgents = input.validAgents.length > 0 ? input.validAgents : ["build", "plan"];
  const state = {
    prompt: input.prompt.slice(0, 4000),
    agent: input.agent ?? "unknown",
    model: input.model ?? "unknown",
  };
  try {
    const signal = input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined;
    const res: JevResponse = await callJevSystemOne(
      input.jevEndpoint,
      input.apiKey,
      {
        state,
        model: input.jevModel,
        questions: buildRouterQuestions({
          freeCandidates: candidates,
          validAgents,
        }),
      },
      signal,
    );
    const routeChoice = res.answers["route"];
    const agentChoice = res.answers["agent"];
    const modelChoice = res.answers["model"];
    const noul = res.answers["is_risky"];
    const score = res.answers["complexity"];

    let route: RouteKind = "fast-coding";
    let agent: string = "build";
    let model: FreeModel = candidates[0];
    let confidence = 0.5;
    let decisionError: string | undefined;

    if (routeChoice && routeChoice.type === "choice" && isRoute(routeChoice.choice)) {
      route = routeChoice.choice;
      confidence = routeChoice.confidence;
    } else {
      decisionError = "jev systemone: resposta choice invalida para route";
    }

    // Agente: decisao real do Jev, limitada aos agentes validos.
    if (agentChoice && agentChoice.type === "choice" && isAgent(agentChoice.choice, validAgents)) {
      agent = agentChoice.choice;
    }

    // Modelo: decisao real do Jev, somente dentro dos candidatos free.
    if (modelChoice && modelChoice.type === "choice" && isFreeCandidate(modelChoice.choice, candidates)) {
      model = modelChoice.choice;
    }

    let overridden = false;
    // Guardrails determinísticas: risco alto/confiança baixa podem escalar a
    // lane, mas preservam as escolhas de model/agent do Jev (o upgrade e de
    // política/estratégia; nao substitui decisao valida do Jev).
    const risky = noul?.type === "noul" ? noul.noul >= 0.7 : false;
    const complexity = score?.type === "score" ? score.score : 1;
    const wasUpgraded =
      confidence < input.confidenceThreshold || risky || complexity >= 1.5;
    if (wasUpgraded && route !== "heavy-reasoning") {
      route = "heavy-reasoning";
      overridden = true;
    }
    // Se o Jev nao respondeu nem agente nem modelo validos, usamos o padrao da
    // lane (deterministico) e marcamos overridden — nunca deixamos modelo/agente
    // arbitrario passar.
    let attemptedAgent: string | undefined;
    if (!agentChoice || agentChoice.type !== "choice" || !isAgent(agentChoice.choice, validAgents)) {
      if (agentChoice && agentChoice.type === "choice" && typeof agentChoice.choice === "string") {
        attemptedAgent = agentChoice.choice;
      }
      agent = route === "fast-coding" ? "build" : "plan";
      overridden = true;
    }
    if (!modelChoice || modelChoice.type !== "choice" || !isFreeCandidate(modelChoice.choice, candidates)) {
      model = FALLBACK_CHAIN[route][0];
      overridden = true;
    }
    if (wasUpgraded) {
      overridden = true;
    }

    if (decisionError) {
      // Rota invalida: fallback heuristico mantem via/error para diagnostico.
      const fb = heuristicRoute(input.prompt);
      fb.error = decisionError;
      return fb;
    }

    return {
      route,
      agent,
      model,
      confidence,
      risky,
      complexity,
      via: "jev",
      overridden,
      ...(attemptedAgent !== undefined ? { attemptedAgent } : {}),
    };
  } catch (err) {
    const fallback = heuristicRoute(input.prompt);
    fallback.error = err instanceof Error ? err.message : String(err);
    return fallback;
  }
}

// Decisao generica: qualquer pergunta SystemOne (choice/noul/score) sobre
// qualquer estado. E o que permite ao Jev julgar qualquer decisao da equipe,
// nao so roteamento de lanes. Valida o formato minimo das perguntas.
export async function decideGeneric(input: {
  state: unknown;
  questions: Record<string, unknown>;
  jevModel: string;
  jevEndpoint: string;
  apiKey: string | undefined;
  timeoutMs?: number;
}): Promise<Record<string, JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer>> {
  validateState(input.state);
  validateQuestions(input.questions);
  // G4: estado ilimitado pode exceder o contexto do Jev. Trunca (string ou
  // objeto serializado) mantendo um aviso de truncamento no texto.
  const state = clampState(input.state, 12000);
  const signal = input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined;
  const res = await callJevSystemOne(
    input.jevEndpoint,
    input.apiKey,
    { state, model: input.jevModel, questions: input.questions },
    signal,
  );
  return res.answers;
}

function clampState(state: unknown, maxChars: number): unknown {
  if (typeof state === "string") {
    return state.length > maxChars ? `${state.slice(0, maxChars)}\n[truncated: ${state.length - maxChars} chars]` : state;
  }
  if (state === null || state === undefined) return state;
  const json = JSON.stringify(state);
  if (json.length <= maxChars) return state;
  return `${json.slice(0, maxChars)}\n[state truncado pelo plugin: ${json.length - maxChars} chars removidos]`;
}

const QUESTION_TYPES = ["choice", "noul", "score"];

function validateState(state: unknown): void {
  // O endpoint exige body.state presente (nao-null). Falha local e deterministica
  // em vez de HTTP 422 apos rede.
  if (state === undefined || state === null) {
    throw new Error("jev decide: state deve ser objeto ou texto nao vazio (nunca null)");
  }
  if (typeof state === "string") {
    if (!state.trim()) {
      throw new Error("jev decide: state deve ser objeto ou texto nao vazio (nunca null)");
    }
    return;
  }
  if (typeof state !== "object") {
    throw new Error("jev decide: state deve ser objeto ou texto nao vazio (nunca null)");
  }
}

function validateQuestions(questions: Record<string, unknown>): void {
  const keys = Object.keys(questions);
  if (keys.length === 0) throw new Error("jev decide: questions vazio");
  if (keys.length > 8) throw new Error("jev decide: maximo 8 perguntas por chamada");
  for (const key of keys) {
    const q = questions[key] as Record<string, unknown>;
    if (!q || typeof q !== "object") throw new Error(`jev decide: pergunta "${key}" invalida`);
    const type = String(q.type ?? "");
    if (!QUESTION_TYPES.includes(type)) {
      throw new Error(`jev decide: pergunta "${key}" precisa de type choice|noul|score`);
    }
    if (typeof q.instructions !== "string" || !q.instructions.trim()) {
      throw new Error(`jev decide: pergunta "${key}" precisa de instructions`);
    }
    // criteria e obrigatorio para todos os tipos (contrato System One confirmado
    // por builders internos e por HTTP 422 no endpoint remoto quando ausente).
    // Formato por tipo: choice/noul exigem objeto { chave: descricao };
    // score exige array de legendas. Valores/elementos devem ser strings.
    const c = q.criteria;
    if (type === "score") {
      if (!Array.isArray(c) || c.length === 0) {
        throw new Error(
          `jev decide: pergunta "${key}" do tipo score precisa de criteria como array nao vazio de strings ` +
          `(ex: ["Trivial", "Moderate", "Very complex"])`,
        );
      }
      const bad = c.find((v) => typeof v !== "string" || !v.trim());
      if (bad !== undefined) {
        throw new Error(
          `jev decide: pergunta "${key}" do tipo score tem criteria com elemento invalido ` +
          `(cada legenda deve ser string nao vazia)`,
        );
      }
    } else {
      // choice | noul: objeto mapa nao vazio, nunca array.
      if (c === undefined || c === null || typeof c !== "object" || Array.isArray(c)) {
        throw new Error(
          `jev decide: pergunta "${key}" do tipo ${type} precisa de criteria como objeto nao vazio ` +
          (type === "choice"
            ? `(ex: { alpha: "Option alpha", beta: "Option beta" })`
            : `(ex: { true: "...", false: "..." })`),
        );
      }
      const entries = Object.entries(c);
      if (entries.length === 0) {
        throw new Error(
          `jev decide: pergunta "${key}" do tipo ${type} precisa de criteria nao vazio ` +
          `(choice: { chave: descricao }, noul: { true: ..., false: ... }, score: [legenda, ...])`,
        );
      }
      const bad = entries.find(([, v]) => typeof v !== "string" || !v.trim());
      if (bad) {
        throw new Error(
          `jev decide: pergunta "${key}" do tipo ${type} tem criteria com valor invalido na chave "${bad[0]}" ` +
          `(cada descricao deve ser string nao vazia)`,
        );
      }
    }
  }
}

export interface EscalationDecision {
  model?: FreeModel;
  via: "jev" | "chain" | "stop";
  error?: string;
}

export async function decideEscalation(input: {
  failedModel: string;
  reason?: string;
  candidates: FreeModel[];
  triedModels?: string[];
  /** Snapshot enriquecido da sessao (quando disponivel): estado ao Jev no retry. */
  snapshot?: DecisionSnapshot;
  jevModel: string;
  jevEndpoint: string;
  apiKey: string | undefined;
  timeoutMs?: number;
}): Promise<EscalationDecision> {
  const tried = input.triedModels ?? [];
  const eligible = input.candidates.filter(
    (c) => c !== input.failedModel && isFreeModel(c) && !tried.includes(c),
  );
  if (eligible.length === 0) {
    return { via: "stop" };
  }
  if (eligible.length === 1) {
    return { model: eligible[0], via: "chain" };
  }
  try {
    const signal = input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined;
    // Estado completo e bounded para o Jev decidir quem segue: sessao
    // (intencao/agente/modelo/rota/tentativa real), falha (modelo que falhou,
    // erro normalizado, modelos tentados, decisao anterior) e candidatos free
    // disponiveis no catalogo. Nunca history completa nem dados sensiveis.
    const baseState = input.snapshot
      ? {
          session: {
            intention: input.snapshot.intention,
            agent: input.snapshot.agent,
            model: input.snapshot.model,
            route: input.snapshot.route,
            attempt: input.snapshot.attempt,
          },
          failure: {
            failedModel: input.failedModel,
            error: input.snapshot.lastError ?? input.reason ?? "",
            triedModels: Array.from(
              new Set<string>([...tried, ...(input.snapshot?.triedModels ?? [])]),
            ),
            priorDecision: input.snapshot.priorDecision,
          },
          availableModels: input.snapshot.freeModels,
        }
      : {
          failedModel: input.failedModel,
          reason: input.reason ?? "",
          triedModels: tried,
        };
    const res = await callJevSystemOne(
      input.jevEndpoint,
      input.apiKey,
      {
        state: clampState(baseState, 12000),
        model: input.jevModel,
        questions: buildEscalateQuestions(eligible),
      },
      signal,
    );
    const answer = res.answers["next_model"];
    if (answer?.type === "choice" && isFreeModel(answer.choice) && eligible.includes(answer.choice)) {
      return { model: answer.choice, via: "jev" };
    }
    return { model: eligible[0], via: "chain", error: "jev retornou modelo invalido; usando primeiro candidato" };
  } catch (err) {
    return {
      model: eligible[0],
      via: "chain",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Proximo modelo da cadeia de fallback. Retorna undefined quando esgotada.
export function nextFallback(route: RouteKind, failedModel: string): FreeModel | undefined {
  const chain = FALLBACK_CHAIN[route];
  const idx = chain.findIndex((m) => m === failedModel);
  if (idx < 0) return chain[0];
  return chain[idx + 1];
}

export function chainFor(route: RouteKind): FreeModel[] {
  return [...FALLBACK_CHAIN[route]];
}