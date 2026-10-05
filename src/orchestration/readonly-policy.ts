import { PROVIDER_COMPATIBILITY_PERMISSIONS } from "./tool-authority.ts";

/**
 * Provider-facing compatibility rules. OpenCode uses session permissions
 * while building the model tool registry, so hard-deny rules hide tools from
 * providers that reject a reduced toolset. These allows advertise tools only;
 * `tool.execute.before` remains the local authority boundary for critic and
 * orchestrator sessions.
 */
export function buildCriticProviderPermissions(): readonly { action: string; resource: string; effect: "allow" | "deny" }[] {
  return PROVIDER_COMPATIBILITY_PERMISSIONS;
}

export function buildOrchestratorProviderPermissions(): readonly { action: string; resource: string; effect: "allow" | "deny" }[] {
  return PROVIDER_COMPATIBILITY_PERMISSIONS;
}
