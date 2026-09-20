// Sanitizacao para persistir decisoes de forma bounded e sem conteudo
// sensivel. Nunca armazenar API keys, Authorization headers, tokens,
// credentials ou secrets obvios.

const REDACT_KEY_RE =
  /(api[_-]?key|authorization|auth[_-]?token|token|credential|secret|bearer|cookie|password|passwd|access[_-]?key|private[_-]?key)/i;

export const SANITIZE_MAX_CHARS = 8000;

function redactKey(key: string): boolean {
  return REDACT_KEY_RE.test(key);
}

/**
 * Normaliza um estado para persistência segura:
 * - remove chaves sensiveis (nome da chave contem segredo);
 * - remove objetos Authorization/{apiKey, token, ...} por valor;
 * - limita o tamanho total (bounded).
 */
export function sanitizeState(state: unknown): unknown {
  if (typeof state === "string") {
    return state.length > SANITIZE_MAX_CHARS
      ? `${state.slice(0, SANITIZE_MAX_CHARS)}…[truncado pelo plugin]`
      : state;
  }
  if (state === null || state === undefined) return state;
  if (Array.isArray(state)) {
    return state.slice(0, 200).map((v) => sanitizeState(v));
  }
  if (typeof state === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(state as Record<string, unknown>)) {
      if (redactKey(k)) continue;
      // Valor com marcador claro de segredo (ex: Bearer, sk-, token jwt) ou
      // sub-arvore inteira com chave sensivel -> redact total.
      if (valueLooksSecret(v) || hasSensitiveShape(v)) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = sanitizeState(v);
    }
    return out;
  }
  return state;
}

// Marcadores objetivos de segredo em valores (strings).
const SECRET_VALUE_RE =
  /(^|[^a-z0-9])(sk-[a-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|eyJ[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/i;

function valueLooksSecret(v: unknown): boolean {
  if (typeof v === "string") return SECRET_VALUE_RE.test(v);
  if (Array.isArray(v)) return v.some(valueLooksSecret);
  if (v && typeof v === "object") {
    return Object.values(v).some(valueLooksSecret);
  }
  return false;
}

function hasSensitiveShape(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const keys = Object.keys(v as Record<string, unknown>);
  return keys.some((k) => redactKey(k));
}

/** Monta o registro de decisao persistido (bounded e sanitizado). */
export function buildDecisionRecord(state: unknown, answers: unknown): unknown {
  return {
    at: Date.now(),
    state: sanitizeState(state),
    answers: sanitizeState(answers),
  };
}