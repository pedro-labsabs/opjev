// Camada de admissao bounded (#24) — pura e deterministica. PORTADA da PR #21
// apenas com conceitos permitidos: identidade de turno real, contrato
// canonico validado pelo kernel, chaves de storage e status de binding.
//
// PROIBIDO e deliberadamente AUSENTE aqui: buildAutomaticTrampolinePrompt /
// launcher textual / qualquer rewrite de prompt. O run e chamado pelo seam
// RPC explicito (src/orchestration/admission-rpc.ts), nunca por trampolim.
//
// Nenhum ctx/rede/Date.now/Math.random: este modulo so CONSTRUI datapath
// (contract, runID, chaves). Efeitos (storage, runner, publicacao) ficam no
// handler do seam RPC.

import {
  CONTRACT_LIMITS,
  OrchestrationError,
  validateExecutionContract,
  type ExecutionContract,
} from "./types.ts";
import { createHash } from "node:crypto";

export const ADMISSION_RUN_ID_CAP = 200;

// ───────────────────────── chaves de persistencia ─────────────────────────

export function sessionBindingKey(sessionID: string): string {
  return `orchestration/session/${sessionID}`;
}

export function admissionRecordKey(sessionID: string, messageID: string): string {
  return `orchestration/admission/${sessionID}/${messageID}`;
}

// ───────────────────────── binding status ─────────────────────────

const TERMINAL_BINDING_PHASES = ["completed", "stopped", "failed", "awaiting-human"] as const;

/**
 * Status observavel de um binding session<>run a partir da fase do kernel.
 * Fases terminais (e o boundary humano) mapeiam para si mesmas; todo o resto
 * e "running". Deterministico.
 */
export function bindingStatusFromPhase(phase: unknown): string {
  const p = String(phase ?? "running");
  return (TERMINAL_BINDING_PHASES as readonly string[]).includes(p) ? p : "running";
}

// ───────────────────────── identidade de run ─────────────────────────

/**
 * runID da admissao: derivado DIRETAMENTE da identidade de turno real
 * (sessionID + messageID) — NUNCA de hash(texto). Duas mensagens
 * legitimamente identicas com messageID distinto permanecem turnos
 * distintos. Sanitizado para chaves de storage e capped em 200 chars.
 * O sufixo e um hash curto da identidade COMPLETA (nao truncada): sem ele,
 * duas identidades longas differing so alem do corte colidiriam.
 */
export function autoAdmissionRunID(sessionID: string, messageID: string): string {
  const slug = (v: unknown): string => String(v ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  const s = slug(sessionID).slice(0, 60) || "anon";
  const m = slug(messageID).slice(0, 60) || "anon";
  const digest = createHash("sha1")
    .update(`${String(sessionID ?? "")}\0${String(messageID ?? "")}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  const raw = `auto-${s}-${m}-${digest}`;
  return raw.length > ADMISSION_RUN_ID_CAP ? raw.slice(0, ADMISSION_RUN_ID_CAP) : raw;
}

export function boundText(text: unknown, max: number): string {
  const t = String(text ?? "");
  if (t.length <= max) return t;
  const marker = "…[truncado]";
  return `${t.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

// ───────────────────────── contrato canonico ─────────────────────────

export interface AutomaticAdmissionInput {
  sessionID: string;
  messageID: string;
  objective: string;
  maxRounds?: number;
}

/**
 * Contrato canonico da admissao. maxRounds e validado LOUD (OrchestrationError,
 * sem clamp silencioso) e o objective e estritamente bounded pelo limite do
 * kernel para que o contrato resultante SEMPRE passe em
 * validateExecutionContract. Deterministico.
 */
export function buildAutomaticExecutionContract(input: AutomaticAdmissionInput): ExecutionContract {
  const maxRounds = input.maxRounds ?? 3;
  if (
    typeof maxRounds !== "number" ||
    !Number.isInteger(maxRounds) ||
    maxRounds < 1 ||
    maxRounds > CONTRACT_LIMITS.maxRounds
  ) {
    throw new OrchestrationError(
      "invalid-max-rounds",
      `maxRounds deve ser inteiro entre 1 e ${CONTRACT_LIMITS.maxRounds} (recebido: ${String(maxRounds)})`,
    );
  }
  const contract: ExecutionContract = {
    runID: autoAdmissionRunID(input.sessionID, input.messageID),
    objective: boundText(input.objective, CONTRACT_LIMITS.objective),
    scope: {},
    constraints: [
      "Siga os criterios de aceite",
      "Nao altere arquivos fora do escopo definido",
      "Ao terminar, reporte evidencia objetiva do que foi feito",
    ],
    acceptanceCriteria: ["Trabalho concluido conforme o objetivo e os criterios de aceite"],
    requiredEvidence: ["worker-session-outcome"],
    maxRounds,
  };
  validateExecutionContract(contract);
  return contract;
}
