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
const TOOL_READ_ALLOWLIST = new Set(["read", "glob", "grep"]);
const INTERNAL_ROLES = new Set(["worker", "critic", "orchestrator"]);
const AGENT_ROLES = new Set(["implementer", "critic", "orchestrator"]);
const MAX_REGISTERED_INTERNAL_SESSIONS = 4096;
const registeredInternalSessions = new Map<string, Exclude<InternalToolRole, "external" | "ambiguous">>();

/** Track sessions created by this control plane, bounded for long-lived hosts. */
export function registerInternalToolSession(
  sessionID: string,
  role: Exclude<InternalToolRole, "external" | "ambiguous">,
): void {
  if (!sessionID || sessionID.length > 256) throw new Error("invalid internal session identity");
  registeredInternalSessions.delete(sessionID);
  registeredInternalSessions.set(sessionID, role);
  while (registeredInternalSessions.size > MAX_REGISTERED_INTERNAL_SESSIONS) {
    const oldest = registeredInternalSessions.keys().next().value;
    if (oldest === undefined) break;
    registeredInternalSessions.delete(oldest);
  }
}

/** Resolve only control-plane metadata persisted on the session itself. */
export function resolveInternalToolRole(metadata: unknown, sessionID?: string): InternalToolRole {
  const expectedRole = sessionID ? registeredInternalSessions.get(sessionID) : undefined;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return expectedRole ? "ambiguous" : "external";
  }
  const meta = metadata as Record<string, unknown>;
  const role = meta["jev-role"];
  const agentRole = meta["jev-agent-role"];
  const router = meta["jev-router"];
  const hasInternalClaim = router === INTERNAL_ROUTER_MARKER ||
    (typeof role === "string" && INTERNAL_ROLES.has(role)) ||
    (typeof agentRole === "string" && AGENT_ROLES.has(agentRole));

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

function deny(reason: "session state unavailable" | "role metadata ambiguous" | "local read-only authority"): never {
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

  let role: InternalToolRole;
  try {
    role = resolveInternalToolRole((await ctx.session.get({ sessionID }) as any)?.metadata, sessionID);
  } catch {
    deny("session state unavailable");
  }
  if (role === "external" || role === "worker") return;
  if (role === "ambiguous") deny("role metadata ambiguous");

  const tool = typeof event.tool === "string" ? event.tool : "";
  if (!TOOL_READ_ALLOWLIST.has(tool)) deny("local read-only authority");
}
import { Tool } from "@opencode/schema/tool";
