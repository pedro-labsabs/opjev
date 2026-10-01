// Presentation boundary do resultado da orchestration (PR #27) — transporte +
// render. Estado authoritative continua EXATAMENTE onde ja estava (record/
// binding no storage do plugin + synthetic duravel resume:false); esta camada
// apenas TRANSPORTA o notice bounded por um evento RPC PUBLICO e o RENDERIZA
// no TUI via superficies publicas (toast + slot session.composer.top).
//
// Invariantes de autoridade (presentation = sem poder):
//   - decide nada (accept/recovery/phase/round/model);  - nao auto-resume;
//   - nao fabrica resultado;                            - nao toca inbox;
//   - nunca transforma notificacao em execucao.
//
// Bounded: o evento transporta SOMENTE o notice ja bounded
// (buildAdmissionRunNotice) + identidade (runID/sessionID) + phase/round.
// Nunca transporte contexto bruto de worker/critic.
//
// Tudo aqui e PURO e deterministicamente testavel; os unicos seams injetaveis
// sao `emit` (evento RPC) e `isPresentable` (papel da sessao). O lado TUI
// (tui.ts) monta os seams reais e mantem TODO o comportamento de render
// fora do caminho authoritative.

import { isInternalOrchestrationSession } from "../worker-hooks.ts";

/** Evento publico unico: `rpc.opjev.presentation.v1/orchestration-result`. */
export const ORCHESTRATION_RESULT_EVENT = "orchestration-result" as const;

/**
 * Limite duro do notice transportado no evento — mesma cota do notice do
 * seam de admission (buildAdmissionRunNotice). Este modulo e FOLHA do grafo
 * (nao importa admission-rpc): a constante vive aqui e o seam autoritative
 * reexporta, mantendo uma unica fonte de verdade sem ciclo de imports.
 */
export const NOTICE_EVENT_LIMIT = 2000;

export interface OrchestrationResultEvent {
  /** Identidade do run (nunca hash de texto). 1:1 com o estado authoritative. */
  runID: string;
  /** Sessao parent alvo da apresentacao. */
  sessionID: string;
  /** Fase terminal reportada pelo kernel (completed/failed/...). */
  phase: string;
  /** Rodada concluida (opcional). */
  round?: number;
  /** Notice bounded (<= NOTICE_EVENT_LIMIT). */
  notice: string;
}

const ALLOWED_EVENT_KEYS = new Set(["runID", "sessionID", "phase", "round", "notice"]);

function boundedErrorText(err: unknown): string {
  return String(err instanceof Error ? err.message : err)
    .split("\n")[0]
    .slice(0, 300);
}

/**
 * Construtor do evento de apresentacao a partir do resultado authoritative.
 * Fail-closed: campos obrigatorios ausentes/invalidos lancam erro bounded
 * (nunca fabrica evento). Campos DESCONHECIDOS sao DESCARTADOS (allowlist):
 * o evento nunca vira canal de exfiltracao de contexto bruto/credenciais.
 */
export function buildOrchestrationResultEvent(input: {
  runID: string;
  sessionID: string;
  phase: string;
  round?: number;
  notice: string;
}): OrchestrationResultEvent {
  if (input === null || typeof input !== "object") {
    throw new Error("presentation: input de evento invalido");
  }
  // Allowlist: apenas campos conhecidos sao considerados; resto e descartado.
  const picked: Record<string, unknown> = {};
  for (const key of ALLOWED_EVENT_KEYS) {
    if ((input as Record<string, unknown>)[key] !== undefined) {
      picked[key] = (input as Record<string, unknown>)[key];
    }
  }
  const runID = String(picked.runID ?? "").trim();
  const sessionID = String(picked.sessionID ?? "").trim();
  const phase = String(picked.phase ?? "").trim();
  const notice = String(picked.notice ?? "");
  if (runID.length < 1 || runID.length > 200) {
    throw new Error("presentation: runID invalido (1..200)");
  }
  if (sessionID.length < 1 || sessionID.length > 200) {
    throw new Error("presentation: sessionID invalido (1..200)");
  }
  if (phase.length < 1 || phase.length > 60) {
    throw new Error("presentation: phase invalida (1..60)");
  }
  if (notice.length < 1) {
    throw new Error("presentation: notice vazio (nunca fabrica resultado)");
  }
  return {
    runID,
    sessionID,
    phase,
    ...(picked.round !== undefined && Number.isFinite(Number(picked.round))
      ? { round: Math.trunc(Number(picked.round)) }
      : {}),
    notice:
      notice.length > NOTICE_EVENT_LIMIT
        ? `${notice.slice(0, NOTICE_EVENT_LIMIT - 1)}…`
        : notice,
  };
}

/**
 * Schema do RPC de apresentacao. Somente EVENTOS (nenhum metodo): a
 * apresentacao nao pode ser invocada para decidir/executar nada.
 */
export const OrchestrationResultRpc = {
  id: "opjev.presentation.v1",
  methods: {},
  events: {
    [ORCHESTRATION_RESULT_EVENT]: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["runID", "sessionID", "phase", "notice"],
        properties: {
          runID: { type: "string", minLength: 1, maxLength: 200 },
          sessionID: { type: "string", minLength: 1, maxLength: 200 },
          phase: { type: "string", minLength: 1, maxLength: 60 },
          round: { type: "integer", minimum: 0 },
          notice: { type: "string", minLength: 1, maxLength: NOTICE_EVENT_LIMIT },
        },
      },
    },
  },
} as const;

/**
 * Presenter: publica o evento de resultado para a sessao parent.
 * Sem autoridade: interface minima { publish }; emit/isPresentable sao seams.
 */
export function createOrchestrationResultPresenter(deps: {
  emit(event: OrchestrationResultEvent): Promise<void>;
  /** true = sessao cujo TUI deve mostrar o resultado (parent). */
  isPresentable?(sessionID: string): boolean | Promise<boolean>;
  /** Cap de dedupe em memoria (bounded; default 64). */
  seenCap?: number;
}): { publish(input: Parameters<typeof buildOrchestrationResultEvent>[0]): Promise<boolean> } {
  const seen = new Set<string>();
  const seenCap = Math.max(1, Math.trunc(Number(deps.seenCap ?? 64)));
  return {
    async publish(input) {
      let event: OrchestrationResultEvent;
      try {
        event = buildOrchestrationResultEvent(input);
      } catch {
        return false; // input invalido: nunca fabrica apresentacao
      }
      // Dedupe por runID (identidade real). Falha de emit NUNCA des-duplica:
      // replay re-apresenta em vez de perder o resultado (stateless client).
      if (seen.has(event.runID)) return true;
      if (deps.isPresentable !== undefined) {
        try {
          if (!(await deps.isPresentable(event.sessionID))) return false;
        } catch {
          return false; // papel indeterminado => fail-closed (nao apresenta)
  }
      }
      if (seen.size >= seenCap) {
        const first = seen.values().next().value;
        if (typeof first === "string") seen.delete(first); // cap FIFO bounded
      }
      seen.add(event.runID);
      try {
        await deps.emit(event);
      } catch {
        return false; // degradacao bounded: nunca propaga, nunca executa nada
      }
      return true;
    },
  };
}

/**
 * Filtro de sessao apresentavel (lado TUI): a sessao atual do TUI deve ser a
 * parent do run e NAO pode ser uma sessao interna (worker/critic/orchestrator).
 * `metadata` opcional: quando disponivel (SessionInfo.metadata), marcadores
 * internos do opjev fecham a porta; `parentID` cobre subagentes nativos.
 * Erro/indeterminado => false (fail-closed: sem apresentacao).
 */
export function isPresentableSession(input: {
  currentSessionID: string | undefined;
  eventSessionID: string;
  metadata?: Record<string, unknown> | undefined;
  parentID?: string | undefined;
}): boolean {
  if (input.currentSessionID === undefined) return false;
  if (input.currentSessionID !== input.eventSessionID) return false;
  if (input.parentID !== undefined && input.parentID !== null) return false;
  if (
    isInternalOrchestrationSession(
      input.metadata as Record<string, unknown> | undefined,
    )
  ) {
    return false;
  }
  return true;
}
