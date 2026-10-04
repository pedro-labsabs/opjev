# Relatório de Estabilização E2E Multi-Round (Issue #14)

- **Issue:** [#14 — `[READY] Full multi-round E2E and stabilization gate`](https://github.com/pedro-labsabs/opjev/issues/14)
- **Branch:** `feat/issue-14-multiround-e2e-stabilization`
- **PR:** `test: complete multi-round E2E stabilization gate (#14)` (PR #32)
- **Data:** 2026-10-03
- **Runtime de Autoridade:** OpenCode **v2.0.11** (`/tmp/opencode-2.0.11/package/bin/opencode`), `@opencode/plugin@2.0.7`, Node.js `v22.x`
- **Jev Neural Engine:** Jev SystemOne Live (`https://opencode.ai/zen/v1/systemone` com chave autoritativa `OPENCODE_API_KEY`)
- **Veredito:** **GATE APROVADO (17/17 PASS no Runtime OpenCode Real + 17/17 PASS na Matriz Hermética)**

---

## 1. Contexto Arquitetural e Divisão de Autoridade

O OPJEV é um **Agentic Control Plane para OpenCode**, governando orquestrações complexas sobre o runtime nativo do OpenCode com o Jev (SystemOne) atuando como julgador semântico.

O fluxo canônico estrito é:
```
entrada → admission → ExecutionContract → kernel/state machine → Jev decide → dispatcher executa → worker → EvidencePacket → critic/Jev julga → recovery/escalation → conclusão
```

### Invariantes de Autoridade e Confiança
1. **Kernel governa:** É a única autoridade sobre contagem de rodadas, transições de fase, orçamentos (`maxRounds`) e integridade de estado (`RunState`).
2. **Jev decide:** O Jev (SystemOne) avalia evidências estruturadas e toma decisões semânticas de roteamento, julgamento e estratégia de recuperação; não executa comandos nem muta o filesystem.
3. **Dispatcher apenas executa:** O dispatcher realiza estritamente as ações autorizadas pelo kernel e pelo Jev; nunca assume autoridade de julgar nem ignora diretivas de fase.
4. **Worker nunca se autoaprova:** O worker apenas executa o contrato (`ExecutionContract`); o veredito final depende exclusivamente de verificação determinística e do julgamento independente do critic e do Jev.
5. **Critic é read-only:** O critic possui política restrita default-deny para qualquer ação de escrita, mutação, execução de subagente ou shell.
6. **Stale evidence é rejeitada:** Evidências de rodadas anteriores ou futuras disparam erro determinístico no kernel (`OrchestrationError: invalid-evidence`) e jamais aprovam uma rodada.
7. **Zero recursão de sessões internas:** Sessões criadas pelo dispatcher (`worker`, `critic`, `orchestrator`) possuem markers internos de isolamento; qualquer tentativa de reinvocar o fluxo de orquestração via prompt hook, admission RPC ou ferramenta de retomada é bloqueada deterministicamente.
8. **Zero auto-resume no gate humano:** Quando a orquestração pausa em `awaiting-human`, chamadas automáticas de sessões internas são rejeitadas; apenas o chamador humano pode autorizar a retomada.
9. **Serialização estrita de concorrência:** Chamadas concorrentes ao `orchestrate_resume` para o mesmo `runID` são serializadas por mutex assíncrono com re-leitura atômica de estado (prevenção determinística de TOCTOU); exatamente 1 chamada vence, os concorrentes perdem com erro bounded `invalid-resumable-run`, nenhum worker extra é criado e o round é incrementado uma única vez.
10. **FREE_POOL estrito:** Nenhum modelo pago ou fora do catálogo gratuito do OpenCode Zen pode ser selecionado.

---

## 2. Camadas de Prova e Estratégia de Teste

Para garantir conformidade total com o modelo de confiança sem falsos positivos, a suíte classifica e separa rigorosamente as camadas de evidência:

| Camada / Tier | Escopo / Mecanismo | Papel na Validação |
|---|---|---|
| **UNIT** | Invariantes puras de kernel, transições de estado, parsing de vereditos e prompt builders sem I/O. | Valida a lógica central e contratos de dados matematicamente isolados. |
| **INTEGRATION / HERMETIC** | Harness in-memory com SQLite simulado e `stubFetch` (`src/multiround-stabilization.test.mjs` via `npm run e2e:matrix`). | Valida a integração entre módulos internos com velocidade sub-segundo (~55ms) e determinismo total para CI. |
| **OPENCODE REAL E2E** | Processo binário autoritativo OpenCode v2.0.11 com SQLite real em disco (`session_v2`), servidor HTTP/RPC real de admission e sessões reais (`scripts/e2e-multiround-real.mjs` via `npm run e2e:multiround-real`). | Prova que o OPJEV funciona sobre o runtime de produção real do OpenCode v2.0.11. |
| **LIVE JEV SYSTEMONE** | Chamada de rede real via HTTP ao endpoint oficial do SystemOne (`https://opencode.ai/zen/v1/systemone`) autenticado via `OPENCODE_API_KEY`. | Prova a integração semântica viva com a rede neural de julgamento do Jev. |
| **FAULT-INJECTED E2E** | Injeção de falhas estritamente na fronteira de rede/ambiente (proxy HTTP interceptando e retornando 500, 429 ou timeouts) sem tocar no código de produção. | Prova resiliência, fail-closed e integridade de gates diante de adversidades do mundo real. |

---

## 3. Matriz Definitiva de Estabilização (17 Cenários da Issue #14)

Todos os 17 cenários foram executados e aprovados tanto no **Runner E2E Real** quanto na **Matriz Hermética**:

| # | Cenário | Camada de Evidência Principal | Invariante Comprovada | Fase Final | Status |
|---|---------|-------------------------------|----------------------|------------|--------|
| 1 | **happy path → accept** | **REAL OPENCODE + LIVE JEV SYSTEMONE** | Worker executa, critic read-only valida (0 findings), Jev neural ao vivo emite `accept`. Kernel conclui. Worker e critic em sessões distintas. | `completed` (Round 1) | **PASS** |
| 2 | **critic encontra problema → Jev não aceita** | **REAL OPENCODE + CONTROLLED JEV BOUNDARY** | Critic detecta blocker. Gate determinístico do kernel barra `accept` e transiciona para recuperação. | `awaiting-human` (Round 1) | **PASS** |
| 3 | **repair-same** | **REAL OPENCODE + MULTI-ROUND RUNTIME** | Mesma sessão do worker (`workerSessionID`) reusada na rodada 2; critic anterior descartado e novo critic provisionado. Round avança 1 → 2. | `completed` (Round 2) | **PASS** |
| 4 | **fresh-same** | **REAL OPENCODE + MULTI-ROUND RUNTIME** | Sessão de worker anterior descartada; nova sessão de worker criada mantendo mesmo agent (`build`) e model (`opencode/big-pickle`). | `completed` (Round 2) | **PASS** |
| 5 | **switch-model** | **REAL OPENCODE + FREE_POOL GUARD** | Troca semântica de modelo autorizada pelo Jev; modelo validado contra o `FREE_POOL` (ex.: `opencode/ling-3.0-flash-fin-free`); nova sessão criada. | `completed` (Round 2) | **PASS** |
| 6 | **switch-agent** | **REAL OPENCODE + CATALOG GUARD** | Troca de agente autorizada pelo Jev; agente validado como `primaryEligible` (ex.: `plan`); nova sessão criada com round incrementado. | `completed` (Round 2) | **PASS** |
| 7 | **replan** | **REAL OPENCODE + ORCHESTRATOR ISOLATION** | Sessão isolada de `orchestrator` read-only (zero mutações permitidas); novo `ExecutionContract` validado (mesmo `runID`, `maxRounds` preservado). Nova sessão de worker executa o contrato revisado. | `completed` (Round 2) | **PASS** |
| 8 | **human + resume concorrente** | **REAL OPENCODE + CONCURRENCY LOCK** | Pausa em `awaiting-human`. Duas chamadas concorrentes sobrepostas: barreira temporal comprova sobreposição estrita (`enters[1] < exits[0]`); exatamente 1 winner; exatamente 1 loser (`invalid-resumable-run`); 1 única human-decision; 1 worker e 1 critic na rodada retomada; 0 locks pendentes. | `completed` (Round 2) | **PASS** |
| 9 | **stop** | **REAL OPENCODE + IMMEDIATE TERMINATION** | Decisão de parada encerra imediatamente o run em `stopped` na rodada 1; zero novas sessões de worker e zero rodadas extras. | `stopped` (Round 1) | **PASS** |
| 10 | **worker timeout / interrupted** | **REAL OPENCODE + WORKER BOUNDARY** | Worker excede timeout bounded (`OPJEV_WORKER_TIMEOUT_MS`); OpenCode interrompe a sessão; checks determinísticos falham; run encerra de forma bounded em `failed`. | `failed` (Round 1) | **PASS** |
| 11 | **critic timeout / failure** | **REAL OPENCODE + CRITIC GUARD** | Falha de execução ou corrupção de saída JSON do critic marca `critic-session-outcome: fail`; impede aprovação determinística no kernel. | `failed` (Round 1) | **PASS** |
| 12 | **Jev unavailable / timeout** | **REAL OPENCODE + FAULT INJECTION (HTTP 500)** | Falha HTTP 500 na fronteira de rede do Jev tratada de forma bounded sem loops infinitos; run falha de forma segura. | `failed` (Round 1) | **PASS** |
| 13 | **provider / global throttle** | **REAL OPENCODE + FAULT INJECTION (HTTP 429)** | Detecção de status 429 (rate limit) no provedor interrompe a orquestração em `switch-throttled`, evitando tempestades de chamadas. | `failed` (Round 1) | **PASS** |
| 14 | **maxRounds exhaustion** | **REAL OPENCODE + BUDGET ENFORCEMENT** | Limite de rodadas do contrato atingido; kernel barra qualquer rodada adicional e escala obrigatoriamente para `awaiting-human` com `kind: max-rounds`. | `awaiting-human` (Round 2) | **PASS** |
| 15 | **tentativa de recursão por sessão interna** | **REAL OPENCODE + MULTI-LAYER RECURSION GUARD** | Bloqueio verificado em 3 camadas para `worker`, `critic` e `orchestrator`: prompt hook seta `orchestration-internal` e zera escrita de rota; admission RPC retorna `internal-bypass` (0 runs); `orchestrate_resume` rejeita chamador interno. | `internal-bypass` (Round 0) | **PASS** |
| 16 | **agent / model candidate inválido** | **REAL OPENCODE + CANDIDATE INTEGRITY** | 4 sub-testes exaustivos: (16a) modelo pago fora do free pool (`openai/gpt-4o`); (16b) modelo inexistente; (16c) agente desconhecido; (16d) agente não-primário (`subagent`). Todos rejeitados fail-closed. | `failed` (Round 1) | **PASS** |
| 17 | **stale evidence / rodada errada** | **REAL OPENCODE + CAUSAL ROUND INTEGRITY** | Pacote de evidência com rodada inconsistente (`round: 99`) injetado no kernel; rejeitado deterministicamente com `OrchestrationError(code: "invalid-evidence")`. | `evaluating` (Round 1) | **PASS** |

---

## 4. Evidência Estruturada Salva em Disco

A execução do runner E2E real gerou o artefato auditável:
`docs/reports/artifacts/issue-14-real-e2e-evidence.json`

O artefato contém exatamente os campos bounded exigidos pelo modelo de conformidade e segurança:
`scenarioId`, `scenarioName`, `tier`, `runID`, `round`, `workerSessionID`, `criticSessionID`, `executor`, `verdict`, `command`, `finalPhase`.

Zero raw context, zero chain-of-thought e zero segredos/tokens foram expostos.

---

## 5. Execução dos Gates Obrigatórios

Todos os 6 gates de verificação foram executados com saída limpa:

### 5.1 Typecheck
```bash
npm run typecheck
```
```
> opencode-jev-free-router@0.1.0 typecheck
> tsc --noEmit -p ./tsconfig.json
(0 erros, saída limpa)
```

### 5.2 Testes Unitários e de Integração
```bash
npm test
```
```
# tests 602
# suites 100
# pass 602
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

### 5.3 Matriz Hermética de Estabilização
```bash
npm run e2e:matrix
```
```
# tests 17
# suites 1
# pass 17
# fail 0
# duration_ms ~55ms
```

### 5.4 Gateway E2E
```bash
npm run e2e:gateway
```
```
[e2e-gateway] OpenCode v2.0.11 upstream pronto
[e2e-gateway] Teste 1: Admissão RPC → PASS
[e2e-gateway] Teste 2: Prompt hook bypass → PASS
[e2e-gateway] Teste 3: Presentation notice → PASS
[e2e-gateway] TODOS OS TESTES PASSARAM COM SUCESSO!
```

### 5.5 Runner E2E Real Multi-Round (#14)
```bash
npm run e2e:multiround-real
```
```
[e2e-real] Iniciando Gate Definitivo de Estabilização E2E Multi-Round Real
[e2e-real] OpenCode binary: /tmp/opencode-2.0.11/package/bin/opencode
[e2e-real] Chave OpenCode Zen: [CONFIGURED]
[e2e-real] Jev SystemOne Proxy ouvindo em :38799
[e2e-real] Subindo upstream OpenCode v2.0.11 em :40397...
[e2e-real] Upstream pronto: OpenCode v2.0.11
[e2e-real] OpenCode v2.0.11 e RPC de Admission operacionais. Iniciando execução dos 17 cenários...
[e2e-real] [1/17] Cenário 1: PASS (phase=completed, round=1)
...
[e2e-real] [17/17] Cenário 17: PASS (threwStale=true)
====================================================================================================
 [SUCCESS] Todos os 17 cenários do Gate de Estabilização E2E passaram com sucesso!
 [PROVA E2E REAL] Executado sobre OpenCode v2.0.11 com Jev SystemOne real e fault-injection de rede.
====================================================================================================
```

### 5.6 Git Diff Check
```bash
git diff --check
```
```
(0 conflitos de espaço em branco ou formato, saída limpa)
```

---

## 6. Conclusão

A **Issue #14** está integralmente resolvida. O gate de estabilização multi-round comprovou em execução viva e reproduzível que o OPJEV é um control plane robusto, à prova de autoaprovação, com isolamento rígido de papéis e com autoridade estrita do kernel e do Jev.
