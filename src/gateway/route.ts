// Modo `route` do gateway (#24): decide com o MESMO router do plugin
// (src/router.ts decideRoute — importado, nunca duplicado) e APLICA via
// endpoints publicos (POST model/agent) ANTES do forward unico do prompt.
//
// Guardrails revalidados antes de aplicar: modelo precisa pertencer ao
// FREE_POOL (src/config.ts isFreeModel) e, se o catalogo veio preenchido,
// estar disponivel nele; agente precisa estar no catalogo de agentes validos.
// Qualquer falha (catalogo/decisao/switch) => {applied:false}: o chamador cai
// para `normal` (pre-admissao,1 forward unico, zero duplicacao).

import { decideRoute, type RouteDecision } from "../router.ts";
import { isFreeModel, resolveOptions, type FreeModel } from "../config.ts";
import { isInternalOrchestrationSession } from "../worker-hooks.ts";
import type { GatewayConfig } from "./config.ts";
import type { CallAuth, UpstreamClient } from "./upstream.ts";

export interface RouteOutcome {
  applied: boolean;
  decision?: RouteDecision;
  reason?: string;
  /**
   * Parcial NAO-silencioso: model foi aplicado mas o agent falhou depois.
   * `rollback` indica se o modelo anterior foi restaurado best-effort
   * (false quando o estado anterior era desconhecido — documentado, nunca
   * mascarado como fallback limpo).
   */
  partial?: { modelApplied: string; rollback: boolean };
}

function bounded(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split("\n")[0]!.slice(0, 200);
}

export async function decideAndApplyRoute(input: {
  sessionID: string;
  text: string;
  config: GatewayConfig;
  upstream: UpstreamClient;
  env?: Record<string, string | undefined>;
  /**
   * Postura de auth do CLIENTE (string) ou anonima (null): catalogos,
   * switches e leitura de sessao espelham o cliente — nunca herdam a senha
   * de env. Cliente anonimo em upstream protegido => 401 nos catalogos =>
   * fallback normal (o forward decide nativamente).
   */
  clientAuth?: CallAuth;
  /**
   * Seam de teste para o endpoint Jev (hermetico): quando definido, substitui
   * o endpoint default das opcoes. Producao (server.ts) nunca passa — usa o
   * default canonico. Nao muda decisao, so o destino HTTP da consulta.
   */
  jevEndpoint?: string;
  jevApiKey?: string | undefined;
}): Promise<RouteOutcome> {
  // Guarda de papel PRIMEIRO: sem confirmacao de papel externo, NENHUM
  // trabalho de routing (ZERO catalogos, ZERO Jev, ZERO switches). Sessoes
  // internas ja tem executor determinado pelo dispatcher; papel ambiguo nao
  // pode provar externo. Metadata ausente em GET 200 continua externa (o
  // runtime pode nao expor metadata em sessoes normais). Lookup sempre com
  // input.clientAuth — nunca senha de env.
  let beforeModel: { providerID: string; id: string } | undefined;
  try {
    const current = await input.upstream.getSession(input.sessionID, input.clientAuth);
    if (isInternalOrchestrationSession(current.metadata)) {
      return {
        applied: false,
        reason: "sessao interna: sem routing, sem catalogos, sem Jev (forward normal)",
      };
    }
    beforeModel = current.model;
  } catch (err) {
    return {
      applied: false,
      reason: `papel da sessao indeterminado; sem routing, sem catalogos, sem Jev (fallback normal): ${bounded(err)}`,
    };
  }

  try {
    const [agents, models] = await Promise.all([
      input.upstream.listAgents(input.clientAuth),
      input.upstream.listModels(input.clientAuth),
    ]);
    const validAgents = agents.map((a) => a.id).filter((id) => id.length > 0);
    const freeCandidates = models
      .map((m) => `${m.providerID}/${m.id}`)
      .filter((ref): ref is FreeModel => isFreeModel(ref));

    // mesma config canonica do plugin (resolveOptions defaults = fonte unica)
    const opts = resolveOptions({});
    const env = input.env ?? process.env;
    const apiKey = typeof env[opts.apiKeyEnv] === "string" ? (env[opts.apiKeyEnv] as string) : undefined;

    const decision = await decideRoute({
      prompt: input.text,
      validAgents,
      freeCandidates,
      route: "unknown",
      jevModel: opts.jevModel,
      jevEndpoint: input.jevEndpoint ?? opts.jevEndpoint,
      apiKey: input.jevApiKey !== undefined ? input.jevApiKey : apiKey,
      confidenceThreshold: opts.confidenceThreshold,
      timeoutMs: input.config.routeDecisionTimeoutMs,
    });

    // guardrails (nunca aplicar fora da politica FREE_POOL/candidatos)
    if (!isFreeModel(decision.model)) {
      return { applied: false, decision, reason: `modelo fora do FREE_POOL: ${String(decision.model).slice(0, 80)}` };
    }
    if (freeCandidates.length > 0 && !freeCandidates.includes(decision.model)) {
      return { applied: false, decision, reason: `modelo ausente do catalogo: ${decision.model.slice(0, 80)}` };
    }
    if (validAgents.length > 0 && !validAgents.includes(decision.agent)) {
      return { applied: false, decision, reason: `agente invalido: ${decision.agent.slice(0, 80)}` };
    }

    const sep = decision.model.indexOf("/");
    const providerID = decision.model.slice(0, sep);
    const modelID = decision.model.slice(sep + 1);
    // beforeModel veio do role guard (primeira chamada, com clientAuth).
    await input.upstream.switchModel(input.sessionID, { providerID, id: modelID }, input.clientAuth);
    try {
      await input.upstream.switchAgent(input.sessionID, decision.agent, input.clientAuth);
    } catch (err) {
      // Switch de model para o MESMO estado anterior = no-op semantico:
      // nenhum side effect parcial, fallback limpo e honesto.
      if (
        beforeModel !== undefined &&
        beforeModel.providerID === providerID &&
        beforeModel.id === modelID
      ) {
        return { applied: false, decision, reason: `agent switch falhou (model inalterado): ${bounded(err)}` };
      }
      let rollback = false;
      if (beforeModel !== undefined) {
        try {
          await input.upstream.switchModel(input.sessionID, beforeModel, input.clientAuth);
          rollback = true;
        } catch {
          rollback = false;
        }
      }
      return {
        applied: false,
        decision,
        reason: `agent switch falhou apos model aplicado (${bounded(err)}); rollback=${rollback}`,
        partial: { modelApplied: decision.model, rollback },
      };
    }
    return { applied: true, decision };
  } catch (err) {
    return { applied: false, reason: bounded(err) };
  }
}
