// Cliente minimo para o Jev System One (nao-generativo).
// POST { state, model, questions } -> { answers, usage }
// Docs: https://docs.typesafe.ai/api (endpoint /v1/systemone)

export interface JevRequest {
  state: unknown;
  model: string;
  questions: Record<string, unknown>;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}

export interface JevScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

export async function callJevSystemOne(
  endpoint: string,
  apiKey: string | undefined,
  body: JevRequest,
  signal?: AbortSignal,
): Promise<JevResponse> {
  // A key vem das docs do provedor (mesma do Zen). O codigo tolera a ausencia
  // (tentativa sem header; muitas vezes o fallback local assume se o Jev nao
  // responder) — mas configure a key conforme as docs antes de usar.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(endpoint, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify(body),
  }).catch((err: unknown) => {
    // AbortSignal.timeout aborta com DOMException (name "TimeoutError").
    // Normalizamos para um Error claro — callers dependem de err.message.
    if (signal?.aborted) {
      throw new Error("jev systemone: timeout apos o limite configurado");
    }
    throw err;
  });
  if (res.status === 429 || res.status === 529) {
    throw new Error(`jev overloaded/rate-limited (http ${res.status})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`jev systemone http ${res.status}: ${text.slice(0, 500)}`);
  }
  const parsed = (await res.json()) as JevResponse;
  validateJevResponse(parsed);
  return parsed;
}

export function validateJevResponse(res: JevResponse): void {
  if (!res || typeof res !== "object" || !res.answers || typeof res.answers !== "object") {
    throw new Error("jev systemone: resposta sem campo answers");
  }
}

// Perguntas padrao do juiz-roteador: 1 choice (rota) + agent + model
// + 1 noul (risco) + 1 score (complexidade). Independentes, avaliadas em
// paralelo pelo Jev. As perguntas de agent/model recebem criterias dinamicas
// (candidatos validos), nunca listas arbitrarias.
export function buildRouterQuestions(input: {
  freeCandidates: string[];
  validAgents: string[];
}) {
  const agentCriteria: Record<string, string> = {};
  for (const a of input.validAgents) {
    agentCriteria[a] =
      a === "build"
        ? "Full development with all tools (edit, bash, etc.) - for implementation"
        : a === "plan"
          ? "Read-only analysis and planning (no edit/bash) - for design, research, review"
          : `Available OpenCode agent "${a}" - pick it if it is the best fit for this task`;
  }
  const modelCriteria: Record<string, string> = {};
  for (const m of input.freeCandidates) {
    modelCriteria[m] = `Great free model for engineering work (${m})`;
  }
  return {
    route: {
      type: "choice",
      instructions: "Which free-model lane should handle this engineering task?",
      criteria: {
        "fast-coding": "Small edits, boilerplate, tests, lint fixes, refactors locais",
        "heavy-reasoning": "Multi-file design, debugging dificil, algoritmos, trade-offs",
        "research-docs": "Pesquisa, docs oficiais, comparacao de libs, explicacoes",
      },
    },
    agent: {
      type: "choice",
      instructions: "Which agent should execute this task? (choose only from the given agents)",
      criteria: agentCriteria,
    },
    model: {
      type: "choice",
      instructions: "Which free model should execute this task? (choose only from the given free models)",
      criteria: modelCriteria,
    },
    is_risky: {
      type: "noul",
      instructions: "Does this task risk data loss, prod breakage, or security exposure?",
      criteria: {
        true: "Deleta dados, muda auth/infra/prod, executa comandos destrutivos",
        false: "Leitura, edicao local reversivel, pesquisa",
      },
    },
    complexity: {
      type: "score",
      instructions: "How complex is this task?",
      criteria: ["Trivial", "Moderate", "Very complex"],
    },
  };
}

// Pergunta de escalonamento: dado o modelo que falhou e o motivo, o Jev
// escolhe entre os candidatos restantes da cadeia qual e capaz de continuar.
export function buildEscalateQuestions(candidates: string[]) {
  const criteria: Record<string, string> = {};
  for (const c of candidates) criteria[c] = `Escalar para o free model ${c}`;
  return {
    next_model: {
      type: "choice",
      instructions:
        "The previous free model failed. Which remaining free model is most capable of continuing this task?",
      criteria,
    },
  };
}

// Decisao de recuperacao apos erro material de tool (execute.after).
// O Jev apenas recomenda; o plugin so executa acoes nao-destrutivas e
// dentro das permissoes do runtime.
export function buildToolRecoverQuestions() {
  return {
    action: {
      type: "choice",
      instructions:
        "A tool failed materially. What should be the next step? Choose the most useful, least destructive option.",
      criteria: {
        retry: "Try the same tool again (ephemeral failure)",
        "switch-model": "The model is stuck; switch to another free model",
        "switch-agent": "The agent is stuck; switch to another available agent",
        replan: "Keep the model; the approach needs to change",
        stop: "Stop this step; do not repeat it",
        escalate: "Escalate: ask for a fresh route/executor decision",
      },
    },
    keep_model: {
      type: "noul",
      instructions: "Is keeping the current model reasonable despite this tool failure?",
      criteria: {
        true: "Failure is tool/environment-specific; model choice is fine",
        false: "The model keeps failing; switching models helps",
      },
    },
  };
}
