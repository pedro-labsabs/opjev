export const CONTEXT_METRICS_KEY = "context/metrics/v1";
export const CONTEXT_METRICS_WINDOW_MS = 86_400_000;
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
    toolCallParts: number;
    terminalParts: number;
    pairedGroups: number;
  };
}

export type ContextMetricIncrement = {
  tool?: Partial<ContextMetricsV1["tool"]>;
  context?: Partial<ContextMetricsV1["context"]>;
};

type Storage = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
const queues = new WeakMap<object, Promise<void>>();

/** Persist only fixed counters and byte estimates; no IDs, labels, or content. */
export async function recordContextMetrics(
  storage: Storage,
  increment: ContextMetricIncrement,
  now = Date.now(),
): Promise<boolean> {
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
    for (const key of ["requests", "estimatedRequestBytesTotal"] as const) {
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
    estimatedRequestBytesTotal: safeCount(contextRaw.estimatedRequestBytesTotal), toolCallParts: safeCount(contextRaw.toolCallParts),
    terminalParts: safeCount(contextRaw.terminalParts), pairedGroups: safeCount(contextRaw.pairedGroups),
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
    context: { requests: 0, estimatedRequestBytes: 0, estimatedRequestBytesTotal: 0, toolCallParts: 0, terminalParts: 0, pairedGroups: 0 },
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
