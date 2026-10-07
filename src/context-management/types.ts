export const CONTEXT_SCHEMA = 1 as const;
export const CONTEXT_LEDGER_GROUP_CAPACITY = 2048;
export const CONTEXT_LEDGER_SESSION_CAPACITY = 256;
export const CONTEXT_LEDGER_TTL_MS = 86_400_000;
export const CONTEXT_ASSET_MAX_SERIALIZED_BYTES = 512;
export const CONTEXT_LEDGER_PENDING_LIMIT = 128;
export const CONTEXT_RECENT_GROUPS = 8;
export const CONTEXT_LEDGER_KEY = "context/asset-ledger/v1";

export type ContextRolloutStage =
  | "disabled"
  | "observe"
  | "deterministic-shadow"
  | "deterministic-enforce"
  | "semantic-shadow"
  | "semantic-enforce";
export type RetentionAction = "KEEP" | "KEEP_IDENTITY_TRUNCATE_PAYLOAD" | "DROP";
export type ProtectionState = "protected" | "clear" | "unknown";
export type EvidenceRole =
  | "none"
  | "required-evidence"
  | "deterministic-check"
  | "evidence-packet"
  | "critic-finding"
  | "binding-decision"
  | "unknown";
export type ContextAssetRole = "user-session" | "worker" | "critic" | "orchestrator" | "unknown";
export type ContextAssetSource = "tool-call" | "tool-result" | "tool-failure" | "tool-artifact";

export interface ContextAssetV1 {
  schema: typeof CONTEXT_SCHEMA;
  assetID: string;
  groupID: string;
  sessionRef: string;
  runRef?: string;
  round?: number;
  role: ContextAssetRole;
  source: ContextAssetSource;
  tool: string;
  callRef: string;
  messageRef?: string;
  entityRef?: string;
  payloadBytes?: number;
  fingerprint?: string;
  createdAt: number;
  lastReferencedAt?: number;
  supersededBy?: string;
  evidenceRoles: EvidenceRole[];
  protection: ProtectionState;
  retention: RetentionAction;
  confidence?: "high" | "medium" | "low";
}

export interface ContextToolGroupV1 {
  groupID: string;
  sessionRef: string;
  messageRef?: string;
  call: ContextAssetV1;
  terminal?: ContextAssetV1;
  createdAt: number;
  updatedAt: number;
}
