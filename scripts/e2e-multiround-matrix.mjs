#!/usr/bin/env node
// Gate de Estabilização E2E Multi-Round (Issue #14)
// Runner standalone que executa os 17 cenários obrigatórios e emite a matriz estruturada.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testFile = path.resolve(__dirname, "../src/multiround-stabilization.test.mjs");

const SCENARIOS = [
  {
    id: 1,
    name: "happy path → accept",
    existingProof: "state-machine.test.mjs (accept), dispatcher.test.mjs (single round)",
    missingProof: "Execução multi-round completa com evidência limpa e isolamento worker/critic",
    testRequired: "Cenário 1: round 1 completed, workerSessionID != criticSessionID, zero auto-approval",
  },
  {
    id: 2,
    name: "critic encontra problema → Jev não aceita",
    existingProof: "state-machine.test.mjs (hard failure determinística)",
    missingProof: "Bloqueio determinístico de veredito desonesto no runtime do dispatcher",
    testRequired: "Cenário 2: critic reporta blocker, gate determinístico barra accept -> failed",
  },
  {
    id: 3,
    name: "repair-same",
    existingProof: "state-machine.test.mjs (repairing state transition)",
    missingProof: "Reuso estrito da workerSessionID, novo critic isolado, avanço de round no dispatcher",
    testRequired: "Cenário 3: round 1 repair-same -> round 2 mesmo workerSessionID + nova criticSessionID",
  },
  {
    id: 4,
    name: "fresh-same",
    existingProof: "state-machine.test.mjs (fresh-same route)",
    missingProof: "Descarte de sessão de worker anterior com preservação de agent e model",
    testRequired: "Cenário 4: round 1 fresh-same -> round 2 novo workerSessionID + mesmo agent/model",
  },
  {
    id: 5,
    name: "switch-model",
    existingProof: "config.ts (FREE_POOL), prompt.test.mjs (model guardrails)",
    missingProof: "Seleção dinâmica autorizada de modelo via SystemOne e transição de rodada",
    testRequired: "Cenário 5: troca explícita para modelo elegível do FREE_POOL com fresh worker",
  },
  {
    id: 6,
    name: "switch-agent",
    existingProof: "prompt.test.mjs (agent catalogue)",
    missingProof: "Seleção de agente via question SystemOne com fresh worker e nova rodada",
    testRequired: "Cenário 6: transição de agente primaryEligible e round 2 concluído",
  },
  {
    id: 7,
    name: "replan",
    existingProof: "state-machine.test.mjs (RP1-RP8 replan lifecycle)",
    missingProof: "Sessão de orchestrator isolada read-only, contrato revisado sem aumento de maxRounds",
    testRequired: "Cenário 7: planejamento isolado, contrato revisado e fresh worker round 2",
  },
  {
    id: 8,
    name: "human + resume",
    existingProof: "human-gate.test.mjs, dispatcher.test.mjs (awaiting-human)",
    missingProof: "Caller guard impedindo internal sessions + lock serializando chamadas concorrentes",
    testRequired: "Cenário 8: pausa awaiting-human, rejeição de worker caller, resume serializado",
  },
  {
    id: 9,
    name: "stop",
    existingProof: "state-machine.test.mjs (stopped phase)",
    missingProof: "Terminação imediata no dispatcher com zero workers subsequentes",
    testRequired: "Cenário 9: parada imediata em stopped na rodada 1 sem novas sessões",
  },
  {
    id: 10,
    name: "worker timeout / interrupted",
    existingProof: "dispatcher.ts (WORKER_TIMEOUT_MS constant)",
    missingProof: "Interrupção bounded do worker sem travar o loop de orquestração",
    testRequired: "Cenário 10: timeout dispara interrupção, deterministic check fail -> phase failed",
  },
  {
    id: 11,
    name: "critic timeout / failure",
    existingProof: "readonly-policy.ts (critic permissions)",
    missingProof: "Falha catastrófica do critic resulta em check fail e impede accept",
    testRequired: "Cenário 11: saída corrompida do critic -> critic-session-outcome fail -> blocked accept",
  },
  {
    id: 12,
    name: "Jev unavailable / timeout",
    existingProof: "fetch stubs em testes unitários",
    missingProof: "Resposta 500 do Jev aborta execução de forma bounded sem loops infinitos",
    testRequired: "Cenário 12: SystemOne HTTP 500 capturado e abortado com erro explícito",
  },
  {
    id: 13,
    name: "provider / global throttle",
    existingProof: "retry.test.mjs (switch-throttled heuristics)",
    missingProof: "Detecção de 429 no worker impede storms de novas worker sessions",
    testRequired: "Cenário 13: worker rate-limit aborta transição switch-model sem spawning de workers",
  },
  {
    id: 14,
    name: "maxRounds exhaustion",
    existingProof: "state-machine.test.mjs (budget enforcement)",
    missingProof: "Loop multi-round esgota maxRounds e transiciona para awaiting-human kind max-rounds",
    testRequired: "Cenário 14: rodadas sucessivas pausam em awaiting-human sem ultrapassar maxRounds",
  },
  {
    id: 15,
    name: "tentativa de recursão por sessão interna",
    existingProof: "worker-hooks.ts (isInternalWorkerSession)",
    missingProof: "Proteção multi-camada: admission RPC internal-bypass + resume tool caller check",
    testRequired: "Cenário 15: sessão interna bloqueada em prompt hook, admission RPC e resume tool",
  },
  {
    id: 16,
    name: "agent / model candidate inválido",
    existingProof: "config.ts (FREE_POOL check)",
    missingProof: "Tentativa de switch para modelo pago ou agent inexistente é barrada fast-fail",
    testRequired: "Cenário 16: modelo pago (ex: gpt-4o) rejeitado imediatamente no dispatcher",
  },
  {
    id: 17,
    name: "stale evidence / rodada errada",
    existingProof: "state-machine.ts (evidence.round validation)",
    missingProof: "EVIDENCE_READY com round descompassado falha deterministicamente",
    testRequired: "Cenário 17: evidence de rodada anterior/posterior rejeitada com OrchestrationError",
  },
];

console.log("================================================================================");
console.log("   OPJEV — GATE DEFINITIVO DE ESTABILIZAÇÃO E2E MULTI-ROUND (ISSUE #14)         ");
console.log("================================================================================\n");

const child = spawn("node", ["--test", testFile], { stdio: ["inherit", "pipe", "pipe"] });

let stdout = "";
let stderr = "";

child.stdout.on("data", (d) => { stdout += d.toString(); });
child.stderr.on("data", (d) => { stderr += d.toString(); });

child.on("close", (code) => {
  const allPassed = code === 0;
  
  console.log("| #  | Cenário                                  | Teste / E2E Necessário                                            | Resultado |");
  console.log("|----|------------------------------------------|-------------------------------------------------------------------|-----------|");
  
  for (const s of SCENARIOS) {
    const passed = stdout.includes(`ok ${s.id} - Cenário ${s.id}:`);
    const status = passed ? " PASS " : " FAIL ";
    const idStr = String(s.id).padEnd(2, " ");
    const nameStr = s.name.padEnd(40, " ");
    const testStr = s.testRequired.slice(0, 65).padEnd(65, " ");
    console.log(`| ${idStr} | ${nameStr} | ${testStr} |   ${status}  |`);
  }
  
  console.log("================================================================================");
  if (allPassed) {
    console.log(" [SUCCESS] Todos os 17 cenários da Issue #14 passaram com sucesso.");
    console.log(" [GATE OK] Matriz multi-round e estabilização de orquestração v1 consolidada.");
    console.log("================================================================================\n");
    process.exit(0);
  } else {
    console.error(" [FAILURE] Falha em cenários da matriz de estabilização.");
    if (stderr) console.error(stderr);
    process.exit(1);
  }
});
