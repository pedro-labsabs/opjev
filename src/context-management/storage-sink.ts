import { ContextLedger, serializeContextGroup } from "./ledger.ts";
import {
  CONTEXT_LEDGER_GROUP_CAPACITY,
  CONTEXT_LEDGER_KEY,
  CONTEXT_LEDGER_PENDING_LIMIT,
} from "./types.ts";
import type { ContextToolGroupV1 } from "./types.ts";

type ContextStorage = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
};

const writesByOwner = new WeakMap<object, Promise<void>>();
const queuedByOwner = new WeakMap<object, number>();

/** Serialized bounded metadata writes; saturation and storage failures lose observation only. */
export function createContextAssetSink(
  owner: object,
  storage: ContextStorage,
  options: { now?: () => number } = {},
): (group: ContextToolGroupV1) => Promise<boolean> {
  return async (group) => {
    const queued = queuedByOwner.get(owner) ?? 0;
    if (queued >= CONTEXT_LEDGER_PENDING_LIMIT) return false;
    queuedByOwner.set(owner, queued + 1);
    const previous = writesByOwner.get(owner) ?? Promise.resolve();
    let accepted = false;
    const write = previous.catch(() => {}).then(async () => {
      const stored = await storage.get(CONTEXT_LEDGER_KEY);
      const ledger = new ContextLedger({ now: options.now });
      if (
        stored && typeof stored === "object" &&
        (stored as Record<string, unknown>).schema === 1 &&
        Array.isArray((stored as Record<string, unknown>).groups)
      ) {
        ledger.replace((stored as { groups: unknown[] }).groups);
      }
      accepted = ledger.upsertGroup(group);
      if (!accepted) return;
      await storage.set(CONTEXT_LEDGER_KEY, {
        schema: 1,
        capacity: CONTEXT_LEDGER_GROUP_CAPACITY,
        groups: ledger.snapshot().map(serializeContextGroup),
      });
    });
    writesByOwner.set(owner, write);
    try {
      await write;
      return accepted;
    } catch {
      return false;
    } finally {
      queuedByOwner.set(owner, Math.max(0, (queuedByOwner.get(owner) ?? 1) - 1));
      if (writesByOwner.get(owner) === write) writesByOwner.delete(owner);
      if (queuedByOwner.get(owner) === 0) queuedByOwner.delete(owner);
    }
  };
}
