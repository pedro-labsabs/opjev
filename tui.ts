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
import { selectUnpresentedNotices } from "./src/orchestration/presentation-reconcile.ts";

/** Cap do dedupe client-side (bounded; FIFO). */
const SEEN_CAP = 64;
/** Duracao do toast (ms): suficiente para leitura e para o canario do E2E. */
const TOAST_DURATION_MS = 15000;
/**
 * Reapresentacoes do mesmo notice logo apos o primeiro show (mesmo runID, sem
 * novo fato): cobrem a janela em que a camada transitoria do toast e limpa
 * antes do flush porque a view esta animada.
 */
const TOAST_REFRESH_MAX = 4;
const TOAST_REFRESH_INTERVAL_MS = 4000;
/**
 * Janela bounded de retentativa enquanto o router do TUI ainda nao navegou para
 * a sessao do run (o evento chega em emissao unica: o resultado e duravel, o
 * evento nao e reemitido). Fecha a corrida entre a admissao do primeiro prompt
 * e a navegacao do TUI para a sessao criada.
 */
const ROUTE_RETRY_WINDOW_MS = 30_000;
const ROUTE_POLL_MS = 200;
/** Intervalo da reconciliacao duravel a partir do inbox da sessao. */
const RECONCILE_INTERVAL_MS = 1500;

/**
 * Trace DIAGNOSTICO opcional (off por padrao): append de uma linha JSON por
 * evento de apresentacao. Habilitado apenas por OPJEV_TUI_TRACE=<arquivo>.
 * Nao altera comportamento — existe para tornar a prova de apresentacao
 * auditavel quando o canario do E2E falha.
 */
const TRACE_PATH = (() => {
  try {
    return process.env?.OPJEV_TUI_TRACE;
  } catch {
    return undefined;
  }
})();
function trace(event: string, detail?: Record<string, unknown>): void {
  if (!TRACE_PATH) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    fs.appendFileSync(TRACE_PATH, `${JSON.stringify({ t: Date.now(), event, ...detail })}\n`);
  } catch {
    // trace nunca pode derrubar a apresentacao
  }
}

export default Plugin.define({
  id: "jev-free-router-presentation",
  async setup(ctx: any) {
    trace("setup", { hasClient: typeof (ctx as any)?.client?.rpc === "function" });
// Dedupe por runID (identidade real): reconexao do barramento de eventos
    // ou re-emissao do server NUNCA produzem display duplicado.
    const seen = new Set<string>();
    /** Runs com apresentacao em andamento (evita toast duplicado concorrente). */
    const inflight = new Set<string>();
    /** Sessoes cuja historia ja foi marcada como vista (evita replay no TUI). */
    const baselined = new Set<string>();
    // Cursor temporal da instalação para recuperar notices publicados antes
    // do primeiro poll, sem reapresentar notices históricos da sessão.
    const reconciliationStartedAt = Date.now();

    /**
     * Uma tentativa de render.
     *  - "shown": toast publicado (terminal).
     *  - "retry":  estado TRANSITORIO (router ainda navegando para a sessao, ou
     *    sessao ainda ausente no cache do client).
     *  - "skip":   decisao PERMANENTE (outra sessao aberta, sessao
     *    interna/subagente). Nunca re-tenta.
     */
    const renderOnce = (sessionID: string, phase: string, notice: string): "shown" | "retry" | "skip" => {
      // Filtro de papel (fail-closed): sessao corrente do TUI deve ser a
      // parent do run; sessoes internas/subagentes nunca apresentam.
      let currentSessionID: string | undefined;
      try {
        const route = ctx.ui.router.current();
        currentSessionID = route?.type === "session" ? String(route.sessionID) : undefined;
      } catch {
        return "retry"; // rota indeterminada => transitorio
      }
      if (currentSessionID !== undefined && currentSessionID !== sessionID) {
        return "skip"; // TUI em outra sessao: permanente
      }
      if (currentSessionID === undefined) {
        return "retry"; // navegacao para a sessao em curso
      }

      let info: any;
      try {
        info = ctx.data.session.get(sessionID);
      } catch {
        return "retry"; // sessao ausente no cache: transitorio
      }

      if (
        !isPresentableSession({
          currentSessionID,
          eventSessionID: sessionID,
          metadata: info?.metadata as Record<string, unknown> | undefined,
          parentID: typeof info?.parentID === "string" ? info.parentID : undefined,
        })
      ) {
        // Mesma sessao, mas papel interno/subagente: permanente.
        return "skip";
      }

      // Estado da UI no instante do render: um toast emitido com a sessao
      // ocupada nao chega ao terminal (sobrevive na API, nao no PTY).
      let status = "unknown";
      try {
        status = String(ctx.data.session.status(sessionID));
      } catch {
        status = "unknown";
      }
      trace("render", { sessionID, status, currentSessionID });

      ctx.ui.toast.show({
        title: "Orquestracao",
        message: String(notice ?? "").slice(0, 2000),
        variant: phase === "failed" ? "error" : "success",
        duration: TOAST_DURATION_MS,
      });
      return "shown";
    };

    /**
     * Refresca o MESMO notice algumas vezes logo apos o primeiro show.
     *
     * O toast e uma camada transitoria: enquanto a view da sessao esta animada
     * (spinner de execucao), o renderer pode limpar a camada antes do flush e o
     * toast nunca chega ao terminal — a chamada a API "tem sucesso" e nada e
     * pintado. Reapresentar o mesmo notice (mesmo runID, mesmo texto, sem novo
     * fato) cobre essa janela. Bounded por TOAST_REFRESH_MAX.
     */
    const refreshToast = (sessionID: string, phase: string, notice: string): void => {
      for (let i = 1; i <= TOAST_REFRESH_MAX; i++) {
        const t = setTimeout(() => {
          try {
            const route = ctx.ui.router.current();
            if (route?.type !== "session" || String(route.sessionID) !== sessionID) return;
            ctx.ui.toast.show({
              title: "Orquestracao",
              message: String(notice ?? "").slice(0, 2000),
              variant: phase === "failed" ? "error" : "success",
              duration: TOAST_DURATION_MS,
            });
            trace("toast-refreshed", { sessionID, attempt: i });
          } catch {
            // refresh best-effort: nunca propaga
          }
        }, TOAST_REFRESH_INTERVAL_MS * i);
        (t as unknown as { unref?: () => void }).unref?.();
      }
    };

    const markSeen = (runID: string): void => {
      if (seen.size >= SEEN_CAP) {
        const first = seen.values().next().value;
        if (typeof first === "string") seen.delete(first); // cap FIFO bounded
      }
      seen.add(runID);
    };

    /**
     * Apresenta um resultado. O evento RPC e unico (nao e reemitido), entao um
     * estado TRANSITORIO e re-tentado numa janela bounded; apos isso o run ainda
     * e reconciliado pelo loop duravel (abaixo).
     */
    const present = async (
      runID: string,
      sessionID: string,
      phase: string,
      notice: string,
      source: "event" | "reconcile",
    ): Promise<boolean> => {
      if (runID === "" || sessionID === "") return false;
      if (seen.has(runID)) return false;
      if (inflight.has(runID)) return false;
      inflight.add(runID);
      try {
        const deadline = Date.now() + ROUTE_RETRY_WINDOW_MS;
        let outcome = renderOnce(sessionID, phase, notice);
        while (outcome === "retry" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, ROUTE_POLL_MS));
          outcome = renderOnce(sessionID, phase, notice);
        }
        if (outcome !== "shown") {
          trace("not-shown", { runID, outcome, source });
          return false;
        }
        trace("shown", { runID, sessionID, source });
        markSeen(runID);
        refreshToast(sessionID, phase, notice);
        return true;
      } catch {
        return false; // falha de apresentacao isolada: nunca propaga
      } finally {
        inflight.delete(runID);
      }
    };

    let unsubscribe: (() => void) | undefined;
    try {
      const client = (ctx.client as any).rpc(OrchestrationResultRpc);
      unsubscribe = client.events.on(
        ORCHESTRATION_RESULT_EVENT,
        (event: { data?: OrchestrationResultEvent }) => {
          void (async () => {
            try {
              const data = event?.data;
              if (!data || typeof data !== "object") return;
              const runID = String(data.runID ?? "");
              const sessionID = String(data.sessionID ?? "");
              trace("event", { runID, sessionID, phase: String(data.phase ?? "") });
              await present(runID, sessionID, String(data.phase ?? ""), String(data.notice ?? ""), "event");
            } catch {
              // falha de apresentacao isolada: nunca propaga
            }
          })();
        },
      );
      trace("subscribed", { event: ORCHESTRATION_RESULT_EVENT, unsubscribeType: typeof unsubscribe });
    } catch (err) {
      trace("subscribe-failed", { error: String((err as Error)?.message ?? err).slice(0, 300) });
      // Barramento/SDK indisponivel nesta superficie: apresentacao fica
      // desligada (degradacao bounded). O resultado continua duravel no
      // inbox (synthetic resume:false) e no record/binding do opjev.
    }

    // ─────────────── reconciliacao DURAVEL ───────────────
    // O evento RPC acima e fire-and-forget e pode se perder (reconexao do
    // barramento entre a assinatura e a emissao). O resultado do run, NAO, e
    // duravel: o notice vive no inbox da sessao (synthetic resume:false). Este
    // loop reconcilia a apresentacao a partir desse estado duravel, com
    // baseline por sessao para nunca reapresentar historico.
    const timer = setInterval(() => {
      void (async () => {
        try {
          const route = ctx.ui.router.current();
          if (route?.type !== "session") return;
          const sessionID = String(route.sessionID);
          const items: unknown[] = ctx.data.session.pending.list(sessionID) ?? [];
          const isBaseline = !baselined.has(sessionID);
          const toPresent = selectUnpresentedNotices({ sessionID, items, seen, baseline: baselined, startedAt: reconciliationStartedAt });
          if (isBaseline) {
            trace("baseline", { sessionID, marked: toPresent.length, recoveredFresh: toPresent.length });
          }
          for (const f of toPresent) {
            await present(f.runID, sessionID, f.phase, f.notice, "reconcile");
          }
          // Trace so quando o reconciliador REALMENTE recupera algo (evidencia
          // que importa); polls sem novelty ficam fora do arquivo.
          if (toPresent.length > 0) {
            trace("reconcile-recovered", { sessionID, recovered: toPresent.length });
          }
        } catch (err) {
          trace("reconcile-error", { error: String((err as Error)?.message ?? err).slice(0, 200) });
        }
      })();
    }, RECONCILE_INTERVAL_MS);
    // Nao segura o processo do TUI aberto.
    (timer as unknown as { unref?: () => void }).unref?.();

    return () => {
      try {
        unsubscribe?.();
      } catch {
        // cleanup best-effort
      }
      try {
        clearInterval(timer);
      } catch {
        // cleanup best-effort
      }
    };
  },
});
