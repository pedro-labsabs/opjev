// Dispatcher do Orchestration Kernel — slice "uma rodada".
//
// Puro e testavel: nao importa `ctx`. Todo efeito e injetado via interfaces
// (WorkerRuntime, DispatcherDecisions). O index.ts faz a adaptacao para o
// runtime real (ctx.session.*) e para as decisoes do Jev (decideRoute, decideGeneric).

import {
  OrchestrationError,
  type EvidencePacket,
  type ExecutionContract,
  type ExecutionOutcome,
  type JevVerdict,
  type RunState,
} from "./types.ts";
import { createRunState, transitionRun } from "./state-machine.ts";
import { buildRoundJudgementQuestions, buildRoundJudgementState, parseRoundVerdict } from "./judgement.ts";
import { isFreeModel, splitModelRef } from "../config.ts";

export const WORKER_TIMEOUT_MS = 60_000;
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

export interface DispatcherDeps {
  runtime: WorkerRuntime;
  decisions: DispatcherDecisions;
  workerTimeoutMs?: number;
  location?: { directory?: string };
  persist?(input: { kind: "worker-created" | "evidence-ready" | "verdict-applied"; runID: string; workerSessionID?: string; state: RunState; at: number }): Promise<void>;
  now?(): number;
}

export interface OrchestrationRunResult {
  runID: string;
  phase: RunState["phase"];
  round: number;
  selection?: ExecutorSelection;
  worker?: { sessionID: string; agent: string; model: string; outcome: ExecutionOutcome; finalText: string };
  evidence?: EvidencePacket;
  verdict?: JevVerdict;
  pendingCommands: string[];
  error?: string;
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

function withTimeout<T>(op: () => Promise<T>, timeoutMs: number, onTimeout?: () => Promise<void> | void): Promise<T> {
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
        .finally(() => reject(new OrchestrationError("worker-timeout", `execucao do worker excedeu ${timeoutMs}ms; worker interrompido best-effort`)));
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

async function failRun(state: RunState, runID: string, error: unknown, extra?: Partial<OrchestrationRunResult>): Promise<OrchestrationRunResult> {
  try {
    const allowed = ["ready", "evaluating", "repairing", "awaiting-human"];
    if (allowed.includes(state.phase)) {
      const r = transitionRun(state, { type: "COMMAND_FAILED", error: bounded(error) });
      return { runID, phase: r.state.phase, round: state.round, pendingCommands: [], error: bounded(error), ...extra };
    }
  } catch { /* kernel barrier */ }
  return { runID, phase: "failed", round: state.round, pendingCommands: [], error: bounded(error), ...extra };
}

async function persist(deps: DispatcherDeps, kind: "worker-created" | "evidence-ready" | "verdict-applied", runID: string, workerSessionID: string | undefined, state: RunState, at: number): Promise<void> {
  if (!deps.persist) return;
  try {
    await deps.persist({ kind, runID, workerSessionID, state, at });
  } catch {
    // best-effort: storage falha nao corrompe o kernel
  }
}

// ───────────────────────── core: runOrchestrationOnce ─────────────────────────

export async function runOrchestrationOnce(contract: ExecutionContract, deps: DispatcherDeps): Promise<OrchestrationRunResult> {
  const timeoutMs = deps.workerTimeoutMs ?? WORKER_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  // 1. kernel aceita o contrato
  let state: RunState;
  try {
    state = createRunState(contract);
    state = transitionRun(state, { type: "CONTRACT_READY" }).state;
  } catch (err) {
    return { runID: contract.runID, phase: "failed", round: 1, pendingCommands: [], error: bounded(err) };
  }

  // 2. Jev seleciona executor
  let selection: ExecutorSelection;
  try {
    selection = await deps.decisions.selectExecutor({ contract, round: state.round });
    validateSelection(selection);
  } catch (err) {
    return await failRun(state, contract.runID, err, { phase: "failed" });
  }

  // 3. cria worker
  let workerSessionID: string;
  try {
    const created = await deps.runtime.createWorker({
      agent: selection.agent,
      model: splitModelRef(selection.model),
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
    return await failRun(state, contract.runID, err);
  }

  // 4. executa worker (prompt + wait)
  let view: WorkerSessionView;
  let messages: unknown[];
  try {
    await persist(deps, "worker-created", contract.runID, workerSessionID, state, now());
    state = transitionRun(state, { type: "EXECUTION_STARTED", executor: { agent: selection.agent, model: selection.model, sessionID: workerSessionID } }).state;
    const promptText = buildWorkerPrompt(contract, state.round, state.contract.maxRounds);
    await deps.runtime.prompt({ sessionID: workerSessionID, text: promptText, metadata: { "jev-router": "orchestration-internal", "jev-role": "worker" } });
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
      runID: contract.runID,
      phase: "failed",
      round: state.round,
      pendingCommands: [],
      error: bounded(err),
      worker: { sessionID: workerSessionID, agent: selection.agent, model: selection.model, outcome: "interrupted", finalText: "" },
    };
  }

  // 5. EXECUTION_FINISHED + evidence
  const finalText = extractFinalAssistantText(messages);
  const fallbackOutcome: ExecutionOutcome = finalText.trim() ? "succeeded" : "failed";
  const outcome: ExecutionOutcome = view.outcome ?? fallbackOutcome;
  const agent = view.agent?.trim() || selection.agent;
  const model = view.model?.trim() || selection.model;

  state = transitionRun(state, { type: "EXECUTION_FINISHED", outcome }).state;

  const evidence: EvidencePacket = {
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

  try {
    state = transitionRun(state, { type: "EVIDENCE_READY", evidence }).state;
  } catch (err) {
    return await failRun(state, contract.runID, err, { evidence, worker: { sessionID: workerSessionID, agent, model, outcome, finalText } });
  }
  await persist(deps, "evidence-ready", contract.runID, workerSessionID, state, now());

  // 6. judge
  let answers: unknown;
  try {
    const judgementState = buildRoundJudgementState(state.contract, state.evidence as EvidencePacket, state.lastVerdict);
    const questions = buildRoundJudgementQuestions();
    answers = await deps.decisions.judgeRound({ state: judgementState, questions });
  } catch (err) {
    return await failRun(state, contract.runID, err, { evidence, worker: { sessionID: workerSessionID, agent, model, outcome, finalText } });
  }

  // 7. parse + verdict
  let verdict: JevVerdict;
  try {
    verdict = parseRoundVerdict(answers);
  } catch (err) {
    return await failRun(state, contract.runID, err, { evidence, worker: { sessionID: workerSessionID, agent, model, outcome, finalText } });
  }

  // 8. apply
  let transition;
  try {
    transition = transitionRun(state, { type: "VERDICT_RECEIVED", verdict });
    state = transition.state;
  } catch (err) {
    return await failRun(state, contract.runID, err, { evidence, worker: { sessionID: workerSessionID, agent, model, outcome, finalText }, verdict });
  }
  await persist(deps, "verdict-applied", contract.runID, workerSessionID, state, now());

  const pendingCommands: string[] = state.phase === "completed" ? [] : transition.commands.map((c) => c.type);
  return {
    runID: contract.runID,
    phase: state.phase,
    round: state.round,
    selection,
    worker: { sessionID: workerSessionID, agent, model, outcome, finalText },
    evidence,
    verdict,
    pendingCommands,
  };
}