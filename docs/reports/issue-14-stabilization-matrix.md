# Relatório de Estabilização E2E Multi-Round (Issue #14)

- **Issue:** [#14 — `[READY] Full multi-round E2E and stabilization gate`](https://github.com/pedro-labsabs/opjev/issues/14)
- **Branch:** `feat/issue-14-multiround-e2e-stabilization`
- **PR:** `test: complete multi-round E2E stabilization gate (#14)`
- **Data:** 2026-10-03
- **Runtime de Autoridade:** OpenCode **v2.0.11** (`/tmp/opencode-2.0.11/package/bin/opencode`), `@opencode/plugin@2.0.7`, Node.js `v22.x`
- **Veredito:** **GATE APROVADO (17/17 PASS)**

---

## 1. Contexto Arquitetural e Divisão de Autoridade

O OPJEV é um **Agentic Control Plane para OpenCode**, governando orquestrações complexas sobre o runtime nativo do OpenCode com o Jev (SystemOne) atuando como julgador semântico.

O fluxo canônico estrito é:
```
entrada → admission → ExecutionContract → kernel/state machine → Jev decide → dispatcher executa → worker → EvidencePacket → critic/Jev julga → recovery/escalation → conclusão
```

### Invariantes de Autoridade
1. **Kernel governa:** É a única autoridade sobre contagem de rodadas, transições de fase, orçamentos (`maxRounds`) e integridade de estado (`RunState`).
2. **Jev decide:** O Jev (SystemOne) avalia evidências estruturadas e toma decisões semânticas de roteamento, julgamento e estratégia de recuperação; não executa comandos nem muta o filesystem.
3. **Dispatcher apenas executa:** O dispatcher realiza estritamente as ações autorizadas pelo kernel e pelo Jev; nunca assume autoridade de julgar nem ignora diretivas de fase.
4. **Worker nunca se autoaprova:** O worker apenas executa o contrato (`ExecutionContract`); o veredito final depende exclusivamente de verificação determinística e do julgamento independente do critic e do Jev.
5. **Critic é read-only:** O critic possui política restrita default-deny para qualquer ação de escrita, mutação, execução de subagente ou shell.
6. **Stale evidence é rejeitada:** Evidências de rodadas anteriores ou futuras disparam erro determinístico no kernel (`OrchestrationError: invalid-evidence`) e jamais aprovam uma rodada.
7. **Zero recursão de sessões internas:** Sessões criadas pelo dispatcher (`worker`, `critic`, `orchestrator`) possuem markers internos de isolamento; qualquer tentativa de reinvocar o fluxo de orquestração via prompt hook, admission RPC ou ferramenta de retomada é bloqueada deterministicamente.
8. **Zero auto-resume no gate humano:** Quando a orquestração pausa em `awaiting-human`, chamadas automáticas de sessões internas são rejeitadas; apenas o chamador humano pode autorizar a retomada.
9. **FREE_POOL estrito:** Nenhum modelo pago ou fora do catálogo gratuito do OpenCode Zen pode ser selecionado.

---

## 2. Matriz de Estabilização E2E (17 Cenários Obrigatórios)

| # | Cenário | Prova Existente | Gap / O que Faltava | Teste / E2E Implementado | Resultado |
|---|---------|-----------------|---------------------|---------------------------|-----------|
| 1 | **happy path → accept** | `state-machine.test.mjs` (accept puro) | Provar ciclo multi-round ponta a ponta com worker e critic em sessões isoladas e evidência limpa | Cenário 1 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 2 | **critic encontra problema → Jev não aceita** | `state-machine.test.mjs` (hard failure no kernel) | Provar que quando o critic reporta blocker, gate determinístico barra `accept` desonesto do Jev | Cenário 2 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 3 | **repair-same** | `state-machine.test.mjs` (transição para `repairing`) | Reuso estrito da `workerSessionID`, novo critic isolado, avanço de round no dispatcher | Cenário 3 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 4 | **fresh-same** | `state-machine.test.mjs` (transição fresh-same) | Descarte da sessão de worker anterior com criação de nova sessão preservando agent e model | Cenário 4 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 5 | **switch-model** | `config.ts` (FREE_POOL), `prompt.test.mjs` | Troca autorizada de modelo via SystemOne respeitando FREE_POOL com fresh worker e round incrementado | Cenário 5 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 6 | **switch-agent** | `prompt.test.mjs` (catálogo de agentes) | Troca de agente elegível (`primaryEligible`) via SystemOne com fresh worker e round incrementado | Cenário 6 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 7 | **replan** | `state-machine.test.mjs` (RP1-RP8 lifecycle) | Sessão de orchestrator isolada read-only, novo contrato validado sem aumento de `maxRounds`, fresh worker na rodada 2 | Cenário 7 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 8 | **human + resume** | `human-gate.test.mjs`, `dispatcher.test.mjs` | Pausa em `awaiting-human`, bloqueio de caller interno de worker, e serialização de chamadas concorrentes via lock | Cenário 8 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 9 | **stop** | `state-machine.test.mjs` (stopped phase) | Terminação imediata no dispatcher na rodada 1 sem novas sessões de worker ou novas rodadas | Cenário 9 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 10 | **worker timeout / interrupted** | `dispatcher.ts` (`WORKER_TIMEOUT_MS`) | Interrupção bounded do worker sem travar o loop; deterministic check falha e encerra em `failed` | Cenário 10 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 11 | **critic timeout / failure** | `readonly-policy.ts` (permissões do critic) | Falha catastrófica ou corrupção de saída do critic marca `critic-session-outcome: fail` e impede aprovação | Cenário 11 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 12 | **Jev unavailable / timeout** | Testes com fetch stubs locais | Falha HTTP 500 do SystemOne capturada de forma bounded sem loops infinitos ou crash da aplicação | Cenário 12 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 13 | **provider / global throttle** | `retry.test.mjs` (heurísticas de throttle) | Detecção de erro 429 no worker impede storms de novos workers e encerra com `switch-throttled` | Cenário 13 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 14 | **maxRounds exhaustion** | `state-machine.test.mjs` (enforcement puro) | Loop atinge limite de rodadas e pausa em `awaiting-human` com `kind: max-rounds` sem exceder o budget | Cenário 14 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 15 | **tentativa de recursão por sessão interna** | `worker-hooks.ts` (marker puro) | Bloqueio efetivo em 3 superfícies: prompt hook bypass, admission RPC `internal-bypass` e `orchestrate_resume` caller guard | Cenário 15 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 16 | **agent / model candidate inválido** | `config.ts` (`isFreeModel`) | Tentativa de selecionar modelo pago (ex: `openai/gpt-4o`) ou agent fora da lista falha fast-fail | Cenário 16 em `src/multiround-stabilization.test.mjs` | **PASS** |
| 17 | **stale evidence / rodada errada** | `state-machine.ts` (validação de round) | Injeção de `EvidencePacket` com rodada descompassada dispara `OrchestrationError(invalid-evidence)` determinístico | Cenário 17 em `src/multiround-stabilization.test.mjs` | **PASS** |

---

## 3. Prova Detalhada dos 17 Cenários

### Cenário 1: Happy path → accept
- **Invariante:** O worker executa o contrato na rodada 1; o critic inspeciona os resultados de forma read-only; o Jev emite veredito `accept` com evidência verde (todos checks determinísticos `pass`, zero findings do critic). O kernel conclui o run com fase `completed` na rodada 1. Worker e critic possuem IDs de sessão distintos.

### Cenário 2: Critic encontra problema → Jev não aceita
- **Invariante:** Quando o critic encontra um defeito `blocker`, o gate determinístico do kernel bloqueia qualquer tentativa de aceitação, mesmo que o Jev emita veredito `accept`. O estado transiciona para `failed` com mensagem diagnóstica explícita (`deterministicChecks contem hard failure`).

### Cenário 3: repair-same
- **Invariante:** Na falha de implementação reparável, o Jev emite `repair-same`. A `workerSessionID` da rodada 1 é reutilizada exatamente na rodada 2 com prompt de feedback acumulado. O critic da rodada 1 é descartado e um novo critic é provisionado. A rodada é incrementada e concluída.

### Cenário 4: fresh-same
- **Invariante:** O Jev opta por recomeçar a tarefa (`fresh-same`). A sessão de worker da rodada 1 é descartada; uma nova sessão de worker é criada mantendo rigorosamente o mesmo agente (`build`) e o mesmo modelo (`opencode/big-pickle`). A rodada avança de 1 para 2.

### Cenário 5: switch-model
- **Invariante:** O Jev diagnostica fraqueza de modelo (`wrong-model`) e solicita troca. Os candidatos válidos são restritos estritamente ao `FREE_POOL`. O Jev seleciona o modelo substituto via question `selected_model`. Uma nova sessão de worker com o novo modelo é criada e a rodada 2 é executada.

### Cenário 6: switch-agent
- **Invariante:** O Jev diagnostica fraqueza de agente (`wrong-agent`). Os candidatos disponíveis no catálogo do runtime (`primaryEligible`) são apresentados. O Jev seleciona o novo agente via question `selected_agent`. Uma nova sessão de worker é instanciada e a rodada 2 é concluída.

### Cenário 7: replan
- **Invariante:** Diante de contrato inexequível (`bad-contract`), o Jev solicita replanejamento. O dispatcher cria uma sessão de `orchestrator` estritamente read-only (com permissões negando qualquer mutação `edit/shell/subagent`). O contrato revisado é validado pelo kernel (mesmo `runID`, `maxRounds` nunca aumentado), e uma fresh worker session executa a rodada 2.

### Cenário 8: human + resume
- **Invariante:** Falta de contexto ou ambiguidade faz o Jev decidir `human`. O run é pausado em `awaiting-human` com `requestID` determinístico. Chamadas ao `orchestrate_resume` originadas de sessões internas (worker/critic) são barradas com mensagem de segurança. Chamadas concorrentes de humanos são serializadas via `withResumeLock`, e a decisão vencedora retoma o run até a conclusão.

### Cenário 9: stop
- **Invariante:** Quando o Jev determina `stop`, o kernel transiciona imediatamente para a fase terminal `stopped`. Nenhuma sessão subsequente de worker ou critic é criada, e o loop encerra imediatamente na rodada 1.

### Cenário 10: worker timeout / interrupted
- **Invariante:** Se a execução do worker estourar o limite de tempo bounded (`WORKER_TIMEOUT_MS`), o runtime interrompe a sessão via `ctx.session.interrupt`. O resultado registra o outcome `interrupted`, os checks determinísticos falham e o run encerra bounded em `failed` sem hang do processo.

### Cenário 11: critic timeout / failure
- **Invariante:** Caso o critic falhe, dê crash ou retorne saída não-JSON corrompida, o check determinístico `critic-session-outcome` é marcado como `fail`. Esse check impede deterministicamente que qualquer veredito `accept` seja honrado, evitando autoaprovação silenciosa.

### Cenário 12: Jev unavailable / timeout
- **Invariante:** Se o endpoint do Jev SystemOne retornar HTTP 500 ou timeout, o erro é capturado de forma bounded pelo dispatcher. O run transiciona para `failed` com diagnóstico explícito, sem loops de retry infinitos.

### Cenário 13: provider / global throttle
- **Invariante:** Quando o worker falha com mensagem indicando throttle do provedor (HTTP 429 / rate limit), o dispatcher detecta a condição e interrompe a orquestração com `switch-throttled`, impedindo tempestades de novas sessões e chamadas à API.

### Cenário 14: maxRounds exhaustion
- **Invariante:** Se o número máximo de rodadas (`maxRounds`) for alcançado sem conclusão, o kernel intercepta a tentativa de novo ciclo e escala obrigatoriamente para `awaiting-human` com `kind: max-rounds`. O número da rodada nunca excede o limite contratual.

### Cenário 15: tentativa de recursão por sessão interna
- **Invariante:** Proteção de auto-recursão em 3 camadas:
  1. No hook de prompt, sessões com marker `orchestration-internal` sofrem bypass de auto-roteamento;
  2. No handler de RPC de admissão, chamadas vindas de sessões internas retornam status `internal-bypass` e zero runs são despachados;
  3. Na ferramenta `orchestrate_resume`, a verificação de sessão rejeita callers internos de orquestração (`worker`, `critic`, `orchestrator`).

### Cenário 16: agent / model candidate inválido
- **Invariante:** Se o Jev tentar selecionar um modelo proibido ou pago (como `openai/gpt-4o`) ou um agente não cadastrado, o dispatcher rejeita a resposta e falha fast-fail com erro explícito (`fora dos candidatos validos`).

### Cenário 17: stale evidence / rodada errada
- **Invariante:** A máquina de estados valida estritamente a pertinência temporal do `EvidencePacket`. Se um pacote contendo `round: 2` for entregue enquanto o estado estiver em `round: 1`, a transição `EVIDENCE_READY` dispara `OrchestrationError(code: "invalid-evidence")`, rejeitando a evidência.

---

## 4. Evidência de Execução dos Gates

### 4.1 Typecheck
```
> opencode-jev-free-router@0.1.0 typecheck
> tsc --noEmit -p ./tsconfig.json
(0 erros, saída limpa)
```

### 4.2 Testes Unitários e de Integração
```
> opencode-jev-free-router@0.1.0 test
> node --test ./src/*.test.mjs

# tests 602
# suites 100
# pass 602
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### 4.3 Matriz E2E Multi-Round Dedicada (#14)
```
> opencode-jev-free-router@0.1.0 e2e:matrix
> node scripts/e2e-multiround-matrix.mjs

================================================================================
   OPJEV — GATE DEFINITIVO DE ESTABILIZAÇÃO E2E MULTI-ROUND (ISSUE #14)         
================================================================================

| #  | Cenário                                  | Teste / E2E Necessário                                            | Resultado |
|----|------------------------------------------|-------------------------------------------------------------------|-----------|
| 1  | happy path → accept                      | Cenário 1: round 1 completed, workerSessionID != criticSessionID, |    PASS   |
| 2  | critic encontra problema → Jev não aceita | Cenário 2: critic reporta blocker, gate determinístico barra acce |    PASS   |
| 3  | repair-same                              | Cenário 3: round 1 repair-same -> round 2 mesmo workerSessionID + |    PASS   |
| 4  | fresh-same                               | Cenário 4: round 1 fresh-same -> round 2 novo workerSessionID + m |    PASS   |
| 5  | switch-model                             | Cenário 5: troca explícita para modelo elegível do FREE_POOL com  |    PASS   |
| 6  | switch-agent                             | Cenário 6: transição de agente primaryEligible e round 2 concluíd |    PASS   |
| 7  | replan                                   | Cenário 7: planejamento isolado, contrato revisado e fresh worker |    PASS   |
| 8  | human + resume                           | Cenário 8: pausa awaiting-human, rejeição de worker caller, resum |    PASS   |
| 9  | stop                                     | Cenário 9: parada imediata em stopped na rodada 1 sem novas sessõ |    PASS   |
| 10 | worker timeout / interrupted             | Cenário 10: timeout dispara interrupção, deterministic check fail |    PASS   |
| 11 | critic timeout / failure                 | Cenário 11: saída corrompida do critic -> critic-session-outcome  |    PASS   |
| 12 | Jev unavailable / timeout                | Cenário 12: SystemOne HTTP 500 capturado e abortado com erro expl |    PASS   |
| 13 | provider / global throttle               | Cenário 13: worker rate-limit aborta transição switch-model sem s |    PASS   |
| 14 | maxRounds exhaustion                     | Cenário 14: rodadas sucessivas pausam em awaiting-human sem ultra |    PASS   |
| 15 | tentativa de recursão por sessão interna | Cenário 15: sessão interna bloqueada em prompt hook, admission RP |    PASS   |
| 16 | agent / model candidate inválido         | Cenário 16: modelo pago (ex: gpt-4o) rejeitado imediatamente no d |    PASS   |
| 17 | stale evidence / rodada errada           | Cenário 17: evidence de rodada anterior/posterior rejeitada com O |    PASS   |
================================================================================
 [SUCCESS] Todos os 17 cenários da Issue #14 passaram com sucesso.
 [GATE OK] Matriz multi-round e estabilização de orquestração v1 consolidada.
================================================================================
```

---

## 5. Conclusão

Todos os requisitos da **Issue #14** foram estritamente satisfeitos:
1. Matriz de 17 cenários comprovada integralmente;
2. Zero auto-aprovação de worker;
3. Respeito inviolável a `maxRounds`, isolamento de sessões e política read-only;
4. Gateway e runtime de autoridade OpenCode v2.0.11 validados;
5. Suíte e runners automatizados e reprodutíveis sem segredos.
