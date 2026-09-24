// Seam RPC PUBLICO bounded do plugin (#24): o gateway de admission chega ao
// opjev diretamente por `POST /api/rpc/opjev.admission.v1/orchestrate` —
// sem parent/model trampoline, sem segundo motor de orquestracao.
//
// O handler e um factory com seams injetaveis (storage do ctx, runner =
// runOrchestrationOnce real, publicacao = ctx.session.synthetic) para ser
// testavel sem rede. Conceitos portados da PR #21 permitidos: identidade de
// turno, idempotencia por record, keyed lock, gate humano (zero auto-resume),
// contract canonico validado, fail-closed. PROIBIDO: trampoline/rewrite.

import { OrchestrationError, type ExecutionContract } from "./types.ts";
import {
  admissionRecordKey,
  autoAdmissionRunID,
  bindingStatusFromPhase,
  buildAutomaticExecutionContract,
  sessionBindingKey,
} from "./admission.ts";
import { withKeyedLock } from "../lock.ts";

export const NOTICE_LIMIT = 2000;

/** Superficie unica e bounded: SÓ orchestrate (resume fica no tool explicito). */
export const AdmissionRpc = {
  id: "opjev.admission.v1",
  methods: {
    orchestrate: {
      input: {
        type: "object",
        additionalProperties: false,
        required: ["sessionID", "messageID", "objective"],
        properties: {
          sessionID: { type: "string", minLength: 4, maxLength: 200 },
          messageID: { type: "string", minLength: 4, maxLength: 200 },
          objective: { type: "string", minLength: 1, maxLength: 1048576 },
          maxRounds: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["runID", "status"],
        properties: {
          runID: { type: "string", minLength: 1, maxLength: 200 },
          status: { type: "string", minLength: 1, maxLength: 60 },
        },
      },
    },
  },
  events: {},
} as const;

export interface AdmissionOrchestrateInput {
  sessionID: string;
  messageID: string;
  objective: string;
  maxRounds?: number;
}

const ALLOWED_KEYS = new Set(["sessionID", "messageID", "objective", "maxRounds"]);

/** Validacao LOUD e bounded de todo input (nada passa sem validar). */
export function validateAdmissionOrchestrateInput(input: unknown): AdmissionOrchestrateInput {
  const fail: (msg: string) => never = (msg) => {
    throw new OrchestrationError("invalid-rpc-input", `input de orchestrate invalido: ${msg}`);
  };
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail("deve ser objeto");
  const i = input as Record<string, unknown>;
  for (const key of Object.keys(i)) {
    if (!ALLOWED_KEYS.has(key)) fail(`campo desconhecido: ${String(key).slice(0, 40)}`);
  }
  if (typeof i.sessionID !== "string" || i.sessionID.length < 4) fail("sessionID deve ser string (>=4)");
  if (typeof i.messageID !== "string" || i.messageID.length < 4) fail("messageID deve ser string (>=4)");
  if (typeof i.objective !== "string" || i.objective.length < 1) fail("objective deve ser string nao-vazia");
  if (i.maxRounds !== undefined) {
    if (typeof i.maxRounds !== "number" || !Number.isInteger(i.maxRounds) || i.maxRounds < 1 || i.maxRounds > 100) {
      fail("maxRounds deve ser inteiro entre 1 e 100");
    }
  }
  return {
    sessionID: i.sessionID,
    messageID: i.messageID,
    objective: i.objective,
    ...(i.maxRounds !== undefined ? { maxRounds: i.maxRounds } : {}),
  };
}

function boundedError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split("\n")[0]!.slice(0, 300);
}

/**
 * Notice de resultado/erro PUBLICADO de volta na sessao (synthetic,
 * resume:false — duravel, sem acordar o parent). Sempre bounded; nunca vaza
 * texto bruto do worker nem credencial.
 */
export function buildAdmissionRunNotice(input: {
  runID: string;
  phase: string;
  round?: number;
  error?: string;
  worker?: { outcome?: string };
}): string {
  let text = `Orquestracao ${input.runID}: fase ${input.phase}, rodada ${input.round ?? "?"}`;
  if (input.worker?.outcome) text += `, worker ${input.worker.outcome}`;
  if (input.error) text += `. Erro: ${boundedError(input.error)}`;
  if (text.length > NOTICE_LIMIT) text = `${text.slice(0, NOTICE_LIMIT - 1)}…`;
  return text;
}

export interface AdmissionHandlerDeps {
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  runner(contract: ExecutionContract): Promise<{
    runID: string;
    phase: unknown;
    round?: number;
    error?: string;
    worker?: { outcome?: string };
  }>;
  publish(sessionID: string, text: string): Promise<void>;
  /**
   * Guarda de papel autoritativa (opcional): true = sessao interna
   * (worker/critic/orchestrator) => bypass sem run e sem record. Ausente =
   * permite (testes hermeticos; em producao o index.ts conecta ao ctx real e
   * o gateway ja filtra best-effort antes). Erro do seam = permite (a
   * indisponibilidade da leitura nao pode travar turnos legitimos aqui).
   */
  isInternalSession?: (sessionID: string) => Promise<boolean>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function publishSafe(deps: AdmissionHandlerDeps, sessionID: string, text: string): Promise<void> {
  try {
    await deps.publish(sessionID, text);
  } catch {
    // publicacao nunca derruba o run: record/binding ja preservam o estado
  }
}

/**
 * Handler do metodo `orchestrate`:
 *  1. valida todo input (LOUD/bounded);
 *  2. gate humano PRIMEIRO: binding em awaiting-human => ZERO auto-resume;
 *  3. keyed lock por runID (identidade real): duplicatas concorrentes => 1 run;
 *  4. record por sessionID+messageID: re-submissao/replay => duplicate-ignored;
 *  5. contrato canonico validado pelo kernel (sem trampoline);
 *  6. EXATAMENTE UMA chamada do runner; conclusao assincrona grava
 *     record+binding e publica o notice (retornar/registrar erro explicito).
 */
export function createAdmissionOrchestrateHandler(
  deps: AdmissionHandlerDeps,
): (input: unknown) => Promise<{ runID: string; status: string }> {
  return async function orchestrate(rawInput: unknown): Promise<{ runID: string; status: string }> {
    const input = validateAdmissionOrchestrateInput(rawInput);
    const { sessionID, messageID, objective, maxRounds } = input;

    // 0. guarda de papel autoritativa: sessao interna nunca inicia orchestration
    // (o gateway ja filtra best-effort; aqui e in-process, sem rede).
    if (deps.isInternalSession !== undefined) {
      let internal = false;
      try {
        internal = await deps.isInternalSession(sessionID);
      } catch {
        internal = false;
      }
      if (internal) {
        return { runID: autoAdmissionRunID(sessionID, messageID), status: "internal-bypass" };
      }
    }

    // 1. gate humano primeiro: prevalece sobre idempotencia (zero auto-resume)
    const binding = asRecord(await deps.storage.get(sessionBindingKey(sessionID)));
    const bindingRunID = binding !== undefined && typeof binding.runID === "string" ? binding.runID : "";
    if (
      binding !== undefined &&
      bindingRunID !== "" &&
      bindingStatusFromPhase(binding.phase) === "awaiting-human"
    ) {
      return { runID: bindingRunID, status: "awaiting-human-no-resume" };
    }

    const runID = autoAdmissionRunID(sessionID, messageID);
    const recordKey = admissionRecordKey(sessionID, messageID);
    // Lock de SESSAO (externo) + lock de TURNO (interno): admissoes da mesma
    // sessao serializam o trecho gate+record, fechando a corrida em que o
    // binding vira awaiting-human entre o check e o dispatch de outro turno.
    // Sessoes distintas nunca se tocam (chaves distintas, sem deadlock: ordem
    // fixa sessao->turno, chaves sempre diferentes).
    const sessionLockKey = `admission/session/${sessionID}`;

    return await withKeyedLock(sessionLockKey, async () => {
      // Re-check AUTORITATIVO do gate humano dentro do lock de sessao (o
      // fast-path acima e so atalho; este prevalece sobre idempotencia).
      const innerBinding = asRecord(await deps.storage.get(sessionBindingKey(sessionID)));
      const innerBindingRunID =
        innerBinding !== undefined && typeof innerBinding.runID === "string" ? innerBinding.runID : "";
      if (
        innerBinding !== undefined &&
        innerBindingRunID !== "" &&
        bindingStatusFromPhase(innerBinding.phase) === "awaiting-human"
      ) {
        return { runID: innerBindingRunID, status: "awaiting-human-no-resume" };
      }

      return await withKeyedLock(runID, async () => {
      // 2. idempotencia por record: mesma identidade => nunca um run extra.
      // Excecao: "binding-failed" significa que a persistencia pre-run falhou
      // ANTES de qualquer runner (provado abaixo: o runner so e invocado apos
      // os dois sets); nesse caso o retry e seguro e continua com run<=1.
      const prior = asRecord(await deps.storage.get(recordKey));
      if (prior && prior.runID === runID && prior.state !== "binding-failed") {
        return { runID, status: "duplicate-ignored" };
      }

      // 3. contrato canonico (validacao loud do kernel)
      const contract = buildAutomaticExecutionContract({
        sessionID,
        messageID,
        objective,
        ...(maxRounds !== undefined ? { maxRounds } : {}),
      });

      // 4. persistencia pre-run: se QUALQUER set falhar, o runner NUNCA rodou.
      // Nao deixar "started" mentiroso: marca diagnostico retryable e propaga
      // erro explicito (o gateway responde 502 fail-closed; o replay retoma).
      // Janela residual honesta: crash do processo entre o set do record e a
      // invocacao do runner (gap de microtask) deixa "started" sem runner;
      // replay entao ignora (fail-closed, run<=1 preservado; recuperacao via
      // expiracao/limpeza de record pelo operador — ver limitacao documentada).
      try {
        await deps.storage.set(recordKey, { runID, state: "started", at: Date.now() });
        await deps.storage.set(sessionBindingKey(sessionID), { runID, phase: "running", at: Date.now() });
      } catch (err) {
        const error = boundedError(err);
        try {
          await deps.storage.set(recordKey, { runID, state: "binding-failed", error, at: Date.now() });
        } catch {
          // storage totalmente fora do ar: o erro propagado preserva o diagnostico
        }
        throw new OrchestrationError(
          "admission-persistence-failed",
          `persistencia pre-run falhou (runner nao executado): ${error}`,
        );
      }

      // 4. EXATAMENTE uma execucao; conclusao assincrona => record + notice
      void (async () => {
        try {
          const result = await deps.runner(contract);
          const phase = String(result.phase ?? "completed");
          await deps.storage.set(recordKey, {
            runID,
            state: phase,
            ...(result.error !== undefined ? { error: boundedError(result.error) } : {}),
          });
          await deps.storage.set(sessionBindingKey(sessionID), { runID, phase });
          await publishSafe(
            deps,
            sessionID,
            buildAdmissionRunNotice({
              runID,
              phase,
              ...(result.round !== undefined ? { round: result.round } : {}),
              ...(result.error !== undefined ? { error: result.error } : {}),
              ...(result.worker !== undefined ? { worker: result.worker } : {}),
            }),
          );
        } catch (err) {
          const error = boundedError(err);
          try {
            await deps.storage.set(recordKey, { runID, state: "failed", error });
          } catch {
            // storage fora do ar: o log/emit do chamador preserva o diagnostico
          }
          try {
            await deps.storage.set(sessionBindingKey(sessionID), { runID, phase: "failed" });
          } catch {
            // mesmo escope acima
          }
          await publishSafe(deps, sessionID, buildAdmissionRunNotice({ runID, phase: "failed", error }));
        }
      })();

      return { runID, status: "started" };
      });
    });
  };
}
