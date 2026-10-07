import { hashStableRef } from "./identity.ts";
import type { ContextAssetRole, ContextToolGroupV1 } from "./types.ts";

export type ContextProtectionReason =
  | "user-session-unlinked"
  | "protected-role"
  | "worker-round-evidence"
  | "canonical-state-unknown"
  | "group-identity-unknown";
export type ContextProtectionState = "protected" | "clear" | "unknown";
export interface ContextProtectionGroup {
  groupID: string;
  state: ContextProtectionState;
  reason: ContextProtectionReason;
}
export interface ContextProtectionSnapshot {
  role: ContextAssetRole;
  runRef?: string;
  round?: number;
  checkpointIdentity?: string;
  checkpointVersion?: number;
  groups: ContextProtectionGroup[];
}
export interface ContextProtectionDeps {
  getSessionMetadata(sessionID: string): Promise<unknown>;
  getRun(runID: string): Promise<unknown>;
  isFingerprintCurrent(fingerprint: string): boolean;
}
const INTERNAL_ROLES = new Set(["worker", "critic", "orchestrator"]);
const GROUP_ID = /^[a-f0-9]{64}$/;
const CHECKPOINTS = new Set([
  "worker-created", "evidence-ready", "verdict-applied", "contract-revised",
  "human-awaiting", "human-decision", "run-failed",
]);

/** Read-only projection; absent exact provenance never creates pruning permission. */
export async function projectContextProtection(
  deps: ContextProtectionDeps,
  sessionID: string,
  groups: readonly ContextToolGroupV1[],
): Promise<ContextProtectionSnapshot> {
  let metadata: Record<string, unknown> | undefined;
  try {
    const value = await deps.getSessionMetadata(sessionID);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      metadata = record.metadata !== null && typeof record.metadata === "object" && !Array.isArray(record.metadata)
        ? record.metadata as Record<string, unknown> : record;
    }
  } catch { /* unknown is fail-closed */ }

  const roleValue = metadata?.["jev-role"];
  const router = metadata?.["jev-router"];
  const role: ContextAssetRole = router === "orchestration-internal" && INTERNAL_ROLES.has(String(roleValue))
    ? roleValue as ContextAssetRole
    : metadata && roleValue === undefined && router === undefined
      && metadata["jev-run-id"] === undefined && metadata["jev-round"] === undefined
      ? "user-session" : "unknown";

  if (role === "critic" || role === "orchestrator") {
    return { role, groups: groups.map((group) => ({ groupID: group.groupID, state: "protected", reason: "protected-role" })) };
  }
  if (role === "user-session") {
    const sessionRef = hashStableRef(sessionID);
    return {
      role,
      groups: groups.map((group) => matchesGroupIdentity(group, role, sessionRef, undefined, undefined, deps.isFingerprintCurrent)
        ? { groupID: group.groupID, state: "clear", reason: "user-session-unlinked" }
        : { groupID: group.groupID, state: "unknown", reason: "group-identity-unknown" }),
    };
  }
  if (role !== "worker") {
    return { role, groups: groups.map((group) => ({ groupID: group.groupID, state: "unknown", reason: "canonical-state-unknown" })) };
  }

  const runID = metadata?.["jev-run-id"];
  const round = metadata?.["jev-round"];
  if (typeof runID !== "string" || runID.length === 0 || !Number.isSafeInteger(round) || Number(round) < 1) {
    return { role, groups: groups.map((group) => ({ groupID: group.groupID, state: "unknown", reason: "canonical-state-unknown" })) };
  }
  let checkpoint: unknown;
  try { checkpoint = await deps.getRun(runID); } catch { /* unknown is fail-closed */ }
  if (!isRecord(checkpoint) || !CHECKPOINTS.has(String(checkpoint.checkpoint)) || !isRecord(checkpoint.state)
    || !isRecord(checkpoint.state.contract) || checkpoint.state.contract.runID !== runID
    || checkpoint.state.round !== round || checkpoint.workerSessionID !== sessionID
    || typeof checkpoint.updatedAt !== "number" || !Number.isSafeInteger(checkpoint.updatedAt) || checkpoint.updatedAt <= 0) {
    return { role, runRef: hashStableRef(runID), round: Number(round), groups: groups.map((group) => ({ groupID: group.groupID, state: "unknown", reason: "canonical-state-unknown" })) };
  }
  const checkpointUpdatedAt = checkpoint.updatedAt;

  const sessionRef = hashStableRef(sessionID);
  const runRef = hashStableRef(runID);
  const projected = groups.map((group) => {
    if (!matchesGroupIdentity(group, role, sessionRef, runRef, Number(round), deps.isFingerprintCurrent) || group.updatedAt > checkpointUpdatedAt) {
      return { groupID: group.groupID, state: "unknown" as const, reason: "group-identity-unknown" as const };
    }
    // The checkpoint has no part-to-evidence provenance, so protect this complete round.
    return { groupID: group.groupID, state: "protected" as const, reason: "worker-round-evidence" as const };
  });
  return {
    role, runRef, round: Number(round), checkpointIdentity: runID,
    checkpointVersion: checkpointUpdatedAt, groups: projected,
  };
}

function matchesGroupIdentity(
  group: ContextToolGroupV1,
  role: ContextAssetRole,
  sessionRef: string,
  runRef: string | undefined,
  round: number | undefined,
  isFingerprintCurrent: (fingerprint: string) => boolean,
): boolean {
  const terminal = group.terminal;
  if (!terminal || !GROUP_ID.test(group.groupID) || group.sessionRef !== sessionRef
    || !positiveTime(group.createdAt) || !positiveTime(group.updatedAt) || group.updatedAt < group.createdAt) return false;
  const assets = [group.call, terminal];
  return group.call.source === "tool-call" && (terminal.source === "tool-result" || terminal.source === "tool-failure")
    && terminal.callRef === group.call.callRef
    && assets.every((asset) => GROUP_ID.test(asset.assetID) && asset.groupID === group.groupID
      && asset.sessionRef === sessionRef && asset.callRef === group.call.callRef && asset.role === role
      && (runRef === undefined ? asset.runRef === undefined : asset.runRef === runRef)
      && (round === undefined ? asset.round === undefined : asset.round === round)
      && GROUP_ID.test(asset.fingerprint ?? "") && currentFingerprint(asset.fingerprint, isFingerprintCurrent) && positiveTime(asset.createdAt))
    && terminal.createdAt >= group.call.createdAt;
}

function currentFingerprint(fingerprint: string | undefined, verify: (fingerprint: string) => boolean): boolean {
  if (!fingerprint) return false;
  try { return verify(fingerprint) === true; } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positiveTime(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
