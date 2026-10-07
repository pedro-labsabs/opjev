import { ContextLedger } from "./ledger.ts";
import { recordContextMetrics } from "./metrics.ts";
import { CONTEXT_LEDGER_KEY } from "./types.ts";
import { observeContextRequest, observeToolAfter, resolveContextManagementStage, IMPLEMENTED_CONTEXT_STAGES } from "./observer.ts";
import { projectContextProtection } from "./protection.ts";
import { applyProjectionPlan, buildRequestProjectionPlan } from "./request-projection.ts";
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
    await observeContextRequest(event, deps);
    if (stage === "deterministic-shadow") await planShadowRequest(ctx, event);
  });
}

async function planShadowRequest(ctx: ContextRuntime, event: unknown): Promise<void> {
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  if (!("sessionID" in event) || typeof event.sessionID !== "string" || !("messages" in event) || !Array.isArray(event.messages)) return;
  const sessionID = event.sessionID;
  const messages = event.messages;
  const system = "system" in event ? event.system : undefined;
  let decisions: DeterministicDecision[] = [];
  let valid = false;
  try {
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
    const plan = buildRequestProjectionPlan({ sessionID, messages, system, ledger: ledger.snapshot(), protection });
    const result = applyProjectionPlan(plan, messages, system);
    decisions = result.decisions;
    valid = result.valid;
    await recordContextMetrics(ctx.storage, {
      context: {
        bytePreservedRequests: valid ? 1 : 0,
        plannedGroups: decisions.length,
        proposedKeep: decisions.filter((item) => item.action === "KEEP").length,
        proposedTruncate: decisions.filter((item) => item.action === "KEEP_IDENTITY_TRUNCATE_PAYLOAD").length,
        proposedDrop: decisions.filter((item) => item.action === "DROP").length,
        invalidatedPlans: valid ? 0 : 1,
        unknownGroups: decisions.filter((item) => item.reason === "unknown-protection" || item.reason === "request-shape-unknown" || item.reason === "request-pair-mismatch").length,
      },
    });
  } catch {
    try { await recordContextMetrics(ctx.storage, { context: { invalidatedPlans: 1 } }); } catch { /* fail closed */ }
  }
}
