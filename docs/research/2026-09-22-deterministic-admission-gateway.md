# Deterministic Admission Gateway — descoberta de protocolo real e design (issue #24)

Status: evidência capturada **antes** da implementação, em runtime real
`opencode` **v2.0.11** (`/tmp/opencode-2.0.11/package/bin/opencode`,
sha256 `0ed7d8546cf24acc41e6371ec30928ed931ec1474e1a54bbecdde8e0dd801d2f`),
HOME/isolamento próprios, servidor em `127.0.0.1:4511` (`/tmp/opjev-gw/proto-serve.log`).
Runtime `v2.0.13` usado apenas como cross-check secundário. Nenhuma API privada é
usada no design; tudo abaixo é endpoint/definição pública observada em runtime.

## 1. Superfície de protocolo provada (requisição → resposta exatas)

### 1.1 Autenticação

- `GET /api/info` **sem** credencial → `401` + `WWW-Authenticate: Basic realm="Secure Area"`.
- `GET /api/info` com `Authorization: Basic base64("opencode:<password>")` → `200`,
  corpo `{"version":"2.0.11", ...}`.
- `opencode serve` imprime a senha no log no formato `server password <pw>`
  (também existem as envs `OPENCODE_PASSWORD` / `OPENCODE_SERVER_PASSWORD` no runtime).
- Nenhuma credencial é hardcoded no gateway: a senha vem de env em runtime e nunca é
  logada (log emite somente IDs/estados/contadores).

### 1.2 Admissão de prompt (o endpoint que o gateway intercepta)

- `POST /api/session` → `200` `{"data":{"id":"ses_...", ...}}` (envelope `data`).
- `POST /api/session/:sessionID/prompt` com body `{"text": "...", "resume": false}`:
  - `200` `{"data":{"id":"msg_...","sessionID":"ses_...","time":{"created":...},
    "type":"user","payload":{"text":"..."},"delivery":"steer"}}`;
  - o item aparece durável em `GET /api/session/:sid/inbox`;
  - `GET /api/session/:sid/message` (transcript) permanece **vazio**;
  - **nenhuma execução** ocorre (`session.execution.*` nunca dispara).
  → persist-first comprovado: `resume:false` **persiste no inbox sem acordar o parent**.
- Itens permanecem duráveis até entrega; o mesmo `msg_` id é preservado entre
  persistência e entrega.

### 1.3 Wake (única forma observada de executar um item persistido)

- `PATCH /api/session/:sid/inbox/:inboxID` com `{"delivery":"steer"}`:
  - `409 Conflict` quando o valor já é `steer` (no-change é rejeitado);
  - sequência comprovada para um item criado em `steer`: `PATCH {"delivery":"queue"}`
    → `204` (muda estado, **sem** execução) e então `PATCH {"delivery":"steer"}` →
    `204` + eventos `session.inbox.delivered` + `session.execution.started`
    (+ `execution.succeeded` com modelo real) → item aparece no transcript com o
    **mesmo** `msg_` id.
- Wake de item `synthetic` pela mesma sequência **também acorda o parent**
    (`execution.started` + deltas de reasoning observados) → entregar mensagem
    = executar o parent. Portanto: **não existe entrega sem wake** neste contrato.

### 1.4 Identidade / idempotência (o request real possui identidade?)

- O payload de `prompt` aceita `id` **opcional** no formato `SessionMessage.ID`
  (`msg_...`) — é a identidade de turno real fornecida pelo cliente.
  - 1ª submissão com `id` → `200` cria item;
  - replay com o **mesmo** `id` (ainda pendente) → `200` com o **mesmo** `id` e o
    inbox continua com `count=1` (**idempotente**, sem duplicar);
  - 6 replays **concorrentes** com o mesmo `id` → todos `200`, sem duplicar item;
  - textos idênticos **sem** `id` → `msg_` distintos (turnos distintos preservados);
  - replay **pós-entrega** com o mesmo `id` pode devolver `time.created` novo —
    semântica de re-submissão após execução, por isso o gateway usa identidade
    **antes** de qualquer wake.
- **Não existe header de idempotência** no contrato e **não** existe wake genérico
  além do PATCH de inbox; não há WebSocket/upgrade no contrato público (somente
  endpoints PTY próprios). Event stream = SSE `GET /api/event`
  (eventos `server.connected`, `session.inbox.*`, `session.execution.*`,
  `session.reasoning.*`, `session.text.*`, heartbeat).

### 1.5 RPC pública

- `POST /api/rpc/:rpcID/:method` com body `{"input": ...}` → `200` `{"output": ...}`.
  `rpcID` = `id` da definição RPC; `?location.directory=` opcional (funciona sem).
- Provado ao vivo com plugin spike: `POST /api/rpc/spike.admission.v1/ping`
  `{"input":{"text":"..."}}` → `200 {"output":{"echo":"..."}}` e handler registrado
  no `server.log`. Método inexistente → `400`.
- Definições portable: `{id, methods: {m: {input, output}}, events: {}}`. O spike usou
  zod (StandardSchemaV1); o opjev **não** depende de zod, então a definição usará a
  forma `JsonSchema` aceita por `Rpc.PortableMethod`, com validação manual extra no
  handler (input validado e bounded, como exige o slice).

### 1.6 Catálogo e switches usados pelo modo `route`

- `GET /api/model` → `{"location":..., "data":[{"id","providerID","name",...}, ...]}`.
- `GET /api/agent` → `{"location":..., "data":[{"id":"build",...},{"id":"plan",...},...]}`.
- `POST /api/session/:sessionID/model` payload `{"model": {"id","providerID"}}`
  (`Model.Ref` struct) e `POST /api/session/:sessionID/agent` payload `{"agent": "..."}`.
- Sessão não expõe modelo atual na listagem → `decideRoute` recebe `agent/model`
  ausentes (`"unknown"`), exatamente como o contrato do router permite.

### 1.7 Publicação de resultado sem acordar o parent (fronteira crítica)

- `POST /api/session/:sid/synthetic` com `{"text","resume":false}` → item durável
  `type:"synthetic"` no inbox, **sem** wake (provado), mas **não** entra no
  transcript (`GET /message` não o mostra) — transcript só recebe mensagens
  entregues, e entrega exige wake (`PATCH steer`), que acorda o parent
  (seção 1.3). O server ctx do plugin expõe `ctx.session.synthetic`
  (mesma semântica pública), que será o mecanismo de publicação do resultado:
  **publicar = enfileirar synthetic durável sem wake**; a visibilidade desse item
  enfileirado na experiência TUI é medida no E2E real (se o TUI não o exibir, o
  slice é reportado como PARCIAL com o blocker documentado — nenhuma API privada
  é usada para contornar).

## 2. Semântica de falha (decisão)

Fronteira: **admissão durável** = `POST .../prompt {resume:false}` aceito (2xx).

- **Antes** da admissão (parse, decisão, rota, switches de route): falha ⇒
  fallback seguro para `normal` (forward transparente único) ou rejeição
  bounded sem nenhum efeito upstream.
- **Depois** da admissão: **fail-closed** — nunca re-encaminhar o prompt ao parent,
  nunca PATCH/wake; responder erro explícito bounded (`502` +
  `{"error":{"code","message"}}`) e registrar estado diagnóstico
  (records gateway + record de admission no plugin).
- Ambiguidade de admissão (timeout/erro de rede após enviar o `POST`): não
  re-tentar (poderia duplicar) → `502` fail-closed.
- Resultado do run: registro `record`/`binding` + notice synthetic durável
  (registro assíncrono é aceito pela spec: "retornar/**registrar** erro explícito").

## 3. Identidade e idempotência (gateway)

- Identidade de turno = **`id` real do request quando presente** (passado
  adiante na admissão) → upstream devolve `msg_...`; `runID` determinístico =
  `autoAdmissionRunID(sessionID, messageID)` (portado da PR #21,
  **nunca** `hash(text)` permanente — mesmo texto com `messageID` distinto ⇒
  turnos distintos).
- Chaves: `orchestration/admission/<sessionID>/<messageID>` (record durável,
  storage do plugin) e lock process-local por `runID` (duplicatas concorrentes
  serializam; a segunda encontra o record e **não** dispara novo run).
- Sem identidade vinda do cliente, cada request é um turno novo (igual ao
  comportamento nativo do upstream; sem cabeçalho de idempotência no contrato).
- Duas sessões distintas ⇒ chaves distintas ⇒ isolamento por construção.

## 4. Fluxos por modo (design)

Interceptação narrow: **somente** `POST /api/session/:sessionID/prompt`
(method + path exatos). Todo o resto (SSE `GET /api/event`, catálogos, inbox,
PTY, upgrade) passa pelo proxy transparente.

- **normal** — parse bounded → forward transparente **exato 1×** (bytes originais,
  resposta nativa preservada; comportamento OpenCode intacto, zero duplicação).
- **route** — decide (`decideRoute` real do `src/router.ts`, **não** um segundo
  router; candidatos do catálogo HTTP + `FREE_POOL`/`isFreeModel`/defaults de
  `src/config.ts`) → aplica (`POST model`/`POST agent`, com guardrails
  revalidados) → forward transparente **exato 1×**. Qualquer falha de
  decisão/aplicação (pré-admissão) ⇒ fallback `normal` (forward único).
- **orchestrate** — admissão persist-first: `POST prompt {resume:false}` (preserva
  `text/files/metadata/id` do request real) → `msg_...` durável → record +
  `runID` determinístico → **RPC direta** `POST /api/rpc/opjev.admission.v1/orchestrate`
  (seam pública do plugin, **sem** parent/model trampoline) → lock por `runID` +
  idempotência por record (duplicata ⇒ zero run extra) → o handler valida input,
  monta/valida `ExecutionContract` (port sem trampoline), aplica gate
  awaiting-human (**zero** auto-resume) e chama `runOrchestrationOnce` **exatamente
  uma vez** → resposta `200` nativa ao cliente **logo após** o dispatch; conclusão
  assíncrona atualiza record/binding e publica notice synthetic (`resume:false`,
  parent nunca acorda). **Nunca** PATCH/wake deste item.

## 5. Configuração bounded (env; opt-in; sem hardcode)

| Var | Default | Limite |
|---|---|---|
| `OPJEV_GATEWAY_ENABLED` | (off) | precisa ser `1`/`true` para subir |
| `OPJEV_GATEWAY_UPSTREAM` | — | URL http(s) obrigatória quando ligado |
| `OPJEV_GATEWAY_HOST` | `127.0.0.1` | bind explícito |
| `OPJEV_GATEWAY_PORT` | — | 0–65535 (0 = efêmera), obrigatório quando ligado |
| `OPJEV_GATEWAY_PROXY_TIMEOUT_MS` | 30000 | 100–120000 |
| `OPJEV_GATEWAY_UPSTREAM_TIMEOUT_MS` | 30000 | 100–120000 |
| `OPJEV_GATEWAY_RPC_TIMEOUT_MS` | 15000 | 100–120000 |
| `OPJEV_GATEWAY_ROUTE_TIMEOUT_MS` | 15000 | 50–120000 |
| `OPJEV_GATEWAY_MAX_BODY_BYTES` | 1048576 | 1024–16777216 |
| `OPJEV_GATEWAY_DEFAULT_MODE` | `normal` | `normal\|route\|orchestrate` |
| `OPJEV_GATEWAY_RULES` | `[]` | JSON `[{prefix,mode}]`, ≤10 regras, prefix ≤200 |
| senha upstream | — | `OPJEV_UPSTREAM_PASSWORD` senão `OPENCODE_PASSWORD`/`OPENCODE_SERVER_PASSWORD`; nunca logada |

Modo `orchestrate` é opt-in explícito por regra/default da config (é o stub
determinístico admitido para controlar a decisão de admission nesta fatia; o
guard de confiança do Jev da #13 pluga no mesmo seam depois). Marcadores internos
(`jev-router`/`jev-role` de worker/critic/orchestrator) **zeram** a admissão
(recursão interna impossível: workers vivem in-process e não atravessam o gateway).

## 6. Mapa teste → cenário (TDD, fronteira HTTP real)

1. proxy de request não interceptado 1× · 2. status/header/body preservados ·
3. normal →1 forward · 4. route → apply +1 forward · 5. orchestrate →0 wake/0
forward nativo (só persist `resume:false`) · 6.1 run único (handler) +6.2 RPC
dispatch 1× (HTTP) · 7. duplicata concorrente/replay →1 run · 8. textos iguais
sem id →2 admissions · 9. duas sessões isoladas · 10. falha pré-efeito →
fallback normal · 11. falha pós-admissão →502 fail-closed,0 wake · 12. marcador
interno → bypass (sem recursão) · 13. awaiting-human →0 auto-resume ·
14. `orchestrate_once`/`orchestrate_resume` existentes intactos (suíte atual) ·
15. gateway disabled → não sobe, plugin intacto · 16. malformed/oversized →
400/413 bounded,0 upstream · 17. streaming progressivo + cancelamento sem leak.
E2E real v2.0.11 com TUI atrás do gateway fecha o gate duro:
intercept=1, admission=1, parent=0, RPC=1, run=1, worker=1, publicação sem wake.

## 7. Riscos/blockers registrados

- Visibilidade do synthetic enfileirado no TUI é medida no E2E real; se invisível,
  publicação = PARCIAL com blocker documentado (sem API privada para contornar).
- Idempotência total depende de identidade real (`id` no payload); sem ela,
  replay = novo turno (idêntico ao nativo). Hash de texto nunca é usado.
- Records de gateway são process-local (bounded, ≤500 entradas); o record
  durável de admission vive no storage do plugin.
