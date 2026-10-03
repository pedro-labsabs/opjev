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
//   - baseline POR SESSAO, uma unica vez: o que ja existia quando o TUI abriu a
//     sessao e historico e nao e reapresentado;
//   - exatamente uma apresentacao por runID (dedupe compartilhado com o
//     caminho do evento) — reconciliar nunca duplica o que o evento ja mostra.
//
// Puro e deterministico: nenhuma referencia a SDK, I/O, timer ou relogio.

/**
 * Identidade do run + fase extraidas do notice duravel. Estrito por design: o
 * reconciliador so reconhece o formato emitido por buildAdmissionRunNotice
 * (`Orquestracao <runID>: fase <phase>, ...`) — nunca texto livre.
 */
export const ORCHESTRATION_NOTICE_RE = /Orquestracao\s+([^\s:]+):\s+fase\s+([a-z-]+)/i;

export interface DurableNotice {
  runID: string;
  phase: string;
  notice: string;
}

/** Textos extraidos de um item de inbox de sessao (aceita `text` ou JSON). */
export function extractNoticeText(item: unknown): string {
  if (item !== null && typeof item === "object") {
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  if (typeof item === "string") return item;
  try {
    return JSON.stringify(item ?? "");
  } catch {
    return "";
  }
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
    out.push({ runID, phase, notice: text });
  }
  return out;
}

/**
 * Decide o que apresentar a partir do inbox.
 *
 * `baseline` e mutado: na primeira observacao de uma sessao, TODOS os notices
 * ja presentes sao marcados como vistos (historico) e nada e apresentado. Nas
 * observacoes seguintes, apenas notices cujo runID ainda nao foi visto sao
 * devolvidos — do mais novo para o mais antigo (bounded pelo proprio inbox).
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
}): DurableNotice[] {
  const { sessionID, items, seen, baseline } = input;
  const found = collectNotices(items);
  if (!baseline.has(sessionID)) {
    baseline.add(sessionID);
    for (const f of found) seen.add(f.runID);
    return []; // primeira observacao: historico, nada a apresentar
  }
  const out: DurableNotice[] = [];
  for (let i = found.length - 1; i >= 0; i--) {
    const f = found[i]!;
    if (seen.has(f.runID)) continue;
    out.push(f);
  }
  return out;
}