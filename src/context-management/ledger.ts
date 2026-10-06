import {
  CONTEXT_ASSET_MAX_SERIALIZED_BYTES,
  CONTEXT_LEDGER_GROUP_CAPACITY,
  CONTEXT_LEDGER_SESSION_CAPACITY,
  CONTEXT_LEDGER_TTL_MS,
  CONTEXT_SCHEMA,
  type ContextAssetV1,
  type ContextToolGroupV1,
  type EvidenceRole,
} from "./types.ts";

export {
  CONTEXT_ASSET_MAX_SERIALIZED_BYTES,
  CONTEXT_LEDGER_GROUP_CAPACITY,
  CONTEXT_LEDGER_KEY,
  CONTEXT_LEDGER_PENDING_LIMIT,
  CONTEXT_LEDGER_SESSION_CAPACITY,
  CONTEXT_LEDGER_TTL_MS,
  CONTEXT_RECENT_GROUPS,
} from "./types.ts";

const ASSET_FIELDS = [
  "schema", "assetID", "groupID", "sessionRef", "runRef", "round", "role", "source", "tool", "callRef",
  "messageRef", "entityRef", "payloadBytes", "fingerprint", "createdAt", "lastReferencedAt", "supersededBy",
  "evidenceRoles", "protection", "retention", "confidence",
] as const;
const ROLE_VALUES = ["user-session", "worker", "critic", "orchestrator", "unknown"] as const;
const SOURCE_VALUES = ["tool-call", "tool-result", "tool-failure", "tool-artifact"] as const;
const PROTECTION_VALUES = ["protected", "clear", "unknown"] as const;
const RETENTION_VALUES = ["KEEP", "KEEP_IDENTITY_TRUNCATE_PAYLOAD", "DROP"] as const;
const CONFIDENCE_VALUES = ["high", "medium", "low"] as const;
const EVIDENCE_VALUES = ["none", "required-evidence", "deterministic-check", "evidence-packet", "critic-finding", "binding-decision", "unknown"] as const;

const HEX_64 = /^[a-f0-9]{64}$/;
const ROLES = new Set(["user-session", "worker", "critic", "orchestrator", "unknown"]);
const SOURCES = new Set(["tool-call", "tool-result", "tool-failure", "tool-artifact"]);
const EVIDENCE_ROLES = new Set<EvidenceRole>([
  "none", "required-evidence", "deterministic-check", "evidence-packet", "critic-finding", "binding-decision", "unknown",
]);
const PROTECTIONS = new Set(["protected", "clear", "unknown"]);
const RETENTION = new Set(["KEEP", "KEEP_IDENTITY_TRUNCATE_PAYLOAD", "DROP"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
const ASSET_KEYS = new Set([
  "schema", "assetID", "groupID", "sessionRef", "runRef", "round", "role", "source", "tool", "callRef",
  "messageRef", "entityRef", "payloadBytes", "fingerprint", "createdAt", "lastReferencedAt", "supersededBy",
  "evidenceRoles", "protection", "retention", "confidence",
]);
const GROUP_KEYS = new Set(["groupID", "sessionRef", "call", "terminal", "createdAt", "updatedAt"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isPositiveTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

/** Strict metadata allowlist. Unknown/free-form fields invalidate the record. */
export function sanitizeContextAsset(value: unknown): ContextAssetV1 | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ASSET_KEYS)) return undefined;
  if (value.schema !== CONTEXT_SCHEMA) return undefined;
  for (const key of ["assetID", "groupID", "sessionRef", "callRef"] as const) {
    if (typeof value[key] !== "string" || !HEX_64.test(value[key] as string)) return undefined;
  }
  for (const key of ["runRef", "messageRef", "entityRef", "supersededBy", "fingerprint"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || !HEX_64.test(value[key] as string))) return undefined;
  }
  if (typeof value.role !== "string" || !ROLES.has(value.role)) return undefined;
  if (typeof value.source !== "string" || !SOURCES.has(value.source)) return undefined;
  if (typeof value.tool !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(value.tool)) return undefined;
  if (!isPositiveTime(value.createdAt)) return undefined;
  if (value.lastReferencedAt !== undefined && !isPositiveTime(value.lastReferencedAt)) return undefined;
  if (value.round !== undefined && (!Number.isSafeInteger(value.round) || Number(value.round) <= 0)) return undefined;
  if (value.payloadBytes !== undefined && (!Number.isSafeInteger(value.payloadBytes) || Number(value.payloadBytes) < 0)) return undefined;
  if (!Array.isArray(value.evidenceRoles) || value.evidenceRoles.length > 8 || value.evidenceRoles.some((x) => !EVIDENCE_ROLES.has(x as EvidenceRole))) return undefined;
  if (typeof value.protection !== "string" || !PROTECTIONS.has(value.protection)) return undefined;
  if (typeof value.retention !== "string" || !RETENTION.has(value.retention)) return undefined;
  if (value.confidence !== undefined && (typeof value.confidence !== "string" || !CONFIDENCE.has(value.confidence))) return undefined;

  const asset = {
    schema: CONTEXT_SCHEMA,
    assetID: value.assetID as string,
    groupID: value.groupID as string,
    sessionRef: value.sessionRef as string,
    ...(value.runRef !== undefined ? { runRef: value.runRef as string } : {}),
    ...(value.round !== undefined ? { round: value.round as number } : {}),
    role: value.role as ContextAssetV1["role"],
    source: value.source as ContextAssetV1["source"],
    tool: value.tool,
    callRef: value.callRef as string,
    ...(value.messageRef !== undefined ? { messageRef: value.messageRef as string } : {}),
    ...(value.entityRef !== undefined ? { entityRef: value.entityRef as string } : {}),
    ...(value.payloadBytes !== undefined ? { payloadBytes: value.payloadBytes as number } : {}),
    ...(value.fingerprint !== undefined ? { fingerprint: value.fingerprint as string } : {}),
    createdAt: value.createdAt,
    ...(value.lastReferencedAt !== undefined ? { lastReferencedAt: value.lastReferencedAt as number } : {}),
    ...(value.supersededBy !== undefined ? { supersededBy: value.supersededBy as string } : {}),
    evidenceRoles: [...value.evidenceRoles] as EvidenceRole[],
    protection: value.protection as ContextAssetV1["protection"],
    retention: value.retention as ContextAssetV1["retention"],
    ...(value.confidence !== undefined ? { confidence: value.confidence as ContextAssetV1["confidence"] } : {}),
  } satisfies ContextAssetV1;
  if (Buffer.byteLength(JSON.stringify(serializeContextAsset(asset)), "utf8") > CONTEXT_ASSET_MAX_SERIALIZED_BYTES) return undefined;
  return asset;
}

/** Compact positional wire form keeps complete SHA-256 references within the asset byte ceiling. */
export function serializeContextAsset(asset: ContextAssetV1): readonly unknown[] {
  return ASSET_FIELDS.map((key) => {
    const value = asset[key];
    if (value === undefined) return null;
    if (key === "role") return ROLE_VALUES.indexOf(value as typeof ROLE_VALUES[number]);
    if (key === "source") return SOURCE_VALUES.indexOf(value as typeof SOURCE_VALUES[number]);
    if (key === "protection") return PROTECTION_VALUES.indexOf(value as typeof PROTECTION_VALUES[number]);
    if (key === "retention") return RETENTION_VALUES.indexOf(value as typeof RETENTION_VALUES[number]);
    if (key === "confidence") return CONFIDENCE_VALUES.indexOf(value as typeof CONFIDENCE_VALUES[number]);
    if (key === "evidenceRoles") return (value as EvidenceRole[]).map((role) => EVIDENCE_VALUES.indexOf(role));
    return value;
  });
}

export function deserializeContextAsset(value: unknown): ContextAssetV1 | undefined {
  if (!Array.isArray(value) || value.length !== ASSET_FIELDS.length) return sanitizeContextAsset(value);
  const expanded: Record<string, unknown> = {};
  ASSET_FIELDS.forEach((key, index) => {
    const item = value[index];
    if (item === null) return;
    if (key === "role") expanded[key] = ROLE_VALUES[item as number];
    else if (key === "source") expanded[key] = SOURCE_VALUES[item as number];
    else if (key === "protection") expanded[key] = PROTECTION_VALUES[item as number];
    else if (key === "retention") expanded[key] = RETENTION_VALUES[item as number];
    else if (key === "confidence") expanded[key] = CONFIDENCE_VALUES[item as number];
    else if (key === "evidenceRoles") expanded[key] = Array.isArray(item) ? item.map((n) => EVIDENCE_VALUES[n as number]) : item;
    else expanded[key] = item;
  });
  return sanitizeContextAsset(expanded);
}

function sanitizeGroup(value: unknown): ContextToolGroupV1 | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, GROUP_KEYS)) return undefined;
  if (typeof value.groupID !== "string" || !HEX_64.test(value.groupID)) return undefined;
  if (typeof value.sessionRef !== "string" || !HEX_64.test(value.sessionRef)) return undefined;
  if (!isPositiveTime(value.createdAt) || !isPositiveTime(value.updatedAt) || Number(value.updatedAt) < Number(value.createdAt)) return undefined;
  const call = deserializeContextAsset(value.call);
  const terminal = value.terminal === undefined ? undefined : deserializeContextAsset(value.terminal);
  if (!call || (value.terminal !== undefined && !terminal)) return undefined;
  if (call.source !== "tool-call") return undefined;
  if (terminal && terminal.source !== "tool-result" && terminal.source !== "tool-failure") return undefined;
  const members = terminal ? [call, terminal] : [call];
  if (members.some((asset) => asset.groupID !== value.groupID || asset.sessionRef !== value.sessionRef || asset.callRef !== call.callRef)) return undefined;
  return {
    groupID: value.groupID,
    sessionRef: value.sessionRef,
    call,
    ...(terminal ? { terminal } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function serializeContextGroup(group: ContextToolGroupV1): readonly unknown[] {
  return [
    group.groupID,
    group.sessionRef,
    serializeContextAsset(group.call),
    group.terminal ? serializeContextAsset(group.terminal) : null,
    group.createdAt,
    group.updatedAt,
  ];
}

export function deserializeContextGroup(value: unknown): ContextToolGroupV1 | undefined {
  if (Array.isArray(value) && value.length === 6) {
    return sanitizeGroup({
      groupID: value[0],
      sessionRef: value[1],
      call: value[2],
      ...(value[3] !== null ? { terminal: value[3] } : {}),
      createdAt: value[4],
      updatedAt: value[5],
    });
  }
  return sanitizeGroup(value);
}

function resetAsset(asset: ContextAssetV1): ContextAssetV1 {
  return { ...asset, protection: "unknown", retention: "KEEP", confidence: undefined };
}

/** In-memory bounded metadata index. Eviction never changes OpenCode history. */
export class ContextLedger {
  private groups = new Map<string, ContextToolGroupV1>();
  private readonly now: () => number;
  readonly capacity: number;
  readonly sessionCapacity: number;
  readonly ttlMs: number;

  constructor(options: { now?: () => number; capacity?: number; sessionCapacity?: number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.capacity = boundedInt(options.capacity, CONTEXT_LEDGER_GROUP_CAPACITY, CONTEXT_LEDGER_GROUP_CAPACITY);
    this.sessionCapacity = boundedInt(options.sessionCapacity, CONTEXT_LEDGER_SESSION_CAPACITY, CONTEXT_LEDGER_SESSION_CAPACITY);
    this.ttlMs = boundedInt(options.ttlMs, CONTEXT_LEDGER_TTL_MS, CONTEXT_LEDGER_TTL_MS);
  }

  get size(): number { this.evictExpired(); return this.groups.size; }

  upsertGroup(value: unknown): boolean {
    const next = sanitizeGroup(value);
    if (!next) return false;
    this.evictExpired();
    const prior = this.groups.get(next.groupID);
    let safe = next;
    if (prior) {
      const priorAssets = [prior.call, ...(prior.terminal ? [prior.terminal] : [])];
      const nextAssets = [next.call, ...(next.terminal ? [next.terminal] : [])];
      const changed = priorAssets.length !== nextAssets.length || priorAssets.some((oldAsset) => {
        const replacement = nextAssets.find((asset) => asset.assetID === oldAsset.assetID && asset.source === oldAsset.source);
        return !replacement || oldAsset.fingerprint !== replacement.fingerprint;
      });
      if (changed) {
        safe = {
          ...next,
          call: resetAsset(next.call),
          ...(next.terminal ? { terminal: resetAsset(next.terminal) } : {}),
        };
      }
      this.groups.delete(next.groupID);
    }
    this.groups.set(safe.groupID, cloneGroup(safe));
    this.enforceSessionCapacity(safe.sessionRef);
    this.enforceTotalCapacity();
    return this.groups.has(safe.groupID);
  }

  snapshot(): ContextToolGroupV1[] {
    this.evictExpired();
    return [...this.groups.values()].map(cloneGroup);
  }

  replace(values: unknown[]): void {
    this.groups.clear();
    if (!Array.isArray(values)) return;
    for (const value of values.slice(-this.capacity)) {
      const item = deserializeContextGroup(value);
      if (!item || this.isExpired(item)) continue;
      this.groups.set(item.groupID, item);
      this.enforceSessionCapacity(item.sessionRef);
    }
    this.enforceTotalCapacity();
  }

  private isExpired(group: ContextToolGroupV1): boolean {
    const now = this.now();
    return !Number.isFinite(now) || now < group.createdAt || now - group.createdAt >= this.ttlMs;
  }
  private evictExpired(): void {
    for (const [key, group] of this.groups) if (this.isExpired(group)) this.groups.delete(key);
  }
  private enforceSessionCapacity(sessionRef: string): void {
    const entries = [...this.groups.values()].filter((x) => x.sessionRef === sessionRef);
    while (entries.length > this.sessionCapacity) {
      const oldest = entries.shift()!;
      this.groups.delete(oldest.groupID);
    }
  }
  private enforceTotalCapacity(): void {
    while (this.groups.size > this.capacity) {
      const oldest = this.groups.values().next().value as ContextToolGroupV1 | undefined;
      if (!oldest) return;
      this.groups.delete(oldest.groupID);
    }
  }
}

function boundedInt(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}
function cloneGroup(group: ContextToolGroupV1): ContextToolGroupV1 {
  const cloneAsset = (asset: ContextAssetV1): ContextAssetV1 => ({ ...asset, evidenceRoles: [...asset.evidenceRoles] });
  return {
    groupID: group.groupID,
    sessionRef: group.sessionRef,
    call: cloneAsset(group.call),
    ...(group.terminal ? { terminal: cloneAsset(group.terminal) } : {}),
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}
