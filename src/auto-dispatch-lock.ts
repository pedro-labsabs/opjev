// Serializacao process-local do dispatch da admissao automatica (#13).
//
// TOCTOU identico ao do gate humano (#12): duas invocacoes simultaneas de
// `orchestrate_once` para o MESMO runID (submissao concorrente via trampoline)
// leriam o binding `admitted` antes de qualquer uma dispatcher o run, e ambas
// selecionariam executor + criariam worker. Este helper serializa a secao
// critica POR runID na instancia local do plugin: o primeiro caller adquire
// ownership, RE-LE o storage dentro do lock e executa; o segundo espera,
// re-le o estado pos-winner (status do binding ja nao e mais `admitted`) e e
// rejeitado bounded ([auto-dispatch-already-executed]) — nunca alcança
// `runOrchestrationOnce`.
//
// Escopo honesto: process-local. A instancia do plugin e a dona unica das
// invocacoes de tool neste runtime; NENHUMA garantia cross-process. Runs
// diferentes nunca se bloqueiam.
//
// O lock NAO decide nada (dispatcher executa, kernel e a autoridade): so
// ownership do dispatch. Authority continua: storage atual -> binding
// `admitted` para o runID -> runOrchestrationOnce.

const tails = new Map<string, Promise<void>>();

/**
 * Executa `fn` com ownership exclusivo do `runID` (mesma semantica de
 * withResumeLock: fila por chave, cauda que nunca rejeita, release em
 * finally com cleanup por identidade — nenhum lock orfao).
 */
export async function withAutoDispatchLock<T>(runID: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(runID) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail: Promise<void> = prev.then(
    () => gate,
    () => gate,
  );
  tails.set(runID, tail);
  await prev.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await fn();
  } finally {
    releaseGate();
    if (tails.get(runID) === tail) tails.delete(runID);
  }
}

/** Seam de teste: quantas filas keyed estao vivas (prova de cleanup, sem leak). */
export function autoDispatchLockCount(): number {
  return tails.size;
}