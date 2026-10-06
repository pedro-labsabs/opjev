import { FREE_POOL, isFreeModel, type FreeModel, type RouteKind, type RouterOptions } from "./config.ts";

import { chainFor, decideEscalation, decideGeneric, decideRoute } from "./router.ts";
import { buildSnapshot, type DecisionSnapshot } from "./snapshot.ts";
import { buildDecisionRecord } from "./sanitize.ts";

import { runOrchestrationOnce, runOrchestrationResume, type OrchestrationRunResult } from "./orchestration/dispatcher.ts";
import { OrchestrationError, validateExecutionContract, type ExecutionContract } from "./orchestration/types.ts";

import { validateResumableRunState } from "./orchestration/human-gate.ts";
import { withResumeLock } from "./orchestration/resume-lock.ts";

import { applySwitch, firstAvailable, freeCandidates, makeOrchestrationDeps, orchestrationRoleOf, pruneKeys, safeStorageGet, switchExecutor, type RouteState, type IntentionRecord, validAgents } from "./plugin-runtime.ts";

export async function registerTools(
  ctx: any,
  opts: Required<RouterOptions>,
  getKey: () => Promise<string | undefined>,
): Promise<void> {
  await ctx.tool.transform((editor: any) => {
    editor.namespace({
      name: "jev",
      description: "Jev juiz-roteador para free models do Zen",
    });
    editor.add({
      name: "route",
      description:
        "Pergunta ao Jev (SystemOne choice+confidence) qual lane+agent+model free usar entre os candidatos permitidos (FREE_POOL ∩ catalogo). Retorna rota, modelo, agente e cadeia de fallback.",
      input: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Tarefa a rotear" },
          agent: { type: "string", description: "Agente atual da sessao" },
          sessionID: { type: "string", description: "Sessao OpenCode (para memoria de fallback)" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      options: { namespace: "jev", codemode: true },
      execute: async (input: any) => {
        const sessionID = String(input.sessionID ?? "");
        const candidates = await freeCandidates(ctx);
        const agents = await validAgents(ctx);
        let snapshot: DecisionSnapshot | undefined;
        if (sessionID) {
          snapshot = await buildSnapshot(ctx, sessionID);
        }
        const d = await decideRoute({
          prompt: String(input.prompt ?? ""),
          agent: snapshot?.agent ?? input.agent,
          model: snapshot?.model,
          validAgents: agents,
          freeCandidates: candidates,
          route: snapshot?.route ?? "unknown",
          jevModel: opts.jevModel,
          jevEndpoint: opts.jevEndpoint,
          apiKey: await getKey(),
          confidenceThreshold: opts.confidenceThreshold,
          timeoutMs: opts.jevTimeoutMs,
        });
        if (sessionID) {
          const intention: IntentionRecord = {
            text: String(input.prompt ?? "").slice(0, 4000),
            route: d.route,
            model: d.model,
            agent: d.agent,
            via: d.via,
            confidence: d.confidence,
            overridden: d.overridden,
            at: Date.now(),
          };
          const res = await applySwitch(ctx, sessionID, d.route, d.model, d.agent, d.via, intention, { metadata: {} });
          if (!res.ok) {
            // Sem switch (indisponivel/falha). A decisao do Jev segue valida
            // como recomendacao; nada de route/* mentiroso.
          } else {
            // Somente reporta o estado efetivamente aplicado.
            d.model = res.model as FreeModel;
            d.agent = res.agent;
          }
        }
        return {
          content: JSON.stringify({
            route: d.route,
      explanation: d.explanation,
            model: d.model,
            agent: d.agent,
            confidence: d.confidence,
            risky: d.risky,
            complexity: d.complexity,
            via: d.via,
            overridden: d.overridden,
            chain: chainFor(d.route),
            ...(d.error ? { jevError: d.error } : {}),
          }),
        };
      },
    });

    editor.add({
      name: "escalate",
      description:
        "O Jev escolhe outro free model capaz apos falha (proximo da cadeia ou override explícito dentro do pool free).",
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          toModel: { type: "string", description: "Override opcional dentro do pool free, ex: opencode/big-pickle" },
          reason: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      options: { namespace: "jev", codemode: true },
      execute: async (input: any) => {
        const sessionID = String(input.sessionID ?? "");
        if (!sessionID) return { content: "sessionID e obrigatorio" };
        const override = input.toModel as string | undefined;
        if (override !== undefined && !isFreeModel(override)) {
          return { content: `override ${override} fora do pool free; escolha um de: ${chainFor("fast-coding").join(", ")} (ou outra lane)` };
        }
        const stored = (await safeStorageGet(ctx, `route/${sessionID}`)) as RouteState | undefined;
        const failed = stored?.model;
        const routeKind: RouteKind = stored?.route && (stored.route === "heavy-reasoning" || stored.route === "research-docs") ? stored.route : "fast-coding";
        const chain = chainFor(routeKind);
        const snapshot = await buildSnapshot(ctx, sessionID);
        const tried = snapshot.triedModels;
        let next: string | undefined = override;
        let via: "override" | "jev" | "chain" | "override-alt" = "override";
        if (!next) {
          const esk = await decideEscalation({
            failedModel: failed ?? snapshot.model,
            reason: input.reason as string | undefined,
            candidates: chain.filter((m) => m !== failed),
            triedModels: tried,
            jevModel: opts.jevModel,
            jevEndpoint: opts.jevEndpoint,
            apiKey: await getKey(),
            timeoutMs: opts.jevTimeoutMs,
          });
          if (esk.model) {
            via = esk.via === "jev" ? "jev" : "chain";
            next = esk.model;
          } else {
            via = "chain";
            // decideEscalation already filters failed and tried routes. A stop
            // decision is terminal; never restart the chain as a side door.
            next = undefined;
          }
        }
        if (!next) return { content: `Fallback encerrado para a rota ${routeKind}: ${failed ? `falha em ${failed}; ` : ""}nenhum modelo elegivel e nao tentado permanece (tentados: ${tried.join(", ") || "nenhum"}). Habilite/configure outro provedor elegivel ou aguarde a cota/indisponibilidade antes de iniciar uma nova tentativa.` };
        // Validate availability without silently selecting a failed/previously
        // attempted route.
        const eligibleModels = [next, ...chain.filter((m) => !tried.includes(m) && m !== failed)];
        const available = await firstAvailable(ctx, eligibleModels);
        if (!available) {
          return { content: `nenhum modelo da rota ${routeKind} disponivel no catalogo (${next} indisponivel)` };
        }
        if (available !== next) {
          via = via === "override" ? "override-alt" : via;
        }
        // Mesma transacao do switch normal (valida antes, rollback best-effort).
        const currentAgent = stored?.agent ?? (snapshot.agent === "unknown" ? "build" : snapshot.agent);
        const exec = await switchExecutor(ctx, sessionID, routeKind, available, currentAgent, eligibleModels);
        if (!exec.ok) {
          const reason = exec.reason === "model-unavailable" ? "indisponivel no catalogo" : "switch-failed";
          return {
            content: `falha ao trocar para ${available} (${reason}): ${
              exec.error instanceof Error ? exec.error.message : "nenhum candidato da rota disponivel"
            }`,
          };
        }
        await ctx.storage.set(`route/${sessionID}`, { route: routeKind, model: exec.model, agent: exec.agent, chain });
        return { content: `escalado para ${exec.model} (via ${via})${input.reason ? `: ${input.reason}` : ""}` };
      },
    });

    editor.add({
      name: "decide",
      description:
        "Juiz generico da equipe: envia qualquer estado + perguntas SystemOne (choice/noul/score) ao Jev e retorna as respostas. Use quando precisar decidir algo (modelo, prioridade, trade-off, proximo passo) em vez de adivinhar ou pedir ao usuario.",
      input: {
        type: "object",
        properties: {
          state: {
            description: "Estado/fatos para o Jev julgar (objeto ou texto, nunca null; ex: {} ou \"contexto\")",
            anyOf: [{ type: "object" }, { type: "string" }],
          },
          questions: {
            type: "object",
            description:
              "Objeto/mapa com 1-8 perguntas. Cada CHAVE e um nome escolhido por voce para a pergunta. " +
              "Cada VALOR e { type, instructions, criteria }. " +
              "type: 'choice' (criteria = objeto { chave: descricao }), " +
              "'noul' (criteria = objeto { true: ..., false: ... }), " +
              "'score' (criteria = array [legenda, ...]). " +
              'Exemplo: { "opcao": { type: "choice", instructions: "Qual vem primeiro?", criteria: { alpha: "Option alpha", beta: "Option beta" } } }',
            minProperties: 1,
            maxProperties: 8,
            additionalProperties: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["choice", "noul", "score"],
                  description: "Tipo da pergunta SystemOne",
                },
                instructions: {
                  type: "string",
                  description: "Pergunta/instrucao para o Jev (nao vazia)",
                },
                criteria: {
                  description:
                    "choice/noul: objeto { chave: descricao } (strings nao vazias). " +
                    "score: array de legendas (strings nao vazias).",
                  anyOf: [
                    { type: "object", additionalProperties: { type: "string" } },
                    { type: "array", items: { type: "string" } },
                  ],
                },
              },
              required: ["type", "instructions", "criteria"],
              additionalProperties: false,
            },
          },
          sessionID: { type: "string", description: "Sessao OpenCode (para catalogar a decisao)" },
        },
        required: ["state", "questions"],
        additionalProperties: false,
      },
      options: { namespace: "jev", codemode: true },
      execute: async (input: any) => {
        try {
          const answers = await decideGeneric({
            state: input.state,
            questions: input.questions as Record<string, unknown>,
            jevModel: opts.jevModel,
            jevEndpoint: opts.jevEndpoint,
            apiKey: await getKey(),
            timeoutMs: opts.jevTimeoutMs,
          });
          if (input.sessionID) {
            // Persistencia bounded e sanitizada: nunca o input.state bruto.
            await ctx.storage.set(
              `decision/${input.sessionID}/${Date.now()}`,
              buildDecisionRecord(input.state, answers),
            );
          }
          await pruneKeys(ctx, String(input.sessionID ?? ""), `decision/${input.sessionID}/`, 50);
          return { content: JSON.stringify({ answers, via: "jev" }) };
        } catch (err) {
          await pruneKeys(ctx, String(input.sessionID ?? ""), `decision/${input.sessionID}/`, 50);
          return { content: `jev decide falhou: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });

    editor.add({
      name: "orchestrate_once",
      description:
        "Runtime entrypoint EXPLICITO do dispatcher de orquestracao (scheduler multi-round bounded): o Jev seleciona o " +
        "executor UMA vez, cria a worker session OpenCode real, executa o ExecutionContract com EvidencePacket e o Jev julga " +
        "cada rodada (JevVerdict). Apos verdict repair-same/fresh-same, uma NOVA rodada e executada automaticamente " +
        "(repair-same reutiliza a MESMA worker session; fresh-same cria sessao NOVA, mesmo agent/model), sempre com critic " +
        "novo, ate accept/stop ou o limite maxRounds (kernel). Apos verdict switch-model/switch-agent, o Jev seleciona o " +
        "novo executor entre candidatos validos e uma NOVA rodada e executada automaticamente (nova worker session, mesmo " +
        "agent/model conforme o switch, critic novo). Apos verdict replan, um orchestrator read-only propoe UM revised " +
        "ExecutionContract (kernel valida: mesmo runID, sem aumento de maxRounds) e uma NOVA rodada executa o contrato " +
        "revisado em nova worker session, com critic novo. Verdict human (ou esgotamento de maxRounds) pausa o run no " +
        "boundary humano: fase awaiting-human (checkpoint human-awaiting) com pendingHuman exposto (HumanRequest " +
        "deterministico com requestID) e a retomada EXPLICITA e feita por um humano via orchestrate_resume " +
        "(resume/stop) — nunca auto-resume: o run permanece pausado ate a decisao humana chegar. " +
        "Test seam explicito — NUNCA e chamada automaticamente pelo prompt hook. " +
        "Contract invalido e rejeitado localmente (validateExecutionContract).",
      input: {
        type: "object",
        properties: {
          contract: {
            type: "object",
            description:
              "ExecutionContract bounded da rodada: runID, objective, scope (include/exclude), constraints, " +
              "acceptanceCriteria, requiredEvidence e maxRounds.",
            properties: {
              runID: { type: "string", description: "Identificador unico da execucao (max 200 chars)" },
              objective: { type: "string", description: "Objetivo da rodada (max 2000 chars)" },
              scope: {
                type: "object",
                description: "Escopo da tarefa",
                properties: {
                  include: { type: "array", items: { type: "string" }, description: "Caminhos/areas incluidas" },
                  exclude: { type: "array", items: { type: "string" }, description: "Caminhos/areas excluidas" },
                },
                additionalProperties: false,
              },
              constraints: {
                type: "array",
                items: { type: "string" },
                description: "Restricoes da execucao (max 50 itens, 500 chars cada)",
              },
              acceptanceCriteria: {
                type: "array",
                items: { type: "string" },
                description: "Criterios de aceite — obrigatorio, pelo menos 1",
              },
              requiredEvidence: {
                type: "array",
                items: { type: "string" },
                description: "Evidencia exigida da rodada",
              },
              maxRounds: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                description:
                  "Limite de rodadas do scheduler (kernel e a autoridade): repair-same/fresh-same/switch-model/switch-agent " +
                  "executam rounds internos enquanto round+1 <= maxRounds; alem do limite, o kernel emite awaiting-human + request-human.",
              },
            },
            required: ["runID", "objective", "acceptanceCriteria", "maxRounds"],
            additionalProperties: false,
          },
        },
        required: ["contract"],
        additionalProperties: false,
      },
      options: { namespace: "jev", codemode: true },
      execute: async (input: any) => {
        try {
          validateExecutionContract(input?.contract);
        } catch (err) {
          return { content: `orchestrate_once: contract invalido: ${err instanceof Error ? err.message : String(err)}` };
        }
        try {
          const result: OrchestrationRunResult = await runOrchestrationOnce(
            input.contract as ExecutionContract,
            makeOrchestrationDeps(ctx, opts, getKey),
          );
          return { content: JSON.stringify(result) };
        } catch (err) {
          return {
            content: `orchestrate_once falhou: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });

    editor.add({
      name: "orchestrate_resume",
      description:
        "Seam UNICO de retomada do gate humano (#12): aplica um HumanDecision bounded " +
        "(requestID do pendingHuman, action resume|stop, instruction <= 1000 chars, newMaxRounds <= 100) a um run " +
        "pausado em awaiting-human (checkpoint human-awaiting). A autoridade e SEMPRE humana: o caller e inferido " +
        "so do Tool.Context real (context.sessionID), nunca de input, e sessao interna de orchestration " +
        "(worker/critic/orchestrator) e rejeitada; input.callerRole e proibido no schema e na execucao. resume abre " +
        "exatamente uma rodada em mode human-resume com o executor canonico (sem reselecao); sem newMaxRounds o " +
        "orcamento nao muda e resume sem budget suficiente e rejeitado. stop encerra sem trabalho novo. Nunca ha " +
        "auto-resume: o run permanece pausado ate a decisao humana explicita chegar por esta tool. Chamadas " +
        "simultaneas para o mesmo runID sao serializadas com ownership process-local: o segundo caller re-le o " +
        "storage pos-winner e e rejeitado bounded, sem worker/critic novos.",
      input: {
        type: "object",
        properties: {
          runID: { type: "string", description: "Identificador do run pausado em awaiting-human" },
          decision: {
            type: "object",
            description:
              "HumanDecision bounded: requestID = pendingHuman.requestID obrigatorio; action resume|stop; " +
              "instruction (so resume, <= 1000 chars) e newMaxRounds (1..100, >= maxRounds atual) opcionais.",
            properties: {
              requestID: { type: "string", description: "requestID do pendingHuman (deterministico)" },
              action: { type: "string", enum: ["resume", "stop"], description: "resume (nova rodada) ou stop (encerra)" },
              instruction: { type: "string", maxLength: 1000, description: "Instrucao bounded da autoridade humana (so resume)" },
              newMaxRounds: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                description: "Novo limite de rodadas (so resume; nunca reduz o orcamento atual)",
              },
            },
            required: ["requestID", "action"],
            additionalProperties: false,
          },
        },
        required: ["runID", "decision"],
        additionalProperties: false,
      },
      options: { namespace: "jev", codemode: true },
      // Caller guard via Tool.Context REAL (@opencode/plugin 2.0.7): o plugin
      // injeta { sessionID, agent, messageID, id } no runtime — nao e
      // spoofavel via input. Nenhum resultado de run e fabricado sem ele.
      execute: async (input: any, context: any) => {
        try {
          // 1. Chaves estritas: callerRole (e qualquer chave desconhecida)
          //    nunca chega nem no schema (additionalProperties:false) nem aqui.
          const inputObj = input && typeof input === "object" ? input : {};
          for (const key of Object.keys(inputObj)) {
            if (key !== "runID" && key !== "decision") {
              return {
                content: `orchestrate_resume: chave desconhecida proibida: ${key} (somente runID|decision; callerRole nunca e aceito)`,
              };
            }
          }
          if (context?.callerRole !== undefined) {
            return { content: "orchestrate_resume: callerRole no Tool.Context e proibido — caller vem de context.sessionID" };
          }
          // 2. Caller humano verificavel no Tool.Context real; nada inferido.
          const callerSessionID = String(context?.sessionID ?? "");
          if (!callerSessionID) {
            return { content: "orchestrate_resume: contexto do chamador ausente — Tool.Context.sessionID obrigatorio" };
          }
          // Leitura da sessao e OBRIGATORIA: falha de leitura nunca vira
          // "humano" (fail-closed no gate de autoridade — guard minimo).
          try {
            await ctx.session.get({ sessionID: callerSessionID });
          } catch {
            return { content: "orchestrate_resume: contexto do chamador nao verificavel — falha ao ler a sessao" };
          }
          // 3. Worker/critic/orchestrator internos nunca decidem o gate humano.
          const role = await orchestrationRoleOf(ctx, callerSessionID, context ?? {});
          if (role) {
            return {
              content: `orchestrate_resume: chamada interna de orchestration (papel ${role}) — somente um humano decide resume/stop`,
            };
          }
          const runID = String(inputObj.runID ?? "");
          if (!runID) return { content: "orchestrate_resume: runID obrigatorio" };
          // 4. Serializacao por runID + RE-READ dentro do ownership (TOCTOU
          //    #5769360749): o primeiro caller consome o pendingHuman; o
          //    segundo espera, re-le o estado pos-winner e e rejeitado
          //    bounded (nunca alcanca runOrchestrationResume, zero
          //    worker/critic novos). O lock cobre toda a retomada do run e
          //    libera em finally (sucesso, rejeicao ou throw).
          return await withResumeLock(runID, async () => {
            const stored: any = await safeStorageGet(ctx, `orchestration/run/${runID}`);
            if (!stored || typeof stored !== "object" || Array.isArray(stored) || !stored.state) {
              return { content: `[invalid-resumable-run] RunState nao retomavel: run ${runID} inexistente` };
            }
            validateResumableRunState(stored.state, runID);
            const result = await runOrchestrationResume(
              {
                runID,
                state: stored.state,
                decision: inputObj.decision,
                workerSessionID: stored.workerSessionID,
                criticSessionID: stored.criticSessionID,
              },
              makeOrchestrationDeps(ctx, opts, getKey),
            );
            return { content: JSON.stringify(result) };
          });
        } catch (err) {
          if (err instanceof OrchestrationError) {
            return { content: `[${err.code}] ${err.message}` };
          }
          return { content: `orchestrate_resume falhou: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });
  });
}
