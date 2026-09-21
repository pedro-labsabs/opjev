// Gate humano do Orchestration Kernel (#12): HumanRequest deterministico e
// validacao estrita do HumanDecision.
//
// Puro e deterministico: NENHUM import de ctx, sessao, rede, hooks nem
// storage. Autoridade:
//   - o Jev PODE setar nextAction=human (pausa o run em awaiting-human) —
//     mas NUNCA fabrica aprovacao, nunca aumenta orcamento, nunca retoma;
//   - worker/critic/orchestrator NUNCA decidem o gate;
//   - apenas um HumanDecision valido (chegando via orchestrate_resume, de
//     sessao humana verificada pelo caller guard do adapter) autoriza
//     resume/stop; o kernel continua autoridade final da transicao.
//
// Nada aqui coerencia, clampa ou infere: forma desconhecida, acao invalida,
// instrucao fora do limite, requestID stale ou orcamento insuficiente viram
// OrchestrationError com code `invalid-human-decision` — deterministicamente.

import {
  CONTRACT_LIMITS,
  HUMAN_LIMITS,
  OrchestrationError,
  normalizeEvidencePacket,
  validateExecutionContract,
  validateVerdict,
  type HumanDecision,
  type HumanRequest,
  type RunState,
} from "./types.ts";

export type HumanRequestKind = HumanRequest["kind"];

const HUMAN_DECISION_KEYS = ["requestID", "action", "instruction", "newMaxRounds"] as const;

function boundReason(text: string): string {
  return text.length > HUMAN_LIMITS.reason ? text.slice(0, HUMAN_LIMITS.reason) : text;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Monta o HumanRequest do boundary `awaiting-human`. Deterministico:
 * requestID = `human:<round>:<historyLength>:<kind>` — sem random, sem UUID,
 * mesma pausa => mesmo requestID. `historyLength` e o tamanho da history
 * APOS o fechamento da rodada pausada (post-recordRound).
 */
export function buildHumanRequest(input: {
  round: number;
  historyLength: number;
  kind: HumanRequestKind;
  currentMaxRounds: number;
  failureClass?: string;
}): HumanRequest {
  const minimumMaxRounds = input.round + 1;
  const requiredAuthority =
    input.currentMaxRounds >= minimumMaxRounds ? "resume-or-stop" : "increase-budget-or-stop";
  const reason =
    input.kind === "jev-human"
      ? `verdict human na rodada ${input.round}/${input.currentMaxRounds}${
          input.failureClass ? ` (failureClass ${input.failureClass})` : ""
        }`
      : `orcamento esgotado: maxRounds=${input.currentMaxRounds} na rodada ${input.round}; retomada exige newMaxRounds >= ${minimumMaxRounds} ou stop`;
  return {
    requestID: `human:${input.round}:${input.historyLength}:${input.kind}`,
    kind: input.kind,
    round: input.round,
    reason: boundReason(reason),
    requiredAuthority,
    currentMaxRounds: input.currentMaxRounds,
    minimumMaxRounds,
  };
}

/**
 * Validacao estreta do HumanDecision (ordem documentada):
 *   chaves desconhecidas -> forma -> acao especifica -> stale -> orcamento.
 * Code unico: `invalid-human-decision`. Sem coercao, sem clamp, sem default:
 * `newMaxRounds` so vale como inteiro exato dentro de [1, 100], >= orcamento
 * atual (nunca reduz) e, no gate duro, >= round+1 (senao a retomada nao abre
 * rodada — inclusive para kind=max-rounds).
 */
export function validateHumanDecision(v: unknown, state: RunState): asserts v is HumanDecision {
  const fail: (msg: string) => never = (msg) => {
    throw new OrchestrationError("invalid-human-decision", `HumanDecision invalido: ${msg}`);
  };

  if (!v || typeof v !== "object" || Array.isArray(v)) fail("decisao deve ser objeto");
  const d = v as Record<string, unknown>;

  // 1. chaves desconhecidas sao rejeitadas explicitamente (nunca ignoradas):
  //    agent/model/sessionID/approved/revisedContract/toolPermissions/…
  for (const key of Object.keys(d)) {
    if (!(HUMAN_DECISION_KEYS as readonly string[]).includes(key)) {
      fail(`chave desconhecida proibida: ${key} (somente ${HUMAN_DECISION_KEYS.join("|")})`);
    }
  }

  // 2. forma bounded.
  if (typeof d.requestID !== "string" || d.requestID.trim().length === 0) {
    fail("requestID deve ser string nao vazia");
  }
  if (d.requestID.length > HUMAN_LIMITS.requestID) fail(`requestID excede ${HUMAN_LIMITS.requestID} chars`);
  if (d.action !== "resume" && d.action !== "stop") fail(`action invalida: ${String(d.action)} (esperado resume|stop)`);

  // 3. acao especifica: stop rejeita os extras; resume os valida bounded.
  if (d.action === "stop") {
    if (d.instruction !== undefined) fail("instruction so e permitido em action=resume");
    if (d.newMaxRounds !== undefined) fail("newMaxRounds so e permitido em action=resume");
  } else {
    if (d.instruction !== undefined) {
      if (typeof d.instruction !== "string") fail("instruction deve ser string");
      if (d.instruction.trim().length === 0) fail("instruction nao pode ser vazia");
      if (d.instruction.length > HUMAN_LIMITS.instruction) {
        fail(`instruction excede ${HUMAN_LIMITS.instruction} chars`);
      }
    }
    if (d.newMaxRounds !== undefined) {
      const n = d.newMaxRounds;
      if (typeof n !== "number" || !Number.isInteger(n)) fail("newMaxRounds deve ser inteiro (sem coercao)");
      if (n < 1 || n > CONTRACT_LIMITS.maxRounds) {
        fail(`newMaxRounds deve estar em [1, ${CONTRACT_LIMITS.maxRounds}] (recebido: ${n})`);
      }
      if (n < state.contract.maxRounds) {
        fail(`newMaxRounds nao pode reduzir o orcamento atual (${state.contract.maxRounds})`);
      }
    }
  }

  // 4. requestID stale: so o pedido pendente deste run e decidivel.
  const pending = state.pendingHuman;
  if (!pending) fail("estado sem pendingHuman (nenhum pedido humano pendente)");
  if (d.requestID !== pending.requestID) fail(`requestID stale: esperado ${pending.requestID}`);

  // 5. gate duro de orcamento: resume abre exatamente round+1; sem budget
  //    suficiente e invalid-human-decision (kind=max-rounds exige aqui o
  //    newMaxRounds; kind=jev-human com orcamento curto idem).
  if (d.action === "resume") {
    const effective = typeof d.newMaxRounds === "number" ? d.newMaxRounds : state.contract.maxRounds;
    if (effective < state.round + 1) {
      fail(
        `orcamento insuficiente para retomar: maxRounds efetivo ${effective} < round+1 ${state.round + 1} (newMaxRounds obrigatorio)`,
      );
    }
  }
}

/**
 * Validacao do estado persistido antes de qualquer retomada. Code unico:
 * `invalid-resumable-run`. O estado DEVE ser exatamente o de uma pausa real:
 * awaiting-human + pendingHuman coerente + executor canonico + evidence da
 * rodada pausada + ultimo verdict. `createRunState()`/`selectExecutor()`/
 * restart de history NUNCA sao usados — este guard e o que impede isso.
 */
export function validateResumableRunState(v: unknown, runID: string): asserts v is RunState {
  const fail: (msg: string) => never = (msg) => {
    throw new OrchestrationError("invalid-resumable-run", `RunState nao retomavel: ${msg}`);
  };

  if (!v || typeof v !== "object" || Array.isArray(v)) fail("state deve ser objeto");
  const s = v as Record<string, unknown>;

  if (s.phase !== "awaiting-human") fail(`phase deve ser awaiting-human (recebida: ${String(s.phase)})`);

  if (!s.contract || typeof s.contract !== "object") fail("contract ausente");
  try {
    validateExecutionContract(s.contract);
  } catch (e) {
    fail(`contract invalido: ${errText(e)}`);
  }
  const contract = s.contract as { runID?: unknown };
  if (contract.runID !== runID) fail(`runID divergente: contract ${String(contract.runID)} != caller ${runID}`);

  const round = s.round;
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1) fail("round deve ser inteiro >= 1");

  if (!Array.isArray(s.history)) fail("history deve ser array");
  for (const entry of s.history as unknown[]) {
    if (!entry || typeof entry !== "object") fail("history entry deve ser objeto");
    const e = entry as Record<string, unknown>;
    if (typeof e.round !== "number" || !Number.isInteger(e.round) || e.round < 1) {
      fail("history entry round deve ser inteiro >= 1");
    }
  }

  const ph = s.pendingHuman as Record<string, unknown> | undefined;
  if (!ph || typeof ph !== "object") fail("pendingHuman ausente");
  if (typeof ph.requestID !== "string" || ph.requestID.trim().length === 0) fail("pendingHuman.requestID invalido");
  if (ph.requestID.length > HUMAN_LIMITS.requestID) fail("pendingHuman.requestID excede o limite");
  if (ph.kind !== "jev-human" && ph.kind !== "max-rounds") fail(`pendingHuman.kind desconhecido: ${String(ph.kind)}`);
  if (ph.round !== round) fail("pendingHuman.round difere do state.round");
  if (typeof ph.reason !== "string" || ph.reason.trim().length === 0) fail("pendingHuman.reason vazio");
  if (ph.reason.length > HUMAN_LIMITS.reason) fail("pendingHuman.reason excede 500 chars");
  if (ph.requiredAuthority !== "resume-or-stop" && ph.requiredAuthority !== "increase-budget-or-stop") {
    fail(`pendingHuman.requiredAuthority desconhecida: ${String(ph.requiredAuthority)}`);
  }
  const maxRounds = (s.contract as { maxRounds?: unknown }).maxRounds;
  if (ph.currentMaxRounds !== maxRounds) fail("pendingHuman.currentMaxRounds difere do contract.maxRounds");
  if (ph.minimumMaxRounds !== (round as number) + 1) fail("pendingHuman.minimumMaxRounds difere de round+1");

  const ex = s.executor as Record<string, unknown> | undefined;
  if (!ex || typeof ex !== "object") fail("executor canonico ausente (retomada nunca reseleciona)");
  if (typeof ex.agent !== "string" || !ex.agent.trim()) fail("executor.agent vazio");
  if (typeof ex.model !== "string" || !ex.model.trim()) fail("executor.model vazio");

  if (!s.evidence || typeof s.evidence !== "object") fail("evidence da rodada pausada ausente");
  try {
    normalizeEvidencePacket(s.evidence);
  } catch (e) {
    fail(`evidence invalida: ${errText(e)}`);
  }
  if ((s.evidence as { round?: unknown }).round !== round) fail("evidence.round difere do state.round");

  if (s.lastVerdict === undefined) fail("lastVerdict ausente");
  try {
    validateVerdict(s.lastVerdict);
  } catch (e) {
    fail(`lastVerdict invalido: ${errText(e)}`);
  }
}
