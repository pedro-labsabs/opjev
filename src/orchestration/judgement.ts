// Contrato Jev para julgar UMA rodada (SystemOne, nao-generativo).
//
// Puro e deterministico: nenhum acesso a ctx/rede/sessao. O Jev e decision
// engine — nao planner textual. Este modulo constroi as perguntas SystemOne
// do julgamento e converte as respostas em JevVerdict (parsing estrito).

import {
  CONTRACT_LIMITS,
  EVIDENCE_LIMITS,
  FAILURE_CLASSES,
  NEXT_ACTIONS,
  OrchestrationError,
  truncate,
  type EvidencePacket,
  type ExecutionContract,
  type FailureClass,
  type JevVerdict,
  type NextAction,
} from "./types.ts";

// ───────────────────────── perguntas da rodada ─────────────────────────

/** Resposta SystemOne (wire shape) aceita pelo parser do julgamento. */
export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}

export type SystemOneAnswer = JevChoiceAnswer | JevNoulAnswer;

/** Mapa de respostas do Jev para o julgamento de uma rodada. */
export type RoundJudgementAnswers = Record<string, SystemOneAnswer>;

/** Perguntas SystemOne validas (mesmo schema que o runtime valida em validateQuestions). */
export type RoundJudgementQuestions = Record<
  string,
  { type: "choice" | "noul"; instructions: string; criteria: Record<string, string> }
>;

/**
 * Perguntas do julgamento de uma rodada: 4 perguntas independentes.
 *   done                     -> noul
 *   failure_class            -> choice (exatamente FAILURE_CLASSES)
 *   same_executor_can_repair -> noul
 *   next_action              -> choice (exatamente NEXT_ACTIONS)
 * As criteria ensinam a diferenca entre as acoes (o Jev precisa decidir
 * entre alternativas materialmente distintas, nao adivinhar).
 */
export function buildRoundJudgementQuestions(): RoundJudgementQuestions {
  return {
    done: {
      type: "noul",
      instructions: "Round complete: are ALL acceptance criteria satisfied by the produced evidence?",
      criteria: {
        true: "Objective achieved; accept and finish",
        false: "Objective not achieved; more work is needed",
      },
    },
    failure_class: {
      type: "choice",
      instructions:
        "Given the round evidence, which failure class best explains the outcome? Choose the single most material cause.",
      criteria: {
        none: "Everything went as expected; no failure",
        implementation: "The code/implementation is wrong; the executor produced incorrect technical work",
        reasoning: "The line of reasoning, plan or strategy behind the work is wrong",
        "missing-context": "Necessary context/docs/information was missing to do the task",
        "wrong-agent": "The agent (specialization) was not the right one for this task",
        "wrong-model": "The model was not capable/appropriate for this task",
        environment: "Environment/infra/tooling failure, not the executor's fault",
        "bad-contract": "The contract/objective/acceptance criteria were poorly defined",
      },
    },
    same_executor_can_repair: {
      type: "noul",
      instructions: "Can the SAME executor (current agent + model) fix this by continuing directly?",
      criteria: {
        true: "Same executor can repair; a correction within the same session works",
        false: "Same executor does not fix it; something external must change",
      },
    },
    next_action: {
      type: "choice",
      instructions:
        "Which action must the scheduler take next? The scheduler applies this decision; models/agents are selected separately, never here.",
      criteria: {
        accept: "Accept the result; the objective is complete (requires done=true)",
        "repair-same": "The SAME session/executor receives a correction contract and keeps going",
        "fresh-same": "Start a CLEAN new session, same agent/model (context contamination suspected)",
        "switch-model": "Same role/task, but a different model (current model is stuck/incapable)",
        "switch-agent": "A different specialized agent is needed (agent mismatch)",
        replan: "The contract/strategy must be rebuilt (objective, criteria or approach)",
        human: "Requires human decision or authority; cannot proceed autonomously",
        stop: "Continuing is not useful or not safe; stop the run",
      },
    },
  };
}

// ───────────────────────── estado canonico enviado ao Jev ─────────────────────────

/**
 * State bounded enviado junto com buildRoundJudgementQuestions() ao SystemOne.
 * Contem APENAS fatos necessarios para julgar uma rodada:
 *  - objetivo/criterios/evidencia exigida (contract, bounded);
 *  - round/maxRounds (o Jev sabe quao proximo do limite esta);
 *  - executor (so agent/model — nunca sessionID interno);
 *  - rosto da evidence (outcome, deterministicChecks, criticFindings, resultSummary);
 *  - previousVerdict (quando houver, para comparar progresso).
 * NUNCA: conversa completa, raw tool outputs, chain-of-thought nem prompts.
 * O dispatcher do proximo slice fara:
 *   state = buildRoundJudgementState(contract, evidence, previousVerdict)
 *   questions = buildRoundJudgementQuestions()
 * e enviara { state, questions } ao SystemOne — um formato canonico unico.
 */
export interface RoundJudgementState {
  objective: string;
  acceptanceCriteria: string[];
  requiredEvidence: string[];
  round: number;
  maxRounds: number;
  executor: { agent: string; model: string };
  outcome: EvidencePacket["outcome"];
  deterministicChecks: EvidencePacket["deterministicChecks"];
  criticFindings: EvidencePacket["criticFindings"];
  resultSummary: string;
  previousVerdict?: JevVerdict;
}

/**
 * Builder puro e defensivo do estado enviado ao Jev. Sempre bounded: trunca
 * strings e corta arrays mesmo se o chamador passar dados acima dos limites
 * (o kernel normaliza antes de armazenar; aqui e rede de seguranca).
 */
export function buildRoundJudgementState(
  contract: ExecutionContract,
  evidence: EvidencePacket,
  previousVerdict?: JevVerdict,
): RoundJudgementState {
  const c = contract as unknown as Record<string, unknown> | undefined;
  const ev = evidence as unknown as Record<string, unknown> | undefined;

  const objective = truncate(asString(c?.objective), CONTRACT_LIMITS.objective);
  const acceptanceCriteria = asStringArray(c?.acceptanceCriteria, CONTRACT_LIMITS.array).map((x) =>
    truncate(x, CONTRACT_LIMITS.phrase),
  );
  const requiredEvidence = asStringArray(c?.requiredEvidence, CONTRACT_LIMITS.array).map((x) =>
    truncate(x, CONTRACT_LIMITS.evidence),
  );

  const checks = Array.isArray(ev?.deterministicChecks) ? ev.deterministicChecks : [];
  const deterministicChecks = checks.slice(0, EVIDENCE_LIMITS.checks).map((raw: unknown) => {
    const ck = (raw ?? {}) as Record<string, unknown>;
    return {
      name: truncate(asString(ck.name), EVIDENCE_LIMITS.checkName),
      status: asCheckStatus(ck.status),
      ...(typeof ck.summary === "string" && ck.summary.trim()
        ? { summary: truncate(ck.summary, EVIDENCE_LIMITS.checkSummary) }
        : {}),
    };
  });

  const findings = Array.isArray(ev?.criticFindings) ? ev.criticFindings : [];
  const criticFindings = findings.slice(0, EVIDENCE_LIMITS.findings).map((raw: unknown) => {
    const f = (raw ?? {}) as Record<string, unknown>;
    return {
      severity: asSeverity(f.severity),
      summary: truncate(asString(f.summary), EVIDENCE_LIMITS.finding),
    };
  });

  const exec = (ev?.executor ?? {}) as Record<string, unknown>;
  const round = typeof ev?.round === "number" && Number.isInteger(ev.round) ? ev.round : 0;
  const maxRounds = typeof c?.maxRounds === "number" && Number.isInteger(c.maxRounds) ? c.maxRounds : 0;

  const state: RoundJudgementState = {
    objective,
    acceptanceCriteria,
    requiredEvidence,
    round,
    maxRounds,
    executor: {
      agent: truncate(asString(exec.agent), EVIDENCE_LIMITS.agentModel),
      model: truncate(asString(exec.model), EVIDENCE_LIMITS.agentModel),
    },
    outcome: asOutcome(ev?.outcome),
    deterministicChecks,
    criticFindings,
    resultSummary: truncate(asString(ev?.resultSummary), EVIDENCE_LIMITS.resultSummary),
  };
  if (previousVerdict) return { ...state, previousVerdict };
  return state;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, max).filter((x): x is string => typeof x === "string");
}

function asCheckStatus(v: unknown): EvidencePacket["deterministicChecks"][number]["status"] {
  return v === "pass" || v === "fail" || v === "unknown" ? v : "unknown";
}

function asSeverity(v: unknown): EvidencePacket["criticFindings"][number]["severity"] {
  return v === "critical" || v === "important" || v === "minor" ? v : "minor";
}

function asOutcome(v: unknown): EvidencePacket["outcome"] {
  return v === "succeeded" || v === "failed" ? v : "interrupted";
}

// ───────────────────────── parsing estrito ─────────────────────────

/** Limiar determinístico do noul (>= 0.5 => true). */
const NOUL_THRESHOLD = 0.5;

/**
 * Converte as respostas do Jev em JevVerdict. Falha explicitamente para:
 * pergunta ausente, tipo de resposta errado, choice desconhecida, valor
 * invalido, resposta estruturalmente incompleta. NAO faz invariantes de
 * combinacao aqui (isso e validateVerdict, em types.ts).
 */
export function parseRoundVerdict(answers: unknown): JevVerdict {
  const fail: (msg: string) => never = (msg) => {
    throw new OrchestrationError("invalid-answers", `parseRoundVerdict: ${msg}`);
  };
  if (!answers || typeof answers !== "object") fail("answers deve ser objeto");
  const a = answers as Record<string, unknown>;

  const doneAnswer = requireAnswer(a, "done", fail);
  const done = parseNoul(doneAnswer, "done", fail) >= NOUL_THRESHOLD;

  const fcAnswer = requireAnswer(a, "failure_class", fail);
  const failureClass = parseChoice(fcAnswer, "failure_class", FAILURE_CLASSES as readonly string[], fail) as FailureClass;

  const repairAnswer = requireAnswer(a, "same_executor_can_repair", fail);
  const sameExecutorCanRepair = parseNoul(repairAnswer, "same_executor_can_repair", fail) >= NOUL_THRESHOLD;

  const naAnswer = requireAnswer(a, "next_action", fail);
  const nextAction = parseChoice(naAnswer, "next_action", NEXT_ACTIONS as readonly string[], fail) as NextAction;

  let confidence: number | undefined;
  const rawConfidence = (naAnswer as Record<string, unknown>).confidence;
  if (rawConfidence !== undefined) {
    if (typeof rawConfidence !== "number" || !Number.isFinite(rawConfidence) || rawConfidence < 0 || rawConfidence > 1) {
      fail('next_action.confidence deve ser numero em [0,1]');
    }
    confidence = rawConfidence;
  }

  return {
    done,
    failureClass,
    sameExecutorCanRepair,
    nextAction,
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

function requireAnswer(a: Record<string, unknown>, key: string, fail: (m: string) => never): unknown {
  if (!(key in a)) fail(`pergunta "${key}" ausente nas answers`);
  return a[key];
}

function parseNoul(answer: unknown, key: string, fail: (m: string) => never): number {
  if (!answer || typeof answer !== "object" || (answer as Record<string, unknown>).type !== "noul") {
    fail(`pergunta "${key}": esperada resposta do tipo noul`);
  }
  const v = (answer as Record<string, unknown>).noul;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    fail(`pergunta "${key}": noul deve ser numero em [0,1] (recebido: ${String(v)})`);
  }
  return v;
}

function parseChoice(
  answer: unknown,
  key: string,
  allowed: readonly string[],
  fail: (m: string) => never,
): string {
  if (!answer || typeof answer !== "object" || (answer as Record<string, unknown>).type !== "choice") {
    fail(`pergunta "${key}": esperada resposta do tipo choice`);
  }
  const c = (answer as Record<string, unknown>).choice;
  if (typeof c !== "string" || !allowed.includes(c)) {
    fail(`pergunta "${key}": choice desconhecida "${String(c)}"`);
  }
  return c;
}