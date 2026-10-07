import { createHash } from "node:crypto";
import { classifyContextGroups, type DeterministicDecision, type DeterministicReason } from "./deterministic-pruner.ts";
import { hashStableRef } from "./identity.ts";
import { CONTEXT_LEDGER_SESSION_CAPACITY, type ContextToolGroupV1 } from "./types.ts";
import type { ContextProtectionSnapshot } from "./protection.ts";

export interface ProjectionPlan {
  sessionID: string;
  requestFingerprint?: string;
  decisions: DeterministicDecision[];
}
export interface ProjectionResult {
  valid: boolean;
  messages: unknown[];
  decisions: DeterministicDecision[];
}
export interface BuildRequestProjectionInput {
  sessionID: string;
  messages: unknown[];
  system: unknown;
  ledger: readonly ContextToolGroupV1[];
  protection: ContextProtectionSnapshot;
}

/** Plans are descriptive only in this PR; no retention action is applied. */
export function buildRequestProjectionPlan(input: BuildRequestProjectionInput): ProjectionPlan {
  const sessionRef = hashStableRef(input.sessionID);
  const groups = input.ledger.filter((group) => group.sessionRef === sessionRef).slice(0, CONTEXT_LEDGER_SESSION_CAPACITY);
  let decisions = classifyContextGroups({ groups, protection: input.protection });
  let shape: "valid" | "unknown" | "mismatch" = inspectMessagePairs(input.messages);
  if (shape !== "valid") {
    const reason: DeterministicReason = shape === "unknown" ? "request-shape-unknown" : "request-pair-mismatch";
    decisions = decisions.map((decision) => ({ ...decision, action: "KEEP", reason }));
  } else {
    const pairs = collectPairs(input.messages);
    decisions = decisions.map((decision) => {
      const group = groups.find((candidate) => candidate.groupID === decision.groupID);
      const id = group && [...pairs.calls.keys()].find((callID) => hashStableRef(`${input.sessionID}\u0000${callID}`) === group.groupID);
      if (!group || !id || pairs.calls.get(id) !== 1 || pairs.results.get(id) !== 1) {
        return { ...decision, action: "KEEP", reason: "request-pair-mismatch" };
      }
      return decision;
    });
  }
  return { sessionID: input.sessionID, requestFingerprint: requestFingerprint(input.messages, input.system), decisions };
}

/** Revalidation is the only operation here. Shadow always returns the supplied original array. */
export function applyProjectionPlan(plan: ProjectionPlan, messages: unknown[], system: unknown): ProjectionResult {
  const current = requestFingerprint(messages, system);
  const valid = current !== undefined && plan.requestFingerprint !== undefined && current === plan.requestFingerprint;
  return { valid, messages, decisions: plan.decisions };
}

function requestFingerprint(messages: unknown, system: unknown): string | undefined {
  try {
    const serialized = JSON.stringify([messages, system]);
    if (serialized === undefined) return undefined;
    return createHash("sha256").update(serialized).digest("hex");
  } catch { return undefined; }
}

function inspectMessagePairs(messages: unknown[]): "valid" | "unknown" | "mismatch" {
  if (!Array.isArray(messages)) return "unknown";
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return "unknown";
    const item = message as Record<string, unknown>;
    if (typeof item.role !== "string" || !Array.isArray(item.content)) return "unknown";
    if (!(["user", "assistant", "tool", "system"] as string[]).includes(item.role)) return "unknown";
    for (const part of item.content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) return "unknown";
      const value = part as Record<string, unknown>;
      if (value.type === "tool-call" || value.type === "tool-result") {
        if (typeof value.id !== "string" || value.id.length === 0 || typeof value.name !== "string") return "mismatch";
        const counts = value.type === "tool-call" ? calls : results;
        counts.set(value.id, (counts.get(value.id) ?? 0) + 1);
      } else if (!(["text", "media", "reasoning", "redacted-reasoning", "file", "source", "document", "image", "audio", "video", "compaction", "effort"] as string[]).includes(String(value.type))) {
        return "unknown";
      }
    }
  }
  for (const [id, count] of calls) if (count !== 1 || results.get(id) !== 1) return "mismatch";
  for (const [id, count] of results) if (count !== 1 || calls.get(id) !== 1) return "mismatch";
  return "valid";
}

function collectPairs(messages: unknown[]): { calls: Map<string, number>; results: Map<string, number> } {
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const message of messages) {
    const item = message as { content: Array<{ type?: string; id?: string }> };
    for (const part of item.content) {
      if (typeof part.id !== "string") continue;
      if (part.type === "tool-call") calls.set(part.id, (calls.get(part.id) ?? 0) + 1);
      if (part.type === "tool-result") results.set(part.id, (results.get(part.id) ?? 0) + 1);
    }
  }
  return { calls, results };
}
