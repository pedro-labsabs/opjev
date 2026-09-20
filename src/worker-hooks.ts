// Hooks de worker interno: isolamento do auto-routing e instrucao de role.
//
// Estas funcoes sao puras (sem ctx) e sao chamadas pelos hooks do index.ts
// para decidir se uma sessao e um worker de orchestration e, se sim,
// pular o auto-routing e injetar a instrucao de role apropriada.

export const INTERNAL_WORKER_ROLE = "worker";
export const INTERNAL_WORKER_MARKER = "orchestration-internal";

export function isInternalWorkerSession(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  if (metadata["jev-role"] !== INTERNAL_WORKER_ROLE) return false;
  // Aceita dois formatos validos de marker:
  // - prompt metadata do dispatcher (jev-router=orchestration-internal), e
  // - session metadata do dispatcher (jev-orchestration=true).
  // Ambos sao escritos apenas pelo dispatcher ao criar o worker; sessoes
  // normais nunca os carregam.
  return metadata["jev-router"] === INTERNAL_WORKER_MARKER || metadata["jev-orchestration"] === true;
}

export function hasInternalPromptMarker(promptMetadata: Record<string, unknown> | undefined): boolean {
  if (!promptMetadata) return false;
  return promptMetadata["jev-router"] === INTERNAL_WORKER_MARKER && promptMetadata["jev-role"] === INTERNAL_WORKER_ROLE;
}

/**
 * Instrucao curta para worker de orchestration.
 * Nao incentiva Jev em decision boundaries; so executa o contrato.
 */
export function buildWorkerContextInstruction(): string {
  return (
    "You are a worker in an orchestrated execution.\n" +
    "Execute ONLY the ExecutionContract you receive.\n" +
    "Do not choose another agent/model, do not start another orchestration, and do not declare the work approved.\n" +
    "Produce the task result; the dispatcher/Jev will evaluate it."
  );
}

/**
 * Instrucao normal para sessoes de usuario (ja existe no index.ts como
 * string inline). Exportada aqui para reuso/testes e para que o hook
 * context a use condicionalmente.
 */
export function buildDefaultContextInstruction(): string {
  return (
    "The Jev (SystemOne) is the decision layer: consult it only at decision boundaries " +
    "(new intent, choose executor, objective doubt between alternatives, material failure, " +
    "repeated error or escalation). Do not call `jev.decide`/`tools.jev.decide` as a direct tool " +
    "(it does not exist in the catalog). ALWAYS use the `execute` tool in Code Mode: inside it write JavaScript " +
    "(no import/export) and return the call, e.g. `return await tools.jev.decide({...})`. " +
    "The same applies to `tools.jev.route(...)` and `tools.jev.escalate(...)`. " +
    "Do not stop the service or ask the user; invoke the tool. Outside those moments, proceed without Jev."
  );
}