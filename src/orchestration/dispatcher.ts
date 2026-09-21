// Dispatcher do Orchestration Kernel — scheduler multi-round bounded.
//
// Puro e testavel: nao importa `ctx`. Todo efeito e injetado via interfaces
// (WorkerRuntime, CriticRuntime, OrchestratorRuntime, DispatcherDecisions). O index.ts faz a
// adaptacao para o runtime real (ctx.session.*) e para as decisoes do Jev.
//
// Este slice transforma repair-same/fresh-same/switch-model/switch-agent/replan
// em efeitos runtime reais:
//   - repair-same: round+1 na MESMA worker session (mesmo agent/model);
//   - fresh-same:  round+1 em NOVA worker session (mesmo agent/model);
//   - switch-model/switch-agent: round+1 em NOVA worker session com executor
//     escolhido pelo Jev entre candidatos validos (selectModel/selectAgent);
//   - replan: orchestrator read-only propoe revised ExecutionContract (kernel
//     valida) e round+1 executa o contrato revisado em NOVA worker session;
//   - demais acoes (human) param no boundary e voltam como pendingCommands.
// O Jev decide a estrategia; o dispatcher apenas executa deterministicamente.
// Nenhuma nova rodada acontece sem um JevVerdict valido.

import {
  OrchestrationError,
  type EvidencePacket,
  type ExecutionContract,
  type ExecutionOutcome,
  type HumanDecision,
  type HumanRequest,
  type JevVerdict,
  type NextAction,
  type RunState,
} from "./types.ts";
import { createRunState, transitionRun } from "./state-machine.ts";
import { validateResumableRunState } from "./human-gate.ts";
import { buildRoundJudgementQuestions, buildRoundJudgementState, parseRoundVerdict } from "./judgement.ts";
import { buildCriticPrompt, criticOutcomeCheck, parseCriticOutput, type CriticFinding } from "./critic.ts";
import { buildRecoveryPrompt } from "./recovery-prompt.ts";
import { buildReplanPrompt, parseRevisedContract } from "./replan.ts";
import { isFreeModel, splitModelRef } from "../config.ts";

export const WORKER_TIMEOUT_MS = 60_000;
export const CRITIC_TIMEOUT_MS = WORKER_TIMEOUT_MS;
export const MAX_FINAL_TEXT = 2000;

// ───────────────────────── interfaces injetaveis ─────────────────────────

export interface WorkerRuntime {
  createWorker(input: {
    agent: string;
    model: { providerID: string; id: string };
    location?: { directory?: string };
    metadata: Record<string, unknown>;
  }): Promise<{ sessionID: string }>;
  prompt(input: { sessionID: string; text: string; metadata?: Record<string, unknown> }): Promise<void>;
  wait(input: { sessionID: string }): Promise<void>;
  get(input: { sessionID: string }): Promise<WorkerSessionView>;
  context(input: { sessionID: string }): Promise<unknown[]>;
  interrupt?(input: { sessionID: string }): Promise<void>;
}

export interface WorkerSessionView {
  agent?: string;
  model?: string;
  outcome?: ExecutionOutcome;
  metadata?: Record<string, unknown>;
}

/**
 * Runtime do orchestrator (#11): sessao dedicada de logical role orchestrator
 * (planejamento read-only). Interface separada do WorkerRuntime de proposito:
 * papel orchestrator nunca executa ExecutionContract como worker.
 */
export interface OrchestratorRuntime {
  createOrchestrator(input: {
    agent: string;
    model: { providerID: string; id: string };
    location?: { directory?: string };
    metadata: Record<string, unknown>;
  }): Promise<{ sessionID: string }>;
  prompt(input: { sessionID: string; text: string; metadata?: Record<string, unknown> }): Promise<void>;
  wait(input: { sessionID: string }): Promise<void>;
  get(input: { sessionID: string }): Promise<OrchestratorSessionView>;
  context(input: { sessionID: string }): Promise<unknown[]>;
  interrupt?(input: { sessionID: string }): Promise<void>;
}

export interface OrchestratorSessionView {
  agent?: string;
  model?: string;
  outcome?: ExecutionOutcome;
  metadata?: Record<string, unknown>;
}

/**
 * Runtime do critic: sessao separada da worker, contexto fresco, role
 * `critic`. A injecao de permissions read-only e responsabilidade do adapter
 * (index.ts), que passa as regras ao `ctx.session.create` do critic. O
 * kernel/dispatcher nao conhece regras de permissao: apenas cria/chama.
 */
export interface CriticRuntime {
  createCritic(input: {
    agent: string;
    model: { providerID: string; id: string };
    location?: { directory?: string };
    metadata: Record<string, unknown>;
  }): Promise<{ sessionID: string }>;
  prompt(input: { sessionID: string; text: string; metadata?: Record<string, unknown> }): Promise<void>;
  wait(input: { sessionID: string }): Promise<void>;
  get(input: { sessionID: string }): Promise<CriticSessionView>;
  context(input: { sessionID: string }): Promise<unknown[]>;
  interrupt?(input: { sessionID: string }): Promise<void>;
}

export interface CriticSessionView {
  agent?: string;
  model?: string;
  outcome?: ExecutionOutcome;
  metadata?: Record<string, unknown>;
}

export interface ExecutorSelection {
  agent: string;
  model: string;
  via: "jev" | "heuristic";
  route?: string;
  confidence?: number;
  overridden?: boolean;
  error?: string;
}

export interface DispatcherDecisions {
  selectExecutor(input: { contract: ExecutionContract; round: number }): Promise<ExecutorSelection>;
  judgeRound(input: { state: unknown; questions: Record<string, unknown> }): Promise<unknown>;
  /**
   * Switch-material selection (#10): o Jev escolhe UM novo executor entre
   * candidatos validos, com contexto bounded (current + failure + attempts).
   * Sem heuristic local: Jev indisponivel/resposta invalida => o adapter lanca
   * e o scheduler falha bounded. Nunca escolhe destino localmente.
   */
  selectModel(input: SwitchSelectInput): Promise<{ model: string }>;
  selectAgent(input: SwitchSelectInput): Promise<{ agent: string }>;
}

/** Input bounded para selectModel/selectAgent: contexto suficiente, sem raw. */
export interface SwitchSelectInput {
  contract: ExecutionContract;
  round: number;
  current: { agent: string; model: string };
  failureClass: string;
  resultSummary: string;
  failedChecks: Array<{ name: string; status: string; summary?: string }>;
  criticFindings: Array<{ severity: string; summary: string }>;
  /** Pares agent/model ja executados neste run (attempt history bounded). */
  attempts: Array<{ agent: string; model: string }>;
}

export type RoundAction =
  | "initial"
  | "repair-same"
  | "fresh-same"
  | "switch-model"
  | "switch-agent"
  | "replan"
  | "human-resume";

/** Projecao bounded de UMA rodada executada (auditoria minima do resultado). */
export interface RoundProjection {
  round: number;
  action: RoundAction;
  /** nextAction que o Jev deu para essa rodada. */
  verdict: NextAction;
  workerSessionID: string;
  criticSessionID: string;
  agent: string;
  model: string;
  outcome: ExecutionOutcome;
  resultSummary: string;
}

export interface DispatcherDeps {
  runtime: WorkerRuntime;
  critic: CriticRuntime;
  orchestrator: OrchestratorRuntime;
  decisions: DispatcherDecisions;
  workerTimeoutMs?: number;
  criticTimeoutMs?: number;
  orchestratorTimeoutMs?: number;
  location?: { directory?: string };
  persist?(input: {
    kind:
      | "worker-created"
      | "evidence-ready"
      | "verdict-applied"
      | "contract-revised"
      | "human-awaiting"
      | "human-decision"
      | "run-failed";
    runID: string;
    workerSessionID?: string;
    criticSessionID?: string;
    orchestratorSessionID?: string;
    state: RunState;
    at: number;
  }): Promise<void>;
  now?(): number;
}

export interface OrchestrationRunResult {
  runID: string;
  phase: RunState["phase"];
  round: number;
  selection?: ExecutorSelection;
  worker?: { sessionID: string; agent: string; model: string; outcome: ExecutionOutcome; finalText: string };
  /** Projecao bounded do critic da ULTIMA rodada (auditoria minima): nunca contexto/mensagens. */
  critic?: { sessionID: string; agent: string; model: string; outcome: "succeeded" | "failed"; findingsCount: number };
  evidence?: EvidencePacket;
  verdict?: JevVerdict;
  pendingCommands: string[];
  error?: string;
  /** Pedido humano pendente quando o run encerra em awaiting-human (undefined caso contrario). */
  pendingHuman?: HumanRequest;
  /** Projecao bounded de TODAS as rodadas executadas (source of truth fechada: RunState.history). */
  rounds?: RoundProjection[];
  /** Projecao bounded do RunState.history final (kernel e canonico). */
  history?: Array<{ round: number; executor?: { agent: string; model: string }; verdict?: JevVerdict; outcome?: EvidencePacket["outcome"]; resultSummary?: string }>;
}

// ───────────────────────── helpers puros ─────────────────────────

export function buildWorkerPrompt(contract: ExecutionContract, round?: number, maxRounds?: number): string {
  const lines: string[] = [];
  const push = (label: string, value: string) => lines.push(`${label}: ${value}`);
  const pushList = (label: string, items: string[] | undefined) => {
    if (items && items.length > 0) {
      lines.push(`${label}:`);
      for (const it of items) lines.push(`- ${it}`);
    }
  };
  push("OBJECTIVE", contract.objective);
  pushList("SCOPE_INCLUDE", contract.scope?.include);
  pushList("SCOPE_EXCLUDE", contract.scope?.exclude);
  pushList("CONSTRAINTS", contract.constraints);
  pushList("ACCEPTANCE_CRITERIA", contract.acceptanceCriteria);
  pushList("REQUIRED_EVIDENCE", contract.requiredEvidence);
  if (round !== undefined && maxRounds !== undefined) push("ROUND", `${round}/${maxRounds}`);
  lines.push("RULE: execute only this contract. Do not declare the work approved; the judge decides externally.");
  return lines.join("\n");
}

export interface WorkerMessageLike {
  type?: unknown;
  content?: unknown;
}

export function extractFinalAssistantText(messages: unknown[]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m || m.type !== "assistant") continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    const texts: string[] = [];
    for (const partRaw of content) {
      const part = (partRaw ?? {}) as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        texts.push(part.text.trim());
      }
    }
    if (texts.length > 0) {
      const joined = texts.join("\n").trim();
      return joined.length > MAX_FINAL_TEXT ? `${joined.slice(0, MAX_FINAL_TEXT)}…[truncado pelo dispatcher]` : joined;
    }
  }
  return "";
}

function withTimeout<T>(
  op: () => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => Promise<void> | void,
  opts?: { code?: string; label?: string },
): Promise<T> {
  const code = opts?.code ?? "worker-timeout";
  const label = opts?.label ?? "worker";
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => { if (timer) clearTimeout(timer); };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      Promise.resolve()
        .then(() => (onTimeout ? onTimeout() : undefined))
        .catch(() => undefined)
        .finally(() => reject(new OrchestrationError(code, `execucao do ${label} excedeu ${timeoutMs}ms; ${label} interrompido best-effort`)));
    }, timeoutMs);
    op().then(
      (v) => { if (!settled) { settled = true; cleanup(); resolve(v); } },
      (e) => { if (!settled) { settled = true; cleanup(); reject(e); } },
    );
  });
}

function bounded(msg: unknown): string {
  const s = msg instanceof Error ? msg.message : String(msg ?? "");
  return s.length > 400 ? `${s.slice(0, 400)}…[truncado pelo dispatcher]` : s;
}

/**
 * Executor canonico de recovery (repair-same / fresh-same): validacao unica e
 * estrita. O executor observado pelo runtime so governa recovery se continuar
 * elegivel — agent/model presentes e model ∈ FREE_POOL. Ausente, incompleto
 * ou out-of-pool => OrchestrationError bounded (`recovery-no-executor`).
 * Sem fallback para selection (validation != routing: o dispatcher rejeita,
 * nunca escolhe modelo alternativo).
 */
export function requireRecoveryExecutor(state: RunState): { agent: string; model: string; sessionID?: string } {
  const exec = state.executor;
  if (!exec || typeof exec.agent !== "string" || !exec.agent.trim() || typeof exec.model !== "string" || !exec.model.trim()) {
    throw new OrchestrationError("recovery-no-executor", "recovery exige state.executor canonico valido (ausente ou incompleto)");
  }
  if (!isFreeModel(exec.model)) {
    throw new OrchestrationError("recovery-no-executor", `recovery exige model no FREE_POOL: ${exec.model}`);
  }
  return { agent: exec.agent, model: exec.model, sessionID: exec.sessionID };
}

/**
 * Chave deterministica de combinacao agent/model para loop prevention (#10):
 * lowercase(agent) + NUL + model. A combinacao (nao o model/agent isolado)
 * e a unidade de tentativa.
 */
export function attemptKey(agent: string, model: string): string {
  return `${String(agent ?? "").trim().toLowerCase()}\0${String(model ?? "")}`;
}

/**
 * Attempt history bounded a partir da history canonica do kernel (que carrega
 * o executor executado por rodada, item SW0). Deduplicada, em ordem, sem
 * sessionID (inutil para candidate filtering) e sem scoring (item #15).
 */
export function executorAttempts(
  history: Array<{ executor?: { agent: string; model: string } } | undefined | null> | undefined | null,
): Array<{ agent: string; model: string }> {
  const out: Array<{ agent: string; model: string }> = [];
  const seen = new Set<string>();
  for (const h of history ?? []) {
    const e = h?.executor;
    if (!e || typeof e.agent !== "string" || typeof e.model !== "string") continue;
    if (!e.agent.trim() || !e.model.trim()) continue;
    const k = attemptKey(e.agent, e.model);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ agent: e.agent, model: e.model });
  }
  return out;
}

/**
 * Classificacao pura de throttle global a partir de evidencia OBSERVAVEL e
 * bounded (resultSummary + summaries de checks/findings). Vocabulario concreto
 * espelha o guard G2 do roteamento (429/529/rate limit/overload/too many
 * requests) — failureClass=environment SOZINHA nunca e throttle (item #16).
 */
const THROTTLE_SIGNALS: readonly RegExp[] = [/429/, /529/, /rate.?limit/i, /too many requests/i, /overload/i];

export function isGlobalThrottleEvidence(input: {
  resultSummary?: string;
  checks?: Array<{ summary?: string } | undefined | null> | undefined | null;
  findings?: Array<{ summary?: string } | undefined | null> | undefined | null;
}): boolean {
  const texts: string[] = [];
  if (typeof input.resultSummary === "string" && input.resultSummary) texts.push(input.resultSummary);
  for (const ck of input.checks ?? []) {
    if (ck && typeof ck.summary === "string" && ck.summary) texts.push(ck.summary);
  }
  for (const f of input.findings ?? []) {
    if (f && typeof f.summary === "string" && f.summary) texts.push(f.summary);
  }
  return texts.some((t) => THROTTLE_SIGNALS.some((re) => re.test(t)));
}

function validateSelection(sel: ExecutorSelection): void {
  if (typeof sel.agent !== "string" || !sel.agent.trim()) {
    throw new OrchestrationError("invalid-selection", "executor selection: agent vazio");
  }
  if (typeof sel.model !== "string" || !sel.model.trim()) {
    throw new OrchestrationError("invalid-selection", "executor selection: model vazio");
  }
  if (!isFreeModel(sel.model)) {
    throw new OrchestrationError("invalid-selection", `modelo selecionado nao esta no FREE_POOL: ${sel.model}`);
  }
}

async function failRun(
  state: RunState,
  runID: string,
  error: unknown,
  extra?: Partial<OrchestrationRunResult>,
  persistFailure?: {
    deps: DispatcherDeps;
    kind: "run-failed";
    workerSessionID?: string;
    criticSessionID?: string;
    orchestratorSessionID?: string;
  },
): Promise<OrchestrationRunResult> {
  // Blocker B (#11 fix): planning tambem transita (kernel aceita COMMAND_FAILED
  // em planning — RP8). Sem transicao quando a phase nao suporta, exatamente
  // como antes (outros fail paths inalterados sem o 5o argumento).
  let failed: RunState = state;
  let failedPhase: RunState["phase"] = "failed";
  try {
    const allowed = ["ready", "evaluating", "repairing", "awaiting-human", "planning"];
    if (allowed.includes(state.phase)) {
      const r = transitionRun(state, { type: "COMMAND_FAILED", error: bounded(error) });
      failed = r.state;
      failedPhase = r.state.phase;
    }
  } catch { /* kernel barrier */ }
  if (persistFailure) {
    // Estado failed persistido explicitamente: store nunca fica em planning/
    // ready apos failure observavel. Clock injetado (deps.now ?? Date.now).
    const at = persistFailure.deps.now?.() ?? Date.now();
    await persist(persistFailure.deps, {
      kind: persistFailure.kind,
      runID,
      workerSessionID: persistFailure.workerSessionID,
      criticSessionID: persistFailure.criticSessionID,
      orchestratorSessionID: persistFailure.orchestratorSessionID,
      state: failed,
      at,
    });
  }
  return { runID, phase: failedPhase, round: failed.round, pendingCommands: [], error: bounded(error), ...extra };
}

async function persist(
  deps: DispatcherDeps,
  input: {
    kind:
      | "worker-created"
      | "evidence-ready"
      | "verdict-applied"
      | "contract-revised"
      | "human-awaiting"
      | "human-decision"
      | "run-failed";
    runID: string;
    workerSessionID?: string;
    criticSessionID?: string;
    orchestratorSessionID?: string;
    state: RunState;
    at: number;
  },
): Promise<void> {
  if (!deps.persist) return;
  try {
    await deps.persist(input);
  } catch {
    // best-effort: storage falha nao corrompe o kernel
  }
}

function projectHistory(state: RunState): NonNullable<OrchestrationRunResult["history"]> {
  return state.history.map((h) => ({
    round: h.round,
    ...(h.executor ? { executor: h.executor } : {}),
    ...(h.verdict ? { verdict: h.verdict } : {}),
    ...(h.outcome ? { outcome: h.outcome } : {}),
    ...(h.resultSummary ? { resultSummary: h.resultSummary } : {}),
    ...(h.contractRevision ? { contractRevision: h.contractRevision } : {}),
    ...(h.humanDecision ? { humanDecision: h.humanDecision } : {}),
  }));
}

// ───────────────────────── core: scheduler compartilhado (initial + human-resume) ─────────────────────────

/**
 * Uma execucao explicita de orchestration. O Jev seleciona o executor na rodada
 * inicial (somente UMA vez). Apos cada JevVerdict:
 *   - repair-same / fresh-same: nova rodada e EXECUTADA neste slice (bounded
 *     por maxRounds validado pelo kernel);
 *   - switch-model / switch-agent: Jev seleciona o novo executor (selectModel/
 *     selectAgent, sem heuristic local) e a proxima rodada e EXECUTADA em nova
 *     worker session, com pipeline integral e critic novo;
 *   - replan: orchestrator propoe revised contract e a proxima rodada e
 *     EXECUTADA com o executor canonico vigente em sessao nova;
 *   - human: boundary persistido (checkpoint human-awaiting); retomada so via
 *     orchestrate_resume (issue #12) — nunca auto-resume (accept/stop sao
 *     terminais).
 * Toda rodada roda pipeline integral: worker -> evidence -> critic novo -> Jev.
 * Nunca ha recovery automatica sem um JevVerdict valido.
 */
export async function runOrchestrationOnce(contract: ExecutionContract, deps: DispatcherDeps): Promise<OrchestrationRunResult> {
  const now = deps.now ?? Date.now;

  // 1. kernel aceita o contrato
  let state: RunState;
  try {
    state = createRunState(contract);
    state = transitionRun(state, { type: "CONTRACT_READY" }).state;
  } catch (err) {
    return { runID: contract.runID, phase: "failed", round: 1, pendingCommands: [], error: bounded(err), rounds: [] };
  }

  // 2. Jev seleciona executor — APENAS na rodada inicial (repair/fresh nunca reselecionam)
  let selection: ExecutorSelection;
  try {
    selection = await deps.decisions.selectExecutor({ contract, round: state.round });
    validateSelection(selection);
  } catch (err) {
    return await failRun(state, contract.runID, err, { phase: "failed", rounds: [] });
  }

  return await executeSchedule(deps, {
    contract,
    state,
    mode: "initial",
    selection,
    now,
    timeouts: {
      worker: deps.workerTimeoutMs ?? WORKER_TIMEOUT_MS,
      critic: deps.criticTimeoutMs ?? CRITIC_TIMEOUT_MS,
      orchestrator: deps.orchestratorTimeoutMs ?? WORKER_TIMEOUT_MS,
    },
  });
}

interface ExecuteScheduleInput {
  contract: ExecutionContract;
  /** Estado de partida (ja autorizado pelo kernel): ready (initial) ou o
   *  estado transicionado pela decisao humana (human-resume). O scheduler
   *  NUNCA chama createRunState/selectExecutor em retomada. */
  state: RunState;
  mode: RoundAction;
  selection?: ExecutorSelection;
  prev?: { verdict: JevVerdict; evidence: EvidencePacket; switchTo?: { agent: string; model: string } };
  /** Instrucao bounded do humano (apenas human-resume), injetada no prompt. */
  humanInstruction?: string;
  /** Sessoes worker ja utilizadas (fresh-check): o resume sela a pausada. */
  seededSessions?: Iterable<string>;
  now: () => number;
  timeouts: { worker: number; critic: number; orchestrator: number };
}

/**
 * Loop multi-round compartilhado (modos initial e human-resume). Roda pipeline
 * integral por rodada, aplica as transicoes do kernel e persiste checkpoints.
 * Em paths de abort a rodada ja persistiu run-failed; o resultado carrega
 * selection (undefined na retomada), rounds, history e pendingHuman (quando
 * re-pausado).
 */
async function executeSchedule(
  deps: DispatcherDeps,
  input: ExecuteScheduleInput,
): Promise<OrchestrationRunResult> {
  const contract = input.contract;
  const now = input.now;
  const { worker: timeoutMs, critic: criticTimeoutMs, orchestrator: orchestratorTimeoutMs } = input.timeouts;
  const selection = input.selection;
  let state = input.state;

  const rounds: RoundProjection[] = [];
  const usedWorkerSessions = new Set<string>(input.seededSessions ?? []);

  // Executa a rodada atual. mode=initial cria a primeira sessao; repair-same
  // reutiliza EXATAMENTE a sessionID preservada pelo kernel; fresh-same cria
  // sessao realmente nova; switch-model/switch-agent criam sessao nova com o
  // executor escolhido pelo Jev (prev.switchTo, validado pelo scheduler).
  // Retorna `abort` com um OrchestrationRunResult pronto para retornar quando
  // a rodada falha bounded; caso contrario, retorna o fechamento da rodada
  // (state, evidence, verdict, transicao, projecoes).
  async function runRoundOnce(
    mode: RoundAction,
    prev?: { verdict: JevVerdict; evidence: EvidencePacket; switchTo?: { agent: string; model: string } },
  ): Promise<
    | { abort: true; result: OrchestrationRunResult }
    | {
        abort: false;
        state: RunState;
        worker: { sessionID: string; agent: string; model: string; outcome: ExecutionOutcome; finalText: string };
        critic: NonNullable<OrchestrationRunResult["critic"]>;
        evidence: EvidencePacket;
        verdict: JevVerdict;
        transition: { commands: ReturnType<typeof transitionRun>["commands"] };
      }
  > {
    // 2b. executor canonico de recovery — validado UMA vez por rodada.
    // initial usa selection (validada em validateSelection); repair/fresh usam
    // EXCLUSIVAMENTE state.executor via requireRecoveryExecutor. Ausente,
    // incompleto ou out-of-pool => bounded failure. NENHUM fallback para
    // selection nas recovery rounds (validation != routing). Switch/replan
    // rounds nao passam aqui (identidade via scheduler: switchTo / canonico).
    let recoveryAgent = "";
    let recoveryModel = "";
    let recoverySessionID: string | undefined;
    if (mode === "repair-same" || mode === "fresh-same") {
      try {
        const rec = requireRecoveryExecutor(state);
        recoveryAgent = rec.agent;
        recoveryModel = rec.model;
        recoverySessionID = rec.sessionID;
      } catch (err) {
        return { abort: true, result: await failRun(state, contract.runID, err) };
      }
      if (mode === "repair-same" && !recoverySessionID) {
        return { abort: true, result: await failRun(state, contract.runID, new OrchestrationError("repair-no-session", "repair-same sem sessionID preservada no estado")) };
      }
    }

    // 2c. identidade da rodada para STARTED/fallbacks/projection:
    // initial <- selection; repair/fresh <- canonico validado em 2b;
    // switch-model/switch-agent <- prev.switchTo (Jev via scheduler).
    let roundAgent: string;
    let roundModel: string;
    if (mode === "initial") {
      if (!selection) {
        return {
          abort: true,
          result: await failRun(
            state,
            contract.runID,
            new OrchestrationError("initial-no-selection", "mode initial exige selection do Jev"),
          ),
        };
      }
      roundAgent = selection.agent;
      roundModel = selection.model;
    } else if (mode === "repair-same" || mode === "fresh-same") {
      roundAgent = recoveryAgent;
      roundModel = recoveryModel;
    } else if (mode === "replan") {
      // Round pos-replan: EXCLUSIVAMENTE o canonico vigente preservado pelo
      // kernel (agent/model, sem sessionID). Ausente/invalido => bounded, sem
      // fallback para selection, sem reselecao (itens #22).
      try {
        const rec = requireRecoveryExecutor(state);
        roundAgent = rec.agent;
        roundModel = rec.model;
      } catch (err) {
        return { abort: true, result: await failRun(state, contract.runID, err) };
      }
    } else if (mode === "human-resume") {
      // Retomada por decisao humana (#12): EXCLUSIVAMENTE o executor canonico
      // preservado pelo kernel (agent/model, sem sessionID). Ausente/invalido
      // ou fora do FREE_POOL => bounded, sem fallback e sem reselecao (o Jev
      // nunca escolhe o executor no resume).
      try {
        const rec = requireRecoveryExecutor(state);
        roundAgent = rec.agent;
        roundModel = rec.model;
      } catch (err) {
        return { abort: true, result: await failRun(state, contract.runID, err) };
      }
    } else {
      const target = prev?.switchTo;
      if (!target || typeof target.agent !== "string" || !target.agent.trim() || typeof target.model !== "string" || !target.model.trim()) {
        return { abort: true, result: await failRun(state, contract.runID, new OrchestrationError("switch-no-selection", `round ${mode} sem executor selecionado pelo Jev`)) };
      }
      roundAgent = target.agent;
      roundModel = target.model;
    }

    // 3. sessao worker da rodada (criacao OU reutilizacao)
    let workerSessionID: string;
    if (mode === "repair-same") {
      // sessionID presente (garantido em 2b); mesma sessao, sem createWorker.
      workerSessionID = recoverySessionID as string;
    } else {
      // initial / fresh-same / switch-* / replan: cria NOVA worker session
      // (nunca reutiliza a antiga, nunca usa ctx.session.switchModel/switchAgent).
      const workerAgent = roundAgent;
      const workerModel = splitModelRef(roundModel);
      try {
        const created = await deps.runtime.createWorker({
          agent: workerAgent,
          model: workerModel,
          location: deps.location ? { directory: deps.location.directory } : undefined,
          metadata: {
            "jev-orchestration": true,
            "jev-run-id": contract.runID,
            "jev-round": state.round,
            "jev-role": "worker",
            "jev-router": "orchestration-internal",
          },
        });
        workerSessionID = created.sessionID;
        if (!workerSessionID) throw new OrchestrationError("worker-create-failed", "createWorker nao retornou sessionID");
      } catch (err) {
        return { abort: true, result: await failRun(state, contract.runID, err) };
      }
      if (mode !== "initial" && usedWorkerSessions.has(workerSessionID)) {
        // fresh-same / switch-* / replan / human-resume: sessao precisa ser
        // realmente nova. Erro de integracao bounded — nunca executa fingindo
        // ser nova. Persiste run-failed: storage nunca fica em ready.
        const code =
          mode === "fresh-same"
            ? "fresh-not-fresh"
            : mode === "replan"
              ? "replan-not-fresh"
              : mode === "human-resume"
                ? "human-resume-not-fresh"
                : "switch-not-fresh";
        return {
          abort: true,
          result: await failRun(
            state,
            contract.runID,
            new OrchestrationError(code, `createWorker retornou sessionID ja utilizada (${workerSessionID}): ${mode} exige sessao realmente nova`),
            undefined,
            { deps, kind: "run-failed", workerSessionID },
          ),
        };
      }
      usedWorkerSessions.add(workerSessionID);
    }

    // 4. EXECUTION_STARTED + prompt (initial ou correction) + wait/get/context
    let view: WorkerSessionView;
    let messages: unknown[];
    try {
      state = transitionRun(state, {
        type: "EXECUTION_STARTED",
        // Identidade da rodada (2c): initial <- selection; repair/fresh <-
        // canonico validado; switch-* <- Jev via scheduler; human-resume <-
        // canonico preservado. Para repair-same, workerSessionID ==
        // recoverySessionID (reuso); demais, sessao nova.
        executor: { agent: roundAgent, model: roundModel, sessionID: workerSessionID },
      }).state;
      // worker-created apos STARTED (phase running): o store nunca mostra
      // ready quando a rodada ja comecou a executar (RESUME4/RESUME6).
      await persist(deps, { kind: "worker-created", runID: contract.runID, workerSessionID, state, at: now() });
      const promptMeta = { "jev-router": "orchestration-internal", "jev-role": "worker", "jev-round": state.round };
      let promptText: string;
      if (mode === "initial") {
        promptText = buildWorkerPrompt(state.contract, state.round, state.contract.maxRounds);
      } else {
        promptText = buildRecoveryPrompt({
          action: mode,
          contract: state.contract,
          round: state.round,
          maxRounds: state.contract.maxRounds,
          failureClass: prev?.verdict?.failureClass ?? "implementation",
          previousResultSummary: prev?.evidence?.resultSummary ?? "",
          failedChecks: prev?.evidence?.deterministicChecks.filter((ck) => ck.status !== "pass") ?? [],
          criticFindings: prev?.evidence?.criticFindings ?? [],
          // Instrucao bounded do humano (#12): so e injetada na rodada retomada.
          ...(mode === "human-resume" && input.humanInstruction ? { humanInstruction: input.humanInstruction } : {}),
        });
      }
      await deps.runtime.prompt({ sessionID: workerSessionID, text: promptText, metadata: promptMeta });
      await withTimeout(() => deps.runtime.wait({ sessionID: workerSessionID }), timeoutMs, () => deps.runtime.interrupt?.({ sessionID: workerSessionID }));
      view = await deps.runtime.get({ sessionID: workerSessionID });
      messages = await deps.runtime.context({ sessionID: workerSessionID });
    } catch (err) {
      // running -> interrupted -> evaluating -> COMMAND_FAILED -> failed.
      // Persiste run-failed: storage nunca fica em ready quando a API falha.
      let interrupted = false;
      try {
        state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "interrupted" }).state;
        interrupted = true;
      } catch { /* kernel barrier */ }
      if (interrupted) {
        try { state = transitionRun(state, { type: "COMMAND_FAILED", command: "dispatch", error: bounded(err) }).state; } catch {}
      }
      return {
        abort: true,
        result: await failRun(
          state,
          contract.runID,
          err,
          {
            worker: { sessionID: workerSessionID, agent: roundAgent, model: roundModel, outcome: "interrupted", finalText: "" },
            rounds,
          },
          { deps, kind: "run-failed", workerSessionID },
        ),
      };
    }

    // 5. EXECUTION_FINISHED + evidence deterministica BASE (worker)
    const finalText = extractFinalAssistantText(messages);
    const fallbackOutcome: ExecutionOutcome = finalText.trim() ? "succeeded" : "failed";
    const outcome: ExecutionOutcome = view.outcome ?? fallbackOutcome;
    const agent = view.agent?.trim() || roundAgent;
    const model = view.model?.trim() || roundModel;

    // Hard guard FREE_POOL: o model OBSERVADO so vira executor canonico se
    // continuar elegivel. Out-of-pool => bounded failure ANTES de evidence,
    // critic, judge e recovery — sem fallback para selection, sem routing
    // alternativo (validation != routing).
    if (!isFreeModel(model)) {
      try {
        state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome: "failed" }).state;
      } catch { /* kernel barrier */ }
      return {
        abort: true,
        result: await failRun(
          state,
          contract.runID,
          new OrchestrationError("executor-not-free", `modelo observado fora do FREE_POOL: ${model}`),
          {
            worker: { sessionID: workerSessionID, agent, model, outcome: "failed", finalText },
            rounds,
          },
          { deps, kind: "run-failed", workerSessionID },
        ),
      };
    }

    state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome }).state;

    const baseEvidence: EvidencePacket = {
      round: state.round,
      executor: { agent, model, sessionID: workerSessionID },
      outcome,
      deterministicChecks: [
        { name: "worker-session-outcome", status: outcome === "succeeded" ? "pass" : "fail" },
        { name: "worker-final-response", status: finalText.trim() ? "pass" : "fail" },
      ],
      criticFindings: [],
      resultSummary: finalText.trim() ? finalText.slice(0, 500) : "[worker sem resposta final]",
    };

    // 5b. critic isolado (verifier): NOVO em TODA rodada — inclusive nas
    // rodadas de recovery. Sessao distinta, read-only (policy injetada pelo
    // adapter). Timeout/falha/output invalido => critic-session-outcome=fail
    // (bounded) e o fluxo SEGUE ate o Jev; o gate deterministico impede que
    // fail vire accept/completed.
    let criticSessionID: string | undefined;
    let criticCheck: { name: string; status: "pass" | "fail"; summary?: string } = {
      name: "critic-session-outcome",
      status: "fail",
      summary: "critic not executed",
    };
    let criticFindings: CriticFinding[] = [];
    // Identidade inicial do critic acompanha o worker REAL da rodada
    // (agent/model ja resolvidos do runtime ou fallback canonico), nunca a
    // selection inicial stale.
    let criticProj: NonNullable<OrchestrationRunResult["critic"]> = {
      sessionID: "",
      agent,
      model,
      outcome: "failed",
      findingsCount: 0,
    };
    try {
      const created = await deps.critic.createCritic({
        agent,
        model: splitModelRef(model),
        location: deps.location ? { directory: deps.location.directory } : undefined,
        metadata: {
          "jev-orchestration": true,
          "jev-run-id": contract.runID,
          "jev-round": state.round,
          "jev-role": "critic",
          "jev-router": "orchestration-internal",
        },
      });
      const createdSessionID = created.sessionID;
      if (!createdSessionID) throw new OrchestrationError("critic-create-failed", "createCritic nao retornou sessionID");
      criticSessionID = createdSessionID;
      const criticPrompt = buildCriticPrompt({
        objective: state.contract.objective,
        acceptanceCriteria: state.contract.acceptanceCriteria,
        requiredEvidence: state.contract.requiredEvidence,
        round: state.round,
        maxRounds: state.contract.maxRounds,
        workerOutcome: outcome,
        resultSummary: baseEvidence.resultSummary,
        deterministicChecks: baseEvidence.deterministicChecks,
      });
      await deps.critic.prompt({
        sessionID: criticSessionID,
        text: criticPrompt,
        metadata: { "jev-router": "orchestration-internal", "jev-role": "critic", "jev-round": state.round },
      });
      await withTimeout(
        () => deps.critic.wait({ sessionID: createdSessionID }),
        criticTimeoutMs,
        () => deps.critic.interrupt?.({ sessionID: createdSessionID }),
        { code: "critic-timeout", label: "critic" },
      );
      const cView = await deps.critic.get({ sessionID: createdSessionID });
      const cMessages = await deps.critic.context({ sessionID: createdSessionID });
      const ownOutcome = cView.outcome;
      const ownFailed = ownOutcome === "failed" || ownOutcome === "interrupted";
      const raw = extractFinalAssistantText(cMessages);
      const parsed = parseCriticOutput(raw);
      if (ownFailed) {
        // Runtime declarou a sessao do critic como falha ou interrompida: isso
        // NUNCA vira aprovacao silenciosa, mesmo com JSON residual valido no
        // output. Findings de sessao falha sao descartados; a falha pertence ao
        // deterministicCheck critic-session-outcome (fail).
        criticProj = {
          sessionID: criticSessionID,
          agent: cView.agent?.trim() || agent,
          model: cView.model?.trim() || model,
          outcome: "failed",
          findingsCount: 0,
        };
        criticFindings = [];
        criticCheck = criticOutcomeCheck("fail", `critic session outcome: ${ownOutcome}`);
      } else {
        // outcome=succeeded OU ausente: o parser continua determinando a validade
        // do output (compatibilidade com runtimes que nao projetam outcome).
        criticProj = {
          sessionID: criticSessionID,
          agent: cView.agent?.trim() || agent,
          model: cView.model?.trim() || model,
          outcome: parsed.ok ? "succeeded" : "failed",
          findingsCount: parsed.ok ? parsed.findings.length : 0,
        };
        if (parsed.ok) {
          criticFindings = parsed.findings;
          criticCheck = { name: "critic-session-outcome", status: "pass" };
        } else {
          criticCheck = criticOutcomeCheck("fail", parsed.summary); // classe bounded da falha
        }
      }
    } catch (err) {
      criticProj = {
        sessionID: criticSessionID ?? "",
        agent,
        model,
        outcome: "failed",
        findingsCount: 0,
      };
      // Sem loop, sem segunda sessao, sem finding fabricado: falha bounded, o
      // Jev ainda recebe a evidence final (com critic-session-outcome=fail).
      criticCheck = criticOutcomeCheck("fail", `critic ${bounded(err)}`);
    }

    const evidence: EvidencePacket = {
      ...baseEvidence,
      deterministicChecks: [...baseEvidence.deterministicChecks, criticCheck],
      criticFindings,
    };

    try {
      state = transitionRun(state, { type: "EVIDENCE_READY", evidence }).state;
    } catch (err) {
      return {
        abort: true,
        result: await failRun(
          state,
          contract.runID,
          err,
          {
            evidence,
            worker: { sessionID: workerSessionID, agent, model, outcome, finalText },
            critic: criticProj,
            rounds,
          },
          { deps, kind: "run-failed", workerSessionID, criticSessionID },
        ),
      };
    }
    await persist(deps, { kind: "evidence-ready", runID: contract.runID, workerSessionID, criticSessionID, state, at: now() });

    // 6. judge
    let answers: unknown;
    try {
      const judgementState = buildRoundJudgementState(state.contract, state.evidence as EvidencePacket, state.lastVerdict);
      const questions = buildRoundJudgementQuestions();
      answers = await deps.decisions.judgeRound({ state: judgementState, questions });
    } catch (err) {
      return {
        abort: true,
        result: await failRun(
          state,
          contract.runID,
          err,
          {
            evidence,
            worker: { sessionID: workerSessionID, agent, model, outcome, finalText },
            critic: criticProj,
            rounds,
          },
          { deps, kind: "run-failed", workerSessionID, criticSessionID },
        ),
      };
    }

    // 7. parse + verdict
    let verdict: JevVerdict;
    try {
      verdict = parseRoundVerdict(answers);
    } catch (err) {
      return {
        abort: true,
        result: await failRun(
          state,
          contract.runID,
          err,
          {
            evidence,
            worker: { sessionID: workerSessionID, agent, model, outcome, finalText },
            critic: criticProj,
            rounds,
          },
          { deps, kind: "run-failed", workerSessionID, criticSessionID },
        ),
      };
    }

    // 8. kernel transition (VERDICT_RECEIVED)
    let transitionResult;
    try {
      transitionResult = transitionRun(state, { type: "VERDICT_RECEIVED", verdict });
      state = transitionResult.state;
    } catch (err) {
      return {
        abort: true,
        result: await failRun(
          state,
          contract.runID,
          err,
          {
            evidence,
            worker: { sessionID: workerSessionID, agent, model, outcome, finalText },
            critic: criticProj,
            verdict,
            rounds,
          },
          { deps, kind: "run-failed", workerSessionID, criticSessionID },
        ),
      };
    }
    await persist(deps, { kind: "verdict-applied", runID: contract.runID, workerSessionID, criticSessionID, state, at: now() });

    return {
      abort: false,
      state,
      worker: { sessionID: workerSessionID, agent, model, outcome, finalText },
      critic: criticProj,
      evidence,
      verdict,
      transition: { commands: transitionResult.commands },
    };
  }

  // ───────────────────────── scheduler loop ─────────────────────────
  let prev: { verdict: JevVerdict; evidence: EvidencePacket; switchTo?: { agent: string; model: string } } | undefined = input.prev;
  let mode: RoundAction = input.mode;
  let last: Awaited<ReturnType<typeof runRoundOnce>> & { abort: false } | undefined;
  let pendingCommands: string[] = [];

  for (;;) {
    const out = await runRoundOnce(mode, prev);
    if (out.abort) return out.result;

    const projection: RoundProjection = {
      round: out.evidence.round,
      action: mode,
      verdict: out.verdict.nextAction,
      workerSessionID: out.worker.sessionID,
      criticSessionID: out.critic.sessionID,
      agent: out.worker.agent,
      model: out.worker.model,
      outcome: out.worker.outcome,
      resultSummary: out.evidence.resultSummary,
    };
    rounds.push(projection);
    last = out;
    prev = { verdict: out.verdict, evidence: out.evidence };

    const firstCommand = out.transition.commands[0]?.type;
    if (firstCommand === "repair-same") { mode = "repair-same"; continue; }
    if (firstCommand === "fresh-same") { mode = "fresh-same"; continue; }
    if (firstCommand === "select-model" || firstCommand === "select-agent") {
      // Switch-material (#10): kernel incrementou round e limpou o executor.
      // maxRounds barrado pelo kernel => awaiting-human (sem select aqui).
      if (out.state.phase !== "ready") {
        pendingCommands = out.transition.commands.map((cmd) => cmd.type);
        break;
      }
      const isModelSwitch = firstCommand === "select-model";
      // Throttle global observavel => sem storm: falha bounded especifica, sem
      // nova worker, sem select, sem penalidade de capability (item #16).
      if (
        isGlobalThrottleEvidence({
          resultSummary: out.evidence.resultSummary,
          checks: out.evidence.deterministicChecks,
          findings: out.evidence.criticFindings,
        })
      ) {
        return await failRun(
          out.state,
          contract.runID,
          new OrchestrationError(
            "switch-throttled",
            `verdict ${firstCommand} sob throttle global observavel — nenhuma nova worker, sem storm (evidencia: ${out.evidence.resultSummary.slice(0, 160)})`,
          ),
          { worker: last.worker, critic: last.critic, evidence: out.evidence, verdict: out.verdict, rounds },
        );
      }
      // Attempt history canonica (item #8/#10): a rodada que falhou ja entrou
      // no history via VERDICT_RECEIVED — o par atual nunca volta.
      const attempts = executorAttempts(out.state.history);
      const current = { agent: out.evidence.executor.agent, model: out.evidence.executor.model };
      const switchInput = {
        contract: out.state.contract,
        round: out.state.round,
        current,
        failureClass: out.verdict.failureClass,
        resultSummary: out.evidence.resultSummary,
        failedChecks: out.evidence.deterministicChecks
          .filter((ck) => ck.status !== "pass")
          .map((ck) => ({ name: ck.name, status: ck.status as string, ...(ck.summary ? { summary: ck.summary } : {}) })),
        criticFindings: out.evidence.criticFindings.map((f) => ({ severity: f.severity, summary: f.summary })),
        attempts,
      };
      try {
        if (isModelSwitch) {
          const sel = await deps.decisions.selectModel(switchInput);
          const model = typeof sel?.model === "string" ? sel.model.trim() : "";
          if (!model) {
            throw new OrchestrationError("invalid-selection", "switch-model sem model valido na resposta do Jev");
          }
          if (!isFreeModel(model)) {
            throw new OrchestrationError("invalid-selection", `switch-model fora do FREE_POOL: ${model}`);
          }
          if (attempts.some((a) => attemptKey(a.agent, a.model) === attemptKey(current.agent, model))) {
            throw new OrchestrationError("invalid-selection", `switch-model repetido neste run: ${current.agent}/${model} ja tentado`);
          }
          mode = "switch-model";
          prev = { verdict: out.verdict, evidence: out.evidence, switchTo: { agent: current.agent, model } };
          continue;
        }
        const sel = await deps.decisions.selectAgent(switchInput);
        const agent = typeof sel?.agent === "string" ? sel.agent.trim() : "";
        if (!agent) {
          throw new OrchestrationError("invalid-selection", "switch-agent sem agent valido na resposta do Jev");
        }
        // Catalog membership e autoridade do adapter (resolvePrimaryAgent); o
        // dispatcher impoe forma + novidade do par (defesa em profundidade).
        if (attempts.some((a) => attemptKey(a.agent, a.model) === attemptKey(agent, current.model))) {
          throw new OrchestrationError("invalid-selection", `switch-agent repetido neste run: ${agent}/${current.model} ja tentado`);
        }
        mode = "switch-agent";
        prev = { verdict: out.verdict, evidence: out.evidence, switchTo: { agent, model: current.model } };
        continue;
      } catch (err) {
        return await failRun(out.state, contract.runID, err, {
          worker: last.worker,
          critic: last.critic,
          evidence: out.evidence,
          verdict: out.verdict,
          rounds,
        });
      }
    }
    if (firstCommand === "replan") {
      // Replan (#11): kernel avancou round e entrou planning (executor sem
      // sessionID). maxRounds barrado => awaiting-human (sem orchestrator aqui).
      if (out.state.phase !== "planning") {
        pendingCommands = out.transition.commands.map((cmd) => cmd.type);
        break;
      }
      // Identidade canonica vigente para o planner (agent/model, sem sessionID
      // por design). Ausente/invalida => bounded, sem fallback e sem reselecao.
      let orchAgent: string;
      let orchModel: string;
      try {
        const rec = requireRecoveryExecutor(out.state);
        orchAgent = rec.agent;
        orchModel = rec.model;
      } catch (err) {
        return await failRun(out.state, contract.runID, err, {
          worker: last.worker,
          critic: last.critic,
          evidence: out.evidence,
          verdict: out.verdict,
          rounds,
        }, {
          deps,
          kind: "run-failed",
          workerSessionID: last.worker.sessionID,
          criticSessionID: last.critic.sessionID,
        });
      }
      // Orchestrator dedicado: sessao NOVA read-only (policy no adapter).
      let orchestratorSessionID: string;
      try {
        const created = await deps.orchestrator.createOrchestrator({
          agent: orchAgent,
          model: splitModelRef(orchModel),
          location: deps.location ? { directory: deps.location.directory } : undefined,
          metadata: {
            "jev-orchestration": true,
            "jev-run-id": contract.runID,
            "jev-round": out.state.round,
            "jev-role": "orchestrator",
            "jev-agent-role": "orchestrator",
            "jev-router": "orchestration-internal",
          },
        });
        orchestratorSessionID = created.sessionID;
        if (!orchestratorSessionID) {
          throw new OrchestrationError("orchestrator-create-failed", "createOrchestrator nao retornou sessionID");
        }
      } catch (err) {
        return await failRun(out.state, contract.runID, err, {
          worker: last.worker,
          critic: last.critic,
          evidence: out.evidence,
          verdict: out.verdict,
          rounds,
        }, {
          deps,
          kind: "run-failed",
          workerSessionID: last.worker.sessionID,
          criticSessionID: last.critic.sessionID,
        });
      }
      // Proposta bounded (contrato VIGENTE do estado) -> parse estrito ->
      // CONTRACT_READY (kernel valida runID/budget) -> mode replan -> continue.
      // Nenhum Jev extra: o verdict replan ja decidiu; ha UMA proposta.
      try {
        const replanPrompt = buildReplanPrompt({
          contract: out.state.contract,
          round: out.state.round,
          failureClass: out.verdict.failureClass,
          previousResultSummary: out.evidence.resultSummary,
          failedChecks: out.evidence.deterministicChecks.filter((ck) => ck.status !== "pass"),
          criticFindings: out.evidence.criticFindings,
          maxRounds: out.state.contract.maxRounds,
        });
        const orchMeta = { "jev-router": "orchestration-internal", "jev-role": "orchestrator", "jev-round": out.state.round };
        await deps.orchestrator.prompt({ sessionID: orchestratorSessionID, text: replanPrompt, metadata: orchMeta });
        await withTimeout(
          () => deps.orchestrator.wait({ sessionID: orchestratorSessionID }),
          orchestratorTimeoutMs,
          () => deps.orchestrator.interrupt?.({ sessionID: orchestratorSessionID }),
        );
        // Blocker A (#11 fix): outcome da sessao real governa. failed/
        // interrupted NUNCA instalam residual JSON — falha bounded antes de
        // parse/CONTRACT_READY/worker. undefined preserva compat (runtimes sem
        // outcome); succeeded segue. get() nao vira autoridade de mais nada:
        // nao troca agent/model/executor, nao aprova, nao corrige output.
        const orchView = await deps.orchestrator.get({ sessionID: orchestratorSessionID });
        const orchOutcome = orchView?.outcome;
        if (orchOutcome === "failed" || orchOutcome === "interrupted") {
          throw new OrchestrationError(
            "orchestrator-session-failed",
            `orchestrator session ${orchOutcome} (${orchestratorSessionID}): revised contract nao instalado`,
          );
        }
        const orchMessages = await deps.orchestrator.context({ sessionID: orchestratorSessionID });
        const revised = parseRevisedContract(extractFinalAssistantText(orchMessages));
        state = transitionRun(state, { type: "CONTRACT_READY", contract: revised }).state;
        await persist(deps, { kind: "contract-revised", runID: contract.runID, orchestratorSessionID, state, at: now() });
      } catch (err) {
        return await failRun(out.state, contract.runID, err, {
          worker: last.worker,
          critic: last.critic,
          evidence: out.evidence,
          verdict: out.verdict,
          rounds,
        }, {
          deps,
          kind: "run-failed",
          workerSessionID: last.worker.sessionID,
          criticSessionID: last.critic.sessionID,
          orchestratorSessionID,
        });
      }
      mode = "replan";
      continue;
    }
    // Terminal / boundary: accept => completed; stop => stopped; human
    // => pending command mapeado pelo kernel + checkpoint human-awaiting.
    pendingCommands = out.state.phase === "completed" ? [] : out.transition.commands.map((c) => c.type);
    if (out.state.phase === "awaiting-human") {
      // Boundary humano persistido explicitamente (PAUSE1): requestID
      // deterministico + sessoes da rodada pausada para a retomada explicita.
      await persist(deps, {
        kind: "human-awaiting",
        runID: contract.runID,
        workerSessionID: last.worker.sessionID,
        criticSessionID: last.critic.sessionID,
        state: out.state,
        at: now(),
      });
    }
    break;
  }

  return {
    runID: contract.runID,
    phase: last.state.phase,
    round: last.state.round,
    selection,
    worker: last.worker,
    critic: last.critic,
    evidence: last.evidence,
    verdict: last.verdict,
    pendingCommands,
    pendingHuman: last.state.pendingHuman,
    rounds,
    history: projectHistory(last.state),
  };
}

/**
 * Retomada EXPLICITA de um run pausado em awaiting-human (issue #12): o
 * estado persistido e a unica fonte (validateResumableRunState estrita) e a
 * decisao e aplicada pelo kernel (HUMAN_DECISION_RECEIVED). REJEITA (lanca)
 * em decisao/estado invalidos — nunca silencioso, nunca coercio; o adapter
 * formata [code]. stop nao executa trabalho novo; resume abre EXATAMENTE uma
 * rodada com o executor canonico preservado (sem sessionID, sem reselecao),
 * sela a sessao pausada (fresh-check) e roda o scheduler compartilhado.
 * NUNCA usa createRunState/selectExecutor/muda runID/reescreve contract.
 */
export async function runOrchestrationResume(
  input: {
    runID?: string;
    state: RunState;
    decision: HumanDecision;
    /** Sessoes da rodada pausada (carregadas no checkpoint human-decision). */
    workerSessionID?: string;
    criticSessionID?: string;
  },
  deps: DispatcherDeps,
): Promise<OrchestrationRunResult> {
  const runID = input.runID ?? input.state.contract.runID;
  const now = deps.now ?? Date.now;

  // Estado persistido validado ANTES de qualquer efeito: phase awaiting-human,
  // pendingHuman coerente, executor canonico, evidence+verdict da pausa.
  validateResumableRunState(input.state, runID);

  // O kernel aplica a decisao (autoridade final de fase/round/budget/executor)
  // e lanca invalid-human-decision em decisao invalida (stale/forma/budget).
  const applied = transitionRun(input.state, { type: "HUMAN_DECISION_RECEIVED", decision: input.decision });
  const decidedState = applied.state;

  // Storage-truth da autoridade aplicada ANTES de qualquer worker nova/efeito
  // (ordem exigida: human-decision vem depois da pausa e antes de worker).
  const pausedWorker = input.workerSessionID ?? input.state.executor?.sessionID;
  await persist(deps, {
    kind: "human-decision",
    runID,
    workerSessionID: pausedWorker,
    criticSessionID: input.criticSessionID,
    state: decidedState,
    at: now(),
  });

  if (applied.commands.some((c) => c.type === "stop")) {
    // stop: nenhum trabalho novo; auditoria na entry da rodada pausada.
    return {
      runID,
      phase: decidedState.phase,
      round: decidedState.round,
      pendingCommands: applied.commands.map((c) => c.type),
      pendingHuman: undefined,
      rounds: [],
      history: projectHistory(decidedState),
    };
  }

  return await executeSchedule(deps, {
    contract: decidedState.contract,
    state: decidedState,
    mode: "human-resume",
    // A pausa preserva evidence + lastVerdict: viram o prev do recovery prompt.
    prev: { verdict: input.state.lastVerdict as JevVerdict, evidence: input.state.evidence as EvidencePacket },
    humanInstruction: input.decision.instruction,
    // Sela TODAS as sessoes ja usadas no run (executor canonico, executor da
    // evidence da pausa e worker/critic do checkpoint): a worker do resume
    // precisa ser realmente fresca (human-resume-not-fresh).
    seededSessions: [
      ...(input.state.executor?.sessionID ? [input.state.executor.sessionID] : []),
      ...(input.state.evidence?.executor?.sessionID ? [input.state.evidence.executor.sessionID] : []),
      ...(input.workerSessionID ? [input.workerSessionID] : []),
      ...(input.criticSessionID ? [input.criticSessionID] : []),
    ],
    now,
    timeouts: {
      worker: deps.workerTimeoutMs ?? WORKER_TIMEOUT_MS,
      critic: deps.criticTimeoutMs ?? CRITIC_TIMEOUT_MS,
      orchestrator: deps.orchestratorTimeoutMs ?? WORKER_TIMEOUT_MS,
    },
  });
}