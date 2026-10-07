# Issue #5 — avaliação de prontidão para dogfood e qualidade do corpus

**Data da auditoria:** 2026-10-07
**Base analisada:** `origin/main` em `8f61981f2f0741af603cbf908ce4f75891e73e7d`
**Branch da auditoria:** `audit/issue-5-dogfood-evidence-gate`
**Escopo:** auditoria documental OBSERVE e evidências disponíveis; nenhuma mudança de runtime.

## Conclusão — A: OBSERVE suficiente; corpus insuficiente

A fundação OBSERVE em `main` já captura, em caminho executável do dispatcher, identidade de execução/executor, rota quando fornecida, round, requests, outcome após julgamento, resultado do critic/verificador, classe de falha em outcomes, recuperação/escalada e uso de recursos que o host expõe. O caminho de gravação usa o ledger compartilhado bounded e sanitizado. Profiles são derivados sob demanda e não alimentam routing. Os pontos incompletos são explicitamente missing data (ex.: rota ausente em runs sem seleção) ou limites documentados do runtime, não justificativa para continuar adicionando features antes de dogfood.

**Recomendação de governança:** iniciar/manter a DOGFOOD PAUSE prevista em #5/#38 agora: usar o plugin em trabalho real variado, preservar apenas evidências canônicas e inspecionar gaps. Não iniciar SHADOW enquanto não houver corpus natural comparável e verificável. Não implementar feature adicional nesta auditoria.

## Fontes e método

A atualização de `origin` foi feita com `git fetch origin`; `origin/main` avançou de `9aeda3c` para `8f61981f2f0741af603cbf908ce4f75891e73e7d`. A branch foi criada diretamente desse commit.

Li as issues #2, #4, #5 e #38, `docs/model-performance-intelligence-observe.md`, `docs/resource-budget-governor.md`, a spec e o plano de adaptive context, `README.md`, os scripts de E2E, `src/model-intelligence/profiles.ts`, `src/resource-governor/usage-ledger.ts`, `src/orchestration/dispatcher.ts`, o wiring em `src/plugin-runtime.ts`, sinks, hooks e testes correspondentes.

As classificações abaixo distinguem: **comportamento executável observado nos testes/caminho de código**, **comportamento apenas documentado**, **hipótese** e ausência de dados naturais. Nenhum campo TypeScript foi tratado isoladamente como prova.

## Matriz de cobertura OBSERVE

| # | Fato exigido | Classificação | Evidência executável e limite observado |
|---|---|---|---|
| 1 | Modelo, agente, rota e identidade da execução | **PROVADO** | `dispatcher.ts` emite `runID`, `sessionID`, modelo, agente, papel e rota nos eventos de round/request/outcome. O teste `O0g` valida a observação de rota/modelo/agente e acceptance; `O0c` valida gravação do modelo/papel no ledger. Run/session identificam a execução. Rota pode estar ausente quando a seleção não fornece rota; a coorte ausente permanece distinta, não é inferida. |
| 2 | Round e request observados | **PROVADO** | Eventos `round` e `request` são emitidos pelo dispatcher. Cada request do dispatcher está ligado a `runID`, `sessionID`, papel e round. Não há um campo separado de request-ID; o identificador composto acima é a identidade observada no fluxo atual. |
| 3 | Outcome aceito ou rejeitado | **PROVADO** | O evento `outcome` é escrito após `verdict-applied`, com acceptance booleano e round efetivamente julgado. Teste `O0h` prova que outcomes de rounds 1/2 preservam a associação de round através de recovery. |
| 4 | Resultado do verificador e evidence associada | **PROVADO** | Evento outcome inclui `verificationPassed` derivado de `criticCheck.status` e `runID`/round. A evidência completa permanece no checkpoint canônico `orchestration/run/<runID>`; state e evidência são associados ao mesmo run/round. `O0g` verifica resultado do critic/verifier no evento; a persistência de run é o registro para examinar a evidence, sem duplicá-la no ledger de uso. |
| 5 | Failure class e failure domain | **PARCIAL** | Outcomes julgados carregam `failureClass`; erros têm domínios categóricos e provider/quota/context são separados. Falhas de execução antes do outcome, inclusive erro operacional, não recebem necessariamente uma `failureClass` cognitiva. Testes `O0d`–`O0f` reproduzem a separação e a ausência de outcome em erro de provider/local. Não usar essas falhas ausentes como capability rejection. |
| 6 | Decisões de recovery e executor envolvido | **PROVADO** | Dispatcher emite `recovery`/`escalation` com action, modelo/agente/session e round. `O0h` liga recovery e outcome aceito à rodada correspondente. Execução do worker mantém a identidade do executor efetivo, atualizada em troca/replan. |
| 7 | Requests, rounds, tokens e outros recursos disponíveis | **PROVADO** | Requests, rounds e counters de tokens observados são gravados; counters permanecem ausentes se o runtime não os fornecer. O código não fabrica fan-out, compaction ou usage não expostos pelo host. `O0`, `O0c` e testes de governor exercitam captura/agregação. |
| 8 | Erros de provider separados de falhas de capacidade | **PROVADO** | Erros provider estruturados/throttle/quota são tipos/domínios operacionais separados; não viram amostras de capability. `O0d`–`O0f`, testes de perfis e de governor validam esse comportamento. Erro ambíguo é operacional/unknown, não falha cognitiva inferida. |
| 9 | Dados bounded e sanitizados | **PROVADO** | Ledger factual de capacidade fixa 2.048 e limite de fila 256; sink espera no máximo 50 ms por observação. Sanitizer usa whitelist, limita texto identificador e error codes, e descarta prompts/outputs/arbitrary metadata. Testes de ledger/sink cobrem retenção, sanitizer e saturação. Context metrics separados são counters bounded, janela de 24h e fila 128. Saturação pode descartar fatos; não existe garantia de corpus sem perdas. |
| 10 | Coortes e uncertainty sem efeito no routing | **PROVADO** | `buildObserveProfiles` agrupa por rota/role/agent/model exatos, janela temporal fornecida, contagens e freshness; amostra pequena é `high`, limiar atingido é apenas `provisional`. Perfil não é consumido pelo router e não inclui instruções/authority. Testes cobrem cohorts incompatíveis, provider/capability separados, uncertainty e ausência de autoridade. |

**Síntese:** a instrumentação já é suficiente para disparar a pausa de coleta, não para alegar confiança estatística ou qualidade alta do corpus. Context family, complexidade, idioma, tamanho de contexto e duração não são facts confiáveis disponíveis para perfis (documentado em `docs/model-performance-intelligence-observe.md`); não serão inventados como classificações.

## Inventário sanitizado de evidências disponíveis

| Fonte | Resultado auditável | Uso e limitações |
|---|---|---|
| Shared ledger `resource/usage-ledger/v1` no storage OpenCode autorizado deste ambiente | **Nenhum ledger utilizável encontrado** no key exato nem no sufixo namespaced consultado; nenhum conjunto de observations natural pôde ser agregado. | Não se publica caminho de storage, conteúdo SQLite ou identificador de sessão. Ausência local não prova que nenhum outro ambiente possua registros; corpus natural acessível a esta auditoria é zero. |
| Canonical tracked evidence `docs/reports/artifacts/issue-14-real-e2e-evidence.json` e `docs/reports/issue-14-stabilization-matrix.md` | Artefato versionado descreve 17 cenários executados em OpenCode 2.0.11 em 2026-10-04, incluindo live/controlled provider boundaries e fault injection; a matriz local foi executada nesta auditoria com 17/17. | Execuções de teste controladas/sintéticas, source HEAD antigo; **não** são dogfood natural, não medem distribuição representativa de tarefas ou seleção espontânea. O inventário deste relatório não reproduz IDs ou outputs do artifact. |
| E2E real multiround e E2E de Context Management executados nesta auditoria | Ambos foram iniciados com o binário local `OPENCODE_BIN`; ambos falharam na asserção de versão do server, antes de executar cenários: a API do processo informou OpenCode **2.0.18**, embora o binário indicado responda `opencode v2.0.11`. | Não contam como PASS nem como prova de captura OBSERVE real em 2.0.11. Falha concreta de ambiente/runtime verificada, registrada abaixo. Não foi tentado substituir o runtime ou relaxar a asserção. |

### Missingness, diversidade, confiança e viés

- **Missingness:** não há observations naturais acessíveis para calcular missingness por campo, run, round, outcome ou evidence. O sink permite perda em saturação/erro e sobrescreve o anel quando excede 2.048 facts; a retenção não é histórico completo e não há contagem global independente de observations perdidas no ledger de recursos.
- **Identidade e coortes:** o código agrupa por modelo/rota/role/agente exatos; rota ausente não é imputada. Sem corpus natural não há coverage real por coorte nem como provar que falta de rota é rara.
- **Famílias e comparabilidade:** task family, complexidade, idioma e contexto não estão presentes como fatos confiáveis para profiles. A distribuição de famílias é **não verificável**. Rota/lane é proxy contextual parcial, não taxonomia de tarefa comprovada.
- **Diversidade:** não há amostras naturais acessíveis para modelo, agente, rota, condições de recurso ou recovery. E2Es variam cenários por construção e não contam como diversidade natural.
- **Outcome independente:** no corpus natural disponível, nenhuma aceitação externa/verificação independente foi inventariada. O fluxo registrado inclui critic/verifier e checks do kernel, mas uma demonstração sintética desses componentes não mede concordância ou independência em dogfood real.
- **Selection bias:** o router determina quais modelos/rotas recebem tarefas; profiles não corrigem exposição desigual nem possuem denominador de candidatos não selecionados. Não se pode inferir comparação causal ou capacidade geral a partir de contagens futuras sem examinar esse viés.
- **Confiança e freshness:** `high`/`provisional` e stale-after-default 7 dias são rótulos operacionais de suporte, não intervalos de confiança calibrados. Não há decay estatístico persistido. Datas e freshness do corpus natural são impossíveis de avaliar sem observations.
- **Retenção/perdas:** anel circular mantém no máximo 2.048 fatos; gravações pendentes acima de 256 podem ser descartadas e a observação é best-effort. Isso é boundedness provada, mas também implica truncamento e potencial viés temporal em volume alto. Não se observou uma perda natural, nem se pode afirmar ausência de perdas históricas.

## Lacunas ou regressões concretamente verificadas

1. **Sem corpus natural consultável:** consulta sanitizada ao storage local não encontrou o key do ledger compartilhado. Isso impede calcular a qualidade/diversidade do corpus; não é um resultado estatístico zero-success.
2. **E2E exato falha antes dos cenários por mismatch de versão:**
- O binário local verificado anunciou `opencode v2.0.11`;
- `OPENCODE_BIN=<binário local verificado> npm run e2e:multiround-real` → runner reportou `Upstream pronto: OpenCode v2.0.18` e saiu com `Versão inesperada ... esperada 2.0.11, obtida 2.0.18`;
- `OPENCODE_BIN=<binário local verificado> npm run e2e:context` → `expected OpenCode 2.0.11, got opencode v2.0.18`.

   **Correção proposta fora desta PR:** disponibilizar/validar um executável cujo `serve` também anuncie 2.0.11 e então repetir ambos os gates. Não alterar nem relaxar asserts de versão. Isso bloqueia a prova E2E exata neste ambiente, não invalida por si só a implementação OBSERVE.

Não foi reproduzida regressão de routing nem defeito de captura no dispatcher; a suite atual exercita eventos, sanitização, boundedness e perfis. Nenhum teste foi alterado para obter resultado verde.

## Gates executados

Checkout: branch `audit/issue-5-dogfood-evidence-gate`, derivada do `origin/main` SHA acima. Node `v22.23.2`; npm `10.9.8`.

| Comando | Resultado observado |
|---|---|
| `npm ci` | **PASS** — instalou dependências do lockfile (287 packages); avisos de depreciação `node-domexception` e `glob`, sem falha de instalação. |
| `npm run typecheck` | **PASS** — `tsc --noEmit -p ./tsconfig.json`, sem diagnóstico. |
| `npm test` | **PASS** — 748 testes, 104 suites; pass 748, fail 0, skipped 0. |
| `npm run evaluate:routing` | **PASS** — total 11, correct 11, accuracy 1.0; fallback 4/4. |
| `npm run e2e:matrix` | **PASS** — 17/17 cenários herméticos da matriz. Evidência de runtime interno/regressão, não corpus natural. |
| `OPENCODE_BIN=<binário local verificado> npm run e2e:multiround-real` | **FAIL/BLOCKED** — servidor se identificou como 2.0.18; runner exige 2.0.11 e encerrou antes dos cenários. |
| `OPENCODE_BIN=<binário local verificado> npm run e2e:context` | **FAIL/BLOCKED** — mesma incompatibilidade, antes dos cenários. Gate adicional executado para verificar host OBSERVE/Context Management. |
| `git diff --check` | **PASS** — diff do relatório sem whitespace errors; não houve outras mudanças rastreadas. |

O artefato legado `issue-14-real-e2e-evidence.json` comprova somente o seu escopo e SHA antigo declarado no relatório correspondente; não substitui os E2Es que falharam nesta execução.

## Trigger DOGFOOD PAUSE e próximo gate SHADOW

**Trigger:** satisfeito. A implementação em `main` já coleta, agrega boundedly e mantém as observações fora de routing; o conjunto factual cobre identidade suficiente para inspeção por run/round, acceptance/verifier, recovery/failure e os recursos efetivamente observáveis. O valor incerto de campos omitidos permanece ausente. Não há justificativa para adiar dogfood por feature adicional.

**Corpus:** insuficiente e indisponível neste ambiente. Portanto a conclusão obrigatória é **A**, não C. Continuar dogfood real; não preencher lacunas com simulações, não definir contagem mágica e não planejar implementação SHADOW ainda.

**Condições mínimas antes de SHADOW:** corpus natural acessível e sanitizado; linkage verificável entre run/round, identidade do executor, outcome/verifier e evidence canônica; exame explícito de missingness e eviction; diversidade e comparabilidade de tarefas/rotas/modelos/condições; recovery observável; denominadores e seleção do router considerados; outcomes independentes suficientes para avaliar recomendação hipotética sem tratar dados ausentes como sucesso/zero-regressão. Não é fixado threshold de quantidade.

## Boundary C e compaction

A Boundary C da issue #4 é marcada READY, mas o plano a define como bridge nativa ainda a implementar. O código inspecionado registra `execute.after` e `session.hook("context")`; não registra hook de compaction nem event de compaction concluída. Context overflow continua com a compaction nativa do OpenCode, sem bridge ou fallback inventado. O E2E real de compaction não foi executado com sucesso nesta auditoria por mismatch de versão.

**Não foi provado que a compaction atual bloqueie continuidade de dogfood ou a coleta OBSERVE:** ela continua sendo a safety net existente e não há mudança de comportamento do plugin nesta PR. A falta de prova da bridge é bloqueador para promover/aceitar Boundary C e qualquer gate que dependa da integração exata, não razão para atravessar freeze de #38 nem para impedir a pausa de coleta natural. Se uma tarefa natural revelar perda concreta de evidence/continuidade por compaction, registrar reprodução e evidência como blocker específico antes de qualquer exceção.

## Recomendação

Manter #5 e #38 abertas; entrar em DOGFOOD PAUSE; coletar execuções naturais em condições e famílias variadas, preservando artefatos canônicos sanitizados; restaurar primeiro o gate exato OpenCode 2.0.11 no ambiente e reexecutar a verificação real. Reavaliar qualidade/diversidade do corpus antes de propor planejamento de SHADOW. Nenhum SHADOW, compaction bridge, ranking, governor ou mudança de routing foi implementado.
