import { withKeyedLock } from "../lock.ts";

export const QUOTA_ENFORCEMENT_KEY = "resource/enforcement/quota-latch/v1";
export const RESOURCE_ENFORCEMENT_LOCK = "resource/enforcement/state/v1";
export const QUOTA_LATCH_TTL_MS = 15 * 60 * 1000;

export interface ResourceEnforcementStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

let emergencyQuotaExpiresAt = 0;

/** Mark in-process deny synchronously, including the storage-write failure path. */
export function markEmergencyQuotaLatch(at: number): void {
  emergencyQuotaExpiresAt = Math.max(emergencyQuotaExpiresAt, at + QUOTA_LATCH_TTL_MS);
}

export async function readQuotaLatch(storage: ResourceEnforcementStorage, now: number): Promise<boolean> {
  const stored = await storage.get(QUOTA_ENFORCEMENT_KEY);
  let durable = false;
  if (stored !== undefined && stored !== null) {
    const x = stored as Record<string, unknown>;
    if (
      !x || typeof x !== "object" || x.schema !== 1 || x.signal !== "quota-limit" ||
      !Number.isFinite(x.trippedAt) || !Number.isFinite(x.expiresAt) ||
      Number(x.expiresAt) - Number(x.trippedAt) !== QUOTA_LATCH_TTL_MS
    ) throw new Error("invalid bounded quota enforcement state");
    durable = now < Number(x.expiresAt);
  }
  return durable || now < emergencyQuotaExpiresAt;
}

/** Persist the hard latch under the same lock used by policy reads. */
export async function latchQuotaLimit(storage: ResourceEnforcementStorage, at: number): Promise<void> {
  markEmergencyQuotaLatch(at);
  await withKeyedLock(RESOURCE_ENFORCEMENT_LOCK, async () => {
    await storage.set(QUOTA_ENFORCEMENT_KEY, {
      schema: 1,
      signal: "quota-limit",
      trippedAt: at,
      expiresAt: at + QUOTA_LATCH_TTL_MS,
    });
  });
}
