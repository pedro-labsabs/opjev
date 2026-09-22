// State machine PURA do Orchestration Kernel v1.
//
// transitionRun(state, event) => { state, commands } transforma estado e
// DECLARA comandos. Ela NUNCA:
//   - chama o Jev;
//   - cria sessao / troca modelo / troca agente;
//   - chama tools;
//   - acessa `ctx`;
//   - executa side-effects.
// O dispatcher do proximo slice interpreta OrchestrationCommand no OpenCode.
// Nenhum dos modulos de orchestration conhece `ctx`.

import {
  OrchestrationError,
  normalizeEvidencePacket,
  validateExecutionContract,
  validateVerdict,
  type EvidencePacket,
  type ExecutorRef,
  type ExecutionContract,
  type HumanDecisionAudit,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type RoundHistoryEntry,
  type RunPhase,
  type RunState,
  type TransitionResult,
} from "./types.ts";
import { buildHumanRequest, validateHumanDecision } from "./human-gate.ts";

// ───────────────────────── politica de rodadas ─────────────────────────
//
// Regra documentada de incremento de `round`:
//   - `round` e o numero da rodada de execucao que sera julgada pelo Jev;
//   - round comeca em 1 (primeira execucao do objetivo);
//   - TODA nova execucao apos verdict falho consome nova rodada:
//     repair-same, fresh-same, switch-model, switch-agent, replan;
//   - diferença de repair-same: mesma sessionID + mesmo agent + mesmo model
//     (nao e zero de novo ciclo — e nova rodada com o mesmo executor);
//   - fresh-same: nova sessao, mesmo agent/model;
//   - round NUNCA excede contract.maxRounds: quando um novo ciclo excederia
//     o limite, a transicao termina deterministicamente em awaiting-human
//     com command request-human (escalada humana; loop infinito impossivel,
//     mesmo com repair-same encadeado).
//   - history e bounded: max(maxRounds + 2, 4) entradas, FIFO.

const HISTORY_CAP_MIN = 4;

export function createRunState(contract: ExecutionContract): RunState {
  validateExecutionContract(contract);
  return { contract, phase: "planning", round: 1, history: [] };
}

/**
 * Transicao deterministica. Lanca OrchestrationError com code:
 *  - "invalid-transition": fase + evento nao compativeis;
 *  - "invalid-verdict":    verdict inconsistente (validateVerdict falhou);
 *  - "invalid-evidence":   EvidencePacket malformado;
 *  - "invalid-event":      payload do evento invalido.
 * Nunca muta `state`; retorna um novo estado + comandos declarativos.
 */
export function transitionRun(state: RunState, event: OrchestrationEvent): TransitionResult {
  const src = state.phase;
  const invalid = (msg: string): never => {
    throw new OrchestrationError("invalid-transition", `transitionRun: ${msg}`);
  };
  const next = (patch: Partial<RunState>, commands: OrchestrationCommand[]): TransitionResult => ({
    state: { ...state, ...patch },
    commands,
  });

  switch (event.type) {
    case "CONTRACT_READY": {
      if (src !== "planning") invalid(`CONTRACT_READY nao permitido na fase ${src}`);
      if (event.contract !== undefined) {
        validateExecutionContract(event.contract);
        // Invariantes da substituicao de contrato (apos replan):
        // digamos runID/redução de maxRounds -> erro deterministico, nunca silencioso.
        if (event.contract.runID !== state.contract.runID) {
          throw new OrchestrationError(
            "invalid-contract",
            `contrato revisado nao pode mudar runID (esperado ${state.contract.runID}, recebido ${event.contract.runID})`,
          );
        }
        if (event.contract.maxRounds > state.contract.maxRounds) {
          throw new OrchestrationError(
            "invalid-contract",
            `contrato revisado nao pode aumentar maxRounds (original ${state.contract.maxRounds}, revisado ${event.contract.maxRounds}) — aumento exige decisao humana explicita`,
          );
        }
        // Invariante de orcamento: round <= maxRounds. Como replan avancou para
        // state.round, reduzir o budget abaixo dele permitiria execucao acima do
        // orcamento — proibido deterministicamente.
        if (event.contract.maxRounds < state.round) {
          throw new OrchestrationError(
            "invalid-contract",
            `contrato revisado nao pode reduzir maxRounds abaixo da rodada atual (current round ${state.round}, revised maxRounds ${event.contract.maxRounds})`,
          );
        }
        const changedFields = diffContractFields(state.contract, event.contract);
        const revision = {
          from: { objective: state.contract.objective, maxRounds: state.contract.maxRounds },
          to: { objective: event.contract.objective, maxRounds: event.contract.maxRounds },
          changedFields,
        };
        // Audita a revisao no ultimo entry (o do verdict replan); cap preservado
        // (associacao, nao crescimento).
        const history = state.history.length > 0
          ? [...state.history.slice(0, -1), { ...state.history[state.history.length - 1], contractRevision: revision }]
          : state.history;
        return next({ contract: event.contract, phase: "ready", history }, [{ type: "dispatch", mode: "replan" }]);
      }
      return next({ phase: "ready" }, [{ type: "dispatch", mode: "initial" }]);
    }

    case "EXECUTION_STARTED": {
      if (src !== "ready" && src !== "repairing") invalid(`EXECUTION_STARTED nao permitido na fase ${src}`);
      if (src === "ready") {
        // initial/fresh-same/switch-model/switch-agent/replan so executam com
        // identidade explicita (ExecutorRef). Sem ela, erro de integracao.
        if (event.executor === undefined) {
          throw new OrchestrationError(
            "invalid-event",
            "EXECUTION_STARTED em ready exige executor explicito (initial/fresh/switch nunca executam sem identidade)",
          );
        }
        assertExecutor(event.executor);
        return next({ phase: "running", executor: event.executor, lastError: undefined }, []);
      }
      // repairing: executor opcional; omitido reutiliza obrigatoriamente o
      // executor valido do estado (agent/model/sessionID). Nunca running sem
      // ExecutorRef valido.
      const executor = event.executor ?? state.executor;
      assertExecutor(executor);
      return next({ phase: "running", executor, lastError: undefined }, []);
    }

    case "EXECUTION_FINISHED": {
      if (src !== "running") invalid(`EXECUTION_FINISHED nao permitido na fase ${src}`);
      if (!isOutcome(event.outcome)) throw new OrchestrationError("invalid-event", `outcome invalido: ${String(event.outcome)}`);
      return next({ phase: "evaluating" }, [{ type: "evaluate" }]);
    }

    case "EVIDENCE_READY": {
      if (src !== "evaluating") invalid(`EVIDENCE_READY nao permitido na fase ${src}`);
      const evidence = normalizeEvidencePacket(event.evidence);
      // Evidence stale (rodada passada) ou futura (misrouted) nunca e aceita:
      // o Jev julga SEMPRE a rodada atual.
      if (evidence.round !== state.round) {
        throw new OrchestrationError(
          "invalid-evidence",
          `EvidencePacket de outra rodada: expected round ${state.round}, received round ${evidence.round}`,
        );
      }
      return next({ phase: "evaluating", evidence, executor: evidence.executor }, []);
    }

    case "VERDICT_RECEIVED": {
      if (src !== "evaluating") invalid(`VERDICT_RECEIVED nao permitido na fase ${src}`);
      // Adjudicacao "no escuro" e proibida: sem EvidencePacket da rodada atual
      // nao ha o que julgar (worker -> evidence -> critic -> Jev).
      if (state.evidence === undefined || state.evidence.round !== state.round) {
        throw new OrchestrationError(
          "invalid-evidence",
          `VERDICT_RECEIVED exige EvidencePacket da rodada atual (expected round ${state.round}, recebido ${
            state.evidence === undefined ? "nenhum" : String(state.evidence.round)
          })`,
        );
      }
      validateVerdict(event.verdict);
      const verdict = event.verdict;
      const history = recordRound(state, verdict);
      switch (verdict.nextAction) {
        case "accept": {
          // Gate deterministico (Blocker A): hard deterministic failure — qualquer
          // deterministicChecks[].status === "fail" — NUNCA pode ser aprovado por
          // um veredito accept do Jev. O Jev continua recebendo a evidencia
          // negativa para classificar e escolher acao (repair/fresh/switch/replan/
          // human/stop); apenas a combinacao accept + hard failure e rejeitada
          // aqui, deterministicamente, no kernel. "unknown" NAO conta como fail
          // neste slice. Nenhuma acao alternativa e escolhida localmente: o kernel
          // apenas rejeita a transicao (OrchestrationError), o dispatcher falha
          // bounded e o resultado jamais termina em completed.
          const hardFailure = (state.evidence?.deterministicChecks ?? []).some((ck) => ck.status === "fail");
          if (hardFailure) {
            throw new OrchestrationError(
              "verdict-rejected",
              "VERDICT accept incompativel com evidencia deterministica: deterministicChecks contem hard failure",
            );
          }
          return next({ phase: "completed", lastVerdict: verdict, history }, [{ type: "complete" }]);
        }
        case "repair-same":
          // Nova rodada bounded, SEMPRE: mesma sessionID/agent/model (o executor
          // permanece no estado) mas round++ — repair-same nunca vira loop.
          return beginNextRound(
            state,
            verdict,
            history,
            (round) =>
              next(
                { phase: "repairing", round, lastVerdict: verdict, history, evidence: undefined },
                [{ type: "repair-same" }],
              ),
          );
        case "fresh-same":
          // Nova sessao: preserva agent/model, descarta a sessionID antiga
          // (a identidade que o dispatcher usara na proxima EXECUTION_STARTED
          // em ready DEVE carregar uma sessionID nova).
          return beginNextRound(
            state,
            verdict,
            history,
            (round) =>
              next(
                {
                  phase: "ready",
                  round,
                  lastVerdict: verdict,
                  history,
                  evidence: undefined,
                  ...(state.executor ? { executor: { agent: state.executor.agent, model: state.executor.model } } : {}),
                },
                [{ type: "fresh-same" }],
              ),
          );
        case "switch-model":
          return beginNextRound(
            state,
            verdict,
            history,
            (round) =>
              next(
                { phase: "ready", round, lastVerdict: verdict, history, evidence: undefined, executor: undefined },
                [{ type: "select-model" }],
              ),
          );
        case "switch-agent":
          return beginNextRound(
            state,
            verdict,
            history,
            (round) =>
              next(
                { phase: "ready", round, lastVerdict: verdict, history, evidence: undefined, executor: undefined },
                [{ type: "select-agent" }],
              ),
          );
        case "replan":
          return beginNextRound(
            state,
            verdict,
            history,
            (round) =>
              next(
                {
                  phase: "planning",
                  round,
                  lastVerdict: verdict,
                  history,
                  evidence: undefined,
                  // #11: identidade canonica preservada (agent/model), sessionID
                  // descartada — a proxima worker pos-replan sera realmente fresh.
                  executor: state.executor
                    ? { agent: state.executor.agent, model: state.executor.model }
                    : undefined,
                },
                [{ type: "replan" }],
              ),
          );
        case "human":
          // Boundary humano (#12): o Jev PODE pedir pausa (nextAction=human),
          // mas a retomada exige um HumanDecision humano validado — nunca
          // auto-resume. O HumanRequest e deterministico (sem random/UUID).
          return next(
            {
              phase: "awaiting-human",
              lastVerdict: verdict,
              history,
              pendingHuman: buildHumanRequest({
                round: state.round,
                historyLength: history.length,
                kind: "jev-human",
                currentMaxRounds: state.contract.maxRounds,
                failureClass: verdict.failureClass,
              }),
            },
            [{ type: "request-human" }],
          );
        case "stop":
          return next({ phase: "stopped", lastVerdict: verdict, history }, [{ type: "stop" }]);
        default: {
          // validateVerdict ja garante a cobertura; isto e rede de seguranca.
          const _exhaustive: never = verdict.nextAction;
          return invalid(`nextAction inesperada: ${String(_exhaustive)}`);
        }
      }
    }

    case "HUMAN_DECISION_RECEIVED": {
      // Fase checada ANTES da validacao da decisao (#12): um run que ja nao
      // esta mais pausado (resume/stop ja aplicado, completed, failed, …)
      // recebe invalid-transition — retomada duplicada nunca reabre rodada.
      if (src !== "awaiting-human") invalid(`HUMAN_DECISION_RECEIVED nao permitido na fase ${src}`);
      validateHumanDecision(event.decision, state);
      const decision = event.decision;
      const maxRoundsBefore = state.contract.maxRounds;
      const maxRoundsAfter =
        decision.action === "resume" && decision.newMaxRounds !== undefined
          ? decision.newMaxRounds
          : maxRoundsBefore;
      // Auditoria na entry da rodada pausada (padrao contractRevision:
      // associacao, NUNCA crescimento de history).
      const audit: HumanDecisionAudit = {
        requestID: decision.requestID,
        action: decision.action,
        ...(decision.instruction !== undefined ? { instruction: decision.instruction } : {}),
        maxRoundsBefore,
        maxRoundsAfter,
      };
      const history =
        state.history.length > 0
          ? [...state.history.slice(0, -1), { ...state.history[state.history.length - 1], humanDecision: audit }]
          : state.history;
      if (decision.action === "stop") {
        // Encerra sem trabalho novo: round inalterado, pendingHuman consumido.
        return next({ phase: "stopped", history, pendingHuman: undefined }, [{ type: "stop" }]);
      }
      // Resume: abre EXATAMENTE uma rodada (round+1 uma unica vez), phase
      // ready, executor canonico sem sessionID (worker fresca no dispatcher),
      // dispatch mode human-resume. Apenas contract.maxRounds pode mudar —
      // CONTRACT_READY continua proibindo aumento de orcamento.
      return next(
        {
          phase: "ready",
          round: state.round + 1,
          contract:
            maxRoundsAfter !== maxRoundsBefore
              ? { ...state.contract, maxRounds: maxRoundsAfter }
              : state.contract,
          history,
          pendingHuman: undefined,
          ...(state.executor
            ? { executor: { agent: state.executor.agent, model: state.executor.model } }
            : {}),
        },
        [{ type: "dispatch", mode: "human-resume" }],
      );
    }

    case "COMMAND_FAILED": {
      const allowed: RunPhase[] = ["ready", "evaluating", "repairing", "awaiting-human", "planning"];
      if (!allowed.includes(src)) invalid(`COMMAND_FAILED nao permitido na fase ${src}`);
      const raw = event.error ?? `comando falhou: ${String(event.command ?? "desconhecido")}`;
      const lastError = raw.length > 400 ? `${raw.slice(0, 400)}…[truncado pelo kernel]` : raw;
      return next({ phase: "failed", lastError }, []);
    }
  }
}

// ───────────────────────── helpers internos ─────────────────────────

/**
 * MaxRounds enforcement: novo ciclo (round+1) so acontece se nao exceder
 * contract.maxRounds. Caso contrario, terminal deterministico
 * awaiting-human + request-human (sem novo dispatch, sem loop).
 */
function beginNextRound(
  state: RunState,
  verdict: RunState["lastVerdict"],
  history: RoundHistoryEntry[],
  onRound: (round: number) => TransitionResult,
): TransitionResult {
  const nextRound = state.round + 1;
  if (nextRound > state.contract.maxRounds) {
    // Esgotamento de orcamento (#12): pausa com pedido humano de autoridade
    // de budget — retomada exige newMaxRounds >= round+1 (ou stop). O kernel
    // nunca aumenta orcamento sozinho e nunca executa round+1 sem decisao.
    return {
      state: {
        ...state,
        phase: "awaiting-human",
        lastVerdict: verdict,
        history,
        pendingHuman: buildHumanRequest({
          round: state.round,
          historyLength: history.length,
          kind: "max-rounds",
          currentMaxRounds: state.contract.maxRounds,
          ...(verdict?.failureClass ? { failureClass: verdict.failureClass } : {}),
        }),
      },
      commands: [{ type: "request-human" }],
    };
  }
  return onRound(nextRound);
}

// Registra o fechamento da rodada na history (bounded FIFO).
/**
 * Campos alterados entre contratos (nomes conhecidos apenas). Comparacao
 * deterministica por valor serializado; conservadora (ordem de array conta
 * como mudanca) — direcao audit-safe.
 */
function diffContractFields(a: ExecutionContract, b: ExecutionContract): string[] {
  const out: string[] = [];
  if (a.objective !== b.objective) out.push("objective");
  if (JSON.stringify(a.scope) !== JSON.stringify(b.scope)) out.push("scope");
  if (JSON.stringify(a.constraints) !== JSON.stringify(b.constraints)) out.push("constraints");
  if (JSON.stringify(a.acceptanceCriteria) !== JSON.stringify(b.acceptanceCriteria)) out.push("acceptanceCriteria");
  if (JSON.stringify(a.requiredEvidence) !== JSON.stringify(b.requiredEvidence)) out.push("requiredEvidence");
  if (a.maxRounds !== b.maxRounds) out.push("maxRounds");
  return out;
}

function recordRound(state: RunState, verdict: RunState["lastVerdict"]): RoundHistoryEntry[] {
  const entry: RoundHistoryEntry = {
    round: state.round,
    // Attempt history (#10): identidade do executor executado (agent/model).
    // Sem sessionID (inutil para candidate filtering) e sem scoring.
    ...(state.executor ? { executor: { agent: state.executor.agent, model: state.executor.model } } : {}),
    verdict,
    ...(state.evidence ? { outcome: state.evidence.outcome, resultSummary: state.evidence.resultSummary } : {}),
  };
  const cap = Math.max(HISTORY_CAP_MIN, state.contract.maxRounds + 2);
  const grown = [...state.history, entry];
  return grown.length > cap ? grown.slice(grown.length - cap) : grown;
}

function isOutcome(v: unknown): v is EvidencePacket["outcome"] {
  return v === "succeeded" || v === "failed" || v === "interrupted";
}

function assertExecutor(executor: unknown): asserts executor is ExecutorRef {
  const ok =
    !!executor &&
    typeof (executor as ExecutorRef).agent === "string" &&
    (executor as ExecutorRef).agent.trim().length > 0 &&
    typeof (executor as ExecutorRef).model === "string" &&
    (executor as ExecutorRef).model.trim().length > 0;
  if (!ok) {
    throw new OrchestrationError("invalid-event", "EXECUTION_STARTED exige executor valido (agent e model nao vazios)");
  }
}