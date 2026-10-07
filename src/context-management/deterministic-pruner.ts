import { CONTEXT_RECENT_GROUPS, type ContextToolGroupV1, type ProtectionState, type RetentionAction } from "./types.ts";
import type { ContextProtectionSnapshot } from "./protection.ts";

export type DeterministicReason =
  | "incomplete-group"
  | "protected"
  | "unknown-protection"
  | "recent-group"
  | "unknown-role"
  | "malformed-group"
  | "relation-unproven"
  | "request-shape-unknown"
  | "request-pair-mismatch"
  | "request-payload-mismatch";
export interface DeterministicDecision {
  groupID: string;
  action: RetentionAction;
  reason: DeterministicReason;
  source: "deterministic";
}
export interface ClassifyContextGroupsInput {
  groups: readonly ContextToolGroupV1[];
  protection: Pick<ContextProtectionSnapshot, "groups" | "role">;
  recentGroupIDs?: readonly string[];
}

/** This boundary has no verified tool adapters; every equivalence/supersession stays relation-unproven/KEEP. */
export function classifyContextGroups(input: ClassifyContextGroupsInput): DeterministicDecision[] {
  const protectedByID = new Map(input.protection.groups.map((group) => [group.groupID, group.state]));
  const recent = new Set(input.recentGroupIDs ?? newestCompleteGroups(input.groups));
  return input.groups.map((group) => {
    let reason: DeterministicReason = "relation-unproven";
    const members = [group.call, ...(group.terminal ? [group.terminal] : [])];
    const protection: ProtectionState | undefined = protectedByID.get(group.groupID);
    if (input.protection.role === "critic" || input.protection.role === "orchestrator" || protection === "protected"
      || members.some((asset) => asset.protection === "protected")) reason = "protected";
    else if (input.protection.role === "unknown" || protection === undefined || protection === "unknown") reason = "unknown-protection";
    else if (!group.terminal) reason = "incomplete-group";
    else if (recent.has(group.groupID)) reason = "recent-group";
    else if (input.protection.role !== "user-session" && input.protection.role !== "worker") reason = "unknown-role";
    else if (!/^[a-f0-9]{64}$/.test(group.groupID) || !/^[a-f0-9]{64}$/.test(group.sessionRef)
      || !Number.isSafeInteger(group.createdAt) || !Number.isSafeInteger(group.updatedAt)
      || members.some((asset) => !/^[a-f0-9]{64}$/.test(asset.assetID) || !/^[a-f0-9]{64}$/.test(asset.callRef)
        || !/^[a-f0-9]{64}$/.test(asset.fingerprint ?? "") || asset.groupID !== group.groupID
        || asset.sessionRef !== group.sessionRef || asset.callRef !== group.call.callRef
        || asset.role !== group.call.role || asset.tool !== group.call.tool)
      || group.call.source !== "tool-call" || (group.terminal.source !== "tool-result" && group.terminal.source !== "tool-failure")) reason = "malformed-group";
    else reason = "relation-unproven";
    return { groupID: group.groupID, action: "KEEP", reason, source: "deterministic" };
  });
}

function newestCompleteGroups(groups: readonly ContextToolGroupV1[]): string[] {
  const bySession = new Map<string, ContextToolGroupV1[]>();
  for (const group of groups) {
    if (!group.terminal) continue;
    const sessionGroups = bySession.get(group.sessionRef) ?? [];
    sessionGroups.push(group);
    bySession.set(group.sessionRef, sessionGroups);
  }
  const recent: string[] = [];
  for (const sessionGroups of bySession.values()) {
    sessionGroups.sort((a, b) => b.createdAt - a.createdAt || a.groupID.localeCompare(b.groupID));
    recent.push(...sessionGroups.slice(0, CONTEXT_RECENT_GROUPS).map((group) => group.groupID));
  }
  return recent;
}
