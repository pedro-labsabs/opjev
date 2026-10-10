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
export interface InternalWorkerBinding {
  runID: string;
  round: number;
  model: string;
}
interface InternalToolSessionEntry {
  role: Exclude<InternalToolRole, "external" | "ambiguous">;
  fenced: boolean;
  binding?: InternalWorkerBinding;
}
const registeredInternalSessions = new Map<string, InternalToolSessionEntry>();

const MODEL_REF = /^[A-Za-z0-9._-]{1,80}\/[A-Za-z0-9._:-]{1,120}$/;

function validWorkerBinding(value: unknown): value is InternalWorkerBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return typeof binding.runID === "string" &&
    binding.runID.length > 0 && binding.runID.length <= 200 &&
    binding.runID.trim() === binding.runID &&
    Number.isSafeInteger(binding.round) && Number(binding.round) > 0 &&
    typeof binding.model === "string" && MODEL_REF.test(binding.model);
}
export function assertInternalWorkerBinding(value: unknown): asserts value is InternalWorkerBinding {
  if (!validWorkerBinding(value)) throw new Error("invalid worker session binding");
}

function sameBinding(left: InternalWorkerBinding, right: InternalWorkerBinding): boolean {
  return left.runID === right.runID && left.round === right.round && left.model === right.model;
}

function runtimeModelRef(info: unknown): string | undefined {
  if (!info || typeof info !== "object" || Array.isArray(info)) return undefined;
  const model = (info as Record<string, unknown>).model;
  if (typeof model === "string") return MODEL_REF.test(model) ? model : undefined;
  if (!model || typeof model !== "object" || Array.isArray(model)) return undefined;
  const value = model as Record<string, unknown>;
  if (typeof value.providerID !== "string" || typeof value.id !== "string") return undefined;
  const ref = `${value.providerID}/${value.id}`;
  return MODEL_REF.test(ref) ? ref : undefined;
}

const TOOL_SESSION_LOOKUP_TIMEOUT_MS = 250;

async function readSessionBounded(
  ctx: { session: { get: (input: { sessionID: string }) => Promise<unknown> } },
  sessionID: string,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ctx.session.get({ sessionID }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("session lookup timed out")), TOOL_SESSION_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
let internalToolRegistrySaturated = false;

/** Track sessions created by this control plane, bounded for long-lived hosts. */
export function registerInternalToolSession(
  sessionID: string,
  role: Exclude<InternalToolRole, "external" | "ambiguous">,
  binding?: InternalWorkerBinding,
): void {
  if (!sessionID || sessionID.length > 256) throw new Error("invalid internal session identity");
  if (role === "worker" && binding !== undefined) assertInternalWorkerBinding(binding);
  if (role !== "worker" && binding !== undefined) throw new Error("only workers may have executor bindings");
  const existing = registeredInternalSessions.get(sessionID);
  if (existing) {
    if (existing.fenced) throw new Error("internal session fenced; refusing reuse");
    if (existing.role !== role) {
      existing.fenced = true;
      throw new Error("internal session role conflict; session fenced");
    }
    if (binding && role === "worker") {
      if (existing.binding && !sameBinding(existing.binding, binding)) {
        existing.fenced = true;
        throw new Error("worker session binding conflict; session fenced");
      }
      existing.binding ??= { ...binding };
    }
    return;
  }
  if (internalToolRegistrySaturated) throw new Error("internal tool registry saturated; fail-closed");
  if (registeredInternalSessions.size >= MAX_REGISTERED_INTERNAL_SESSIONS) {
    const evictable = [...registeredInternalSessions].find(([, entry]) => !entry.fenced)?.[0];
    if (evictable) registeredInternalSessions.delete(evictable);
    else {
      // Fenced sessions may still be executing. Saturation fails closed for all
      // internal tools instead of evicting a fence and allowing late effects.
      internalToolRegistrySaturated = true;
      throw new Error("internal tool registry saturated; fail-closed");
    }
  }
  registeredInternalSessions.set(sessionID, { role, fenced: false, ...(binding ? { binding: { ...binding } } : {}) });
}

/** Advance a reused worker only to the next same-model round approved by its caller. */
export function bindInternalWorkerSession(sessionID: string, binding: InternalWorkerBinding): void {
  if (!validWorkerBinding(binding)) throw new Error("invalid worker session binding");
  const entry = registeredInternalSessions.get(sessionID);
  if (!entry || entry.role !== "worker" || entry.fenced) throw new Error("worker session unavailable or fenced");
  if (!entry.binding) {
    entry.binding = { ...binding };
    return;
  }
  if (sameBinding(entry.binding, binding)) return;
  if (
    entry.binding.runID === binding.runID &&
    entry.binding.model === binding.model &&
    binding.round === entry.binding.round + 1
  ) {
    entry.binding = { ...binding };
    return;
  }
  entry.fenced = true;
  throw new Error("worker session binding transition denied; session fenced");
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

function deny(reason:
  | "session state unavailable"
  | "role metadata ambiguous"
  | "worker model contract unavailable"
  | "worker model mismatch"
  | "local read-only authority"
  | "session fenced"
): never {
  throw new Tool.Error({ message: `OPJEV_INTERNAL_TOOL_DENIED: ${reason}` });
}

/**
 * Called by OpenCode's `tool.execute.before` hook. Worker tools require a
 * control-plane binding and an exact model read from the host session state.
 */
export async function enforceInternalToolAuthority(
  ctx: { session: { get: (input: { sessionID: string }) => Promise<unknown> } },
  event: { sessionID?: unknown; tool?: unknown },
): Promise<void> {
  const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
  if (!sessionID) deny("session state unavailable");
  const registered = registeredInternalSessions.get(sessionID);
  if (registered?.fenced) deny("session fenced");

  let info: unknown;
  let role: InternalToolRole;
  try {
    info = await readSessionBounded(ctx, sessionID);
    const metadata = info && typeof info === "object" && !Array.isArray(info) && "metadata" in info
      ? info.metadata
      : undefined;
    role = resolveInternalToolRole(metadata, sessionID);
  } catch {
    if (registered?.role === "worker") registered.fenced = true;
    deny("session state unavailable");
  }

  const entry = registeredInternalSessions.get(sessionID);
  if (entry?.fenced) deny("session fenced");
  if (role === "external") return;
  if (internalToolRegistrySaturated) deny("session fenced");
  if (role === "worker") {
    if (!entry || entry.role !== "worker") deny("role metadata ambiguous");
    if (!entry.binding) {
      entry.fenced = true;
      deny("worker model contract unavailable");
    }
    const observedModel = runtimeModelRef(info);
    if (!observedModel) {
      entry.fenced = true;
      deny("worker model contract unavailable");
    }
    if (observedModel !== entry.binding.model) {
      entry.fenced = true;
      deny("worker model mismatch");
    }
    return;
  }
  if (role === "ambiguous") {
    if (entry?.role === "worker") entry.fenced = true;
    deny("role metadata ambiguous");
  }

  const tool = typeof event.tool === "string" ? event.tool : "";
  if (!Object.hasOwn(TOOL_READ_ALLOWLIST, tool)) deny("local read-only authority");
}

import { Tool } from "@opencode/schema/tool";
