import { ContextLedger } from "./ledger.ts";
import { createPayloadFingerprintKey, fingerprintPayload, hashStableRef } from "./identity.ts";
import { recordContextMetrics, type ContextMetricIncrement } from "./metrics.ts";
import { createContextAssetSink, isContextAssetSinkAtCapacity } from "./storage-sink.ts";
import { CONTEXT_LEDGER_KEY, CONTEXT_LEDGER_PENDING_LIMIT, type ContextAssetRole, type ContextAssetSource, type ContextAssetV1, type ContextToolGroupV1, type ContextRolloutStage } from "./types.ts";

export const IMPLEMENTED_CONTEXT_STAGES = ["disabled", "observe", "deterministic-shadow"] as const;
const FINGERPRINT_KEY = createPayloadFingerprintKey();
const CURRENT_FINGERPRINT_LIMIT = 1024;
const currentFingerprints = new Set<string>();
const VALID_ROLES = new Set<ContextAssetRole>(["worker", "critic", "orchestrator"]);
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,80}$/;
const ID_MAX_LENGTH = 256;
const EVENT_SEEN_LIMIT = 4096;
const EVENT_PENDING_LIMIT = CONTEXT_LEDGER_PENDING_LIMIT;

type Storage = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
type ObservationDeps = {
  storage: Storage;
  owner: object;
  now?: () => number;
  getSession?: (sessionID: string) => Promise<unknown>;
  sink?: (group: ContextToolGroupV1) => Promise<boolean>;
};
const seenByOwner = new WeakMap<object, Map<string, number>>();
const pendingByOwner = new WeakMap<object, Set<string>>();

export function resolveContextManagementStage(value: unknown): ContextRolloutStage {
  if (value === "disabled") return "disabled";
  return (IMPLEMENTED_CONTEXT_STAGES as readonly unknown[]).includes(value) ? value as ContextRolloutStage : "observe";
}

/** Fingerprint with the active process key and remember it for restart-safe verification. */
export function fingerprintContextPayload(value: unknown): string | undefined {
  const fingerprint = fingerprintPayload(value, FINGERPRINT_KEY);
  if (fingerprint !== undefined) {
    currentFingerprints.add(fingerprint);
    while (currentFingerprints.size > CURRENT_FINGERPRINT_LIMIT) currentFingerprints.delete(currentFingerprints.keys().next().value as string);
  }
  return fingerprint;
}

export function isCurrentContextFingerprint(fingerprint: string): boolean {
  return currentFingerprints.has(fingerprint);
}

/** Capture a terminal tool lifecycle fact. No raw payload is persisted or returned. */
export async function observeToolAfter(event: any, deps: ObservationDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  if (!event || (event.status !== "completed" && event.status !== "error")) return;
  const terminalSource: ContextAssetSource = event.status === "completed" ? "tool-result" : "tool-failure";
  const sessionID = opaqueID(event.sessionID);
  const messageID = opaqueID(event.messageID);
  const callID = opaqueID(event.id);
  const tool = typeof event.tool === "string" && SAFE_NAME.test(event.tool) ? event.tool : undefined;
  const terminalValue = terminalSource === "tool-result" ? event.result : event.error;
  if (!sessionID || !messageID || !callID || !tool || terminalValue === undefined) {
    await metric(deps.storage, { tool: { identityLoss: 1 } }, now);
    return;
  }

  const groupID = hashStableRef(`${sessionID}\u0000${callID}`);
  const callRef = hashStableRef(callID);
  const sessionRef = hashStableRef(sessionID);
  const messageRef = hashStableRef(messageID);
  const callFingerprint = fingerprintContextPayload(event.input);
  const terminalFingerprint = fingerprintContextPayload(terminalValue);
  const callBytes = payloadBytes(event.input);
  const terminalBytes = payloadBytes(terminalValue);
  const eventKey = `${groupID}:${callFingerprint ?? "?"}:${terminalFingerprint ?? "?"}`;
  const seen = seenMap(deps.owner);
  const pending = pendingSet(deps.owner);
  if (seen.has(eventKey) || pending.has(eventKey)) {
    await metric(deps.storage, { tool: { duplicateDeliveries: 1 } }, now);
    return;
  }
  if (pending.size >= EVENT_PENDING_LIMIT) {
    await metric(deps.storage, { tool: { queueOverflow: 1 } }, now);
    return;
  }
  pending.add(eventKey);
  try {
    const session = await readSession(deps, sessionID);
    const metadata = metadataOf(session.value);
    const role = roleOf(metadata, session.ok);
    const runID = role !== "user-session" && typeof metadata?.["jev-run-id"] === "string"
      ? opaqueID(metadata["jev-run-id"]) : undefined;
    const metadataRound = metadata?.["jev-round"];
    const round = role !== "user-session" && typeof metadataRound === "number" && Number.isSafeInteger(metadataRound) && metadataRound > 0
      ? metadataRound : undefined;
    const createdAt = safeTime(now);
    const call = makeAsset({
      source: "tool-call", assetID: hashStableRef(`${groupID}\u0000${messageRef}\u0000tool-call`), groupID, sessionRef,
      runRef: runID ? hashStableRef(runID) : undefined, round, role, tool, callRef,
      payloadBytes: callBytes, fingerprint: callFingerprint, createdAt,
    });
    const terminal = makeAsset({
      source: terminalSource, assetID: hashStableRef(`${groupID}\u0000${messageRef}\u0000${terminalSource}`), groupID, sessionRef,
      runRef: runID ? hashStableRef(runID) : undefined, round, role, tool, callRef,
      payloadBytes: terminalBytes, fingerprint: terminalFingerprint, createdAt,
    });
    const group: ContextToolGroupV1 = { groupID, sessionRef, call, terminal, createdAt, updatedAt: createdAt };
    const sink = deps.sink ?? createContextAssetSink(deps.owner, deps.storage, { now: deps.now });
    const wasFull = isContextAssetSinkAtCapacity(deps.owner);
    let persisted = false;
    try { persisted = await sink(group); } catch { /* failed OBSERVE storage loses this observation */ }
    if (!persisted) {
      await metric(deps.storage, wasFull ? { tool: { queueOverflow: 1 } } : { tool: { storageFailures: 1 } }, now);
      return;
    }
    remember(seen, eventKey, now);
    await metric(deps.storage, {
      tool: {
        ...(terminalSource === "tool-result" ? { completed: 1 } : { failed: 1 }),
        pairedGroups: 1,
        ...(role === "unknown" ? { unknownRoles: 1 } : {}),
      },
    }, now);
  } finally {
    pending.delete(eventKey);
    if (pending.size === 0) pendingByOwner.delete(deps.owner);
  }
}

/** Measure the request hook's final observed shape. This function never writes to event. */
export async function observeContextRequest(event: any, deps: ObservationDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const bytes = estimateRequestBytes(event);
  const parts = toolPartIDs(event?.messages);
  let pairedGroups = 0;
  try {
    const stored = await deps.storage.get(CONTEXT_LEDGER_KEY);
    const ledger = new ContextLedger({ now: deps.now });
    if (isRecord(stored) && stored.schema === 1 && Array.isArray(stored.groups)) ledger.replace(stored.groups);
    const sessionID = opaqueID(event?.sessionID);
    if (sessionID) {
      const sessionRef = hashStableRef(sessionID);
      const callIDs = new Set(parts.calls);
      const resultIDs = new Set(parts.terminals);
      for (const group of ledger.snapshot()) {
        if (group.sessionRef !== sessionRef || !group.terminal) continue;
        const callID = group.call.callRef;
        if (callIDs.has(callID) && resultIDs.has(callID)) pairedGroups++;
      }
    }
  } catch {
    // Unknown storage means no pair coverage; request contents stay untouched.
  }
  await metric(deps.storage, {
    context: {
      requests: 1,
      estimatedRequestBytes: bytes,
      estimatedRequestBytesTotal: bytes,
      toolCallParts: parts.calls.length,
      terminalParts: parts.terminals.length,
      pairedGroups,
    },
  }, now);
}

export async function flushContextObservations(owner: object): Promise<void> {
  const seen = seenByOwner.get(owner);
  if (!seen) return;
  await Promise.resolve();
}

async function metric(storage: Storage, increment: ContextMetricIncrement, now: number): Promise<void> {
  try { await recordContextMetrics(storage, increment, now); } catch { /* observation metrics are best-effort */ }
}
async function readSession(deps: ObservationDeps, sessionID: string): Promise<{ ok: boolean; value?: unknown }> {
  try {
    const value = deps.getSession ? await deps.getSession(sessionID) : undefined;
    return { ok: !!value && typeof value === "object", value };
  } catch {
    return { ok: false };
  }
}
function metadataOf(session: unknown): Record<string, unknown> | undefined {
  if (!isRecord(session) || !isRecord(session.metadata)) return undefined;
  return session.metadata;
}
function roleOf(metadata: Record<string, unknown> | undefined, available: boolean): ContextAssetRole {
  if (!available) return "unknown";
  if (!metadata) return "user-session";
  const rawRole = metadata["jev-role"];
  const marker = metadata["jev-router"];
  if (rawRole === undefined && marker === undefined) return "user-session";
  if (marker === "orchestration-internal" && VALID_ROLES.has(rawRole as ContextAssetRole)) return rawRole as ContextAssetRole;
  return "unknown";
}
function makeAsset(input: {
  source: ContextAssetSource; assetID: string; groupID: string; sessionRef: string; runRef?: string; round?: number;
  role: ContextAssetRole; tool: string; callRef: string; payloadBytes?: number;
  fingerprint?: string; createdAt: number;
}): ContextAssetV1 {
  return {
    schema: 1, assetID: input.assetID, groupID: input.groupID, sessionRef: input.sessionRef,
    ...(input.runRef ? { runRef: input.runRef } : {}), ...(input.round ? { round: input.round } : {}),
    role: input.role, source: input.source, tool: input.tool, callRef: input.callRef,
    ...(input.payloadBytes !== undefined ? { payloadBytes: input.payloadBytes } : {}),
    ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}), createdAt: input.createdAt,
    evidenceRoles: ["none"], protection: "unknown", retention: "KEEP",
  };
}
function payloadBytes(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (serialized === undefined) return undefined;
    return Math.min(Number.MAX_SAFE_INTEGER, Buffer.byteLength(serialized, "utf8"));
  } catch {
    return undefined;
  }
}
function estimateRequestBytes(event: unknown): number {
  if (!isRecord(event)) return 0;
  try {
    const request = {
      system: event.system,
      messages: event.messages,
      tools: event.tools,
      options: event.options,
      model: event.model,
      agent: event.agent,
    };
    return Math.min(Number.MAX_SAFE_INTEGER, Buffer.byteLength(JSON.stringify(request) ?? "", "utf8"));
  } catch {
    return 0;
  }
}
function toolPartIDs(messages: unknown): { calls: string[]; terminals: string[] } {
  const calls: string[] = [];
  const terminals: string[] = [];
  if (!Array.isArray(messages)) return { calls, terminals };
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || typeof part.id !== "string" || part.id.length === 0 || part.id.length > ID_MAX_LENGTH) continue;
      const id = hashStableRef(part.id);
      if (part.type === "tool-call") calls.push(id);
      if (part.type === "tool-result") terminals.push(id);
    }
  }
  return { calls, terminals };
}
function opaqueID(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= ID_MAX_LENGTH ? value : undefined;
}
function safeTime(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : Date.now();
}
function seenMap(owner: object): Map<string, number> {
  let value = seenByOwner.get(owner);
  if (!value) { value = new Map(); seenByOwner.set(owner, value); }
  return value;
}
function pendingSet(owner: object): Set<string> {
  let value = pendingByOwner.get(owner);
  if (!value) { value = new Set(); pendingByOwner.set(owner, value); }
  return value;
}
function remember(seen: Map<string, number>, key: string, at: number): void {
  seen.set(key, at);
  while (seen.size > EVENT_SEEN_LIMIT) seen.delete(seen.keys().next().value as string);
}
function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
