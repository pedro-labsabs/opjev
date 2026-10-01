// Keyed lock process-local (conceito portado da PR #21 — auto-dispatch-lock,
// permitido pela spec da #24): serializa o start de runs por CHAVE de
// identidade real (sessionID+messageID via runID), nunca por hash de texto.
//
// Escopo honesto: processo-local. A unicidade cross-processo vem do record
// duravel de admission no storage do plugin (o lock cobre a corrida entre
// dispatches concorrentes dentro deste processo).

const tails = new Map<string, Promise<void>>();

/**
 * Executa `fn` serializado para a `key`: chamadas concorrentes com a mesma
 * chave rodam em ordem de chegada; a segunda enxerga o efeito da primeira.
 * Nunca retém promessas rejeitadas (o tail so encadeia sucesso).
 */
export async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(
    () => current,
    () => current,
  );
  tails.set(key, tail);
  await prev.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
