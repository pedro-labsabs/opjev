// Dispatcher do Orchestration Kernel — scheduler multi-round bounded.
//
// Puro e testavel: nao importa `ctx`. Todo efeito e injetado via interfaces
// (WorkerRuntime, CriticRuntime, DispatcherDecisions). O index.ts faz a
// adaptacao para o runtime real (ctx.session.*) e para as decisoes do Jev.
//
// Este slice transforma repair-same/fresh-same em efeitos runtime reais:
//   - repair-same: round+1 na MESMA worker session (mesmo agent/model);
//   - fresh-same:  round+1 em NOVA worker session (mesmo agent/model);
//   - demais acoes param no boundary e voltam como pendingCommands.
// O Jev decide a estrategia; o dispatcher apenas executa deterministicamente.
// Nenhuma nova rodada acontece sem um JevVerdict valido pedindo repair/fresh.

import {
  OrchestrationError,
  type EvidencePacket,
  type ExecutionContract,
  type ExecutionOutcome,
  type JevVerdict,
  type NextAction,
  type RunState,
} from "./types.ts";
import { createRunState, transitionRun } from "./state-machine.ts";
import { buildRoundJudgementQuestions, buildRoundJudgementState, parseRoundVerdict } from "./judgement.ts";
import { buildCriticPrompt, criticOutcomeCheck, parseCriticOutput, type CriticFinding } from "./critic.ts";
import { buildRecoveryPrompt } from "./recovery-prompt.ts";
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
}

export type RoundAction = "initial" | "repair-same" | "fresh-same";

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
  decisions: DispatcherDecisions;
  workerTimeoutMs?: number;
  criticTimeoutMs?: number;
  location?: { directory?: string };
  persist?(input: {
    kind: "worker-created" | "evidence-ready" | "verdict-applied";
    runID: string;
    workerSessionID?: string;
    criticSessionID?: string;
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
  /** Projecao bounded de TODAS as rodadas executadas (source of truth fechada: RunState.history). */
  rounds?: RoundProjection[];
  /** Projecao bounded do RunState.history final (kernel e canonico). */
  history?: Array<{ round: number; verdict?: JevVerdict; outcome?: EvidencePacket["outcome"]; resultSummary?: string }>;
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
): Promise<OrchestrationRunResult> {
  try {
    const allowed = ["ready", "evaluating", "repairing", "awaiting-human"];
    if (allowed.includes(state.phase)) {
      const r = transitionRun(state, { type: "COMMAND_FAILED", error: bounded(error) });
      return { runID, phase: r.state.phase, round: state.round, pendingCommands: [], error: bounded(error), ...extra };
    }
  } catch { /* kernel barrier */ }
  return { runID, phase: "failed", round: state.round, pendingCommands: [], error: bounded(error), ...extra };
}

async function persist(
  deps: DispatcherDeps,
  input: {
    kind: "worker-created" | "evidence-ready" | "verdict-applied";
    runID: string;
    workerSessionID?: string;
    criticSessionID?: string;
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
    ...(h.verdict ? { verdict: h.verdict } : {}),
    ...(h.outcome ? { outcome: h.outcome } : {}),
    ...(h.resultSummary ? { resultSummary: h.resultSummary } : {}),
  }));
}

// ───────────────────────── core: runOrchestrationOnce (scheduler loop) ─────────────────────────

/**
 * Uma execucao explicita de orchestration. O Jev seleciona o executor na rodada
 * inicial (somente UMA vez). Apos cada JevVerdict:
 *   - repair-same / fresh-same: nova rodada e EXECUTADA neste slice (bounded
 *     por maxRounds validado pelo kernel);
 *   - demais acoes (switch-model/switch-agent/replan/human/stop): param no
 *     boundary e voltam como pendingCommands.
 * Toda rodada roda pipeline integral: worker -> evidence -> critic novo -> Jev.
 * Nunca ha recovery automatica sem um JevVerdict valido.
 */
export async function runOrchestrationOnce(contract: ExecutionContract, deps: DispatcherDeps): Promise<OrchestrationRunResult> {
  const timeoutMs = deps.workerTimeoutMs ?? WORKER_TIMEOUT_MS;
  const criticTimeoutMs = deps.criticTimeoutMs ?? CRITIC_TIMEOUT_MS;
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

  const rounds: RoundProjection[] = [];
  const usedWorkerSessions = new Set<string>();

  // Executa a rodada atual. mode=initial cria a primeira sessao; repair-same
  // reutiliza EXATAMENTE a sessionID preservada pelo kernel; fresh-same cria
  // sessao realmente nova. Retorna `abort` com um OrchestrationRunResult pronto
  // para retornar quando a rodada falha bounded; caso contrario, retorna o
  // fechamento da rodada (state, evidence, verdict, transicao, projecoes).
  async function runRoundOnce(
    mode: RoundAction,
    prev?: { verdict: JevVerdict; evidence: EvidencePacket },
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
    // selection nas recovery rounds (validation != routing).
    let recoveryAgent = "";
    let recoveryModel = "";
    let recoverySessionID: string | undefined;
    if (mode !== "initial") {
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

    // 3. sessao worker da rodada (criacao OU reutilizacao)
    let workerSessionID: string;
    if (mode === "repair-same") {
      // sessionID presente (garantido em 2b); mesma sessao, sem createWorker.
      workerSessionID = recoverySessionID as string;
    } else {
      // initial: selection; fresh-same: executor canonico validado (nunca selection).
      const isInitial = mode === "initial";
      const workerAgent = isInitial ? selection.agent : recoveryAgent;
      let workerModel: { providerID: string; id: string };
      if (isInitial) {
        workerModel = splitModelRef(selection.model);
      } else {
        workerModel = splitModelRef(recoveryModel);
      }
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
      if (mode === "fresh-same" && usedWorkerSessions.has(workerSessionID)) {
        // fresh-same que nao e realmente fresh: erro de integracao bounded,
        // nunca executa a rodada fingindo ser uma sessao nova.
        return {
          abort: true,
          result: await failRun(
            state,
            contract.runID,
            new OrchestrationError("fresh-not-fresh", `createWorker retornou sessionID ja utilizada (${workerSessionID}): fresh-same exige sessao realmente nova`),
          ),
        };
      }
      usedWorkerSessions.add(workerSessionID);
      await persist(deps, { kind: "worker-created", runID: contract.runID, workerSessionID, state, at: now() });
    }

    // 4. EXECUTION_STARTED + prompt (initial ou correction) + wait/get/context
    let view: WorkerSessionView;
    let messages: unknown[];
    try {
      state = transitionRun(state, {
        type: "EXECUTION_STARTED",
        // Identidade do executor: initial usa selection; repair/fresh usam
        // os locais validados em 2b (executor canonico). Para repair-same,
        // workerSessionID == recoverySessionID (reuso). Para fresh-same,
        // workerSessionID e a nova sessao criada com agent/model canonicos.
        executor: mode === "initial"
          ? { agent: selection.agent, model: selection.model, sessionID: workerSessionID }
          : { agent: recoveryAgent, model: recoveryModel, sessionID: workerSessionID },
      }).state;
      const promptMeta = { "jev-router": "orchestration-internal", "jev-role": "worker", "jev-round": state.round };
      let promptText: string;
      if (mode === "initial") {
        promptText = buildWorkerPrompt(contract, state.round, contract.maxRounds);
      } else {
        promptText = buildRecoveryPrompt({
          action: mode,
          contract,
          round: state.round,
          maxRounds: contract.maxRounds,
          failureClass: prev?.verdict?.failureClass ?? "implementation",
          previousResultSummary: prev?.evidence?.resultSummary ?? "",
          failedChecks: prev?.evidence?.deterministicChecks.filter((ck) => ck.status !== "pass") ?? [],
          criticFindings: prev?.evidence?.criticFindings ?? [],
        });
      }
      await deps.runtime.prompt({ sessionID: workerSessionID, text: promptText, metadata: promptMeta });
      await withTimeout(() => deps.runtime.wait({ sessionID: workerSessionID }), timeoutMs, () => deps.runtime.interrupt?.({ sessionID: workerSessionID }));
      view = await deps.runtime.get({ sessionID: workerSessionID });
      messages = await deps.runtime.context({ sessionID: workerSessionID });
    } catch (err) {
      // running -> interrupted -> evaluating -> COMMAND_FAILED -> failed
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
        result: {
          runID: contract.runID,
          phase: "failed",
          round: state.round,
          pendingCommands: [],
          error: bounded(err),
          worker: { sessionID: workerSessionID, agent: mode === "initial" ? selection.agent : recoveryAgent, model: mode === "initial" ? selection.model : recoveryModel, outcome: "interrupted", finalText: "" },
          rounds,
        },
      };
    }

    // 5. EXECUTION_FINISHED + evidence deterministica BASE (worker)
    const finalText = extractFinalAssistantText(messages);
    const fallbackOutcome: ExecutionOutcome = finalText.trim() ? "succeeded" : "failed";
    const outcome: ExecutionOutcome = view.outcome ?? fallbackOutcome;
    const expectedAgent = mode === "initial" ? selection.agent : recoveryAgent;
    const expectedModel = mode === "initial" ? selection.model : recoveryModel;
    const agent = view.agent?.trim() || expectedAgent;
    const model = view.model?.trim() || expectedModel;

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
        result: await failRun(state, contract.runID, new OrchestrationError("executor-not-free", `modelo observado fora do FREE_POOL: ${model}`), {
          worker: { sessionID: workerSessionID, agent, model, outcome: "failed", finalText },
          rounds,
        }),
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
        objective: contract.objective,
        acceptanceCriteria: contract.acceptanceCriteria,
        requiredEvidence: contract.requiredEvidence,
        round: state.round,
        maxRounds: contract.maxRounds,
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
        result: await failRun(state, contract.runID, err, {
          evidence, worker: { sessionID: workerSessionID, agent, model, outcome, finalText }, critic: criticProj, rounds,
        }),
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
        result: await failRun(state, contract.runID, err, {
          evidence, worker: { sessionID: workerSessionID, agent, model, outcome, finalText }, critic: criticProj, rounds,
        }),
      };
    }

    // 7. parse + verdict
    let verdict: JevVerdict;
    try {
      verdict = parseRoundVerdict(answers);
    } catch (err) {
      return {
        abort: true,
        result: await failRun(state, contract.runID, err, {
          evidence, worker: { sessionID: workerSessionID, agent, model, outcome, finalText }, critic: criticProj, rounds,
        }),
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
        result: await failRun(state, contract.runID, err, {
          evidence, worker: { sessionID: workerSessionID, agent, model, outcome, finalText }, critic: criticProj, verdict, rounds,
        }),
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
  let prev: { verdict: JevVerdict; evidence: EvidencePacket } | undefined;
  let mode: RoundAction = "initial";
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
    // Terminal / boundary: accept => completed; stop => stopped; switch-model/
    // switch-agent/replan/human => pending command mapeado pelo kernel.
    pendingCommands = out.state.phase === "completed" ? [] : out.transition.commands.map((c) => c.type);
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
    rounds,
    history: projectHistory(last.state),
  };
}