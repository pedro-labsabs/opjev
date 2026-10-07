import { ContextLedger } from "./ledger.ts";
import { recordContextMetrics } from "./metrics.ts";
import { CONTEXT_LEDGER_KEY } from "./types.ts";
import { estimateRequestBytes, observeContextRequest, observeToolAfter, resolveContextManagementStage, IMPLEMENTED_CONTEXT_STAGES } from "./observer.ts";
import { projectContextProtection } from "./protection.ts";
import { applyProjectionPlan, buildRequestProjectionPlan, requestFingerprint } from "./request-projection.ts";
import type { DeterministicDecision } from "./deterministic-pruner.ts";
import type { RouterOptions } from "../config.ts";

export { IMPLEMENTED_CONTEXT_STAGES };

type Storage = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
type ContextRuntime = {
  storage: Storage;
  session: {
    get(input: { sessionID: string }): Promise<unknown>;
    hook(name: string, callback: (event: unknown) => unknown): Promise<void>;
  };
  tool: { hook(name: string, callback: (event: unknown) => void): Promise<void> };
};
type RequestSnapshot = { sessionID: string; messages: unknown[]; system: unknown; fingerprint?: string; estimatedBytes: number };

/** Register context hooks independently from routing; deterministic-shadow is read-only. */
export async function registerContextManagementHooks(ctx: ContextRuntime, opts: RouterOptions): Promise<void> {
  const stage = resolveContextManagementStage(opts.contextManagementStage);
  if (stage === "disabled") return;
  const deps = {
    storage: ctx.storage,
    owner: ctx,
    getSession: async (sessionID: string) => await ctx.session.get({ sessionID }),
  };
  await ctx.tool.hook("execute.after", (event) => {
    void observeToolAfter(event, deps);
  });
  await ctx.session.hook("context", async (event) => {
    const snapshot = stage === "deterministic-shadow" ? captureRequestSnapshot(event) : undefined;
    await observeContextRequest(event, deps);
    if (stage === "deterministic-shadow") await planShadowRequest(ctx, event, snapshot);
  });
}

function captureRequestSnapshot(event: unknown): RequestSnapshot | undefined {
  try {
    if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
    const value = event as Record<string, unknown>;
    if (typeof value.sessionID !== "string" || !Array.isArray(value.messages)) return undefined;
    const system = "system" in value ? value.system : undefined;
    return { sessionID: value.sessionID, messages: value.messages, system, fingerprint: requestFingerprint(value.messages, system), estimatedBytes: estimateRequestBytes(event) };
  } catch { return undefined; }
}

function requestSnapshotIsCurrent(event: unknown, snapshot: RequestSnapshot): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const value = event as Record<string, unknown>;
  return value.sessionID === snapshot.sessionID && value.messages === snapshot.messages
    && ("system" in value ? value.system : undefined) === snapshot.system
    && snapshot.fingerprint !== undefined && requestFingerprint(snapshot.messages, snapshot.system) === snapshot.fingerprint;
}

async function planShadowRequest(ctx: ContextRuntime, event: unknown, snapshot: RequestSnapshot | undefined): Promise<void> {
  if (!snapshot) return;
  const { sessionID, messages, system, fingerprint: requestFingerprintAtStart } = snapshot;
  let decisions: DeterministicDecision[] = [];
  let valid = false;
  try {
    if (requestFingerprintAtStart === undefined || !requestSnapshotIsCurrent(event, snapshot)) {
      await recordContextMetrics(ctx.storage, { context: { invalidatedPlans: 1 } });
      return;
    }
    const stored = await ctx.storage.get(CONTEXT_LEDGER_KEY);
    const ledger = new ContextLedger();
    if (stored && typeof stored === "object" && !Array.isArray(stored) && "schema" in stored && stored.schema === 1 && "groups" in stored && Array.isArray(stored.groups)) {
      ledger.replace(stored.groups);
    }
    const session = await ctx.session.get({ sessionID });
    const metadata = session && typeof session === "object" && !Array.isArray(session) && "metadata" in session
      ? session.metadata : undefined;
    const protection = await projectContextProtection({
      getSessionMetadata: async () => metadata,
      getRun: async (runID) => await ctx.storage.get(`orchestration/run/${runID}`),
    }, sessionID, ledger.snapshot());
    if (!requestSnapshotIsCurrent(event, snapshot)) {
      await recordContextMetrics(ctx.storage, { context: { invalidatedPlans: 1 } });
      return;
    }
    const plan = buildRequestProjectionPlan({
      sessionID, messages, system, ledger: ledger.snapshot(), protection, requestFingerprintAtStart,
    });
    const result = applyProjectionPlan(plan, messages, system);
    decisions = result.decisions;
    valid = result.valid;
    const current = event && typeof event === "object" && !Array.isArray(event) ? event as Record<string, unknown> : {};
    const afterBytes = estimateRequestBytes({ ...current, messages: result.messages, system });
    await recordContextMetrics(ctx.storage, {
      context: {
        plannedGroups: decisions.length,
        proposedKeep: decisions.filter((item) => item.action === "KEEP").length,
        proposedTruncate: decisions.filter((item) => item.action === "KEEP_IDENTITY_TRUNCATE_PAYLOAD").length,
        proposedDrop: decisions.filter((item) => item.action === "DROP").length,
        invalidatedPlans: valid ? 0 : 1,
        unknownGroups: decisions.filter((item) => item.reason === "unknown-protection" || item.reason === "request-shape-unknown" || item.reason === "request-pair-mismatch" || item.reason === "request-payload-mismatch").length,
        estimatedRequestBytesBeforeTotal: snapshot.estimatedBytes,
        estimatedRequestBytesAfterTotal: afterBytes,
        protectedGroups: protection.groups.filter((item) => item.state === "protected").length,
        unknownProtectionGroups: protection.groups.filter((item) => item.state === "unknown").length,
        userSessionUnlinkedGroups: protection.groups.filter((item) => item.reason === "user-session-unlinked").length,
        protectedRoleGroups: protection.groups.filter((item) => item.reason === "protected-role").length,
        workerRoundProtectedGroups: protection.groups.filter((item) => item.reason === "worker-round-evidence").length,
        canonicalStateUnknownGroups: protection.groups.filter((item) => item.reason === "canonical-state-unknown").length,
        groupIdentityUnknownGroups: protection.groups.filter((item) => item.reason === "group-identity-unknown").length,
        recentGroups: decisions.filter((item) => item.reason === "recent-group").length,
        incompleteGroups: decisions.filter((item) => item.reason === "incomplete-group").length,
        unknownRoleGroups: decisions.filter((item) => item.reason === "unknown-role").length,
        malformedGroups: decisions.filter((item) => item.reason === "malformed-group").length,
        unprovenRelationGroups: decisions.filter((item) => item.reason === "relation-unproven").length,
        requestShapeUnknownGroups: decisions.filter((item) => item.reason === "request-shape-unknown").length,
        requestPairMismatchGroups: decisions.filter((item) => item.reason === "request-pair-mismatch").length,
        requestPayloadMismatchGroups: decisions.filter((item) => item.reason === "request-payload-mismatch").length,
      },
    });
    if (valid && !requestSnapshotIsCurrent(event, snapshot)) {
      await recordContextMetrics(ctx.storage, { context: { invalidatedPlans: 1 } });
    } else if (valid && result.messages === messages && requestSnapshotIsCurrent(event, snapshot)) {
      void recordContextMetrics(ctx.storage, { context: { requestSnapshotsUnchanged: 1 } });
    }
  } catch {
    try { await recordContextMetrics(ctx.storage, { context: { invalidatedPlans: 1 } }); } catch { /* fail closed */ }
  }
}
