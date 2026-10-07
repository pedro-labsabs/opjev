import { Plugin } from "@opencode/plugin";
import { registerSessionHooks, registerToolAuthorityHook } from "./src/hooks.ts";
import { makeOrchestrationDeps, tracePresentation } from "./src/plugin-runtime.ts";
import { registerTools } from "./src/tools.ts";
import { resolveApiKey } from "./src/auth.ts";
import { resolveOptions } from "./src/config.ts";
import { AdmissionRpc, createAdmissionOrchestrateHandler } from "./src/orchestration/admission-rpc.ts";
import { ExecutionSummaryRpc, createExecutionSummaryHandler } from "./src/orchestration/execution-summary-rpc.ts";
import { runOrchestrationOnce } from "./src/orchestration/dispatcher.ts";
import { type ExecutionContract } from "./src/orchestration/types.ts";
import { OrchestrationResultRpc, ORCHESTRATION_RESULT_EVENT } from "./src/orchestration/presentation.ts";
import { buildDecisionRecord, sanitizeState } from "./src/sanitize.ts";
import { isInternalCriticSession, isInternalOrchestratorSession, isInternalWorkerSession } from "./src/worker-hooks.ts";
import { registerContextManagementHooks } from "./src/context-management/runtime-hooks.ts";

export default Plugin.define({
  id: "jev-free-router",
  async setup(ctx: any) {
    const opts = resolveOptions(ctx.options ?? {});
    // Resolve por chamada (nao so no setup) para captar `export` ou
    // `/connect` feitos apos o load. resolveApiKey le a env primeiro.
    const getKey = () => resolveApiKey(ctx, opts.apiKeyEnv);

    await registerToolAuthorityHook(ctx);

    // Emissor do evento de apresentacao (presentation boundary, PR #27):
    // registro somete-eventos no mesmo seam RPC publico; `null` quando a
    // superficie nao expoe rpc.register (ex.: lado TUI).
    let presentationEmit: { emit(name: string, data: unknown): Promise<void> } | null = null;

    // Seam RPC PUBLICO bounded (#24): o gateway de admission deterministico
    // persiste o prompt (resume:false) e dispara runOrchestrationOnce EXATAMENTE
    // uma vez por identidade de turno, por aqui — sem parent/model trampoline.
    // Server-side apenas; ctx sem rpc.register (ex.: lado TUI) = no-op.
    if (ctx?.rpc && typeof ctx.rpc.register === "function") {
      try {
        try {
          const presentationReg = await ctx.rpc.register(OrchestrationResultRpc, {} as any);
          if (
            presentationReg &&
            presentationReg.events &&
            typeof (presentationReg.events as any).emit === "function"
          ) {
            presentationEmit = presentationReg.events as any;
          }
          tracePresentation("server-presentation-registered", { ok: true });
        } catch (err) {
          tracePresentation("server-presentation-registration-failed", {
            error: String((err as Error)?.message ?? err).slice(0, 300),
          });
          // Superficie sem suporte a RPC so-eventos: apresentacao fica
          // indisponivel (degradacao bounded); admission segue integralmente.
        }
        await ctx.rpc.register(AdmissionRpc, {
          orchestrate: createAdmissionOrchestrateHandler({
            storage: {
              get: async (key: string) => {
                return await ctx.storage.get(key);
              },
              set: async (key: string, value: unknown) => {
                await ctx.storage.set(key, value);
              },
            },
            runner: (contract: ExecutionContract) =>
              runOrchestrationOnce(contract, makeOrchestrationDeps(ctx, opts, getKey)),
            publish: async (sessionID: string, text: string) => {
              // resultado voltando a experiencia OpenCode SEM wake do parent:
              // synthetic duravel (resume:false), API publica suportada.
              await ctx.session.synthetic({ sessionID, text, resume: false });
            },
            // Guarda de papel autoritativa (#24/I1): sessoes internas nunca
            // iniciam orchestration aninhada (o gateway filtra fail-closed
            // antes; aqui e in-process). Leitura indisponivel => PROPAGA
            // (o handler recusa fail-closed; erro de lookup nunca vira
            // `internal=false`).
            isInternalSession: async (sessionID: string) => {
              const info: any = await ctx.session.get({ sessionID });
              const metadata = info?.metadata;
              return (
                isInternalWorkerSession(metadata) ||
                isInternalCriticSession(metadata) ||
                isInternalOrchestratorSession(metadata)
              );
            },
            // Presentation boundary (PR #27): transporta o notice bounded do
            // run concluido por evento RPC publico. SEM autoridade: o emit
            // e fire-and-forget; falha nunca altera record/binding/publicacao.
            notify: (event) => {
              if (!presentationEmit) {
                tracePresentation("server-emit-skipped", { runID: event?.runID, reason: "sem emit" });
                return;
              }
              void presentationEmit
                .emit(ORCHESTRATION_RESULT_EVENT, event)
                .then(() => tracePresentation("server-emit-ok", { runID: event?.runID }))
                .catch((err) => {
                  tracePresentation("server-emit-failed", {
                    runID: event?.runID,
                    error: String((err as Error)?.message ?? err).slice(0, 300),
                  });
                  // TUI indisponivel: degradacao bounded (estado authoritative preservado)
                });
            },
          }),
        });
        try {
          await ctx.rpc.register(ExecutionSummaryRpc, {
            getActiveSummary: createExecutionSummaryHandler({
              storage: {
                get: async (key: string) => await ctx.storage.get(key),
              },
            }),
          });
        } catch (err) {
          const msg = String(err instanceof Error ? err.message : err).split("\n")[0] ?? "erro";
          console.error(`[opjev] rpc de execution summary indisponivel nesta superficie: ${msg.slice(0, 200)}`);
        }
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err).split("\n")[0] ?? "erro";
        console.error(`[opjev] rpc de admission indisponivel nesta superficie: ${msg.slice(0, 200)}`);
      }
    }

    // Surface TUI (sem ctx.tool): o entrypoint server aqui nada faz — a
    // apresentacao vive no entrypoint `tui` (tui.ts). Guarda evita TypeError
    // quando o host cli carrega este arquivo por resolucao de package.
    if (!ctx?.tool || typeof ctx.tool.transform !== "function") return;

    await registerTools(ctx, opts, getKey);

    await registerSessionHooks(ctx, opts, getKey);
    await registerContextManagementHooks(ctx, opts);
  },
});
export { sanitizeState, buildDecisionRecord } from "./src/sanitize.ts";
export { errorClassOf, isTrivialFollowUp, isContextOverflow, isGlobalThrottle, freeCandidates, validAgents } from "./src/plugin-runtime.ts";
