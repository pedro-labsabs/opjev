// Correction prompt de recovery (repair-same / fresh-same / switch-model / switch-agent).
//
// Puro e testavel: nao importa ctx. Gera o prompt bounded de correcao para a
// proxima rodada APOS um JevVerdict repair-same/fresh-same. Contem SOMENTE a
// falha observada projetada (classes, summary, checks falhos, findings) —
// nunca: chain-of-thought, raw message history, raw critic output nem
// contexto inteiro da worker. Para fresh-same este prompt E a unica informacao
// de recovery alem do contrato bounded: a conversa/sessao antiga nao e copiada.

import {
  CONTRACT_LIMITS,
  EVIDENCE_LIMITS,
  HUMAN_LIMITS,
  truncate,
  type ExecutionContract,
  type FailureClass,
} from "./types.ts";

export interface RecoveryPromptInput {
  action: "repair-same" | "fresh-same" | "switch-model" | "switch-agent" | "replan" | "human-resume";
  contract: ExecutionContract;
  round: number;
  maxRounds: number;
  failureClass: FailureClass;
  previousResultSummary: string;
  failedChecks: Array<{ name: string; status: "pass" | "fail" | "unknown"; summary?: string }>;
  criticFindings: Array<{ severity: "critical" | "important" | "minor"; summary: string }>;
  /** Instrucao bounded do humano autorizando a retomada (only human-resume). */
  humanInstruction?: string;
}

/** Gera o correction prompt bounded focado somente na falha observada. */
export function buildRecoveryPrompt(input: RecoveryPromptInput): string {
  const c = input.contract;
  const lines: string[] = [];
  const push = (label: string, value: string) => lines.push(`${label}: ${value}`);
  const pushList = (label: string, items: string[] | undefined) => {
    if (items && items.length > 0) {
      lines.push(`${label}:`);
      for (const it of items) lines.push(`- ${truncate(it, CONTRACT_LIMITS.phrase)}`);
    }
  };

  push("RECOVERY_ACTION", input.action);
  push("ROUND", `${input.round}/${input.maxRounds}`);
  push("OBJECTIVE", truncate(c.objective, CONTRACT_LIMITS.objective));
  if (input.action === "replan" || input.action === "human-resume") {
    // Round pos-replan executa o REVISED contract como ativo: escopo,
    // restricoes e evidencia revisados fazem parte do prompt (#11). A rodada
    // retomada por decisao humana (#12) tambem recebe o contrato integral.
    pushList("SCOPE_INCLUDE", c.scope?.include);
    pushList("SCOPE_EXCLUDE", c.scope?.exclude);
    pushList("CONSTRAINTS", c.constraints);
  }
  pushList("ACCEPTANCE_CRITERIA", c.acceptanceCriteria);
  if (input.action === "replan" || input.action === "human-resume") {
    pushList("REQUIRED_EVIDENCE", c.requiredEvidence);
  }
  push("PREVIOUS_FAILURE_CLASS", input.failureClass);
  push("PREVIOUS_RESULT_SUMMARY", truncate(input.previousResultSummary || "[sem summary]", EVIDENCE_LIMITS.resultSummary));

  if (input.action === "human-resume") {
    // Autorizacao humana bounded, jamais inferida: instrucao real do
    // HumanDecision (quando houver) ou placeholder deterministico.
    const instruction = input.humanInstruction?.trim() ?? "";
    push(
      "HUMAN_INSTRUCTION",
      instruction
        ? truncate(instruction, HUMAN_LIMITS.instruction)
        : "[human authorized continuation without additional instruction]",
    );
  }

  const failedChecks = input.failedChecks.slice(0, EVIDENCE_LIMITS.checks);
  if (failedChecks.length > 0) {
    lines.push("FAILED_OR_UNKNOWN_CHECKS:");
    for (const ck of failedChecks) {
      lines.push(`- ${truncate(ck.name, EVIDENCE_LIMITS.checkName)}: ${ck.status}${ck.summary ? ` (${truncate(ck.summary, EVIDENCE_LIMITS.checkSummary)})` : ""}`);
    }
  }

  const findings = input.criticFindings.slice(0, EVIDENCE_LIMITS.findings);
  if (findings.length > 0) {
    lines.push("CRITIC_FINDINGS:");
    for (const f of findings) {
      lines.push(`- ${f.severity}: ${truncate(f.summary, EVIDENCE_LIMITS.finding)}`);
    }
  }

  if (input.action === "replan") {
    lines.push("RULE: Execute the REVISED ExecutionContract. Do not revert to the previous contract. Do not declare the work approved. The external judge decides acceptance.");
  } else if (input.action === "human-resume") {
    // Retomada autorizada por humano (#12): continua SOMENTE o que foi
    // explicitamente autorizado; nenhum poder extra e inferido e o trabalho
    // nunca e auto-aprovado (autoridade final continua no juiz externo).
    lines.push("RULE: Continue only work explicitly authorized by a human. Do not infer additional permissions beyond the HUMAN_INSTRUCTION and this contract.");
    lines.push("RULE: Do not declare approval; the external judge decides acceptance.");
  } else if (input.action === "switch-model" || input.action === "switch-agent") {
    lines.push("RULE: Correct the observed failure under the newly selected executor. Do not declare the work approved. The external judge decides acceptance.");
  } else {
    lines.push("RULE: Correct the observed failure only. Do not declare the work approved. The external judge decides acceptance.");
  }
  return lines.join("\n");
}