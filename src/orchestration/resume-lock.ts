// Serializacao process-local do consumo do gate humano (#12, blocker #5769360749).
//
// TOCTOU corrigido: duas `orchestrate_resume` simultaneas (mesmo runID + mesmo
// requestID) liam o mesmo `awaiting-human` antes de qualquer uma consumir o
// pendingHuman, e ambas aplicavam HUMAN_DECISION_RECEIVED + criavam worker da
// rodada N+1. Este helper serializa a secao critica POR runID na instancia
// local do plugin: o primeiro caller adquire ownership, RE-LE o storage dentro
// do lock e executa; o segundo espera, re-le o estado pos-winner e e rejeitado
// bounded (nunca alcanca `runOrchestrationResume`).
//
// Escopo honesto: process-local. A instancia do plugin e a dona unica das
// invocacoes de tool neste runtime; NENHUMA garantia cross-process (sem CAS
// distribuido, sem lock framework). Runs diferentes nunca se bloqueiam.
//
// O lock NAO decide nada (resume/stop/budget/round/executor/stale): so
// ownership. Authority continua: storage atual -> validateResumableRunState
// -> transitionRun(HUMAN_DECISION_RECEIVED). Kernel soberano.

const tails = new Map<string, Promise<void>>();

/**
 * Executa `fn` com ownership exclusivo do `runID`. A fila e por chave: callers
 * do mesmo run esperam em cadeia (promise-chain, sem lost wakeup); callers de
 * runs diferentes nunca se tocam. A cauda armazenada nunca rejeita (a cadeia
 * nunca quebra e nenhum waiter observa o erro alheio). Release em `finally`
 * (sucesso, rejeicao bounded ou throw inesperado: nenhum lock orfao). Cleanup
 * com identidade: a entrada do Map e removida somente se ainda for a nossa
 * cauda (nunca apaga a fila nova de um waiter que chegou depois).
 */
export async function withResumeLock<T>(runID: string, fn: () => Promise<T>): Promise<T> {
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
  // Espera a vez (o gate do dono anterior). Nunca lanca: o erro do dono
  // anterior (se houver) pertence ao dono anterior.
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
export function resumeLockCount(): number {
  return tails.size;
}
