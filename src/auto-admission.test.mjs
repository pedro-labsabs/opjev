// Testes comportamentais do admission layer automatico (#13) no plugin real.
// Executam o hook `prompt` do index.ts contra o harness e observam o datapath
// completo: trampoline, binding session<>run, admission records, dispatch unico
// (lock process-local), guards (interno/vazio/trivial/awaiting-human), numeros
// de chamadas Jev (<=1 admission + <=1 route por intencao) e seams explicitos
// preservados (orchestrate_once/orchestrate_resume).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import pluginDefault from "../index.ts";
import { FREE_POOL } from "./config.ts";
import {
  autoAdmissionRunID,
  buildAutomaticExecutionContract,
} from "./orchestration/admission.ts";
import { autoDispatchLockCount } from "./auto-dispatch-lock.ts";
import {
  makeCtx,
  makeStorage,
  stubFetch,
  okJev,
  routeAnswers,
  choice,
  noul,
} from "./harness.mjs";

const ALL_MODELS = [...FREE_POOL];

const AUTO_OPTS = {
  enableAutoRoute: true,
  enableAutoOrchestration: true,
  autoOrchestrationMaxRounds: 3,
  jevTimeoutMs: 500,
  confidenceThreshold: 0.55,
  jevEndpoint: "https://opencode.ai/zen/v1/systemone",
  jevModel: "jev-1.13-free",
  apiKeyEnv: "OPENCODE_API_KEY",
};

function acceptAnswers(confidence = 0.95) {
  return {
    done: { type: "noul", noul: 0.9 },
    failure_class: { type: "choice", choice: "none" },
    same_executor_can_repair: { type: "noul", noul: 1 },
    next_action: { type: "choice", choice: "accept", confidence },
  };
}

async function bootAuto(over = {}) {
  const m = makeCtx({
    models: ALL_MODELS,
    storage: over.storage ?? makeStorage({}),
    options: { ...AUTO_OPTS, ...(over.options ?? {}) },
    location: over.location ?? "/proj",
    workerBehavior: over.workerBehavior ?? {},
    criticBehavior: over.criticBehavior ?? {},
  });
  await pluginDefault.setup(m.ctx);
  return m;
}

function orchestrateStub(over = {}) {
  let judgeIdx = 0;
  const judges = over.judges ?? [acceptAnswers()];
  return stubFetch(async ({ body }) => {
    if (over.admissionError) throw over.admissionError;
    if (body?.questions?.admission) {
      const r = typeof over.admission === "function" ? over.admission() : (over.admission ?? choice("orchestrate", 0.95));
      return okJev({ admission: r });
    }
    if (body?.questions?.route) {
      const r = over.route ?? routeAnswers({ route: "fast-coding", agent: "build", model: "opencode/big-pickle", confidence: 0.9 });
      return okJev(r);
    }
    if (body?.questions?.next_action) {
      return okJev(judges[Math.min(judgeIdx++, judges.length - 1)]);
    }
    return okJev(acceptAnswers());
  });
}

function promptEvent(text, messageID = "m1", sessionID = "s1") {
  return { sessionID, messageID, prompt: { text: text.startsWith(" ") || text.startsWith(".") ? text : text }, metadata: {}, delivery: {} };
}

function workerCount(m) {
  return m.workerCalls.create.filter((c) => c?.metadata?.["jev-role"] === "worker").length;
}

function contractOf(text, sessionID = "s1", messageID = "m1") {
  return buildAutomaticExecutionContract({ sessionID, messageID, objective: text, maxRounds: 3 });
}

describe("AUTO1-2: admissao no hook -> trampoline + binding + dispatch unico", () => {
  it("AUTO1: hook admite orchestrate: troca o prompt (trampoline), metadata jev-admission, binding+record persistidos, 1 chamada admission e 0 route", async () => {
    const m = await bootAuto();
    const stub = orchestrateStub();
    const text = "refatorar o dispatcher com admissao bounded";
    const ev = promptEvent(text, "m1", "s1");
    await m.hooks.session.prompt(ev);
    assert.notEqual(ev.prompt.text, text, "trampoline substituiu o texto canônico");
    assert.ok(ev.prompt.text.includes("tools.jev.orchestrate_once"), "launcher nomeia o seam explicito");
    assert.equal(ev.metadata["jev-admission"], "orchestrate");
    assert.equal(ev.metadata["jev-admission-via"], "jev");
    const runID = ev.metadata["jev-run-id"];
    assert.ok(runID && typeof runID === "string");
    assert.ok(ev.metadata["jev-admission-reason"].includes(runID));

    const binding = await m.ctx.storage.get("orchestration/session/s1");
    assert.ok(binding, "binding session<>run persistido");
    assert.equal(binding.runID, runID);
    assert.equal(binding.status, "admitted");
    assert.equal(binding.messageID, "m1");

    const record = await m.ctx.storage.get("orchestration/admission/s1/m1");
    assert.ok(record, "admission record persistido");
    assert.equal(record.runID, runID);
    assert.equal(record.mode, "orchestrate");
    assert.equal(record.status, "pending");

    const bodies = stub.bodies();
    assert.equal(bodies.filter((b) => b?.questions?.admission).length, 1, "<=1 chamada de admission");
    assert.equal(bodies.filter((b) => b?.questions?.route).length, 0, "0 route quando admission=orchestrate");
  });

  it("AUTO2: orchestrate_once executa UMA vez; segunda chamada do mesmo runID e rejeitada bounded, sem worker novo", async () => {
    const m = await bootAuto();
    const stub = orchestrateStub();
    const text = "implementar pipeline de critic isolado";
    const ev = promptEvent(text);
    await m.hooks.session.prompt(ev);
    const runID = ev.metadata["jev-run-id"];
    const contract = contractOf(text);

    const ctx = { sessionID: "s1", agent: "build", messageID: "m1", id: "t1" };
    const res1 = await m.tools.orchestrate_once.execute({ contract }, ctx);
    const out1 = JSON.parse(res1.content);
    assert.equal(out1.runID, runID);
    assert.equal(out1.phase, "completed", "primeira execucao dispatches o run");
    assert.equal(workerCount(m), 1, "exatamente UMA worker session criada");

    const res2 = await m.tools.orchestrate_once.execute({ contract }, ctx);
    assert.match(res2.content, /auto-dispatch-already-executed/, "segunda chamada bloqueada deterministicamente");
    assert.equal(workerCount(m), 1, "nenhuma segunda worker (zero duplicata)");
    assert.equal(stub.bodies().filter((b) => b?.questions?.route).length, 1, "executor selecionado exatamente 1x");

    const binding = await m.ctx.storage.get("orchestration/session/s1");
    assert.equal(binding.status, "completed", "binding terminal apos o run");
    const record = await m.ctx.storage.get("orchestration/admission/s1/m1");
    assert.equal(record.status, "completed");
  });

  it("AUTO3: duas orchestrate_once CONCORRENTES (mesmo runID) -> lock process-local, UMA vitoria, UMA rejeicao", async () => {
    const m = await bootAuto();
    orchestrateStub();
    const text = "tarefa sob submissao simultanea";
    const ev = promptEvent(text);
    await m.hooks.session.prompt(ev);
    const contract = contractOf(text);
    const ctx = { sessionID: "s1", agent: "build", messageID: "m1", id: "t1" };
    const [r1, r2] = await Promise.all([
      m.tools.orchestrate_once.execute({ contract }, ctx),
      m.tools.orchestrate_once.execute({ contract }, ctx),
    ]);
    // r = { content: JSON.stringify(result) | mensagem bounded }: o phase vive
    // DENTRO de content (JSON aninhado), entao JSON.stringify(r) escapa as
    // aspas e nunca contem '"phase":"completed"'. Inspeciona content direto.
    const contents = [String(r1?.content ?? ""), String(r2?.content ?? "")];
    const wins = contents.filter((c) => {
      try {
        return JSON.parse(c)?.phase === "completed";
      } catch {
        return c.includes('"phase":"completed"') || c.includes('\\"phase\\":\\"completed\\"');
      }
    });
    const rej = contents.filter((c) => c.includes("auto-dispatch-already-executed"));
    assert.equal(wins.length, 1, "exatamente um dispatch vence");
    assert.equal(rej.length, 1, "um caller e rejeitado bounded");
    assert.equal(workerCount(m), 1, "exatamente uma worker");
    assert.equal(autoDispatchLockCount(), 0, "lock process-local liberado (sem leak)");
    const binding = await m.ctx.storage.get("orchestration/session/s1");
    assert.equal(binding.status, "completed");
  });
});

describe("AUTO4-6: contagem de chamadas Jev + fallback fail-closed + flag desligada", () => {
  it("AUTO4: intent orchestrate => <=1 admission + <=1 route (executor) no datapath completo", async () => {
    const m = await bootAuto();
    const stub = orchestrateStub();
    const text = "aceitar e completar na primeira rodada";
    const ev = promptEvent(text);
    await m.hooks.session.prompt(ev);
    await m.tools.orchestrate_once.execute({ contract: contractOf(text) }, { sessionID: "s1", agent: "build", messageID: "m1", id: "t1" });
    const bodies = stub.bodies();
    assert.equal(bodies.filter((b) => b?.questions?.admission).length, 1, "1 chamada de admission por intencao");
    assert.equal(bodies.filter((b) => b?.questions?.route).length, 1, "1 chamada de route (selecao executor) por intencao");
  });

  it("AUTO6a: Jev indisponivel na admission + enableAutoRoute => fail-closed route (rota segue), sem trampoline", async () => {
    const m = await bootAuto({ options: { enableAutoRoute: true } });
    const stub = orchestrateStub({ admissionError: new Error("network down") });
    const text = "tarefa qualquer sob janela sem Jev";
    const ev = promptEvent(text);
    await m.hooks.session.prompt(ev);
    assert.equal(ev.prompt.text, text, "sem trampoline quando admission nao e orchestrate");
    assert.equal(ev.metadata["jev-admission"], "route");
    assert.equal(ev.metadata["jev-admission-via"], "fallback");
    assert.ok(ev.metadata["jev-admission-reason"], "razao da fallback presente");
    // Roteamento (fallback heuristico do decideRoute) seguiu o fluxo atual.
    assert.equal(ev.metadata["jev-router"], "routed");
    const binding = await m.ctx.storage.get("orchestration/session/s1");
    assert.equal(binding, undefined, "sem binding quando nao ha orchestrate");
    // O harness (stubFetch) registra bodies ANTES do responder executar, entao
    // mesmo o responder que lanca (admissionError) deixa 1 body de admission
    // registrado. O invariante real e budget bounded (<=1, sem retry) — nao 0.
    assert.equal(stub.bodies().filter((b) => b?.questions?.admission).length, 1, "1 admission call registrada antes da falha (sem retry)");
  });

  it("AUTO6b: Jev indisponivel + enableAutoRoute=false => fail-closed normal, sem switch, sem route", async () => {
    const m = await bootAuto({ options: { enableAutoRoute: false } });
    const stub = orchestrateStub({ admissionError: new Error("network down") });
    const text = "tarefa qualquer";
    const ev = promptEvent(text);
    await m.hooks.session.prompt(ev);
    assert.equal(ev.prompt.text, text);
    assert.equal(ev.metadata["jev-admission"], "normal");
    assert.equal(ev.metadata["jev-admission-via"], "fallback");
    const route = await m.ctx.storage.get("route/s1");
    assert.equal(route, undefined, "sem roteamento quando modalidade e normal");
    assert.equal(m.calls.switchModel.length, 0);
  });

  it("AUTO12: orchestrate com confianca baixa => fail-closed route (nunca orchestrate forçado)", async () => {
    const m = await bootAuto();
    const stub = orchestrateStub({ admission: choice("orchestrate", 0.3) });
    const text = "ou orquestrar ou rotear";
    const ev = promptEvent(text);
    await m.hooks.session.prompt(ev);
    assert.equal(ev.prompt.text, text, "sem trampoline com confianca baixa");
    assert.equal(ev.metadata["jev-admission"], "route");
    assert.equal(ev.metadata["jev-admission-via"], "fallback");
    assert.match(ev.metadata["jev-admission-reason"], /confianca/);
    assert.equal(ev.metadata["jev-router"], "routed", "rota segue apos fallback");
    assert.equal(stub.bodies().filter((b) => b?.questions?.admission).length, 1, "1 admission call");
  });

  it("AUTO5: enableAutoOrchestration desligado => comportamento EXATO do router atual (sem trampoline, sem admission metadata, sem binding)", async () => {
    const m = await bootAuto({ options: { enableAutoOrchestration: false } });
    const stub = orchestrateStub();
    const text = "feature normal roteada";
    const ev = promptEvent(text);
    await m.hooks.session.prompt(ev);
    assert.equal(ev.prompt.text, text, "texto intacto: trampoline desligado");
    assert.equal(ev.metadata["jev-admission"], undefined, "sem metadata de admission");
    assert.equal(ev.metadata["jev-router"], "routed", "router atual funcionando");
    assert.equal(await m.ctx.storage.get("orchestration/session/s1"), undefined);
    assert.equal(await m.ctx.storage.get("orchestration/admission/s1/m1"), undefined);
    assert.ok((await m.ctx.storage.get("route/s1"))?.route, "route/* persistido pelo router atual");
    assert.equal(stub.bodies().filter((b) => b?.questions?.admission).length, 0, "zero admission calls");
  });
});

describe("AUTO7-9, AUTO14: guards (interno / vazio / trivial / sem messageID)", () => {
  it("AUTO7: sessao interna (worker) do hook => bypass TOTAL, zero Jev, zero trampoline", async () => {
    const m = await bootAuto();
    const stub = orchestrateStub();
    const ev = {
      sessionID: "w-1",
      messageID: "m1",
      prompt: { text: "executar contrato interno" },
      metadata: { "jev-router": "orchestration-internal", "jev-role": "worker" },
      delivery: {},
    };
    await m.hooks.session.prompt(ev);
    assert.equal(ev.prompt.text, "executar contrato interno", "interno nunca sofre trampoline");
    assert.equal(ev.metadata["jev-router"], "orchestration-internal");
    assert.equal(stub.bodies().length, 0, "interno nunca consulta o Jev via admission");
  });

  it("AUTO8: prompt vazio => skipped-empty, sem chamadas Jev, sem binding", async () => {
    const m = await bootAuto();
    const stub = orchestrateStub();
    const ev = promptEvent("");
    await m.hooks.session.prompt(ev);
    assert.equal(ev.metadata["jev-router"], "skipped-empty");
    assert.equal(stub.bodies().length, 0, "vazio nao consulta o Jev");
    assert.equal(await m.ctx.storage.get("orchestration/session/s1"), undefined);
  });

  it("AUTO9: follow-up trivial sem binding => nenhuma admission/run; com rota anterior vira continuation (G1 preservado)", async () => {
    const m = await bootAuto({ storage: makeStorage({ "route/s1": { route: "fast-coding", model: "opencode/big-pickle", agent: "build", chain: [] } }) });
    const stub = orchestrateStub();
    const ev = promptEvent("ok");
    await m.hooks.session.prompt(ev);
    assert.equal(ev.prompt.text, "ok");
    assert.equal(ev.metadata["jev-admission"], "skip", "trivial => sem admission");
    assert.equal(ev.metadata["jev-router"], "continuation", "G1 continua valido (rota preservada sem Jev)");
    assert.equal(stub.bodies().length, 0, "trivial nunca consulta o Jev");
    assert.equal(await m.ctx.storage.get("orchestration/session/s1"), undefined, "trivial nunca cria run/binding");
  });

  it("AUTO14: sem messageID => nenhuma admissao (sem identidade de turno); roteamento atual segue", async () => {
    const m = await bootAuto();
    const stub = orchestrateStub();
    const ev = { sessionID: "s1", messageID: "", prompt: { text: "tarefa sem turno" }, metadata: {}, delivery: {} };
    await m.hooks.session.prompt(ev);
    assert.equal(ev.metadata["jev-admission"], "normal");
    assert.equal(ev.metadata["jev-run-id"], undefined, "sem runID inventado a partir de texto");
    assert.equal(stub.bodies().filter((b) => b?.questions?.admission).length, 0, "sem admission call com identidade inexistente");
    assert.equal(await m.ctx.storage.get("orchestration/session/s1"), undefined);
  });
});

describe("AUTO10-11, AUTO13: turno identidade + seams explicitos + zero auto-resume", () => {
  it("AUTO10/BIND6: mesmo texto em NOVO turno (novo messageID) => nova admissao e novo runID permitidos", async () => {
    const m = await bootAuto();
    const stub = orchestrateStub();
    const text = "mesma intencao, novo turno";
    const ev1 = promptEvent(text, "m1");
    const ev2 = promptEvent(text, "m2");
    await m.hooks.session.prompt(ev1);
    await m.hooks.session.prompt(ev2);
    const r1 = ev1.metadata["jev-run-id"];
    const r2 = ev2.metadata["jev-run-id"];
    assert.ok(r1 && r2 && r1 !== r2, "novo messageID => novo runID (identidade de turno real)");
    assert.equal(await m.ctx.storage.get("orchestration/admission/s1/m1"), await m.ctx.storage.get("orchestration/admission/s1/m1"));
    assert.ok(await m.ctx.storage.get("orchestration/admission/s1/m2"), "segundo admission record");
    assert.equal(stub.bodies().filter((b) => b?.questions?.admission).length, 2, "1 admission por turno");
  });

  it("AUTO11: seam explicito (orchestrate_once manual SEM binding) permanece intacto", async () => {
    const m = await bootAuto();
    orchestrateStub();
    const manualContract = {
      runID: "manual-1",
      objective: "tarefa manual explicita",
      scope: { include: [], exclude: [] },
      constraints: [],
      acceptanceCriteria: ["done"],
      requiredEvidence: ["worker-session-outcome"],
      maxRounds: 1,
    };
    const res = await m.tools.orchestrate_once.execute({ contract: manualContract }, { sessionID: "other-session", agent: "build", messageID: "x", id: "t" });
    const out = JSON.parse(res.content);
    assert.equal(out.phase, "completed", "seam explicito nao sofre guard de admission");
    assert.equal(workerCount(m), 1);
    assert.equal(await m.ctx.storage.get("orchestration/session/other-session"), undefined, "manual nao cria binding de admission");
  });

  it("AUTO13/BIND4: binding em awaiting-human => linked-awaiting-human, ZERO auto-resume (resume nunca e invocado)", async () => {
    const m = await bootAuto();
    const stub = orchestrateStub();
    const seedBinding = { version: 1, sessionID: "s1", messageID: "m0", runID: "paused-run", status: "awaiting-human", phase: "awaiting-human", updatedAt: 1 };
    const seedRun = { checkpoint: "human-awaiting", state: { phase: "awaiting-human" }, updatedAt: 1 };
    await m.ctx.storage.set("orchestration/session/s1", seedBinding);
    await m.ctx.storage.set("orchestration/run/paused-run", seedRun);
    let resumeCalls = 0;
    const origResume = m.tools.orchestrate_resume.execute;
    m.tools.orchestrate_resume.execute = async (...args) => { resumeCalls += 1; return origResume(...args); };
    const text = "nova tarefa enquanto ha run pausado";
    const ev = promptEvent(text);
    await m.hooks.session.prompt(ev);
    assert.equal(ev.metadata["jev-admission"], "linked-awaiting-human");
    assert.equal(ev.metadata["jev-run-id"], "paused-run");
    assert.match(ev.metadata["jev-admission-reason"], /awaiting-human/);
    assert.ok(ev.metadata["jev-admission-reason"].includes("sem auto-resume"), "rotulo explicito de zero auto-resume");
    assert.equal(resumeCalls, 0, "hook nunca invoca orchestrate_resume");
    assert.equal(stub.bodies().filter((b) => b?.questions?.admission).length, 0, "nenhuma chamada Jev de admission");
    const bindingAfter = await m.ctx.storage.get("orchestration/session/s1");
    assert.equal(bindingAfter.status, "awaiting-human", "pausa preservada (nada avancou)");
  });
});

describe("BIND: binding session<>run (criacao, idempotencia, linked, terminal, pruning)", () => {
  it("BIND2: re-run do MESMO messageID (concorrencia de submissao) => idempotente: mesmo runID, sem 2a chamada Jev", async () => {
    const m = await bootAuto();
    const stub = orchestrateStub();
    const ev = promptEvent("tarefa submetida 2x no mesmo turno");
    await m.hooks.session.prompt(ev);
    const firstRunID = ev.metadata["jev-run-id"];
    const ev2 = promptEvent("tarefa submetida 2x no mesmo turno", "m1");
    await m.hooks.session.prompt(ev2);
    assert.equal(ev2.metadata["jev-run-id"], firstRunID, "mesmo messageID => mesmo runID");
    assert.equal(ev2.metadata["jev-admission-via"], "idempotent", "readmissao marcada como idempotente");
    assert.equal(ev2.metadata["jev-admission"], "orchestrate");
    assert.equal(stub.bodies().filter((b) => b?.questions?.admission).length, 1, "apenas a primeira submissao consulta o Jev");
    assert.ok(ev2.prompt.text.includes("tools.jev.orchestrate_once"), "trampoline reaproveitado");
  });

  it("BIND3: binding nao-terminal (running) => novo prompt = linked; sem admission, sem trampoline, sem run novo", async () => {
    const m = await bootAuto();
    const stub = orchestrateStub();
    await m.ctx.storage.set("orchestration/session/s1", { version: 1, sessionID: "s1", messageID: "m0", runID: "live-run", status: "running", phase: "running", updatedAt: 1 });
    const ev = promptEvent("segunda tarefa durante um run ativo");
    await m.hooks.session.prompt(ev);
    assert.equal(ev.metadata["jev-admission"], "linked");
    assert.equal(ev.metadata["jev-run-id"], "live-run");
    assert.equal(ev.prompt.text, "segunda tarefa durante um run ativo", "sem trampoline");
    assert.equal(stub.bodies().length, 0, "linked nunca consulta o Jev");
    assert.equal(await m.ctx.storage.get("orchestration/admission/s1/m1"), undefined, "nenhuma admissao nova");
  });

  it("BIND5: binding terminal (completed) => novo prompt admite novo run", async () => {
    const m = await bootAuto();
    const stub = orchestrateStub();
    await m.ctx.storage.set("orchestration/session/s1", { version: 1, sessionID: "s1", messageID: "m0", runID: "done-run", status: "completed", phase: "completed", updatedAt: 1 });
    const ev = promptEvent("nova tarefa apos run concluido");
    await m.hooks.session.prompt(ev);
    assert.equal(ev.metadata["jev-admission"], "orchestrate");
    assert.notEqual(ev.metadata["jev-run-id"], "done-run", "run novo nao reusa o antigo");
    assert.equal(stub.bodies().filter((b) => b?.questions?.admission).length, 1);
  });

  it("BIND7: admission records com pruning bounded (nunca crescem sem limite)", async () => {
    const m = await bootAuto();
    orchestrateStub();
    for (let i = 0; i < 150; i += 1) {
      await m.ctx.storage.set(`orchestration/admission/s1/old-${i}`, { runID: `r-${i}`, mode: "orchestrate", status: "pending" });
    }
    const ev = promptEvent("tarefa que dispara pruning");
    await m.hooks.session.prompt(ev);
    const keys = [];
    let after;
    for (;;) {
      const page = await m.ctx.storage.scan({ prefix: "orchestration/admission/s1/", after, limit: 100 });
      for (const e of page.entries ?? []) keys.push(e.key);
      after = page?.next;
      if (!after) break;
    }
    assert.ok(keys.length <= 100, `admission records bounded (got ${keys.length})`);
    assert.ok(keys.includes("orchestration/admission/s1/m1"), "record do turno atual preservado (FIFO remove os antigos)");
  });
});