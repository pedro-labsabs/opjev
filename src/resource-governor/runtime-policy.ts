import { withKeyedLock } from "../lock.ts";
import { aggregateUsage } from "./usage-ledger.ts";
import { estimateResourcePressure } from "./pressure-estimator.ts";
import { decideResourceBudget, RESOURCE_POLICY_WINDOW_MS, type BudgetStage, type ResourceBudgetDecision } from "./budget-policy.ts";
import { readQuotaLatch, RESOURCE_ENFORCEMENT_LOCK, type ResourceEnforcementStorage } from "./enforcement-state.ts";

export const RESOURCE_LEDGER_KEY = "resource/usage-ledger/v1";

/** Reads enforcement state and best-effort telemetry under the quota-latch lock. */
export async function evaluateResourceBudget(
  storage: ResourceEnforcementStorage,
  input: { stage: BudgetStage; maxRounds: number; round: number },
  now = Date.now(),
): Promise<ResourceBudgetDecision> {
  return withKeyedLock(RESOURCE_ENFORCEMENT_LOCK, async () => {
    const quotaLatch = await readQuotaLatch(storage, now);
    const stored: any = await storage.get(RESOURCE_LEDGER_KEY);
    if (stored !== undefined && stored !== null && (stored.schema !== 1 || !Array.isArray(stored.observations))) {
      throw new Error("invalid bounded resource observation ledger");
    }
    const observations = stored?.schema === 1 ? stored.observations : [];
    const pressure = estimateResourcePressure(aggregateUsage(observations, { from: now - RESOURCE_POLICY_WINDOW_MS, to: now }), now);
    return decideResourceBudget({ pressure, hardQuotaLatch: quotaLatch, ...input });
  });
}
