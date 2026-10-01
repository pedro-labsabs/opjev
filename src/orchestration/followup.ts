// Pending-input bounded de follow-up (#13) — sessao S -> run R ativo ->
// novo follow-up F -> F continua R (zero segundo run), consumo explicito,
// bounded e observavel em um boundary JA governado (montagem do prompt da
// rodada, ownership do dispatcher/kernel).
//
// Puro e deterministico: NENHUM import de ctx/sessao/rede/hooks. Storage e
// injetado ({ get, set }); o lock e o keyed lock process-local existente
// (src/lock.ts) — o mesmo padrao de admission/dispatch. Nenhuma nova
// autoridade publica do kernel: este modulo e ESTADO DE ADMISSION (a mesma
// camada de sessionBindingKey/admissionRecordKey), consumido pelo control
// plane; nunca evento/comando do kernel nem transicao normativa.
//
// Bounded por construcao: texto truncado, index capped por run, consumo
// capped por rodada. Nada de conversa completa, chain-of-thought ou payloads
// arbitrarios — apenas a identidade do turno e o texto do prompt admitido.

import { withKeyedLock } from "../lock.ts";
import { OrchestrationError, type InputFrontier } from "./types.ts";

export const FOLLOWUP_LIMITS = {
  /** Texto armazenado por follow-up (mesma cota do objective do kernel). */
  text: 2000,
  /** Follow-ups por run (cap de armazenamento; attach acima do cap e recusado bounded). */
  perRun: 10,
  /** Follow-ups consumidos por boundary de rodada (crescimento de prompt bounded). */
  perRound: 5,
  messageID: 200,
  sessionID: 200,
  runID: 200,
} as const;

const STATES = ["pending", "reserved", "consumed", "unconsumed"] as const;

export type FollowupState = (typeof STATES)[number];

export interface FollowupRecord {
  /** Qual messageID originou o follow-up (identidade de turno real). */
  messageID: string;
  /** Qual sessao recebeu o input. */
  sessionID: string;
  /** Qual run o possui (o run ATIVO no momento do attach). */
  runID: string;
  /** Texto admitido, truncado ao limite (input preservado, bounded). */
  text: string;
  /** pending | reserved (preparado/reservado para entrega) | consumed | unconsumed */
  state: FollowupState;
  at: number;
  reservedAt?: number;
  reservedRound?: number;
  consumedAt?: number;
  /** Boundary control-plane onde foi consumido (ex.: `round-2-worker-prompt`). */
  consumedBoundary?: string;
  consumedRound?: number;
}

// ───────────────────────── chaves de persistencia ─────────────────────────

/** Record individual por (run, messageID) — provenance e estado de consumo. */
export function followupKey(runID: string, messageID: string): string {
  return `orchestration/followup/${slug(runID)}/${slug(messageID)}`;
}

/** Index de attach por run (ordem de chegada, capped) — evita scan no storage. */
export function followupIndexKey(runID: string): string {
  return `orchestration/followup-index/${slug(runID)}`;
}

/** Chave da revisao de input frontier por run — incrementada deterministicamente no attach. */
export function followupRevisionKey(runID: string): string {
  return `orchestration/followup-rev/${slug(runID)}`;
}

function slug(v: unknown): string {
  return String(v ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, FOLLOWUP_LIMITS.runID);
}

// ───────────────────────── construcao/validacao (fail-closed) ─────────────────────────

/**
 * Record bounded de follow-up. Identidade incompleta => OrchestrationError
 * (nunca record solto sem provenance). Texto e truncado deterministicamente.
 */
export function buildFollowupRecord(input: {
  sessionID: string;
  messageID: string;
  runID: string;
  text: string;
  at: number;
}): FollowupRecord {
  const sessionID = requireBounded(input?.sessionID, FOLLOWUP_LIMITS.sessionID, "sessionID");
  const messageID = requireBounded(input?.messageID, FOLLOWUP_LIMITS.messageID, "messageID");
  const runID = requireBounded(input?.runID, FOLLOWUP_LIMITS.runID, "runID");
  if (typeof input?.text !== "string" || input.text.trim().length === 0) {
    throw new OrchestrationError("invalid-followup", "followup: text deve ser string nao-vazia");
  }
  if (typeof input?.at !== "number" || !Number.isFinite(input.at)) {
    throw new OrchestrationError("invalid-followup", "followup: at deve ser numero");
  }
  return {
    messageID,
    sessionID,
    runID,
    text: truncateText(input.text, FOLLOWUP_LIMITS.text),
    state: "pending",
    at: input.at,
  };
}

/**
 * Validacao fail-closed do record lido do storage: forma/estado desconhecidos
 * => OrchestrationError (nunca coercao silenciosa). Consumidores tratam erro
 * como registro ilegivel (skip bounded) — nunca como pendente.
 */
export function normalizeFollowupRecord(raw: unknown): FollowupRecord {
  // Estilo do codebase: annotation na VARIAVEL (necessaria para o narrowing
  // control-flow do TS tratar fail() como never-returning nos guards abaixo).
  const fail: (m: string) => never = (m) => {
    throw new OrchestrationError("invalid-followup", `followup record invalido: ${m}`);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("deve ser objeto");
  const r = raw as Record<string, unknown>;
  const messageID = requireBounded(r.messageID, FOLLOWUP_LIMITS.messageID, "messageID");
  const sessionID = requireBounded(r.sessionID, FOLLOWUP_LIMITS.sessionID, "sessionID");
  const runID = requireBounded(r.runID, FOLLOWUP_LIMITS.runID, "runID");
  if (typeof r.text !== "string" || r.text.length === 0) fail("text ausente");
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) fail("at invalido");
  if (typeof r.state !== "string" || !(STATES as readonly string[]).includes(r.state)) {
    fail(`state desconhecido: ${String(r.state)}`);
  }
  const base: FollowupRecord = {
    messageID,
    sessionID,
    runID,
    text: truncateText(r.text, FOLLOWUP_LIMITS.text),
    state: r.state as FollowupState,
    at: r.at,
  };
  if (base.state === "reserved") {
    const reservedAt = typeof r.reservedAt === "number" && Number.isFinite(r.reservedAt) ? r.reservedAt : undefined;
    const reservedRound =
      typeof r.reservedRound === "number" && Number.isInteger(r.reservedRound) ? r.reservedRound : undefined;
    return {
      ...base,
      ...(reservedAt !== undefined ? { reservedAt } : {}),
      ...(reservedRound !== undefined ? { reservedRound } : {}),
    };
  }
  if (base.state !== "pending") {
    if (typeof r.consumedAt !== "number" || !Number.isFinite(r.consumedAt)) fail("consumedAt obrigatorio fora de pending");
    if (typeof r.consumedBoundary !== "string" || r.consumedBoundary.length === 0) {
      fail("consumedBoundary obrigatorio fora de pending");
    }
    const consumedAt: number = r.consumedAt;
    const consumedBoundary: string = r.consumedBoundary;
    const consumedRound =
      typeof r.consumedRound === "number" && Number.isInteger(r.consumedRound) ? r.consumedRound : undefined;
    return {
      ...base,
      consumedAt,
      consumedBoundary: truncateText(consumedBoundary, 120),
      ...(consumedRound !== undefined ? { consumedRound } : {}),
    };
  }
  return base;
}

/** Index bounded: array de messageIDs (strings) em ordem de attach, <= perRun. */
export function readFollowupIndex(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new OrchestrationError("invalid-followup", "followup index deve ser array");
  if (raw.length > FOLLOWUP_LIMITS.perRun) {
    throw new OrchestrationError("invalid-followup", `followup index excede ${FOLLOWUP_LIMITS.perRun} itens`);
  }
  return raw.map((m) => {
    if (typeof m !== "string" || m.trim().length === 0) {
      throw new OrchestrationError("invalid-followup", "followup index so aceita strings nao-vazias");
    }
    return m;
  });
}

function requireBounded(v: unknown, max: number, label: string): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new OrchestrationError("invalid-followup", `followup: ${label} deve ser string nao-vazia`);
  }
  return v.trim().slice(0, max);
}

function truncateText(t: string, max: number): string {
  if (t.length <= max) return t;
  const marker = "…[truncado]";
  return `${t.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

// ───────────────────────── consumo exactly-once (boundary da rodada) ─────────────────────────

export interface PendingFollowup {
  messageID: string;
  text: string;
}

export interface FollowupStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/**
 * Seam de consumo usado pelo dispatcher no boundary de cada rodada: consome
 * (marca consumed com round/boundary) e retorna os pendentes, em ordem de
 * attach, capped por FOLLOWUP_LIMITS.perRound. Serializado por run via keyed
 * lock => takes concorrentes nunca duplicam consumo (exactly-once).
 * Registros ausentes/ilegiveis sao ignorados (bounded); pendentes continuam
 * pendentes se o take falhar no meio (nunca consumido sem retorno).
 */
/**
 * Snapshot bounded do input frontier de follow-ups pendentes do run.
 * Capturado no control plane apos evidencias e antes do julgamento do Jev.
 */
export async function getInputFrontier(
  deps: { storage: FollowupStorage },
  runID: string,
): Promise<InputFrontier> {
  const safeRunID = requireBounded(runID, FOLLOWUP_LIMITS.runID, "runID");
  return await withKeyedLock(`followup-take/${safeRunID}`, async () => {
    let index: string[] = [];
    try {
      index = readFollowupIndex(await deps.storage.get(followupIndexKey(safeRunID)));
    } catch {
      return { revision: 0, pendingCount: 0, pendingFollowups: [] };
    }
    const rawRev = await deps.storage.get(followupRevisionKey(safeRunID));
    const revision = typeof rawRev === "number" && Number.isFinite(rawRev) ? rawRev : index.length;
    const pendingFollowups: Array<{ messageID: string; text: string }> = [];
    for (const messageID of index) {
      const raw = await deps.storage.get(followupKey(safeRunID, messageID));
      if (raw === undefined) continue;
      let rec: FollowupRecord;
      try {
        rec = normalizeFollowupRecord(raw);
      } catch {
        continue;
      }
      if (rec.state === "pending" || rec.state === "reserved") {
        pendingFollowups.push({
          messageID: rec.messageID,
          text: rec.text,
        });
      }
    }
    return {
      revision,
      pendingCount: pendingFollowups.length,
      pendingFollowups: pendingFollowups.slice(0, FOLLOWUP_LIMITS.perRound),
    };
  });
}

export interface FollowupTakeSeam {
  (runID: string, round: number): Promise<PendingFollowup[]>;
  reserve(runID: string, round: number): Promise<PendingFollowup[]>;
  confirm(runID: string, items: PendingFollowup[], round: number): Promise<void>;
  getFrontier(runID: string): Promise<InputFrontier>;
}

/**
 * Seam de consumo usado pelo dispatcher no boundary de cada rodada: suporta
 * protocolo duravel em duas fases (pending -> reserved -> entrega real -> consumed)
 * e tambem consumo atomico callable (exactly-once). Serializado por run via keyed
 * lock. Registros ausentes/ilegiveis sao ignorados (bounded).
 */
export function createFollowupTakeSeam(deps: {
  storage: FollowupStorage;
  now?(): number;
  /** Cap de itens por take (default FOLLOWUP_LIMITS.perRound; injetavel para testes). */
  perRound?: number;
}): FollowupTakeSeam {
  const now = deps.now ?? Date.now;
  const cap = Math.max(1, Math.trunc(Number(deps.perRound ?? FOLLOWUP_LIMITS.perRound)));

  const reserve = async (runID: string, round: number): Promise<PendingFollowup[]> => {
    const safeRunID = requireBounded(runID, FOLLOWUP_LIMITS.runID, "runID");
    if (typeof round !== "number" || !Number.isInteger(round) || round < 1) {
      throw new OrchestrationError("invalid-followup", `round invalido para take: ${String(round)}`);
    }
    return await withKeyedLock(`followup-take/${safeRunID}`, async () => {
      const index = readFollowupIndex(await deps.storage.get(followupIndexKey(safeRunID)));
      const targets: Array<{ messageID: string; record: FollowupRecord }> = [];
      for (const messageID of index) {
        if (targets.length >= cap) break;
        const raw = await deps.storage.get(followupKey(safeRunID, messageID));
        if (raw === undefined) continue;
        let rec: FollowupRecord;
        try {
          rec = normalizeFollowupRecord(raw);
        } catch {
          continue;
        }
        if (rec.state !== "pending") continue;
        targets.push({ messageID, record: rec });
      }

      const out: PendingFollowup[] = [];
      const updatedKeys: string[] = [];
      const reservedAt = now();
      try {
        for (const t of targets) {
          const key = followupKey(safeRunID, t.messageID);
          await deps.storage.set(key, {
            ...t.record,
            state: "reserved",
            reservedAt,
            reservedRound: round,
          });
          updatedKeys.push(key);
          out.push({ messageID: t.record.messageID, text: t.record.text });
        }
      } catch (err) {
        for (let i = 0; i < updatedKeys.length; i++) {
          try {
            await deps.storage.set(updatedKeys[i], targets[i].record);
          } catch {}
        }
        throw err;
      }
      return out;
    });
  };

  const confirm = async (runID: string, items: PendingFollowup[], round: number): Promise<void> => {
    if (!Array.isArray(items) || items.length === 0) return;
    const safeRunID = requireBounded(runID, FOLLOWUP_LIMITS.runID, "runID");
    await withKeyedLock(`followup-take/${safeRunID}`, async () => {
      const consumedAt = now();
      const consumedBoundary = `round-${round}-worker-prompt`;
      for (const it of items) {
        if (!it?.messageID) continue;
        const raw = await deps.storage.get(followupKey(safeRunID, it.messageID));
        if (raw === undefined) continue;
        try {
          const rec = normalizeFollowupRecord(raw);
          if (rec.state === "reserved" || rec.state === "pending") {
            await deps.storage.set(followupKey(safeRunID, it.messageID), {
              ...rec,
              state: "consumed",
              consumedAt,
              consumedBoundary,
              consumedRound: round,
            });
          }
        } catch {}
      }
    });
  };

  const getFrontier = async (runID: string): Promise<InputFrontier> => {
    return await getInputFrontier(deps, runID);
  };

  const take = async (runID: string, round: number): Promise<PendingFollowup[]> => {
    const safeRunID = requireBounded(runID, FOLLOWUP_LIMITS.runID, "runID");
    if (typeof round !== "number" || !Number.isInteger(round) || round < 1) {
      throw new OrchestrationError("invalid-followup", `round invalido para take: ${String(round)}`);
    }
    return await withKeyedLock(`followup-take/${safeRunID}`, async () => {
      const index = readFollowupIndex(await deps.storage.get(followupIndexKey(safeRunID)));
      const targets: Array<{ messageID: string; record: FollowupRecord }> = [];
      for (const messageID of index) {
        if (targets.length >= cap) break;
        const raw = await deps.storage.get(followupKey(safeRunID, messageID));
        if (raw === undefined) continue;
        let rec: FollowupRecord;
        try {
          rec = normalizeFollowupRecord(raw);
        } catch {
          continue;
        }
        if (rec.state !== "pending") continue;
        targets.push({ messageID, record: rec });
      }

      const out: PendingFollowup[] = [];
      const updatedKeys: string[] = [];
      const consumedAt = now();
      const consumedBoundary = `round-${round}-worker-prompt`;
      try {
        for (const t of targets) {
          const key = followupKey(safeRunID, t.messageID);
          await deps.storage.set(key, {
            ...t.record,
            state: "consumed",
            consumedAt,
            consumedBoundary,
            consumedRound: round,
          });
          updatedKeys.push(key);
          out.push({ messageID: t.record.messageID, text: t.record.text });
        }
      } catch (err) {
        for (let i = 0; i < updatedKeys.length; i++) {
          try {
            await deps.storage.set(updatedKeys[i], targets[i].record);
          } catch {}
        }
        throw err;
      }
      return out;
    });
  };

  take.reserve = reserve;
  take.confirm = confirm;
  take.getFrontier = getFrontier;

  return take as FollowupTakeSeam;
}

/**
 * Reverte o consumo/reserva de follow-ups se a entrega no runtime (prompt) falhar
 * antes do worker receber os inputs.
 */
export async function revertFollowupConsumption(
  deps: { storage: FollowupStorage },
  runID: string,
  pending: PendingFollowup[],
): Promise<void> {
  if (!Array.isArray(pending) || pending.length === 0) return;
  const safeRunID = requireBounded(runID, FOLLOWUP_LIMITS.runID, "runID");
  await withKeyedLock(`followup-take/${safeRunID}`, async () => {
    for (const item of pending) {
      if (!item?.messageID) continue;
      const raw = await deps.storage.get(followupKey(safeRunID, item.messageID));
      if (raw === undefined) continue;
      try {
        const rec = normalizeFollowupRecord(raw);
        if (rec.state === "consumed" || rec.state === "reserved") {
          const reverted: FollowupRecord = {
            messageID: rec.messageID,
            sessionID: rec.sessionID,
            runID: rec.runID,
            text: rec.text,
            state: "pending",
            at: rec.at,
          };
          await deps.storage.set(followupKey(safeRunID, item.messageID), reverted);
        }
      } catch {
        // best-effort revert
      }
    }
  });
}

/**
 * Fechamento honesto do ciclo do run: chamado pelo callback de conclusao do
 * run (admission-rpc) para contabilizar consumidos e fechar pendentes como
 * `unconsumed` (run terminal nunca deixa pending falso). Idempotente: um
 * record fechado nunca e re-carimbado. Mesmo lock do take (sem corrida).
 */
export async function closeFollowupsForRun(
  deps: { storage: FollowupStorage; now?(): number },
  runID: string,
): Promise<{ consumed: number; pending: number }> {
  const now = deps.now ?? Date.now;
  const safeRunID = requireBounded(runID, FOLLOWUP_LIMITS.runID, "runID");
  return await withKeyedLock(`followup-take/${safeRunID}`, async () => {
    let index: string[] = [];
    try {
      index = readFollowupIndex(await deps.storage.get(followupIndexKey(safeRunID)));
    } catch {
      return { consumed: 0, pending: 0 }; // index ilegivel: nada a fechar (bounded)
    }
    let consumed = 0;
    let pending = 0;
    for (const messageID of index) {
      const raw = await deps.storage.get(followupKey(safeRunID, messageID));
      if (raw === undefined) continue;
      let rec: FollowupRecord;
      try {
        rec = normalizeFollowupRecord(raw);
      } catch {
        continue;
      }
      if (rec.state === "consumed") {
        consumed += 1;
        continue;
      }
      if (rec.state === "unconsumed") {
        pending += 1;
        continue;
      }
      await deps.storage.set(followupKey(safeRunID, messageID), {
        ...rec,
        state: "unconsumed",
        consumedAt: now(),
        consumedBoundary: "run-finished-without-consumption",
      });
      pending += 1;
    }
    return { consumed, pending };
  });
}

// ───────────────────────── secao bounded para o prompt da rodada ─────────────────────────

/**
 * Secao bounded adicionada ao prompt da rodada pelo dispatcher. Cada item:
 * messageID + texto ja capped no attach. A secao inteira e bounded (perRound
 * itens x texto capped) e rotulada como input do control plane — o worker
 * continua executando o contrato; nenhum poder extra e inferido.
 */
export function formatFollowupsSection(items: PendingFollowup[], round: number): string {
  if (!Array.isArray(items) || items.length === 0) return "";
  const lines: string[] = [
    `SESSION_FOLLOWUPS (control-plane input, bounded — user messages received while this run was active):`,
  ];
  for (const it of items.slice(0, FOLLOWUP_LIMITS.perRound)) {
    if (!it || typeof it.messageID !== "string") continue;
    lines.push(`- [${it.messageID.slice(0, FOLLOWUP_LIMITS.messageID)}] ${truncateText(String(it.text ?? ""), FOLLOWUP_LIMITS.text)}`);
  }
  lines.push(`(consumed at round-${round} boundary; do not re-request them)`);
  return lines.join("\n");
}
