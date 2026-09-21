// Agent Catalog da orchestration — puro e testavel (nunca importa `ctx`).
//
// Camada explicita entre OpenCode runtime agents e orchestration roles:
//   runtime agent ID ≠ logical role ≠ primary eligibility.
// O plugin DESCOBRE agents via `ctx.agent.list()` (formato Agent.Info real do
// @opencode/plugin 2.0.7: {id, name, mode: primary|subagent|all, hidden,
// description?...}); nunca registra/inventa agents (sem AgentEditor.add).
//
// Elegibilidade:
//   - primary: mode primary|all && !hidden (hidden = agentes internos como
//     compaction/title/summary — auditaveis no catalogo, nunca candidatos Jev).
//   - subagent: mode subagent|all (uso futuro do orchestrator via allowlist).
// Entries sem mode valido sao descartadas como malformed (mode e required no
// schema; o runtime real sempre envia — provado via `opencode api agent.list`).
// Nenhuma inferencia por texto livre/description em nenhum ponto.

import { OrchestrationError } from "./types.ts";

/** Mode real do runtime (Agent.Info.mode, 2.0.7). */
export type RuntimeAgentMode = "primary" | "subagent" | "all";

/** Papel logico dentro do run (imposto pelo scheduler, nao pelo nome do agent). */
export type LogicalRole = "orchestrator" | "implementer" | "critic";

export interface AgentCatalogEntry {
  /** ID REAL exatamente como retornado pelo runtime (trimado, case preservado). */
  id: string;
  mode: RuntimeAgentMode;
  /** Bounded, so para auditoria — nunca prompt completo. */
  description: string;
  native: boolean;
  hidden: boolean;
  primaryEligible: boolean;
  subagentEligible: boolean;
}

export type AgentCatalogSource = "discovery" | "fallback";

export interface AgentCatalog {
  entries: AgentCatalogEntry[];
  source: AgentCatalogSource;
}

/** Cap rigido do catalogo (bounded, deterministico). */
export const MAX_AGENT_CATALOG = 64;
export const MAX_AGENT_ID = 200;
export const MAX_AGENT_DESCRIPTION = 500;

/** Depth maxima de delegacao controlada pelo opjev: orchestrator -> leaf, STOP. */
export const ORCHESTRATION_MAX_DEPTH = 1;

/** Metadata de logical role (separada de `jev-role`, que continua worker/critic). */
export const JEV_AGENT_ROLE = "jev-agent-role";

/** Permission action V2 para spawn de subagents (2.0.7: "subagent", nao "task"). */
export const SUBAGENT_ACTION = "subagent";

const VALID_MODES: readonly string[] = ["primary", "subagent", "all"];

function failSelection(msg: string): never {
  throw new OrchestrationError("invalid-selection", msg);
}

/**
 * Normaliza descriptors brutos do runtime em catalogo bounded/deterministico:
 * trim IDs, dedupe case-insensitive (primeiro canonico vence), preserva ID
 * real, descarta malformed (sem ID, mode invalido/ausente, nao-objetos),
 * description truncada, cap rigido. Sem inferencia por texto livre.
 */
export function buildAgentCatalog(raw: unknown, source: AgentCatalogSource = "discovery"): AgentCatalog {
  const entries: AgentCatalogEntry[] = [];
  const seen = new Set<string>();
  const items: unknown[] = Array.isArray(raw) ? raw : [];
  for (const item of items) {
    if (entries.length >= MAX_AGENT_CATALOG) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id || id.length > MAX_AGENT_ID) continue;
    const mode = typeof rec.mode === "string" ? rec.mode : "";
    if (!VALID_MODES.includes(mode)) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const runtimeMode = mode as RuntimeAgentMode;
    const hidden = rec.hidden === true;
    const description = typeof rec.description === "string" ? rec.description.slice(0, MAX_AGENT_DESCRIPTION) : "";
    entries.push({
      id,
      mode: runtimeMode,
      description,
      native: rec.native === true,
      hidden,
      primaryEligible: (runtimeMode === "primary" || runtimeMode === "all") && !hidden,
      subagentEligible: runtimeMode === "subagent" || runtimeMode === "all",
    });
  }
  return { entries, source };
}

/** Candidatos a executor primary (Jev): mode primary|all, nunca hidden. */
export function primaryEligibleAgents(catalog: AgentCatalog): AgentCatalogEntry[] {
  return catalog.entries.filter((e) => e.primaryEligible);
}

/** Candidatos a subagent (delegacao futura do orchestrator): mode subagent|all. */
export function subagentEligibleAgents(catalog: AgentCatalog): AgentCatalogEntry[] {
  return catalog.entries.filter((e) => e.subagentEligible);
}

/**
 * Resolve o agent escolhido pelo Jev contra o catalogo (lookup
 * case-insensitive, retorna ID canonico). Desconhecido ou nao primary-eligible
 * => invalid-selection bounded. Nunca inventa alternativa (validation != routing).
 */
export function resolvePrimaryAgent(catalog: AgentCatalog, id: string): AgentCatalogEntry {
  const want = typeof id === "string" ? id.trim().toLowerCase() : "";
  const entry = catalog.entries.find((e) => e.id.toLowerCase() === want);
  if (!entry) {
    failSelection(`agente selecionado nao existe no catalogo runtime: ${String(id)}`);
  }
  if (!entry.primaryEligible) {
    failSelection(
      `agente selecionado nao elegivel como primary no catalogo runtime: ${entry.id} (mode=${entry.mode}, hidden=${entry.hidden})`,
    );
  }
  return entry;
}

export interface DelegationCheck {
  role: LogicalRole;
  targetId: string;
  catalog: AgentCatalog;
  /** IDs explicitamente permitidos para delegacao (case-insensitive). */
  allowlist: string[];
  /** Depth atual do solicitante (0 = orchestrator raiz). */
  depth?: number;
}

/**
 * Politica pura de delegacao (bounded subagent coordination, sem execution
 * loop — a execucao generativa do orchestrator pertence a slice futura):
 *   - critic / implementer: NUNCA delegam (leafs; implementer executa,
 *     critic falsifica);
 *   - orchestrator: somente alvo conhecido + mode subagent|all + allowlist
 *     explicita + depth < ORCHESTRATION_MAX_DEPTH (leaf-safe, sem nesting).
 */
export function checkDelegation(input: DelegationCheck): { allowed: boolean; reason: string } {
  const depth = input.depth ?? 0;
  if (input.role !== "orchestrator") {
    return { allowed: false, reason: `${input.role} cannot delegate subagents` };
  }
  if (depth >= ORCHESTRATION_MAX_DEPTH) {
    return { allowed: false, reason: `delegation depth ${depth} atinge o bound (${ORCHESTRATION_MAX_DEPTH}): leaf nao delega` };
  }
  const want = typeof input.targetId === "string" ? input.targetId.trim().toLowerCase() : "";
  const target = input.catalog.entries.find((e) => e.id.toLowerCase() === want);
  if (!target) {
    return { allowed: false, reason: `delegation target desconhecido no catalogo: ${String(input.targetId)}` };
  }
  if (target.mode !== "subagent" && target.mode !== "all") {
    return { allowed: false, reason: `delegation target nao e subagent-eligible: ${target.id} (mode=${target.mode})` };
  }
  const allowed = Array.isArray(input.allowlist)
    && input.allowlist.some((a) => typeof a === "string" && a.trim().toLowerCase() === target.id.toLowerCase());
  if (!allowed) {
    return { allowed: false, reason: `delegation target fora da allowlist explicita: ${target.id}` };
  }
  return { allowed: true, reason: `orchestrator -> leaf ${target.id} (depth ${depth + 1})` };
}

/**
 * Permission boundary do implementer (worker): nega criacao arbitraria de
 * subagents sem tocar nas demais permissoes da sessao. Formato EXATO do
 * SessionCreateInput 2.0.7 (action "subagent", last-match-wins sobre o
 * allow-all base do app). Critic continua com a policy read-only propria
 * (buildCriticPermissionRules), que ja nega subagent entre outros.
 */
export function buildImplementerPermissionRules(): Array<{ action: string; resource: string; effect: "deny" }> {
  return [{ action: SUBAGENT_ACTION, resource: "*", effect: "deny" }];
}
