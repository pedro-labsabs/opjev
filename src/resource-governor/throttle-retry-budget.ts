import { withKeyedLock } from "../lock.ts";
import { RESOURCE_POLICY_WINDOW_MS } from "./budget-policy.ts";
import type { ResourceEnforcementStorage } from "./enforcement-state.ts";

export const THROTTLE_RETRY_BUDGET_KEY = "resource/throttle-retry/v1";
export const THROTTLE_RETRY_BUDGET_LOCK = "resource/throttle-retry/v1";
export const MAX_THROTTLE_RETRIES_PER_WINDOW = 2;

/** Atomically reserves one global retry slot; storage failures never grant a slot. */
export async function reserveThrottleRetry(storage: ResourceEnforcementStorage, now = Date.now()): Promise<{ allowed: boolean; retries: number }> {
  return withKeyedLock(THROTTLE_RETRY_BUDGET_LOCK, async () => {
    const prior: any = await storage.get(THROTTLE_RETRY_BUDGET_KEY);
    let windowStart = now;
    let retries = 0;
    if (prior !== undefined && prior !== null) {
      if (!Number.isFinite(prior.windowStart) || prior.windowStart > now || !Number.isInteger(prior.retries) || prior.retries < 0 || prior.retries > MAX_THROTTLE_RETRIES_PER_WINDOW) {
        throw new Error("invalid bounded throttle retry enforcement state");
      }
      if (now - prior.windowStart < RESOURCE_POLICY_WINDOW_MS) {
        windowStart = prior.windowStart;
        retries = prior.retries;
      }
    }
    if (retries >= MAX_THROTTLE_RETRIES_PER_WINDOW) return { allowed: false, retries };
    retries += 1;
    await storage.set(THROTTLE_RETRY_BUDGET_KEY, { windowStart, retries });
    return { allowed: true, retries };
  });
}
