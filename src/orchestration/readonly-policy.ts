// Regras de permissao da critic session: read-only, default-deny.
//
// Formato EXATAMENTE o suportado pelos tipos instalados (@opencode/plugin
// 2.0.7): SessionCreateInput.permissions / Permission.Rule =>
// `Array<{ action, resource, effect: "allow" | "deny" | "ask" }>`.
// Semanticas V2 (docs opencode.ai/v2/docs/permissions):
//   - regras combinadas em ordem, LAST MATCH WINS;
//   - sem regra que case => ask (por isso todo invariante mutavel tem deny
//     explicito — critic jamais escala autorizacao interativamente);
//   - "*" casa zero+ chars inclusive "/".
// Vocabulario V2: "shell" (nao bash), "subagent" (nao task), "edit" cobre
// edit/write/apply_patch. Capacidades de leitura: read/glob/grep.
//
// Nao ha catch-all "*" deny de proposito: sob last-match-wins ele mataria os
// allow de leitura (a policy base do app ja fornece allow-all ANTES destas
// regras; as regras aqui sao anexadas por ultimo na sessao do critic).
export interface CriticPermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/** Capacidades conceitualmente permitidas: somente leitura/inspencao. */
export const CRITIC_ALLOWED_ACTIONS = ["read", "glob", "grep"] as const;

/** Capacidades que NUNCA chegam ao critic: mutacao/execucao/interacao/recursao. */
export const CRITIC_DENIED_ACTIONS = [
  "edit", // edit/write/apply_patch
  "shell", // bash/PTY (V2)
  "subagent", // task/subagent spawning (V2)
  "skill",
  "question", // sem escalada interativa
  "webfetch",
  "websearch",
  "external_directory", // sem mutacao fora do workspace
  "execute", // Code Mode / orchestration recursion
] as const;

/**
 * Envelope read-only compartilhado (#11): leitura + deny de segredos +
 * deny HARD de toda superficie mutavel/interativa (inclui subagent e
 * execute — sem spawn, sem recursao Code Mode). Critic e orchestrator usam
 * EXATAMENTE a mesma policy (sem duplicacao); divergir exige teste.
 */
function readOnlySessionRules(): CriticPermissionRule[] {
  return [
    // 1. leitura dentro do workspace (paths location-relative => "**").
    ...CRITIC_ALLOWED_ACTIONS.map((action) => ({
      action,
      resource: "**",
      effect: "allow" as const,
    })),
    // 2. segredos nunca lidos — declarados DEPOIS do allow de read para que
    //    last-match-wins os aplique sobre qualquer path *.env.
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
    // 3. toda superficie mutavel/interativa: deny HARD (nunca ask).
    ...CRITIC_DENIED_ACTIONS.map((action) => ({
      action,
      resource: "*",
      effect: "deny" as const,
    })),
  ];
}

export function buildCriticPermissionRules(): readonly CriticPermissionRule[] {
  return readOnlySessionRules();
}

/**
 * Permissions do orchestrator (#11): planner generativo read-only, nunca
 * executor. Mesmo envelope do critic (read/glob/grep + deny edit/shell/
 * subagent/execute/...). Em especial execute=deny impede tools.jev.* e
 * recursao de orchestration.
 */
export function buildOrchestratorPermissionRules(): readonly CriticPermissionRule[] {
  return readOnlySessionRules();
}