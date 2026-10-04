import { UsageLedger } from "./usage-ledger.ts";

export const RESOURCE_LEDGER_KEY = "resource/usage-ledger/v1";
export const RESOURCE_LEDGER_CAPACITY = 2048;
const writesByOwner = new WeakMap<object, Promise<void>>();
const queuedByOwner = new WeakMap<object, number>();
export const RESOURCE_LEDGER_PENDING_LIMIT = 256;

/** Persist only the sanitized fixed-capacity ring. Queueing is per plugin owner. */
export function createBoundedStorageObservationSink(
  owner: object,
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> },
): (observation: unknown) => Promise<void> {
  return async (observation) => {
    const queued = queuedByOwner.get(owner) ?? 0;
    if (queued >= RESOURCE_LEDGER_PENDING_LIMIT) return; // telemetry may be dropped; orchestration never waits on an unbounded queue
    queuedByOwner.set(owner, queued + 1);
    const prior = writesByOwner.get(owner) ?? Promise.resolve();
    const write = prior.catch(() => {}).then(async () => {
      const stored: any = await storage.get(RESOURCE_LEDGER_KEY);
      const ledger = new UsageLedger({ capacity: RESOURCE_LEDGER_CAPACITY });
      if (stored && stored.schema === 1 && Array.isArray(stored.observations)) ledger.replace(stored.observations);
      ledger.append(observation);
      await storage.set(RESOURCE_LEDGER_KEY, { schema: 1, capacity: ledger.capacity, observations: ledger.snapshot() });
    });
    writesByOwner.set(owner, write);
    try { await write; } finally {
      queuedByOwner.set(owner, Math.max(0, (queuedByOwner.get(owner) ?? 1) - 1));
      if (writesByOwner.get(owner) === write) writesByOwner.delete(owner);
      if (queuedByOwner.get(owner) === 0) queuedByOwner.delete(owner);
    }
  };
}
