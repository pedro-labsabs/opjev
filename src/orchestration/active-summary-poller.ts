import type { ExecutionSummary } from "./summary.ts";

export const ACTIVE_SUMMARY_POLL_INTERVAL_MS = 1500;
export const ACTIVE_SUMMARY_MAX_LIFETIME_MS = 5 * 60 * 1000;

export interface ActiveSummaryPollerScheduler {
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(id: ReturnType<typeof setInterval>): void;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}

export interface ActiveSummarySnapshot {
  runID?: string;
  summary: ExecutionSummary;
}

const defaultScheduler: ActiveSummaryPollerScheduler = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (id) => clearInterval(id),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id),
};

const ACTIVE_PHASES = new Set([
  "planning",
  "ready",
  "running",
  "evaluating",
  "repairing",
  "awaiting-human",
]);
const TERMINAL_PHASES = new Set(["completed", "stopped", "failed"]);

/** Polls a session's read-only summary surface and presents changed active snapshots only. */
export function createActiveSummaryPoller(deps: {
  getSummary(sessionID: string): Promise<ActiveSummarySnapshot>;
  currentSessionID(): string | undefined;
  present(sessionID: string, summary: ExecutionSummary): void;
  scheduler?: ActiveSummaryPollerScheduler;
}, options: {
  intervalMs?: number;
  maxLifetimeMs?: number;
} = {}): { start(sessionID: string): void; stop(): void } {
  const scheduler = deps.scheduler ?? defaultScheduler;
  const intervalMs = Math.max(1, Math.trunc(options.intervalMs ?? ACTIVE_SUMMARY_POLL_INTERVAL_MS));
  const maxLifetimeMs = Math.max(intervalMs, Math.trunc(options.maxLifetimeMs ?? ACTIVE_SUMMARY_MAX_LIFETIME_MS));
  let sessionID: string | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let pollingGeneration: number | undefined;
  let lastSnapshot = "";

  const stop = (): void => {
    generation += 1;
    sessionID = undefined;
    lastSnapshot = "";
    if (interval !== undefined) scheduler.clearInterval(interval);
    if (timeout !== undefined) scheduler.clearTimeout(timeout);
    interval = undefined;
    timeout = undefined;
  };

  const start = (nextSessionID: string): void => {
    if (typeof nextSessionID !== "string" || nextSessionID.trim().length < 4 || nextSessionID.length > 200) {
      stop();
      return;
    }
    const normalized = nextSessionID.trim();
    if (sessionID === normalized) return;
    stop();
    sessionID = normalized;
    const ownGeneration = generation;

    const poll = async (): Promise<void> => {
      if (ownGeneration !== generation || sessionID !== normalized || pollingGeneration === ownGeneration) return;
      let current: string | undefined;
      try {
        current = deps.currentSessionID();
      } catch {
        return;
      }
      if (current !== normalized) {
        stop();
        return;
      }

      pollingGeneration = ownGeneration;
      try {
        const result = await deps.getSummary(normalized);
        if (ownGeneration !== generation || sessionID !== normalized) return;
        // Navigation can happen while the read-only RPC is in flight.
        try {
          current = deps.currentSessionID();
        } catch {
          return;
        }
        if (current !== normalized) {
          stop();
          return;
        }
        const summary = result?.summary;
        if (!summary?.available) return; // transient or unavailable state stays fail-closed; bounded polling may observe recovery
        const runID = typeof result.runID === "string" ? result.runID : "";
        const phase = summary.taskState;
        if (typeof phase !== "string" || !ACTIVE_PHASES.has(phase)) {
          if (typeof phase === "string" && TERMINAL_PHASES.has(phase)) lastSnapshot = `${runID}:${JSON.stringify(summary)}`;
          return;
        }
        const snapshot = `${runID}:${JSON.stringify(summary)}`;
        if (snapshot === lastSnapshot) return;
        deps.present(normalized, summary);
        lastSnapshot = snapshot;
      } catch {
        // Read and presentation failures never create authority or interrupt the run.
      } finally {
        if (pollingGeneration === ownGeneration) pollingGeneration = undefined;
      }
    };

    interval = scheduler.setInterval(() => { void poll(); }, intervalMs);
    timeout = scheduler.setTimeout(stop, maxLifetimeMs);
    (interval as unknown as { unref?: () => void }).unref?.();
    (timeout as unknown as { unref?: () => void }).unref?.();
    void poll();
  };

  return { start, stop };
}
