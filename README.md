# jev-free-router (OpenCode plugin, MVP)

Jev como **juiz-roteador (System One, nao-generativo)** via **OpenCode Zen**,
para os free models do Zen, com **fallback em cadeia**.

## Chave: a mesma do Zen (gratis)

Nao precisa de chave separada da TypeSafe. O Jev no Zen usa:

- Endpoint: `https://opencode.ai/zen/v1/systemone`
- Modelo: `jev-1.13-free` (gratis por tempo limitado; `jev-1.13` pago segue disponivel)
- Auth: `Authorization: Bearer $OPENCODE_API_KEY` — a mesma key do Zen,
  configurada conforme as docs do provedor ([opencode.ai/auth](https://opencode.ai/auth),
  conectada via `/connect`). Configure a key antes de usar; sem key, o plugin
  ainda tolera a chamada e, se o Jev nao responder, cai para o fallback local.

O plugin resolve a chave **a cada chamada**: env `OPENCODE_API_KEY` ->
credential do `/connect` (integration Zen/OpenCode, `Credential.Value`
`{key}` ou `{access}`). Sem chave ou com falha do Jev, cai para
heuristica/cadeia local sem quebrar (e anexa `jevError` no retorno).

## Como funciona

1. **Auto-route (hook `prompt`, quando `enableAutoRoute=true`):** a cada
   prompt admitido, a intencao original e catalogada (`intention/*`: texto,
   rota, agente, modelo, confianca, timestamp) e distribuida — troca o
   modelo da sessao (`ctx.session.switchModel` com `{ providerID, id }`) e o
   agente (`ctx.session.switchAgent`), persiste `route/*` e anota
   `jev-route`/`jev-agent`/`jev-model`/`jev-via`/`jev-overridden` nos
   metadados. Falhas nunca bloqueiam o prompt.
2. **Agentes chamam o Jev sozinhos (hook `context`):** na montagem do contexto
   do agent loop (inclusive em **continuacoes** da sessao, nao so no turno do
   usuario) o plugin injeta uma instrucao ENXUTA: as tools Jev vivem no
   namespace `jev` em Code Mode — o agente usa o tool `execute` e chama
   `tools.jev.decide(...)` (decisao generica), `tools.jev.route(...)`
   (lane/model/agent) ou `tools.jev.escalate(...)` (apos falha). Ninguem
   precisa parar o servico nem mandar mensagem manual para o Jev decidir.
   (Nao existem tools globais `jev_decide`/`jev_route`/`jev_escalate`.)
   Depois de erro material em tool (hook `tool.execute.after`), o mesmo hook
   entrega a recomendacao de recuperacao do Jev (retry/replan/stop/escalate)
   como mensagem **one-shot**, consumida/removida na hora (nunca em loop,
   nunca execucao destrutiva automatica).
3. **Manual (`tools.jev.route` via `execute`):** mesma decisao sob demanda;
   com `sessionID`, o estado so e persistido **apos** o switch bem-sucedido.
4. **Juiz generico (`tools.jev.decide` via `execute`):** qualquer `state` + perguntas
   SystemOne (`choice`/`noul`/`score`, max 8) — o Jev julga qualquer decisao
   da equipe (modelo, prioridade, trade-off, proximo passo). Todas as
   perguntas exigem `criteria` (obrigatorio; choice: `{ chave: descricao }`,
   noul: `{ true: ..., false: ... }`, score: `[legenda, ...]`). Exemplo minimo:
   `{ "opcao": { type: "choice", instructions: "Qual vem primeiro?",
   criteria: { alpha: "Option alpha", beta: "Option beta" } } }`.
   Chamada sempre via tool `execute` em Code Mode (JavaScript, sem imports):
   `return await tools.jev.decide({...})`. Decisoes com
   `sessionID` sao catalogadas em `decision/*`.
5. **Escalonamento (`tools.jev.escalate` via `execute`):** o Jev escolhe entre os candidatos
   restantes da cadeia qual free e capaz de continuar apos a falha
   (`decideEscalation`); override `toModel` so aceita modelos do pool free.
6. **Fallback (hook `retry`):** usa o modelo que **realmente falhou**
   (`event.model`), avanca na cadeia e preserva a decisao original em
   overflow de contexto (a compaction resolve esse caso). O estado enviado ao
   Jev e um **snapshot enriquecido e bounded**: intencao, agente/modelo reais
   da sessao, lane/rota, `attempt` real do evento, modelo que falhou, modelos
   ja tentados, candidatos free disponiveis no catalogo, erro normalizado e a
   decisao anterior catalogada. Com o Jev indisponivel, o fallback
   deterministico da cadeia segue intacto.
7. **Recuperacao de erros de tool (hook `tool.execute.after`):** erro material
   (repeticao ou fluxo inviavel) consulta o Jev; acoes `switch-model`/
   `switch-agent` sao executadas direto (nao-destrutivas, dentro do runtime),
   e `retry`/`replan`/`stop`/`escalate` viram **recomendacao one-shot**
   entregue ao proximo `context` do agente e removida em seguida.

## Lanes (free Zen) — otimizados por benchmarks 2026-09

- `fast-coding` -> `opencode/nemotron-3.5-lightning-free` (670 tok/s **#1 velocidade**) -> `opencode/big-pickle` (rápido, boilerplate) -> `opencode/mimo-v2.5-free` (equilibrado 15B ativos)
- `heavy-reasoning` -> `opencode/muse-spark-1.3-contributor-free` (DeepSWE 75.4% **#1**, Terminal-Bench 88.8% **#1**, Intel 61 **#1**) -> `opencode/nemotron-3-ultra-free` (SWE-Bench Verified 71.9% **#1**, PinchBench 90 **#1**, RULER 1M 94.7%) -> `opencode/mimo-v2.5-free` (Claw-Eval 62.3%) -> `opencode/nemotron-3.5-lightning-free` (PinchBench 85.4)
- `research-docs` -> `opencode/ling-3.0-flash-fin-free` (GPQA Diamond 86.3%, especializado pesquisa/docs, 262K ctx) -> `opencode/muse-spark-1.3-contributor-free` (MRCR 1M 98.1% **#1** long-context retrieval, 1M ctx) -> `opencode/nemotron-3-ultra-free` (RULER 1M 94.7%, 1M ctx) -> `opencode/mimo-v2.5-free` (GPQA 81.6%, multimodal)

Nota: o Jev `jev-1.13-free` no Zen é o SystemOne servido em
`/zen/v1/systemone` (nao um chat model). O roteador o chama como juiz;
os chat models free continuam no pool de lanes acima.

## Opcoes

| Opcao | Default | Efeito |
|---|---|---|
| `jevModel` | `jev-1.13-free` | Modelo SystemOne no Zen |
| `jevEndpoint` | `https://opencode.ai/zen/v1/systemone` | Endpoint SystemOne |
| `apiKeyEnv` | `OPENCODE_API_KEY` | Env com a key do Zen |
| `confidenceThreshold` | `0.55` | Abaixo disso, escala para `heavy-reasoning` |
| `enableAutoRoute` | `true` | Liga o auto-route no hook `prompt` |
| `jevTimeoutMs` | `15000` | Timeout das chamadas ao Jev |

## Correcoes da analise abrangente (2026-09, priorizadas pelo Jev)

Gaps encontrados e corrigidos, na ordem que o Jev julgou:

1. **G1 — afinidade de sessao (prioridade #1).** Follow-ups triviais
   (`ok`, `continua`, `sim`...) nao re-rerrota: mantem rota e modelo da
   sessao, cataloga `intention/*` como `continuation` e nao chama o Jev.
   So re-rerrota no 1o prompt, em intencao nova ou quando a rota muda.
2. **G3 — catalogo de modelos.** Antes de qualquer troca, valida o destino
   contra `ctx.model.list()`; modelo sumido do pool cai para o primeiro da
   cadeia disponivel, sinalizado via `jev-model-unavailable`/`routed-alt`.
3. **G2 — throttle global.** 429/529/rate-limit do gateway Zen nao troca de
   modelo; o retry apenas aguarda com backoff (5s).
4. **G4 — state limitado.** `tools.jev.decide` trunca o `state` (12K chars) com
   aviso de corte, impedindo overflow do contexto do Jev.
5. **Agent switching (unificado).** O Jev decide lane **e** agente na mesma
   chamada (`choice route` + `choice agent`); plan para heavy-reasoning/
   research-docs, build para fast-coding. Troca real via
   `ctx.session.switchAgent`, validada contra `ctx.agent.list()`.
6. **G5 — contexto economico.** Instrucao do hook `context` encurtada e
   entregue apenas na montagem do contexto do agent loop (inclusive em
   continuacoes da sessao — nao so no turno do usuario; nunca por step de tool).
7. **G6 — heuristica EN/PT.** Regex de pesquisa agora cobre ingles
   (research, investigate, find out, compare, explore, analyze) sem
   contaminar a deteccao de heavy-reasoning.
8. **G7 — sobrescritas visiveis.** `jev-overridden` nos metadados quando o
   threshold/risco/complexidade/alinhamento de agent inverte a decisao do Jev.
9. **G8 — decision keys com TTL.** `pruneDecisionKeys` via `storage.scan`
   + `remove` mantem no maximo 50 decisoes por sessao.
10. **G9 — agent informado da sessao.** O hook `prompt` passa o agente e o
    modelo **reais da sessao** (`ctx.session.get`) ao Jev — nao `event.agent`,
    que nao existe no contrato do prompt hook. O sinal build-vs-plan (ou o
    agente custom em uso) chega corretamente na decisao.

Novas garantias desta rodada:

11. **Agente elegivel = `ctx.agent.list()`.** `RouteDecision.agent` e `string`;
    o Jev so recebe como candidatos agentes que o runtime expoe (`build`,
    `plan`, `explore`, custom...), e toda resposta valida nessa lista e aceita
    e aplicada via `ctx.session.switchAgent`. Nenhum candidato apresentado e
    rejeitado pelo validador; o fallback `build/plan` fica apenas para quando a
    lista real esta indisponivel (throw) ou vazia.
12. **Snapshot de retry completo.** `buildSnapshot` aceita contexto especifico
    da decisao (`attempt` real de `event.attempt`, erro normalizado/bounded,
    modelo que falhou, decisao anterior) e o `decideEscalation` monta estado
    completo ao Jev: `session.intention/agent/route/attempt`,
    `failure.failedModel/error/triedModels/priorDecision` e
    `availableModels`. Tudo clampado/bounded, sem history completa; fallback
    deterministico preservado se o Jev estiver indisponivel.
13. **Recuperacao one-shot.** Erros materiais de tool viram recomendacao do Jev
    gravada em `pending-recovery/<sessionID>`; o hook `context` a entrega ao
    proximo contexto do agente UMA unica vez e remove a chave. `retry`,
    `replan`, `stop` e `escalate` nunca sao executados automaticamente; o
    cooldown por assinatura impede re-consultas em loop e o contexto nao cresce.

## Orchestration Kernel v1

Kernel puro e deterministico do loop de orquestracao, **ainda NAO ligado ao
runtime ativo** (nenhum hook/tool existente foi alterado). Vive em
`src/orchestration/` (`types.ts`, `judgement.ts`, `state-machine.ts`):

- `ExecutionContract` (intencao, escopo, restricoes, acceptance criteria,
  evidencia exigida, `maxRounds`) validado com `validateExecutionContract` —
  contrato invalido nunca e aceito em silencio.
- `EvidencePacket` bounded (`normalizeEvidencePacket` trunca/corta) — nunca
  outputs gigantes nem conversa completa.
- `JevVerdict` = decisao material do Jev: `done`, `failureClass`
  (8 classes), `sameExecutorCanRepair`, `nextAction` (8 acoes) e
  `confidence?`. Sem texto generativo de raciocinio: o scheduler aplica.
- Perguntas SystemOne do julgamento (`buildRoundJudgementQuestions`):
  `done` (noul), `failure_class` (choice), `same_executor_can_repair`
  (noul), `next_action` (choice com as 8 acoes). Parsing estrito em
  `parseRoundVerdict` e invariantes em `validateVerdict`
  (ex: `done=true` exige `accept`; `done=false` exige `failureClass!=none`).
- State machine pura (`transitionRun`): nao conhece `ctx`, nao chama Jev,
  nao cria sessao, nao escolhe modelo/agente — apenas transforma estado e
  **declara comandos** (`dispatch`, `evaluate`, `repair-same`, `fresh-same`,
  `select-model`, `select-agent`, `replan`, `request-human`, `complete`,
  `stop`). `switch-model`/`switch-agent` emitem apenas `select-model`/
  `select-agent`: o destino e decidido depois pelo dispatcher com o Jev.
- **`round` = rodada de execucao que sera julgada.** TODA nova execucao apos
  verdict falho consome nova rodada — `repair-same`, `fresh-same`,
  `switch-model`, `switch-agent`, `replan` (nunca execucao desbounded). A
  diferenca do `repair-same` e preservar `sessionID`/`agent`/`model`
  (mesmo executor) — nao "nao consumir rodada". `maxRounds` e teto real:
  esgotado, `awaiting-human` + `request-human`, sem novo dispatch — sequencia
  infinita de repairs e impossivel.
- **Replan substitui o contrato dentro da maquina de estados.** Apos verdict
  `replan` (fase `planning`), o dispatcher envia
  `{ type: "CONTRACT_READY", contract: revisedContract }`: o kernel valida o
  contrato revisado, o instala como `state.contract` e segue para `ready`.
  Invariantes: `runID` igual (revisao nunca vira outro run), `maxRounds`
  conservado (aumento silencioso de orcamento e rejeitado com
  `invalid-contract`; aumento de budget exige decisao humana, fora do kernel)
  e **`revised.maxRounds >= state.round`** — redução abaixo da rodada ja
  consumida e rejeitada, pois violaria a invariante global
  `round <= contract.maxRounds` (mensagem cita `current round` e
  `revised maxRounds`).
- **`fresh-same` cria NOVA sessao:** preserva `agent`/`model` mas descarta a
  `sessionID` antiga (o estado sai de `fresh-same` com `executor` sem
  session). O dispatcher cria a nova sessao e inicia com
  `EXECUTION_STARTED { agent, model, sessionID: novaSessao }`.
- **`EXECUTION_STARTED` inequivoco:** de `ready` exige `ExecutorRef` explicito
  (`initial`/`fresh-same`/`switch-*`/`replan` nunca executam sem identidade);
  de `repairing` pode omitir `executor` e reutilizar obrigatoriamente o
  armazenado (`agent`/`model`/`sessionID`) — sem executor valido no estado,
  `invalid-event` (nunca `running` sem `ExecutorRef`).
- **Evidence pertence a rodada:** `EVIDENCE_READY` rejeita packet de rodada
  diferente da atual (`invalid-evidence`, mensagem `expected round X /
  received round Y`). **Verdict nunca julga no escuro:** `VERDICT_RECEIVED`
  exige `EvidencePacket` da rodada atual — sem evidence, falha
  deterministicamente (`invalid-evidence`).
- Estado canonico do julgamento (`buildRoundJudgementState`): builder puro e
  **bounded** — `objective`, `acceptanceCriteria`, `requiredEvidence`,
  `round`, `maxRounds`, `executor` (agent/model), `outcome`,
  `deterministicChecks`, `criticFindings`, `resultSummary` e
  `previousVerdict?`. O dispatcher envia `buildRoundJudgementState(...)` +
  `buildRoundJudgementQuestions()` ao SystemOne — nunca conversa, prompts,
  raw outputs nem chain-of-thought.
- Transicoes invalidas (ex: `planning + EXECUTION_FINISHED`, `completed +
  VERDICT_RECEIVED`) falham deterministicamente com `OrchestrationError`.

Proximo passo: dispatcher que executa os comandos no OpenCode
(`ctx.session.*`), agentes `orchestrator`/`implementer`/`critic` via
configuracao (`opencode.jsonc`) e a ligacao do loop aos hooks.

## Uso

Conecte o Zen uma vez via `/connect` no TUI, ou exporte a key:

```bash
export OPENCODE_API_KEY=...
```

Copie `opencode.jsonc.example` para seu `opencode.jsonc` (ou adicione o bloco `plugins`).

```bash
npm run typecheck
npm test
```
