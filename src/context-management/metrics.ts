export const CONTEXT_METRICS_KEY = "context/metrics/v1";
export const CONTEXT_METRICS_WINDOW_MS = 86_400_000;
export const CONTEXT_METRICS_PENDING_LIMIT = 128;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

export interface ContextMetricsV1 {
  schema: 1;
  windowStartedAt: number;
  updatedAt: number;
  tool: {
    completed: number;
    failed: number;
    pairedGroups: number;
    duplicateDeliveries: number;
    identityLoss: number;
    storageFailures: number;
    queueOverflow: number;
    unknownRoles: number;
  };
  context: {
    requests: number;
    estimatedRequestBytes: number;
    estimatedRequestBytesTotal: number;
    estimatedRequestBytesBeforeTotal: number;
    estimatedRequestBytesAfterTotal: number;
    toolCallParts: number;
    terminalParts: number;
    pairedGroups: number;
    plannedGroups: number;
    proposedKeep: number;
    proposedTruncate: number;
    proposedDrop: number;
    invalidatedPlans: number;
    unknownGroups: number;
    requestSnapshotsUnchanged: number;
    protectedGroups: number;
    unknownProtectionGroups: number;
    userSessionUnlinkedGroups: number;
    protectedRoleGroups: number;
    workerRoundProtectedGroups: number;
    canonicalStateUnknownGroups: number;
    groupIdentityUnknownGroups: number;
    recentGroups: number;
    incompleteGroups: number;
    unknownRoleGroups: number;
    malformedGroups: number;
    unprovenRelationGroups: number;
    requestShapeUnknownGroups: number;
    requestPairMismatchGroups: number;
    requestPayloadMismatchGroups: number;
  };
}

export type ContextMetricIncrement = {
  tool?: Partial<ContextMetricsV1["tool"]>;
  context?: Partial<ContextMetricsV1["context"]>;
};

type Storage = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
const queues = new WeakMap<object, Promise<void>>();
const pendingByStorage = new WeakMap<object, number>();

/** Persist only fixed counters and byte estimates; no IDs, labels, or content. */
export async function recordContextMetrics(
  storage: Storage,
  increment: ContextMetricIncrement,
  now = Date.now(),
): Promise<boolean> {
  const pending = pendingByStorage.get(storage) ?? 0;
  if (pending >= CONTEXT_METRICS_PENDING_LIMIT) return false;
  pendingByStorage.set(storage, pending + 1);
  const prior = queues.get(storage) ?? Promise.resolve();
  let success = false;
  const write = prior.catch(() => {}).then(async () => {
    const existing = sanitizeContextMetrics(await storage.get(CONTEXT_METRICS_KEY), now);
    const next = existing && now >= existing.windowStartedAt && now - existing.windowStartedAt < CONTEXT_METRICS_WINDOW_MS
      ? existing
      : emptyMetrics(now);
    for (const key of Object.keys(next.tool) as Array<keyof ContextMetricsV1["tool"]>) {
      next.tool[key] = saturatingAdd(next.tool[key], safeCount(increment.tool?.[key]));
    }
    for (const key of [
      "requests", "estimatedRequestBytesTotal", "estimatedRequestBytesBeforeTotal", "estimatedRequestBytesAfterTotal",
      "plannedGroups", "proposedKeep", "proposedTruncate", "proposedDrop", "invalidatedPlans", "unknownGroups",
      "requestSnapshotsUnchanged", "protectedGroups", "unknownProtectionGroups", "userSessionUnlinkedGroups",
      "protectedRoleGroups", "workerRoundProtectedGroups", "canonicalStateUnknownGroups", "groupIdentityUnknownGroups",
      "recentGroups", "incompleteGroups", "unknownRoleGroups", "malformedGroups", "unprovenRelationGroups", "requestShapeUnknownGroups",
      "requestPairMismatchGroups", "requestPayloadMismatchGroups",
    ] as const) {
      next.context[key] = saturatingAdd(next.context[key], safeCount(increment.context?.[key]));
    }
    for (const key of ["estimatedRequestBytes", "toolCallParts", "terminalParts", "pairedGroups"] as const) {
      const value = increment.context?.[key];
      if (value !== undefined) next.context[key] = safeCount(value);
    }
    next.updatedAt = safeTime(now);
    await storage.set(CONTEXT_METRICS_KEY, next);
    success = true;
  });
  queues.set(storage, write);
  try {
    await write;
    return success;
  } catch {
    return false;
  } finally {
    pendingByStorage.set(storage, Math.max(0, (pendingByStorage.get(storage) ?? 1) - 1));
    if (pendingByStorage.get(storage) === 0) pendingByStorage.delete(storage);
    if (queues.get(storage) === write) queues.delete(storage);
  }
}

export function sanitizeContextMetrics(value: unknown, now = Date.now()): ContextMetricsV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const x = value as Record<string, unknown>;
  if (x.schema !== 1 || typeof x.windowStartedAt !== "number" || typeof x.updatedAt !== "number") return undefined;
  const toolRaw = x.tool && typeof x.tool === "object" ? x.tool as Record<string, unknown> : {};
  const contextRaw = x.context && typeof x.context === "object" ? x.context as Record<string, unknown> : {};
  const tool: ContextMetricsV1["tool"] = {
    completed: safeCount(toolRaw.completed), failed: safeCount(toolRaw.failed), pairedGroups: safeCount(toolRaw.pairedGroups),
    duplicateDeliveries: safeCount(toolRaw.duplicateDeliveries), identityLoss: safeCount(toolRaw.identityLoss),
    storageFailures: safeCount(toolRaw.storageFailures), queueOverflow: safeCount(toolRaw.queueOverflow), unknownRoles: safeCount(toolRaw.unknownRoles),
  };
  const context: ContextMetricsV1["context"] = {
    requests: safeCount(contextRaw.requests), estimatedRequestBytes: safeCount(contextRaw.estimatedRequestBytes),
    estimatedRequestBytesTotal: safeCount(contextRaw.estimatedRequestBytesTotal),
    estimatedRequestBytesBeforeTotal: safeCount(contextRaw.estimatedRequestBytesBeforeTotal),
    estimatedRequestBytesAfterTotal: safeCount(contextRaw.estimatedRequestBytesAfterTotal),
    toolCallParts: safeCount(contextRaw.toolCallParts), terminalParts: safeCount(contextRaw.terminalParts), pairedGroups: safeCount(contextRaw.pairedGroups),
    plannedGroups: safeCount(contextRaw.plannedGroups), proposedKeep: safeCount(contextRaw.proposedKeep),
    proposedTruncate: safeCount(contextRaw.proposedTruncate), proposedDrop: safeCount(contextRaw.proposedDrop),
    invalidatedPlans: safeCount(contextRaw.invalidatedPlans), unknownGroups: safeCount(contextRaw.unknownGroups),
    requestSnapshotsUnchanged: safeCount(contextRaw.requestSnapshotsUnchanged),
    protectedGroups: safeCount(contextRaw.protectedGroups), unknownProtectionGroups: safeCount(contextRaw.unknownProtectionGroups),
    userSessionUnlinkedGroups: safeCount(contextRaw.userSessionUnlinkedGroups),
    protectedRoleGroups: safeCount(contextRaw.protectedRoleGroups),
    workerRoundProtectedGroups: safeCount(contextRaw.workerRoundProtectedGroups),
    canonicalStateUnknownGroups: safeCount(contextRaw.canonicalStateUnknownGroups),
    groupIdentityUnknownGroups: safeCount(contextRaw.groupIdentityUnknownGroups),
    recentGroups: safeCount(contextRaw.recentGroups), incompleteGroups: safeCount(contextRaw.incompleteGroups),
    unknownRoleGroups: safeCount(contextRaw.unknownRoleGroups), malformedGroups: safeCount(contextRaw.malformedGroups),
    unprovenRelationGroups: safeCount(contextRaw.unprovenRelationGroups),
    requestShapeUnknownGroups: safeCount(contextRaw.requestShapeUnknownGroups),
    requestPairMismatchGroups: safeCount(contextRaw.requestPairMismatchGroups),
    requestPayloadMismatchGroups: safeCount(contextRaw.requestPayloadMismatchGroups),
  };
  return {
    schema: 1,
    windowStartedAt: safeTime(x.windowStartedAt),
    updatedAt: Math.min(safeTime(x.updatedAt), safeTime(now)),
    tool,
    context,
  };
}

function emptyMetrics(now: number): ContextMetricsV1 {
  return {
    schema: 1, windowStartedAt: safeTime(now), updatedAt: safeTime(now),
    tool: { completed: 0, failed: 0, pairedGroups: 0, duplicateDeliveries: 0, identityLoss: 0, storageFailures: 0, queueOverflow: 0, unknownRoles: 0 },
    context: {
      requests: 0, estimatedRequestBytes: 0, estimatedRequestBytesTotal: 0,
      estimatedRequestBytesBeforeTotal: 0, estimatedRequestBytesAfterTotal: 0,
      toolCallParts: 0, terminalParts: 0, pairedGroups: 0,
      plannedGroups: 0, proposedKeep: 0, proposedTruncate: 0, proposedDrop: 0, invalidatedPlans: 0, unknownGroups: 0,
      requestSnapshotsUnchanged: 0, protectedGroups: 0, unknownProtectionGroups: 0, userSessionUnlinkedGroups: 0,
      protectedRoleGroups: 0, workerRoundProtectedGroups: 0, canonicalStateUnknownGroups: 0, groupIdentityUnknownGroups: 0,
      recentGroups: 0, incompleteGroups: 0, unknownRoleGroups: 0, malformedGroups: 0, unprovenRelationGroups: 0, requestShapeUnknownGroups: 0,
      requestPairMismatchGroups: 0, requestPayloadMismatchGroups: 0,
    },
  };
}
function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function safeTime(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;
}
function saturatingAdd(a: number, b: number): number {
  return Math.min(MAX_COUNTER, a + b);
}
