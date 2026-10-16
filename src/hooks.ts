import { type RouteKind, type RouterOptions } from "./config.ts";

import { chainFor, decideEscalation, decideGeneric, decideRoute } from "./router.ts";
import { buildSnapshot } from "./snapshot.ts";
import { buildDecisionRecord } from "./sanitize.ts";
import { buildToolRecoverQuestions } from "./jev-client.ts";

import { enforceInternalToolAuthority, resolveInternalToolRole, type InternalToolRole } from "./orchestration/tool-authority.ts";

import { evaluateResourceBudget } from "./resource-governor/runtime-policy.ts";
import { latchQuotaLimit } from "./resource-governor/enforcement-state.ts";
import { reserveThrottleRetry } from "./resource-governor/throttle-retry-budget.ts";

import { buildCriticContextInstruction, buildOrchestratorContextInstruction, buildWorkerContextInstruction } from "./worker-hooks.ts";

import { applySwitch, classifyProviderError, errorClassOf, firstAvailable, freeCandidates, isModelAvailable, isTrivialFollowUp, modelRefString, orchestrationRoleOf, pruneKeys, recordRuntimeResource, safeStorageGet, switchExecutor, switchToModel, switchToAgent, validAgents, type IntentionRecord, type ProviderErrorClassification, type RouteState, TOOL_ERROR_WINDOW_MS, TOOL_ERROR_REPEAT_THRESHOLD, TOOL_DECIDE_COOLDOWN_MS, SWITCH_COOLDOWN_MS, RECOVERY_ACTIONS, toolErrorMayBeUnviable } from "./plugin-runtime.ts";

const HOOK_ROLE_LOOKUP_TIMEOUT_MS = 250;

async function lookupHookRole(ctx: any, sessionID: string): Promise<InternalToolRole> {
  if (!sessionID) return "ambiguous";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const info: any = await Promise.race([
      ctx.session.get({ sessionID }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("session role lookup timed out")), HOOK_ROLE_LOOKUP_TIMEOUT_MS);
      }),
    ]);
    if (!info || typeof info !== "object" || Array.isArray(info)) return "ambiguous";
    return resolveInternalToolRole(info.metadata, sessionID);
  } catch {
    return "ambiguous";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function observeRetryFailure(ctx: any, resourceBase: Record<string, unknown>, classification: ProviderErrorClassification): Promise<void> {
  if (classification.kind === "incomplete" || classification.kind === "ambiguous") {
    await recordRuntimeResource(ctx, {
      ...resourceBase,
      kind: "unknown",
      failureDomain: "unknown",
      ...(classification.httpStatus !== undefined ? { statusCode: classification.httpStatus } : {}),
    });
  } else if (classification.kind === "context-overflow") {
    await recordRuntimeResource(ctx, { ...resourceBase, kind: "context-overflow", errorCode: "context-overflow", failureDomain: "context" });
  } else if (classification.kind === "throttle") {
    await recordRuntimeResource(ctx, {
      ...resourceBase, kind: "throttle", signal: "throttle", failureDomain: "provider",
      ...(classification.httpStatus !== undefined ? { statusCode: classification.httpStatus } : {}),
    });
  } else {
    await recordRuntimeResource(ctx, {
      ...resourceBase,
      kind: "provider-error",
      errorCode: classification.httpStatus !== undefined ? String(classification.httpStatus) : "provider-error",
      ...(classification.httpStatus !== undefined ? { statusCode: classification.httpStatus } : {}),
      failureDomain: "provider",
    });
  }
}

async function observeToolError(ctx: any, event: any, opts: { timeoutMs: number; getKey: () => Promise<string | undefined>; jevModel: string; jevEndpoint: string }): Promise<void> {
  if (event?.status !== "error") return;
  const sessionID = String(event?.sessionID ?? "");
  if (!sessionID) return;
  const tool = String(event?.tool ?? "unknown");
  const message = String(event?.error?.message ?? event?.error ?? "");
  const errorClass = errorClassOf(message);

  const counterKey = `tool-errors/${sessionID}/${tool}/${errorClass}`;
  const counter: any = (await safeStorageGet(ctx, counterKey)) ?? { count: 0, lastAt: 0, tool };
  // Janela: se a ultima ocorrencia da mesma assinatura foi ha muito tempo,
  // reinicia a contagem (padrao novo, nao repeticao).
  if (Date.now() - (counter.lastAt ?? 0) > TOOL_ERROR_WINDOW_MS) {
    counter.count = 0;
  }
  counter.count = (counter.count ?? 0) + 1;
  counter.lastAt = Date.now();
  counter.tool = tool;
  counter.errorClass = errorClass;
  await ctx.storage.set(counterKey, counter);
  await pruneKeys(ctx, sessionID, `tool-errors/${sessionID}/`, 400);

  const material =
    counter.count >= TOOL_ERROR_REPEAT_THRESHOLD || toolErrorMayBeUnviable(message);
  if (!material) return;

  // Factual counting above is retained even for internal/ambiguous roles.
  // Only the external parent may use this legacy advisory recovery hook.
  const role = await lookupHookRole(ctx, sessionID);
  if (role !== "external") return;
  // Cooldown: mesma assinatura decidida recentemente nao re-consulta o Jev.
  const decidedKey = `tool-decided/${sessionID}/${tool}/${errorClass}`;
  const lastDecided: any = await safeStorageGet(ctx, decidedKey);
  if (lastDecided && Date.now() - (lastDecided.at ?? 0) < TOOL_DECIDE_COOLDOWN_MS) return;
  await ctx.storage.set(decidedKey, { at: Date.now(), action: "pending" });
  await pruneKeys(ctx, sessionID, `tool-decided/${sessionID}/`, 200);

  // Snapshot enriquecido para a decisao de recuperacao: attempt real (repeticao
  // da ferramenta), erro normalizado/bounded e decisao anterior (quando houver).
  // failedModel default: modelo real resolvido da sessao.
  const errSummary = message.slice(0, 400);
  const snapshot = await buildSnapshot(ctx, sessionID, {
    attempt: counter.count,
    lastError: errSummary,
  });
  try {
    const answers = await decideGeneric({
      state: {
        session: {
          intention: snapshot.intention,
          agent: snapshot.agent,
          model: snapshot.model,
          route: snapshot.route,
          attempt: snapshot.attempt,
        },
        failure: {
          tool,
          errorClass,
          error: snapshot.lastError ?? "",
          repeats: counter.count,
          attempt: snapshot.attempt,
          material: true,
        },
      },
      questions: buildToolRecoverQuestions(),
      jevModel: opts.jevModel,
      jevEndpoint: opts.jevEndpoint,
      apiKey: await opts.getKey(),
      timeoutMs: opts.timeoutMs,
    });
    const action = answers["action"];
    const choice = action?.type === "choice" ? action.choice : undefined;

    // Persiste a decisao (sanitizada e bounded).
    await ctx.storage.set(
      `decision/${sessionID}/${Date.now()}`,
      buildDecisionRecord(
        { tool, errorClass, repeats: counter.count },
        { action: choice, keep_model: answers["keep_model"] },
      ),
    );
    await pruneKeys(ctx, sessionID, `decision/${sessionID}/`, 50);

    // Acoes permitidas (nao-destrutivas, via API publica, dentro do runtime).
    const route: any = await safeStorageGet(ctx, `route/${sessionID}`);
    const routeKind: RouteKind = route?.route && ["fast-coding", "heavy-reasoning", "research-docs"].includes(route.route)
      ? route.route
      : "fast-coding";
    const recentSwitch: any = await safeStorageGet(ctx, `last-tool-switch/${sessionID}`);
    const canSwitch = !recentSwitch || Date.now() - (recentSwitch.at ?? 0) > SWITCH_COOLDOWN_MS;
    const candidates = chainFor(routeKind);

    if (choice === "switch-model" && canSwitch) {
      const failedRef = modelRefString(snapshot.model && snapshot.model !== "unknown" ? snapshot.model : undefined) ?? route?.model;
      const tried = snapshot.triedModels.filter((m) => m !== failedRef);
      const esk = await decideEscalation({
        failedModel: failedRef ?? candidates[0],
        reason: `tool ${tool} failed (${errorClass})`,
        candidates,
        triedModels: tried,
        snapshot,
        jevModel: opts.jevModel,
        jevEndpoint: opts.jevEndpoint,
        apiKey: await opts.getKey(),
        timeoutMs: opts.timeoutMs,
      });
      const currentAgent = route?.agent ?? (snapshot.agent === "unknown" ? "build" : snapshot.agent);
      if (esk.model) {
        const eligibleModels = [
          esk.model,
          ...candidates.filter((model) => model !== failedRef && !tried.includes(model)),
        ];
        const target = await firstAvailable(ctx, eligibleModels);
        if (target) {
          // Mesma transacao do switch normal (valida antes, rollback best-effort).
          const exec = await switchExecutor(ctx, sessionID, routeKind, target, currentAgent, eligibleModels);
          if (exec.ok) {
            await ctx.storage.set(`route/${sessionID}`, { route: routeKind, model: exec.model, agent: exec.agent, chain: candidates });
            await ctx.storage.set(`last-tool-switch/${sessionID}`, { at: Date.now(), tool, target: exec.model });
            await ctx.storage.set(decidedKey, { at: Date.now(), action: `switch-model:${exec.model}` });
          } else {
            await ctx.storage.set(decidedKey, { at: Date.now(), action: "switch-model-failed" });
          }
        }
      }
    } else if (choice === "switch-agent" && canSwitch) {
      const agents = await validAgents(ctx);
      const current = snapshot.agent === "unknown" ? route?.agent ?? "build" : snapshot.agent;
      // Qualquer agente que o runtime expose (ctx.agent.list) e elegivel.
      const next = agents.find((a) => a !== current);
      if (next) {
        const currentModel = snapshot.model !== "unknown" ? snapshot.model : route?.model;
        // switch-agent has authority over the agent only. Confirm the exact
        // current model can be retained, then switch only the agent; never let
        // switchExecutor widen this action into a model fallback.
        let switched = false;
        if (currentModel && await isModelAvailable(ctx, currentModel)) {
          try {
            await switchToAgent(ctx, sessionID, next);
            switched = true;
          } catch { /* failed agent switch leaves the recorded route unchanged */ }
        }
        if (switched) {
          await ctx.storage.set(`route/${sessionID}`, { route: routeKind, model: currentModel, agent: next, chain: candidates });
          await ctx.storage.set(`last-tool-switch/${sessionID}`, { at: Date.now(), tool, target: next });
          await ctx.storage.set(decidedKey, { at: Date.now(), action: `switch-agent:${next}` });
        } else {
          await ctx.storage.set(decidedKey, { at: Date.now(), action: "switch-agent-failed" });
        }
      }
    } else {
      // retry/replan/stop/escalate: acoes nao executadas pelo plugin (sem
      // execucao destrutiva automatica). A recomendacao do Jev vira uma
      // mensagem ONE-SHOT no proximo context do agente e e consumida/removida
      // depois de entregue (nunca cresce um backlog nem roda em loop).
      if (choice && RECOVERY_ACTIONS.includes(choice)) {
        const pending: any = {
          action: choice,
          tool,
          errorClass,
          repeats: counter.count,
          at: Date.now(),
          keep_model:
            answers["keep_model"]?.type === "noul" ? answers["keep_model"].noul : undefined,
        };
        await ctx.storage.set(`pending-recovery/${sessionID}`, pending);
        await pruneKeys(ctx, sessionID, `pending-recovery/${sessionID}`, 5);
      }
      await ctx.storage.set(decidedKey, { at: Date.now(), action: choice ?? "none" });
    }
  } catch (err) {
    await ctx.storage.set(decidedKey, { at: Date.now(), action: "jev-unavailable" });
    // Jev indisponivel: fallback determinístico — apenas registra; nao vira acao.
  }
}
// Recomendacao de recuperacao one-shot: se existe `pending-recovery/<sessionID>`
// (decisao do Jev apos erro material, nao executada pelo plugin), injeta uma
// mensagem ENXUTA no proximo context do agente e CONSONE a chave na hora —
// chega uma unica vez, nunca cresce, nunca roda em loop. Sem acao destrutiva
// automatica: o agente decide se segue a recomendacao.

async function injectPendingRecovery(ctx: any, sessionID: string, event: any): Promise<void> {
  if (!sessionID || !event?.system || !Array.isArray(event.system)) return;
  try {
    const pending: any = await ctx.storage.get(`pending-recovery/${sessionID}`);
    if (!pending) return;
    const action = String(pending.action ?? "none");
    const keep = pending.keep_model !== undefined
      ? ` (manter modelo: ${String(pending.keep_model).slice(0, 80)})`
      : "";
    event.system.push({
      type: "text",
      text:
        `[jev-router] Apos falha material na tool ${String(pending.tool ?? "?").slice(0, 40)}, ` +
        `o Jev recomenda: ${action}${keep}. Nada foi executado automaticamente; ` +
        "aplique apenas se fizer sentido para a tarefa.",
    });
    // Consome a recomendacao: o proximo context NAO a recebe de novo.
    await ctx.storage.remove(`pending-recovery/${sessionID}`);
  } catch {
    // Best-effort: storage indisponivel nao pode quebrar o context hook.
  }
}

export async function registerToolAuthorityHook(ctx: any): Promise<void> {
  // Provider-compatible tools remain subject to local role authority.
  // OpenCode executes execute.before before the tool handler.
  await ctx.tool.hook("execute.before", async (event: any) => {
    await enforceInternalToolAuthority(ctx, event);
  });
}

export async function registerSessionHooks(
  ctx: any,
  opts: Required<RouterOptions>,
  getKey: () => Promise<string | undefined>,
): Promise<void> {
  // Erros materiais de tools entram no loop de decisao (observeToolError).
    await ctx.tool.hook("execute.after", async (event: any) => {
      await observeToolError(ctx, event, {
        timeoutMs: opts.jevTimeoutMs,
        getKey,
        jevModel: opts.jevModel,
        jevEndpoint: opts.jevEndpoint,
      });
    });

    // Fallback em cadeia: quando o provider falha, o Jev participa da escolha
    // do proximo executor (com estado real). Deterministico para:
    // - overflow de contexto -> compaction resolve (sem troca);
    // - throttle global (429/529/rate-limit) -> backoff sem trocar modelo;
    // - nenhum candidato restante -> parar corretamente.
    // Jev indisponivel -> fallback determinístico (cadeia) bounded.
    await ctx.session.hook("retry", async (event: any) => {
      const sessionID = String(event?.sessionID ?? "");
      const resourceModel = modelRefString(event?.model) ?? (event?.model?.providerID && event?.model?.id
        ? `${event.model.providerID}/${event.model.id}` : undefined);
      const resourceBase = {
        at: Date.now(),
        ...(sessionID ? { sessionID } : {}),
        ...(resourceModel ? { model: resourceModel } : {}),
        ...(Number.isInteger(event?.attempt) && event.attempt >= 0 ? { retry: event.attempt } : {}),
        role: "unknown",
        failureDomain: "provider",
      };
      const classification = classifyProviderError(event?.error);
      if (classification.kind === "quota-limit") {
        // Quota is a global deny and must latch before role lookup.
        event.decision = { retry: false };
        try { await latchQuotaLimit(ctx.storage, Date.now()); } catch { /* in-process emergency latch stays active */ }
        await recordRuntimeResource(ctx, {
          ...resourceBase,
          kind: "quota-limit",
          errorCode: classification.quotaErrorCode ?? "quota-limit",
          failureDomain: "quota",
        });
        return;
      }

      if (classification.kind === "non-retryable") {
        // Canonical host terminal categories cannot be upgraded by a 429/529.
        event.decision = { retry: false };
        await recordRuntimeResource(ctx, {
          ...resourceBase,
          kind: "provider-error",
          errorCode: classification.httpStatus !== undefined ? String(classification.httpStatus) : "provider-error",
          ...(classification.httpStatus !== undefined ? { statusCode: classification.httpStatus } : {}),
          failureDomain: "provider",
        });
        return;
      }

      // The host can retry these categories only when provider-specific delivery/
      // operation details allow it. SessionRetry.error omits those details, so
      // never upgrade an explicit host deny from a generic HTTP throttle signal.
      if (classification.hostConditionalRetry && event?.decision?.retry === false) {
        event.decision = { retry: false };
        await recordRuntimeResource(ctx, {
          ...resourceBase,
          kind: "provider-error",
          errorCode: "provider-error",
          failureDomain: "provider",
          ...(classification.httpStatus !== undefined ? { statusCode: classification.httpStatus } : {}),
        });
        return;
      }

      // Incomplete or contradictory error payloads never authorize any recovery
      // effect or consume throttle budget. Keep only normalized HTTP provenance.
      if (!classification.complete || classification.kind === "ambiguous" || classification.kind === "incomplete") {
        event.decision = { retry: false };
        await recordRuntimeResource(ctx, {
          ...resourceBase,
          kind: "unknown",
          failureDomain: "unknown",
          ...(classification.httpStatus !== undefined ? { statusCode: classification.httpStatus } : {}),
        });
        return;
      }

      // Global hooks may recover only an unambiguously external parent. Worker,
      // critic, orchestrator, and unavailable/ambiguous session state are owned
      // by the control plane or denied; preserve facts but do not retry/switch.
      const role = await lookupHookRole(ctx, sessionID);
      if (role !== "external") {
        event.decision = { retry: false };
        await observeRetryFailure(ctx, { ...resourceBase, role: role !== "ambiguous" ? role : "unknown" }, classification);
        return;
      }

      const status = classification.httpStatus;
      if (classification.kind === "context-overflow") {
        recordRuntimeResource(ctx, { ...resourceBase, kind: "context-overflow", errorCode: "context-overflow", failureDomain: "context" });
        return;
      } else if (classification.kind === "throttle") {
        try {
          const budget = await evaluateResourceBudget(ctx.storage, { stage: "provider-retry", maxRounds: 1, round: 1 });
          if (!budget.allowed) {
            event.decision = { retry: false };
            await recordRuntimeResource(ctx, { ...resourceBase, kind: "throttle", signal: "throttle", failureDomain: "provider", ...(status !== undefined ? { statusCode: status } : {}) });
            return;
          }
        } catch {
          event.decision = { retry: false };
          await recordRuntimeResource(ctx, { ...resourceBase, kind: "throttle", signal: "throttle", failureDomain: "provider", ...(status !== undefined ? { statusCode: status } : {}) });
          return;
        }
        let retryAllowed = false;
        let reservation = { allowed: false, retries: 0 };
        try { reservation = await reserveThrottleRetry(ctx.storage, Date.now()); } catch { /* failed reservation denies */ }
        retryAllowed = reservation.allowed;
        // The shared reservation budget is the authoritative bounded throttle
        // retry cap. Do not add a permanent per-session counter here: it would
        // prevent recovery after the policy window expires.
        if (!sessionID) retryAllowed = false;
        const delay = Math.min(15000, Math.max(0, 5000 * (Number.isFinite(reservation.retries) ? Math.max(1, Math.floor(reservation.retries)) : 1)));
        event.decision = retryAllowed ? { retry: true, delay } : { retry: false };
        await recordRuntimeResource(ctx, {
          ...resourceBase, kind: "throttle", signal: "throttle", failureDomain: "provider",
          ...(status !== undefined ? { statusCode: status } : {}),
        });
        if (retryAllowed) recordRuntimeResource(ctx, { ...resourceBase, kind: "retry", failureDomain: "provider" });
        return;
      } else {
        recordRuntimeResource(ctx, {
          ...resourceBase,
          kind: "provider-error",
          errorCode: status !== undefined ? String(status) : "provider-error",
          ...(status !== undefined ? { statusCode: status } : {}),
          failureDomain: "provider",
        });
      }
      // Provider 5xx and other ordinary failures keep the historical Jev
      // escalation only when the authoritative resource policy grants it.
      try {
        const budget = await evaluateResourceBudget(ctx.storage, { stage: "provider-retry", maxRounds: 1, round: 1 });
        if (!budget.allowed) { event.decision = { retry: false }; return; }
      } catch { event.decision = { retry: false }; return; }
      if (!sessionID) return;
      const stored = (await safeStorageGet(ctx, `route/${sessionID}`)) as RouteState | undefined;
      // O modelo que REALMENTE falhou: o retry hook dispara imediatamente apos
      // a falha do modelo ativo, entao event.model (Model.Ref) e a fonte exata;
      // o route/* e apenas fallback quando o evento nao o carrega.
      const failedRef =
        modelRefString(event?.model) ?? (event?.model?.providerID && event?.model?.id
          ? `${event.model.providerID}/${event.model.id}`
          : stored?.model);
      if (!failedRef) return;

      // Estado de retry persistido: evita repetir modelos ja tentados (sem loop).
      const retryState: any = (await safeStorageGet(ctx, `retry/${sessionID}`)) ?? { tried: [] };
      const tried = Array.from(new Set<string>([...(retryState.tried ?? []), failedRef]));

      const snapshot = await buildSnapshot(ctx, sessionID, {
        attempt: Number(event?.attempt) || tried.length,
        lastError: `${classification.safeType ?? ""}: ${classification.safeMessage ?? ""}`,
        failedModel: failedRef,
      });
      const routeKind: RouteKind = snapshot.route !== "unknown"
        ? snapshot.route
        : stored?.route && (stored.route === "heavy-reasoning" || stored.route === "research-docs")
          ? stored.route
          : "fast-coding";
      const chain = chainFor(routeKind);
      const esk = (await decideEscalation({
        failedModel: failedRef,
        reason: `${classification.safeType ?? ""}: ${classification.safeMessage ?? ""}`,
        candidates: chain,
        triedModels: tried,
        snapshot,
        jevModel: opts.jevModel,
        jevEndpoint: opts.jevEndpoint,
        apiKey: await getKey(),
        timeoutMs: opts.jevTimeoutMs,
      })) as { via: string; model?: string; error?: string };

      if (esk.via === "stop" || !esk.model) {
        // nenhum candidato restante: para corretamente (sem loop).
        await ctx.storage.set(`retry/${sessionID}`, { tried, at: Date.now() });
        event.decision = { retry: false };
        return;
      }
      // Guardrail: so troca para modelo disponivel no catalogo.
      try {
        const budget = await evaluateResourceBudget(ctx.storage, { stage: "provider-retry", maxRounds: 1, round: 1 });
        if (!budget.allowed) { event.decision = { retry: false }; return; }
      } catch { event.decision = { retry: false }; return; }
      // Retain the authorization made by decideEscalation through catalog
      // validation. A listed failed model cannot re-enter as an availability
      // fallback when Jev's selected model is unavailable.
      const candidates = [
        esk.model,
        ...chain.filter((model) => model !== failedRef && !tried.includes(model)),
      ];
      const valid = await firstAvailable(ctx, candidates);
      if (!valid) {
        await ctx.storage.set(`retry/${sessionID}`, { tried, at: Date.now() });
        event.decision = { retry: false };
        return;
      }
      try {
        await switchToModel(ctx, sessionID, valid);
        await ctx.storage.set(`route/${sessionID}`, {
          route: routeKind,
          model: valid,
          agent: stored?.agent ?? (snapshot.agent === "unknown" ? "build" : snapshot.agent),
          chain,
        });
        await ctx.storage.set(`retry/${sessionID}`, {
          tried: [...tried, valid].slice(-12),
          at: Date.now(),
          via: esk.via,
        });
        // registra a decisao (sanitizada) para diagnostico
        await ctx.storage.set(
          `decision/${sessionID}/${Date.now()}`,
          buildDecisionRecord(
            { failedModel: failedRef, reasonSnippet: classification.safeMessage?.slice(0, 200) ?? "" },
            { via: esk.via, model: valid },
          ),
        );
        await pruneKeys(ctx, sessionID, `decision/${sessionID}/`, 50);
        event.decision = { retry: true, delay: 1000 };
        recordRuntimeResource(ctx, { ...resourceBase, kind: "retry", failureDomain: "provider" });
        recordRuntimeResource(ctx, { ...resourceBase, kind: "escalation", failureDomain: "provider" });
      } catch {
        // A failed transition must fail closed: retrying without persisted
        // attempted-route state could repeat the same provider indefinitely.
        event.decision = { retry: false };
        recordRuntimeResource(ctx, { ...resourceBase, kind: "provider-error", failureDomain: "provider" });
      }
    });

    // Intencao original catalogada e distribuida: consulta o Jev na admissao
    // do prompt, persiste intention/* (o que o usuario quis) + route/*
    // (o que o Jev decidiu) e distribui via switch + metadados.
    // Falhas nunca bloqueiam o prompt.
    if (opts.enableAutoRoute) {
      await ctx.session.hook("prompt", async (event: any) => {
        const sessionID = String(event?.sessionID ?? "");
        const text = String(event?.prompt?.text ?? "");

        // Sessao interna de orchestration: bypass TOTAL do auto-routing.
        // Worker, critic e orchestrator ja tem papel definido pelo dispatcher;
        // nunca rerrotear.
        const orchestrationRole = await orchestrationRoleOf(ctx, sessionID, event);
        if (orchestrationRole) {
          event.metadata = {
            ...event.metadata,
            "jev-router": "orchestration-internal",
            "jev-role": orchestrationRole,
          };
          return;
        }

        if (!text.trim()) {
          event.metadata = { ...event.metadata, "jev-router": "skipped-empty" };
          return;
        }
        const prior: RouteState | undefined = await safeStorageGet(ctx, `route/${sessionID}`);

        // G1: sessao ja roteada e prompt e follow-up trivial (ok, continua...)
        // -> mantem rota e modelo, apenas cataloga a continuacao. Sem chamada
        // ao Jev, sem troca de modelo no meio da tarefa.
        if (prior && isTrivialFollowUp(text)) {
          await ctx.storage.set(`intention/${sessionID}`, {
            text: text.slice(0, 4000),
            route: prior.route,
            model: prior.model,
            agent: prior.agent,
            via: "continuation",
            confidence: 0,
            at: Date.now(),
          });
          event.metadata = {
            ...event.metadata,
            "jev-router": "continuation",
            "jev-route": prior.route,
            "jev-model": prior.model,
            "jev-agent": prior.agent,
            "jev-via": "continuation",
          };
          return;
        }

        try {
          // Problema 1: agente/modelo reais da sessao (via ctx.session.get),
          // nao event?.agent (que nao existe no contrato do prompt hook).
          const snapshot = await buildSnapshot(ctx, sessionID);
          const candidates = await freeCandidates(ctx);
          const agents = await validAgents(ctx);
          const d = await decideRoute({
            prompt: text,
            agent: snapshot.agent,
            model: snapshot.model !== "unknown" ? snapshot.model : undefined,
            validAgents: agents,
            freeCandidates: candidates,
            route: snapshot.route,
            jevModel: opts.jevModel,
            jevEndpoint: opts.jevEndpoint,
            apiKey: await getKey(),
            confidenceThreshold: opts.confidenceThreshold,
            timeoutMs: opts.jevTimeoutMs,
          });
          const intention: IntentionRecord = {
            text: text.slice(0, 4000),
            route: d.route,
            model: d.model,
            agent: d.agent,
            via: d.via,
            confidence: d.confidence,
            overridden: d.overridden,
            at: Date.now(),
          };
          // Mesma rota+modelo+agente da sessao -> sem switch desnecessario.
          if (prior && prior.route === d.route && prior.model === d.model && prior.agent === d.agent) {
            await ctx.storage.set(`intention/${sessionID}`, intention);
            event.metadata = {
              ...event.metadata,
              "jev-router": "routed",
              "jev-route": d.route,
              "jev-model": d.model,
              "jev-agent": d.agent,
              "jev-via": d.via,
              "jev-confidence": d.confidence,
              ...(d.overridden ? { "jev-overridden": true } : {}),
            };
            return;
          }
          await applySwitch(ctx, sessionID, d.route, d.model, d.agent, d.via, intention, event);
        } catch (err) {
          event.metadata = {
            ...event.metadata,
            "jev-router": "route-failed",
            "jev-error": err instanceof Error ? err.message : String(err),
          };
        }
      });

      // Agentes chamam o Jev sozinhos: instrucao ENXUTA injetada no contexto.
      // As tools Jev vivem no namespace `jev` em Code Mode (codemode: true):
      // nao existem tools globais `jev_decide`/`jev_route`/`jev_escalate`.
      // A chamada real e via tool `execute`: tools.jev.decide/route/escalate.
      // Objetivo: Jev em decision boundaries (nova intencao, escolha de
      // executor, duvida objetiva, falha material, repeticacao, escalada),
      // nunca em toda operacao. Sem bloco grande a cada chamada.
      // Observacao: o hook `context` roda na montagem do contexto do agent
      // loop, inclusive em CONTINUACOES da sessao (nao so no turno do usuario).
      await ctx.session.hook("context", async (event: any) => {
        const sessionID = String(event?.sessionID ?? "");

        // Sessao interna de orchestration recebe instrucao especifica do papel.
        // Worker executa; critic verifica read-only; orchestrator propoe contrato.
        // Nenhum deles rerroteia nem consulta o Jev.
        const orchestrationRole = await orchestrationRoleOf(ctx, sessionID, event);
        if (orchestrationRole === "worker") {
          event.system.push({
            type: "text",
            text: buildWorkerContextInstruction(),
          });
          return;
        }
        if (orchestrationRole === "critic") {
          event.system.push({
            type: "text",
            text: buildCriticContextInstruction(),
          });
          return;
        }
        if (orchestrationRole === "orchestrator") {
          event.system.push({
            type: "text",
            text: buildOrchestratorContextInstruction(),
          });
          return;
        }

        // Instrucao normal para sessoes de usuario (texto atual preservado):
        // Jev em decision boundaries, via tool `execute` em Code Mode.
        event.system.push({
          type: "text",
          text:
            "O Jev (SystemOne) e a camada de decisao: consulte-o so em decision boundaries " +
            "(nova intencao, escolher executor, duvida objetiva entre alternativas, falha material, " +
            "erro repetido ou escalada). Nao chame `jev.decide`/`tools.jev.decide` como tool direta " +
            "(nao existe no catalogo). Use SEMPRE a tool `execute` em Code Mode: dentro dela escreva JavaScript " +
            "(sem import/export) e retorne a chamada, ex: `return await tools.jev.decide({...})`. " +
            "O mesmo vale para `tools.jev.route(...)` e `tools.jev.escalate(...)`. " +
            "Nao pare o servico nem peca ao usuario; invoque o tool. Fora desses momentos, siga sem o Jev.",
        });
        // Recomendacao de recuperacao do Jev (erro material em tool): entregue
        // uma unica vez e removida logo em seguida (one-shot, sem loop).
        await injectPendingRecovery(ctx, sessionID, event);
      });
    }
}
