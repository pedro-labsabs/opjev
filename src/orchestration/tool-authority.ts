/** Logical session role used only for local tool authorization. */
export type InternalToolRole = "external" | "worker" | "critic" | "orchestrator" | "ambiguous";

/**
 * Permissions sent with critic/orchestrator sessions keep tools in the
 * provider request for Zen compatibility. They are not local authorization;
 * `tool.execute.before` applies the restrictive role policy before execution.
 */
export const PROVIDER_COMPATIBILITY_PERMISSIONS = [
  { action: "*", resource: "*", effect: "allow" },
  // Preserve non-tool invariants from the previous session envelope. The
  // generic allow keeps read in the advertised registry; these path rules are
  // still enforced by OpenCode's local Permission API at tool execution.
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "deny" },
] as const;

const INTERNAL_ROUTER_MARKER = "orchestration-internal";
const TOOL_READ_ALLOWLIST = { read: true, glob: true, grep: true } as const;
const INTERNAL_ROLES = { worker: true, critic: true, orchestrator: true } as const;
const AGENT_ROLES = { implementer: true, critic: true, orchestrator: true } as const;
const MAX_REGISTERED_INTERNAL_SESSIONS = 4096;
const registeredInternalSessions = new Map<string, { role: Exclude<InternalToolRole, "external" | "ambiguous">; fenced: boolean }>();
let internalToolRegistrySaturated = false;

/** Track sessions created by this control plane, bounded for long-lived hosts. */
export function registerInternalToolSession(
  sessionID: string,
  role: Exclude<InternalToolRole, "external" | "ambiguous">,
): void {
  if (!sessionID || sessionID.length > 256) throw new Error("invalid internal session identity");
  if (registeredInternalSessions.has(sessionID)) return;
  if (registeredInternalSessions.size >= MAX_REGISTERED_INTERNAL_SESSIONS) {
    const evictable = [...registeredInternalSessions].find(([, entry]) => !entry.fenced)?.[0];
    if (evictable) registeredInternalSessions.delete(evictable);
    else {
      // Fenced sessions may still be executing. Saturation fails closed for all
      // internal tools instead of evicting a fence and allowing late effects.
      internalToolRegistrySaturated = true;
      return;
    }
  }
  registeredInternalSessions.set(sessionID, { role, fenced: false });
}

/** Revoke all future tools before requesting runtime interruption. */
export function fenceInternalToolSession(sessionID: string): void {
  const entry = registeredInternalSessions.get(sessionID);
  if (entry) entry.fenced = true;
  else internalToolRegistrySaturated = true;
}

export function assertInternalToolRegistryAvailable(): void {
  if (internalToolRegistrySaturated) throw new Error("internal tool registry saturated; fail-closed");
}

/** Resolve only control-plane metadata persisted on the session itself. */
export function resolveInternalToolRole(metadata: unknown, sessionID?: string): InternalToolRole {
  const expectedRole = sessionID ? registeredInternalSessions.get(sessionID)?.role : undefined;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return expectedRole ? "ambiguous" : "external";
  }
  const meta = metadata as Record<string, unknown>;
  const role = meta["jev-role"];
  const agentRole = meta["jev-agent-role"];
  const router = meta["jev-router"];
  const hasInternalClaim = router === INTERNAL_ROUTER_MARKER ||
    (typeof role === "string" && Object.hasOwn(INTERNAL_ROLES, role)) ||
    (typeof agentRole === "string" && Object.hasOwn(AGENT_ROLES, agentRole));

  if (!hasInternalClaim) return expectedRole ? "ambiguous" : "external";
  if (router !== INTERNAL_ROUTER_MARKER) return "ambiguous";
  const resolved = role === "worker" && agentRole === "implementer"
    ? "worker"
    : role === "critic" && agentRole === "critic"
      ? "critic"
      : role === "orchestrator" && agentRole === "orchestrator"
        ? "orchestrator"
        : "ambiguous";
  if (resolved === "ambiguous" || (expectedRole && resolved !== expectedRole)) return "ambiguous";
  return resolved;
}

function deny(reason: "session state unavailable" | "role metadata ambiguous" | "local read-only authority" | "session fenced"): never {
  throw new Tool.Error({ message: `OPJEV_INTERNAL_TOOL_DENIED: ${reason}` });
}

/**
 * Called by OpenCode's `tool.execute.before` hook. Reject with OpenCode's
 * typed Tool.Error so its Promise adapter can carry the failure through the
 * Effect hook contract without converting an arbitrary Error into a defect.
 * Unknown internal roles and unreadable session state fail closed.
 */
export async function enforceInternalToolAuthority(
  ctx: { session: { get: (input: { sessionID: string }) => Promise<unknown> } },
  event: { sessionID?: unknown; tool?: unknown },
): Promise<void> {
  const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
  if (!sessionID) deny("session state unavailable");
  if (internalToolRegistrySaturated || registeredInternalSessions.get(sessionID)?.fenced) deny("session fenced");

  let role: InternalToolRole;
  try {
    const info = await ctx.session.get({ sessionID });
    const metadata = info && typeof info === "object" && !Array.isArray(info) && "metadata" in info
      ? info.metadata
      : undefined;
    role = resolveInternalToolRole(metadata, sessionID);
  } catch {
    deny("session state unavailable");
  }
  if (role === "external" || role === "worker") return;
  if (role === "ambiguous") deny("role metadata ambiguous");

  const tool = typeof event.tool === "string" ? event.tool : "";
  if (!Object.hasOwn(TOOL_READ_ALLOWLIST, tool)) deny("local read-only authority");
}

import { Tool } from "@opencode/schema/tool";
