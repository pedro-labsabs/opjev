// Reconciliacao DURAVEL da apresentacao (lado TUI).
//
// O evento publico `orchestration-result` e fire-and-forget: ele NAO e
// reemitido, e pode se perder se o barramento reconectar entre a assinatura e a
// emissao. O RESULTADO do run, ao contrario, e duravel — o notice vive no inbox
// da sessao (synthetic resume:false). Este modulo reconcilia a apresentacao a
// partir desse estado duravel.
//
// Invariantes (presentation = sem poder, igual ao resto da fronteira):
//   - decide nada: nao aceita/recovery/phase/round/model; nao executa nada;
//   - le SOMENTE o inbox da sessao corrente (nunca de outra sessao);
//   - baseline POR SESSAO: notices anteriores ao inicio do reconciliador sao
//     historico; notices posteriores continuam recuperaveis no primeiro poll;
//   - exatamente uma apresentacao por runID (dedupe compartilhado com o
//     caminho do evento) — reconciliar nunca duplica o que o evento ja mostra.
//
// Puro e deterministico: nenhuma referencia a SDK, I/O, timer ou relogio.

/**
 * Identidade do run + fase extraidas do notice duravel. Estrito por design: o
 * reconciliador so reconhece o formato emitido por buildAdmissionRunNotice
 * (`Orquestracao <runID>: fase <phase>, ...`) — nunca texto livre.
 */
export const ORCHESTRATION_NOTICE_RE = /^Orquestracao\s+([^\s:]+):\s+fase\s+([a-z-]+),\s+rodada\s+\S+(?:,\s+worker\s+[^.]*)?(?:\.\s+Erro:\s+.*)?(?:\.\s+follow-ups consumidos:\s+\d+,\s+nao consumidos:\s+\d+)?$/i;

export interface DurableNotice {
  runID: string;
  phase: string;
  notice: string;
  createdAt: number;
}

/** Texto apenas do payload sintético authoritative do inbox do OpenCode. */
export function extractNoticeText(item: unknown): string {
  if (item === null || typeof item !== "object") return "";
  const entry = item as { type?: unknown; payload?: { text?: unknown } };
  if (entry.type !== "synthetic" || entry.payload === null || typeof entry.payload !== "object") return "";
  return typeof entry.payload.text === "string" ? entry.payload.text : "";
}

/** Notices de orquestracao presentes no inbox, em ordem de chegada. */
export function collectNotices(items: readonly unknown[]): DurableNotice[] {
  const out: DurableNotice[] = [];
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    const text = extractNoticeText(item);
    if (text === "") continue;
    const m = ORCHESTRATION_NOTICE_RE.exec(text);
    if (m === null) continue;
    const runID = m[1] ?? "";
    const phase = m[2] ?? "";
    if (runID === "" || phase === "") continue;
    const time = (item as { time?: { created?: unknown } }).time;
    const createdAt = time && typeof time.created === "number" && Number.isFinite(time.created) ? time.created : undefined;
    if (createdAt === undefined) continue;
    out.push({ runID, phase, notice: text, createdAt });
  }
  return out;
}

/**
 * Decide o que apresentar a partir do inbox.
 *
 * `baseline` e mutado: na primeira observacao, notices anteriores a `startedAt`
 * sao historico; os posteriores podem ser recuperados mesmo que ja estejam no
 * inbox. Nas observacoes seguintes, notices ainda nao vistos sao devolvidos,
 * do mais novo para o mais antigo (bounded pelo proprio inbox).
 *
 * Fail-closed: nao conhece o texto, nao filtra por papel (isso e do TUI via
 * isPresentableSession) e nao inventa resultado — um item sem o formato exato
 * simplesmente nao existe para o reconciliador.
 */
export function selectUnpresentedNotices(input: {
  sessionID: string;
  items: readonly unknown[];
  seen: Set<string>;
  baseline: Set<string>;
  startedAt: number;
}): DurableNotice[] {
  const { sessionID, items, seen, baseline, startedAt } = input;
  const found = collectNotices(items);
  if (!baseline.has(sessionID)) {
    baseline.add(sessionID);
    const fresh: DurableNotice[] = [];
    for (const f of found) {
      if (seen.has(f.runID)) continue; // o caminho RPC ja apresentou
      if (f.createdAt >= startedAt) fresh.push(f);
      else seen.add(f.runID); // histórico ou timestamp inválido: fail-closed
    }
    return fresh.reverse();
  }
  const out: DurableNotice[] = [];
  for (let i = found.length - 1; i >= 0; i--) {
    const f = found[i]!;
    if (seen.has(f.runID)) continue;
    out.push(f);
  }
  return out;
}
