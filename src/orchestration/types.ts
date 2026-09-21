// Orchestration Kernel v1 — contrato do control plane.
//
// Puro e deterministico: NENHUM modulo de orchestration importa `ctx`,
// sessao, rede, hooks nem storage. Aqui vivem os tipos e a validacao dos
// contratos do loop
//   USER -> ORCHESTRATOR -> JEV(decide) -> WORKER -> EVIDENCE -> CRITIC
//          -> JEV(julga) -> SCHEDULER(accept|repair-same|fresh-same|
//     switch-model|switch-agent|replan|human|stop).
//
// Este slice (Orchestration Kernel v1) NAO esta conectado ao runtime ativo:
// nada aqui executa efeitos; efeitos sao declarados como OrchestrationCommand
// e serao executados pelo dispatcher do proximo slice.

export class OrchestrationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OrchestrationError";
    this.code = code;
  }
}

// ───────────────────────── ExecutionContract ─────────────────────────

/**
 * Contrato de execucao de uma rodada do orchestrator.
 * Nenhuma historia/conversa completa mora aqui: apenas intencao, escopo,
 * restricoes, criterios de aceite, evidencia exigida e limite de rodadas.
 * Tudo bounded — contract invalido nunca e aceito em silencio.
 */
export interface ExecutionContract {
  runID: string;
  objective: string;
  scope: {
    include?: string[];
    exclude?: string[];
  };
  constraints: string[];
  acceptanceCriteria: string[];
  requiredEvidence: string[];
  maxRounds: number;
}

export const CONTRACT_LIMITS = {
  runID: 200,
  objective: 2000,
  phrase: 500, // constraint / acceptance criterion
  evidence: 300, // requiredEvidence item
  array: 50, // itens por array de strings
  maxRounds: 100,
} as const;

export function validateExecutionContract(contract: unknown): asserts contract is ExecutionContract {
  const fail: (msg: string) => never = (msg) => {
    throw new OrchestrationError("invalid-contract", `ExecutionContract invalido: ${msg}`);
  };
  if (!contract || typeof contract !== "object") fail("contrato deve ser objeto");
  const c = contract as Record<string, unknown>;

  assertBoundedString(c.runID, CONTRACT_LIMITS.runID, "runID", fail);
  assertBoundedString(c.objective, CONTRACT_LIMITS.objective, "objective", fail);
  assertStringArray(c.acceptanceCriteria, CONTRACT_LIMITS.array, CONTRACT_LIMITS.phrase, "acceptanceCriteria", fail, true);
  assertStringArray(c.constraints, CONTRACT_LIMITS.array, CONTRACT_LIMITS.phrase, "constraints", fail, false);
  assertStringArray(c.requiredEvidence, CONTRACT_LIMITS.array, CONTRACT_LIMITS.evidence, "requiredEvidence", fail, false);

  if (c.scope !== undefined) {
    if (!c.scope || typeof c.scope !== "object") fail("scope deve ser objeto");
    const sc = c.scope as Record<string, unknown>;
    if (sc.include !== undefined) assertStringArray(sc.include, CONTRACT_LIMITS.array, CONTRACT_LIMITS.phrase, "scope.include", fail, false);
    if (sc.exclude !== undefined) assertStringArray(sc.exclude, CONTRACT_LIMITS.array, CONTRACT_LIMITS.phrase, "scope.exclude", fail, false);
  }

  const mr = c.maxRounds;
  if (typeof mr !== "number" || !Number.isInteger(mr) || mr < 1 || mr > CONTRACT_LIMITS.maxRounds) {
    fail(`maxRounds deve ser inteiro entre 1 e ${CONTRACT_LIMITS.maxRounds} (recebido: ${String(mr)})`);
  }
}

function assertBoundedString(v: unknown, max: number, label: string, fail: (m: string) => never): asserts v is string {
  if (typeof v !== "string" || v.trim().length === 0) fail(`${label} deve ser string nao vazia`);
  if (v.trim().length > max) fail(`${label} excede limite de ${max} chars (bounded)`);
}

function assertStringArray(
  v: unknown,
  maxItems: number,
  maxChars: number,
  label: string,
  fail: (m: string) => never,
  required: boolean,
): asserts v is string[] {
  if (v === undefined) {
    if (required) fail(`${label} e obrigatorio`);
    return;
  }
  if (!Array.isArray(v) || v.length > maxItems) fail(`${label} deve ser array com no maximo ${maxItems} itens`);
  if (required && v.length === 0) fail(`${label} deve ter pelo menos 1 item`);
  for (const item of v) assertBoundedString(item, maxChars, `${label}[*]`, fail);
}

// ───────────────────────── Executor / Evidence ─────────────────────────

export interface ExecutorRef {
  agent: string;
  model: string;
  sessionID?: string;
}

/**
 * Evidencia de UMA rodada, independente de modelo/agente. Sempre bounded:
 * o kernel trunca campos longos e corta arrays gigantes (normalizeEvidencePacket)
 * antes de armazenar. Nunca outputs arbitrariamente gigantes nem conversa.
 */
export interface EvidencePacket {
  round: number;
  executor: ExecutorRef;
  outcome: "succeeded" | "failed" | "interrupted";
  deterministicChecks: Array<{
    name: string;
    status: "pass" | "fail" | "unknown";
    summary?: string;
  }>;
  criticFindings: Array<{
    severity: "critical" | "important" | "minor";
    summary: string;
  }>;
  artifacts?: string[];
  resultSummary: string;
}

export const EVIDENCE_LIMITS = {
  resultSummary: 500,
  finding: 400,
  checkName: 200,
  checkSummary: 300,
  artifact: 300,
  agentModel: 200,
  sessionID: 200,
  checks: 100,
  findings: 50,
  artifacts: 50,
} as const;

const OUTCOMES = ["succeeded", "failed", "interrupted"] as const;
const CHECK_STATUSES = ["pass", "fail", "unknown"] as const;
const SEVERITIES = ["critical", "important", "minor"] as const;

/** Trunca texto para o limite com marcador determinístico. Util publica do kernel. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncado pelo kernel]` : text;
}

/** Normaliza/valida um EvidencePacket: bounded e deterministico. Nunca muta a entrada. */
export function normalizeEvidencePacket(packet: unknown): EvidencePacket {
  const fail: (msg: string) => never = (msg) => {
    throw new OrchestrationError("invalid-evidence", `EvidencePacket invalido: ${msg}`);
  };
  if (!packet || typeof packet !== "object") fail("packet deve ser objeto");
  const p = packet as Record<string, unknown>;

  const round = p.round;
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1) fail("round deve ser inteiro >= 1");

  const exec = p.executor as Record<string, unknown> | undefined;
  if (!exec || typeof exec !== "object") fail("executor deve ser objeto");
  if (typeof exec.agent !== "string" || exec.agent.trim().length === 0) fail("executor.agent e obrigatorio");
  if (typeof exec.model !== "string" || exec.model.trim().length === 0) fail("executor.model e obrigatorio");
  const executor: ExecutorRef = {
    agent: truncate(exec.agent.trim(), EVIDENCE_LIMITS.agentModel),
    model: truncate(exec.model.trim(), EVIDENCE_LIMITS.agentModel),
    ...(typeof exec.sessionID === "string" && exec.sessionID.trim()
      ? { sessionID: truncate(exec.sessionID.trim(), EVIDENCE_LIMITS.sessionID) }
      : {}),
  };

  const outcome = p.outcome;
  if (typeof outcome !== "string" || !(OUTCOMES as readonly string[]).includes(outcome)) {
    fail(`outcome deve ser ${OUTCOMES.join("|")}`);
  }

  if (!Array.isArray(p.deterministicChecks)) fail("deterministicChecks deve ser array");
  const deterministicChecks = p.deterministicChecks.slice(0, EVIDENCE_LIMITS.checks).map((ck: unknown) => {
    if (!ck || typeof ck !== "object") fail("deterministicCheck invalido");
    const c = ck as Record<string, unknown>;
    if (typeof c.name !== "string" || c.name.trim().length === 0) fail("deterministicCheck.name obrigatorio");
    if (typeof c.status !== "string" || !(CHECK_STATUSES as readonly string[]).includes(c.status)) {
      fail(`deterministicCheck.status deve ser ${CHECK_STATUSES.join("|")}`);
    }
    return {
      name: truncate(c.name.trim(), EVIDENCE_LIMITS.checkName),
      status: c.status as EvidencePacket["deterministicChecks"][number]["status"],
      ...(typeof c.summary === "string" && c.summary.trim()
        ? { summary: truncate(c.summary.trim(), EVIDENCE_LIMITS.checkSummary) }
        : {}),
    };
  });

  if (!Array.isArray(p.criticFindings)) fail("criticFindings deve ser array");
  const criticFindings = p.criticFindings.slice(0, EVIDENCE_LIMITS.findings).map((f: unknown) => {
    if (!f || typeof f !== "object") fail("criticFinding invalido");
    const c = f as Record<string, unknown>;
    if (typeof c.severity !== "string" || !(SEVERITIES as readonly string[]).includes(c.severity)) {
      fail(`criticFinding.severity deve ser ${SEVERITIES.join("|")}`);
    }
    if (typeof c.summary !== "string" || c.summary.trim().length === 0) fail("criticFinding.summary obrigatorio");
    return {
      severity: c.severity as EvidencePacket["criticFindings"][number]["severity"],
      summary: truncate(c.summary.trim(), EVIDENCE_LIMITS.finding),
    };
  });

  let artifacts: string[] | undefined;
  if (p.artifacts !== undefined) {
    if (!Array.isArray(p.artifacts)) fail("artifacts deve ser array");
    artifacts = p.artifacts.slice(0, EVIDENCE_LIMITS.artifacts).map((a) => {
      if (typeof a !== "string" || a.trim().length === 0) fail("artifact deve ser string nao vazia");
      return truncate(a.trim(), EVIDENCE_LIMITS.artifact);
    });
  }

  if (typeof p.resultSummary !== "string" || p.resultSummary.trim().length === 0) fail("resultSummary obrigatorio");

  return {
    round,
    executor,
    outcome: outcome as EvidencePacket["outcome"],
    deterministicChecks,
    criticFindings,
    ...(artifacts ? { artifacts } : {}),
    resultSummary: truncate(p.resultSummary.trim(), EVIDENCE_LIMITS.resultSummary),
  };
}

// ───────────────────────── JevVerdict ─────────────────────────

/**
 * Classes de falha materiais de uma rodada. O Jev NAO narra razao (nao e
 * planner textual): ele classifica e o scheduler aplica deterministicamente.
 */
export const FAILURE_CLASSES = [
  "none",
  "implementation",
  "reasoning",
  "missing-context",
  "wrong-agent",
  "wrong-model",
  "environment",
  "bad-contract",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export function isFailureClass(v: unknown): v is FailureClass {
  return typeof v === "string" && (FAILURE_CLASSES as readonly string[]).includes(v);
}

/** Acoes materiais que o scheduler pode aplicar. */
export const NEXT_ACTIONS = [
  "accept",
  "repair-same",
  "fresh-same",
  "switch-model",
  "switch-agent",
  "replan",
  "human",
  "stop",
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export function isNextAction(v: unknown): v is NextAction {
  return typeof v === "string" && (NEXT_ACTIONS as readonly string[]).includes(v);
}

/**
 * Veredito do Jev para uma rodada. So decisao material e observavel —
 * sem texto generativo de raciocinio.
 */
export interface JevVerdict {
  done: boolean;
  failureClass: FailureClass;
  sameExecutorCanRepair: boolean;
  nextAction: NextAction;
  confidence?: number;
}

/**
 * Invariantes do JevVerdict. Sempre falha deterministicamente —
 * NUNCA faz auto-repair silencioso de verdict inconsistente.
 * Regras:
 *  - done=true  => failureClass="none" E nextAction="accept";
 *  - done=false => failureClass!="none" E nextAction!="accept";
 *  - nextAction="repair-same" => sameExecutorCanRepair=true;
 *  - confidence (se presente) em [0,1].
 */
export function validateVerdict(verdict: unknown): asserts verdict is JevVerdict {
  const fail: (msg: string) => never = (msg) => {
    throw new OrchestrationError("invalid-verdict", `JevVerdict invalido: ${msg}`);
  };
  if (!verdict || typeof verdict !== "object") fail("verdict deve ser objeto");
  const v = verdict as Record<string, unknown>;
  if (typeof v.done !== "boolean") fail("done deve ser boolean");
  if (!isFailureClass(v.failureClass)) fail(`failureClass invalida: ${String(v.failureClass)}`);
  if (typeof v.sameExecutorCanRepair !== "boolean") fail("sameExecutorCanRepair deve ser boolean");
  if (!isNextAction(v.nextAction)) fail(`nextAction invalida: ${String(v.nextAction)}`);
  if (
    v.confidence !== undefined &&
    (typeof v.confidence !== "number" || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1)
  ) {
    fail("confidence deve ser numero em [0,1]");
  }

  const done = v.done as boolean;
  const failureClass = v.failureClass as FailureClass;
  const nextAction = v.nextAction as NextAction;
  if (done) {
    if (failureClass !== "none") fail("done=true exige failureClass=none");
    if (nextAction !== "accept") fail(`done=true exige nextAction=accept (recebido: ${nextAction})`);
  } else {
    if (failureClass === "none") fail("failureClass=none incompativel com done=false");
    if (nextAction === "accept") fail("nextAction=accept incompativel com done=false");
    if (nextAction === "repair-same" && v.sameExecutorCanRepair !== true) {
      fail("nextAction=repair-same exige sameExecutorCanRepair=true");
    }
  }
}

// ───────────────────────── RunState ─────────────────────────

export type RunPhase =
  | "planning"
  | "ready"
  | "running"
  | "evaluating"
  | "repairing"
  | "awaiting-human"
  | "completed"
  | "stopped"
  | "failed";

/** Revisao de contrato auditavel e bounded (from/to enxutos + campos alterados). */
export interface ContractRevision {
  from: { objective: string; maxRounds: number };
  to: { objective: string; maxRounds: number };
  /** Subconjunto de: objective, scope, constraints, acceptanceCriteria, requiredEvidence, maxRounds. */
  changedFields: string[];
}

/** Registro estruturado e bounded de uma rodada fechada (nunca conversa completa). */
export interface RoundHistoryEntry {
  round: number;
  /** Executor que REALMENTE executou a rodada (agent/model, sem sessionID). */
  executor?: { agent: string; model: string };
  /** Revisao instalada via CONTRACT_READY, associada ao entry do verdict replan. */
  contractRevision?: ContractRevision;
  verdict?: JevVerdict;
  outcome?: EvidencePacket["outcome"];
  resultSummary?: string;
  /** Timestamp externo opcional (preenchido pelo dispatcher, nao pelo kernel). */
  at?: number;
}

/**
 * Estado persistivel do loop de orquestracao. Bounded por construcao:
 * history limitada (maxRounds + 2, minimo 4) e EvidencePacket normalizado.
 * Nunca contem conversa completa.
 */
export interface RunState {
  contract: ExecutionContract;
  phase: RunPhase;
  round: number;
  executor?: ExecutorRef;
  evidence?: EvidencePacket;
  lastVerdict?: JevVerdict;
  history: RoundHistoryEntry[];
  /** Erro bounded da ultima falha de comando (diagnostico), quando houver. */
  lastError?: string;
}

// ───────────────────────── Eventos / Comandos ─────────────────────────

export type ExecutionOutcome = "succeeded" | "failed" | "interrupted";

/**
 * Eventos explicitos do control plane. Conjunto minimo: nenhum framework
 * generico de eventos — so o que o loop de orquestracao precisa.
 */
export type OrchestrationEvent =
  | { type: "CONTRACT_READY"; contract?: ExecutionContract }
  | { type: "EXECUTION_STARTED"; executor?: ExecutorRef }
  | { type: "EXECUTION_FINISHED"; outcome: ExecutionOutcome }
  | { type: "EVIDENCE_READY"; evidence: EvidencePacket }
  | { type: "VERDICT_RECEIVED"; verdict: JevVerdict }
  | { type: "COMMAND_FAILED"; command?: OrchestrationCommand["type"]; error?: string };

/**
 * Intencoes declarativas para o futuro dispatcher. A state machine decide
 * QUAL operacao precisa acontecer; o dispatcher decide COMO executa-la no
 * OpenCode (ctx.session.*, agentes, catalogo). O kernel nunca executa efeitos.
 * switch-model/switch-agent NAO escolhem destino: apenas emitem select-model /
 * select-agent (proximo slice consulta o Jev com candidatos validos).
 */
export type OrchestrationCommand =
  | { type: "dispatch"; mode: "initial" | "replan" }
  | { type: "evaluate" }
  | { type: "repair-same" }
  | { type: "fresh-same" }
  | { type: "select-model" }
  | { type: "select-agent" }
  | { type: "replan" }
  | { type: "request-human" }
  | { type: "complete" }
  | { type: "stop" };

export interface TransitionResult {
  state: RunState;
  commands: OrchestrationCommand[];
}