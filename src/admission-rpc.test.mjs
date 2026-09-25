// Testes RED do seam RPC de admission do plugin (issue #24) — HANDLER.
//
// Cenarios (spec #24):
//   R6  orchestrate -> exatamente UM runOrchestrationOnce por identidade de
//       turno (contract montado/validado pelo kernel, runID deterministico)
//   R7  duplicata concorrente/replay -> zero run extra (keyed lock + record)
//   R13 run em awaiting-human -> ZERO auto-resume (gate humano prevalece)
//   R12/R14 superficie bounded: apenas o metodo `orchestrate` (sem resume/
//       accept/stop — a retomada continua sendo so via orchestrate_resume);
//       input validado e rejeitado bounded
//   Identidade: runID = f(sessionID, messageID) — NUNCA hash(text); textos
//       identicos com messageID distinto permanecem turnos distintos
//
// Sem rede: seams injetados (storage fake, runner contavel, publish contavel).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAdmissionOrchestrateHandler,
  AdmissionRpc,
  buildAdmissionRunNotice,
} from "./orchestration/admission-rpc.ts";
import {
  autoAdmissionRunID,
  buildAutomaticExecutionContract,
  sessionBindingKey,
  admissionRecordKey,
} from "./orchestration/admission.ts";

function fakeDeps(overrides = {}) {
  const store = new Map();
  const state = { runs: [], published: [], runnerDelayMs: 0, runnerError: undefined };
  const deps = {
    storage: {
      async get(key) {
        return store.get(key);
      },
      async set(key, value) {
        store.set(key, value);
      },
    },
    async runner(contract) {
      if (state.runnerDelayMs > 0) {
        await new Promise((r) => setTimeout(r, state.runnerDelayMs));
      }
      if (state.runnerError) throw state.runnerError;
      state.runs.push(contract);
      return {
        runID: contract.runID,
        phase: "completed",
        round: 1,
        pendingCommands: [],
        rounds: [],
        worker: { sessionID: "ses_w1", agent: "build", model: "opencode/big-pickle", outcome: "succeeded", finalText: "ok" },
      };
    },
    async publish(sessionID, text) {
      state.published.push({ sessionID, text });
    },
    ...overrides,
  };
  return { deps, store, state, handler: createAdmissionOrchestrateHandler(deps) };
}

const VALID = { sessionID: "ses_rpc1", messageID: "msg_rpc1", objective: "resolver o bug de race" };

test("R6: input valido -> contrato validado, UN run, record+binding, notice publicado bounded", async () => {
  const { deps, store, state, handler } = fakeDeps();
  const out = await handler(VALID);

  assert.equal(out.status, "started");
  assert.equal(out.runID, autoAdmissionRunID(VALID.sessionID, VALID.messageID));
  assert.equal(state.runs.length, 1, "exatamente UM runOrchestrationOnce");

  const contract = state.runs[0];
  assert.equal(contract.runID, out.runID, "runID deterministico da identidade real");
  assert.equal(contract.objective, VALID.objective, "texto vira objective (input preservado)");
  assert.ok(contract.maxRounds >= 1, "contract validado pelo kernel");

  // conclusao do run e assincrona (kick): aguarda o settle antes do record
  await new Promise((r) => setTimeout(r, 30));

  // record + binding persistidos (storage-truth)
  const record = store.get(admissionRecordKey(VALID.sessionID, VALID.messageID));
  assert.equal(record.runID, out.runID);
  assert.equal(record.state, "completed", "fase final registrada");
  const binding = store.get(sessionBindingKey(VALID.sessionID));
  assert.equal(binding.runID, out.runID);
  assert.equal(binding.phase, "completed");

  // publicacao de resultado: notice bounded, na sessao certa
  await new Promise((r) => setImmediate(r));
  assert.equal(state.published.length, 1, "resultado publicado");
  assert.equal(state.published[0].sessionID, VALID.sessionID);
  assert.ok(state.published[0].text.length <= 2000, "notice bounded");
  assert.ok(state.published[0].text.includes(out.runID), "notice carrega o runID");
  assert.ok(state.published[0].text.includes("completed"), "notice carrega a fase");
});

test("R-IDENTIDADE: runID deriva de sessionID+messageID — NUNCA hash(text)", async () => {
  const a = autoAdmissionRunID("ses_x", "msg_1");
  const b = autoAdmissionRunID("ses_x", "msg_1");
  const c = autoAdmissionRunID("ses_x", "msg_2");
  const d = autoAdmissionRunID("ses_y", "msg_1");
  assert.equal(a, b, "mesma identidade => mesmo runID (deterministico)");
  assert.notEqual(a, c, "turno distinto => runID distinto");
  assert.notEqual(a, d, "sessao distinta => runID distinto");
  assert.ok(a.startsWith("auto-ses_x-msg_1".slice(0, 10)), "runID legivel a partir da identidade");

  // sufixo anti-aliasing: identidades longas differing so alem do corte nao colidem
  const long1 = autoAdmissionRunID(`ses_${"a".repeat(120)}X`, "msg_1");
  const long2 = autoAdmissionRunID(`ses_${"a".repeat(120)}Y`, "msg_1");
  assert.notEqual(long1, long2, "truncamento nunca alia identidades distintas");
  assert.ok(long1.length <= 200 && long2.length <= 200, "runID capped");

  // contrato: objective identico com messageID distinto gera contracts distintos
  const k1 = buildAutomaticExecutionContract({ sessionID: "ses_x", messageID: "msg_1", objective: "mesmo texto" });
  const k2 = buildAutomaticExecutionContract({ sessionID: "ses_x", messageID: "msg_2", objective: "mesmo texto" });
  assert.notEqual(k1.runID, k2.runID, "dois turnos identicos = dois runs possiveis");
  // objective acima do limite do kernel e truncado LOUD (nunca estoura validacao)
  const long = buildAutomaticExecutionContract({
    sessionID: "ses_x",
    messageID: "msg_3",
    objective: "x".repeat(9000),
  });
  assert.ok(long.objective.length <= 2000, "objective bounded pelo kernel");
  // maxRounds invalido = erro loud (sem clamp silencioso)
  assert.throws(
    () =>
      buildAutomaticExecutionContract({
        sessionID: "ses_x",
        messageID: "msg_4",
        objective: "y",
        maxRounds: 0,
      }),
    /maxRounds/,
  );
});

test("R7: duplicata sequencial e CONCORRENTE -> UM run efetivo", async () => {
  const { deps, state, handler } = fakeDeps();
  state.runnerDelayMs = 80;

  // concorrente: as duas entram antes de qualquer resolucao
  const [p1, p2] = await Promise.all([handler(VALID), handler(VALID)]);
  assert.equal(p1.status, "started");
  assert.equal(p2.status, "duplicate-ignored", "segunda espera o lock e encontra o record");
  assert.equal(state.runs.length <= 1, true, "nunca dois runs");

  // replay tardio apos conclusao
  const p3 = await handler(VALID);
  assert.equal(p3.status, "duplicate-ignored");
  assert.equal(p3.runID, p1.runID, "mesma identidade => mesmo run");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(state.runs.length, 1, "EXATAMENTE um run para a identidade");
});

test("R7b: novo handler sobre o MESMO storage (restart de processo) -> replay continua idempotente", async () => {
  const first = fakeDeps();
  const out1 = await first.handler(VALID);
  assert.equal(out1.status, "started");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(first.state.runs.length, 1);

  // "Restart": handler novo, storage duravel compartilhado, runner novo contavel.
  const second = fakeDeps();
  second.deps.storage.get = async (key) => first.store.get(key);
  second.deps.storage.set = async (key, value) => {
    first.store.set(key, value);
  };
  const revived = createAdmissionOrchestrateHandler(second.deps);
  const out2 = await revived(VALID);
  assert.equal(out2.status, "duplicate-ignored", "record duravel sobrevive ao restart");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(second.state.runs.length, 0, "nenhum run novo apos restart");
  assert.equal(first.state.runs.length, 1, "exatamente 1 run no total");
});

test("R-ROLE: sessao interna -> internal-bypass, zero run, zero record", async () => {
  const { store, state, handler } = fakeDeps({
    isInternalSession: async () => true,
  });
  const out = await handler(VALID);
  assert.equal(out.status, "internal-bypass");
  assert.equal(out.runID, autoAdmissionRunID(VALID.sessionID, VALID.messageID));
  assert.equal(state.runs.length, 0, "NENHUM run para sessao interna");
  assert.equal(state.published.length, 0);
  assert.equal(store.has(admissionRecordKey(VALID.sessionID, VALID.messageID)), false, "sem record");
});

test("R-GATE-RACE: binding vira awaiting-human entre check e dispatch -> ZERO run novo", async () => {
  const { deps, store, state, handler } = fakeDeps();
  // O binding muda DEPOIS da primeira leitura (outro run completou com gate
  // humano enquanto este dispatch aguardava o lock): o re-check dentro do
  // lock precisa enxergar e bloquear.
  let bindingReads = 0;
  const realGet = deps.storage.get.bind(deps.storage);
  deps.storage.get = async (key) => {
    const v = await realGet(key);
    if (key === sessionBindingKey(VALID.sessionID)) {
      bindingReads += 1;
      if (bindingReads >= 2) return { runID: "auto-outro-run", phase: "awaiting-human" };
    }
    return v;
  };
  const out = await handler(VALID);
  assert.equal(out.status, "awaiting-human-no-resume", "re-check dentro do lock bloqueia");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(state.runs.length, 0, "NENHUM runner apos flip do binding");
  assert.equal(store.has(admissionRecordKey(VALID.sessionID, VALID.messageID)), false, "sem record");
});

test("SEC-ROLE-2: isInternalSession throws -> runner=0, sem run, erro bounded", async () => {
  const { store, state, handler } = fakeDeps({
    isInternalSession: async () => {
      throw new Error("ctx indisponivel");
    },
  });
  await assert.rejects(
    () => handler(VALID),
    (err) => {
      assert.equal(err?.code, "admission-role-unknown", "code diagnostico bounded");
      assert.ok(String(err?.message ?? err).length <= 400, "mensagem bounded");
      return true;
    },
    "erro explicito bounded",
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(state.runs.length, 0, "runner NUNCA executado com papel desconhecido");
  assert.equal(store.has(admissionRecordKey(VALID.sessionID, VALID.messageID)), false, "sem record");
  assert.equal(store.has(sessionBindingKey(VALID.sessionID)), false, "sem binding");
  assert.equal(state.published.length, 0, "nada publicado");
});

test("SEC-ROLE-4: isInternalSession => false -> caminho normal de orchestration intacto", async () => {
  const { state, handler } = fakeDeps({
    isInternalSession: async () => false,
  });
  const out = await handler(VALID);
  assert.equal(out.status, "started", "sessao explicitamente externa orquestra normalmente");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(state.runs.length, 1, "exatamente 1 run");
});

test("R13: binding em awaiting-human -> ZERO auto-resume, zero run", async () => {
  const { store, state, handler } = fakeDeps();
  store.set(sessionBindingKey(VALID.sessionID), {
    runID: "auto-ses_rpc1-msg_antigo",
    phase: "awaiting-human",
  });

  const out = await handler(VALID);
  assert.equal(out.status, "awaiting-human-no-resume", "gate humano prevalece sobre idempotencia");
  assert.equal(out.runID, "auto-ses_rpc1-msg_antigo");
  assert.equal(state.runs.length, 0, "NENHUM run novo em awaiting-human");
  assert.equal(state.published.length, 0, "nada publicado (decisao humana segue explicita)");
  assert.equal(store.has(admissionRecordKey(VALID.sessionID, VALID.messageID)), false, "sem record novo");
});

test("R-FALHA: run que falha -> record failed, notice de erro publicado, replay NAO re-executa", async () => {
  const { store, state, handler } = fakeDeps();
  state.runnerError = new Error("boom interno");

  const out = await handler(VALID);
  assert.equal(out.status, "started", "dispatch e imediato; falha e assincrona");
  await new Promise((r) => setTimeout(r, 30));

  const record = store.get(admissionRecordKey(VALID.sessionID, VALID.messageID));
  assert.equal(record.state, "failed", "falha registrada para diagnostico");
  assert.ok(record.error, "erro bounded preservado");
  assert.equal(store.get(sessionBindingKey(VALID.sessionID)).phase, "failed");
  assert.equal(state.published.length, 1, "erro REGISTRADO via notice publicado");
  assert.ok(state.published[0].text.includes("failed"));
  assert.ok(state.published[0].text.length <= 2000);

  // replay apos falha: nunca segunda execucao (fail-closed)
  const replay = await handler(VALID);
  assert.equal(replay.status, "duplicate-ignored");
  assert.equal(state.runs.length, 0, "zero execucoes (todas falharam, nenhuma nova)");
  const runsAfterFail = state.runs.length;
  assert.equal(runsAfterFail, state.runs.length);
});

test("R-PERSIST: falha de persistencia pre-run NAO mente 'started' e permite retry sem duplicar", async () => {
  const { deps, store, state, handler } = fakeDeps();
  const realSet = deps.storage.set.bind(deps.storage);
  // Falha apenas na escrita do binding (record ja gravado): o runner NUNCA rodou.
  deps.storage.set = async (key, value) => {
    if (key === sessionBindingKey(VALID.sessionID)) throw new Error("storage do binding fora do ar");
    return realSet(key, value);
  };
  await assert.rejects(() => handler(VALID), /binding|persistencia/i, "erro explicito bounded ao cliente");
  assert.equal(state.runs.length, 0, "runner nunca executou");
  const record = store.get(admissionRecordKey(VALID.sessionID, VALID.messageID));
  assert.notEqual(record?.state, "started", "record nao pode mentir 'started' sem runner");
  assert.equal(record?.state, "binding-failed", "falha pre-run registrada com diagnostico");

  // storage volta: replay da mesma identidade retoma (runner ainda nunca rodou => run<=1)
  deps.storage.set = realSet;
  const retry = await handler(VALID);
  assert.equal(retry.status, "started", "retry apos falha pre-run e admitido");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(state.runs.length, 1, "EXATAMENTE um run no total (nunca dois)");
  assert.equal(store.get(admissionRecordKey(VALID.sessionID, VALID.messageID)).state, "completed");
});

test("R12: input invalido -> rejeicao bounded; superficie RPC = so `orchestrate`", async () => {
  const { state, handler } = fakeDeps();
  const cases = [
    {},
    { sessionID: 123, messageID: "msg_x", objective: "x" },
    { sessionID: "ses_x", messageID: "", objective: "x" },
    { sessionID: "ses_x", messageID: "msg_x", objective: "" },
    { sessionID: "ses_x", messageID: "msg_x", objective: "x", maxRounds: 0 },
    { sessionID: "ses_x", messageID: "msg_x", objective: "x", extra: "campo desconhecido" },
  ];
  for (const input of cases) {
    await assert.rejects(() => handler(input), (err) => {
      assert.ok(String(err?.message ?? err).length <= 400, "erro bounded");
      return true;
    }, `input deveria ser rejeitado: ${JSON.stringify(input)}`);
  }
  assert.equal(state.runs.length, 0, "rejeicao bounded nunca executa run");

  // superficie: apenas orchestrate (resume continua no orchestrate_resume existente)
  assert.equal(AdmissionRpc.id, "opjev.admission.v1");
  assert.deepEqual(Object.keys(AdmissionRpc.methods), ["orchestrate"], "RPC bounded,1 metodo");
  assert.equal(AdmissionRpc.methods.resume, undefined);
  assert.equal(AdmissionRpc.methods.accept, undefined);
  assert.equal(AdmissionRpc.methods.stop, undefined);

  // schema do input declara additionalProperties:false e required
  const schema = AdmissionRpc.methods.orchestrate.input;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), ["messageID", "objective", "sessionID"]);
});

test("R-NOTICE: buildAdmissionRunNotice e bounded e diagnostico", () => {
  const ok = buildAdmissionRunNotice({
    runID: "auto-ses-m",
    phase: "completed",
    round: 1,
    worker: { sessionID: "ses_w", agent: "build", model: "opencode/big-pickle", outcome: "succeeded", finalText: "z".repeat(5000) },
  });
  assert.ok(ok.length <= 2000, "notice sempre bounded");
  assert.ok(ok.includes("auto-ses-m"));
  assert.ok(!ok.includes("z".repeat(500)), "nunca vaza texto bruto do worker");

  const failed = buildAdmissionRunNotice({ runID: "auto-ses-m", phase: "failed", round: 2, error: "e".repeat(5000) });
  assert.ok(failed.length <= 2000, "erro bounded no notice");
});
