// Presentation boundary — lado TUI (PR #27). Carregado pelo host do OpenCode
// como entrypoint `tui` do plugin (superficie publica `@opencode/plugin/tui`).
//
// O que este modulo FAZ (somente apresentacao):
//   - assina o evento publico `rpc.opjev.presentation.v1/orchestration-result`
//     (emitido pelo lado server do plugin quando um run conclui);
//   - filtra papel com isPresentableSession (sessao corrente do TUI, nunca
//     sessao interna worker/critic/orchestrator, nunca subagente nativo);
//   - dedupe client-side por runID (reconexoes/reloads nunca duplicam display);
//   - renderiza via `ctx.ui.toast.show` (superficie publica; visibilidade
//     real no TUI comprovada em runtime v2.0.11 — probe da PR #27).
//
// O que este modulo NUNCA faz (sem autoridade):
//   - nao chama session.prompt/synthetic/inbox (nenhum wake do parent);
//   - nao decide accept/recovery/phase/round/model;
//   - nao auto-resume awaiting-human;
//   - nao escreve storage authoritative;
//   - nao transforma notificacao em execucao.
//
// Toda falha e bounded: try/catch em cada bloco; apresentacao indisponivel
// nunca afeta o run (que continua authoritative no lado server/opjev).

import { Plugin } from "@opencode/plugin/tui";
import {
  OrchestrationResultRpc,
  ORCHESTRATION_RESULT_EVENT,
  isPresentableSession,
  type OrchestrationResultEvent,
} from "./src/orchestration/presentation.ts";

/** Cap do dedupe client-side (bounded; FIFO). */
const SEEN_CAP = 64;
/** Duracao do toast (ms): suficiente para leitura e para o canario do E2E. */
const TOAST_DURATION_MS = 15000;

export default Plugin.define({
  id: "jev-free-router-presentation",
  async setup(ctx: any) {
    // Dedupe por runID (identidade real): reconexao do barramento de eventos
    // ou re-emissao do server NUNCA produzem display duplicado.
    const seen = new Set<string>();

    let unsubscribe: (() => void) | undefined;
    try {
      const client = (ctx.client as any).rpc(OrchestrationResultRpc);
      unsubscribe = client.events.on(
        ORCHESTRATION_RESULT_EVENT,
        (event: { data?: OrchestrationResultEvent }) => {
          try {
            const data = event?.data;
            if (!data || typeof data !== "object") return;
            const runID = String(data.runID ?? "");
            const sessionID = String(data.sessionID ?? "");
            if (runID === "" || sessionID === "") return;
            if (seen.has(runID)) return; // duplicata: display unico
            // Filtro de papel (fail-closed): sessao corrente do TUI deve ser a
            // parent do run; sessoes internas/subagentes nunca apresentam.
            let currentSessionID: string | undefined;
            try {
              const route = ctx.ui.router.current();
              currentSessionID = route?.type === "session" ? String(route.sessionID) : undefined;
            } catch {
              return; // rota indeterminada => sem apresentacao
            }

            let info: any;
            try {
              info = ctx.data.session.get(sessionID);
            } catch {
              return; // lookup de sessao falhou => fail-closed: sem apresentacao
            }

            const presentable = isPresentableSession({
              currentSessionID,
              eventSessionID: sessionID,
              metadata: info?.metadata as Record<string, unknown> | undefined,
              parentID: typeof info?.parentID === "string" ? info.parentID : undefined,
            });
            if (!presentable) return;

            ctx.ui.toast.show({
              title: "Orquestracao",
              message: String(data.notice ?? "").slice(0, 2000),
              variant: data.phase === "failed" ? "error" : "success",
              duration: TOAST_DURATION_MS,
            });

            if (seen.size >= SEEN_CAP) {
              const first = seen.values().next().value;
              if (typeof first === "string") seen.delete(first);
            }
            seen.add(runID);
          } catch {
            // falha de apresentacao isolada: nunca propaga
          }
        },
      );
    } catch {
      // Barramento/SDK indisponivel nesta superficie: apresentacao fica
      // desligada (degradacao bounded). O resultado continua duravel no
      // inbox (synthetic resume:false) e no record/binding do opjev.
    }

    return () => {
      try {
        unsubscribe?.();
      } catch {
        // cleanup best-effort
      }
    };
  },
});
