// Harness comportamental: fake-<context> do OpenCode + stub do Jev (fetch).
// Permite executar o plugin real (index.ts) contra um runtime simulado e
// observar os efeitos (switches, storage, hook calls, bodies enviados ao Jev).

export function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get: async (k) => (map.has(k) ? map.get(k) : undefined),
    set: async (k, v) => {
      map.set(k, v);
    },
    remove: async (k) => {
      map.delete(k);
    },
    scan: async ({ prefix = "", after, limit = 100 }) => {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const startIndex = after === undefined ? 0 : keys.indexOf(after) + 1;
      if (startIndex < 0) return { entries: [], next: undefined };
      const end = startIndex + limit;
      const page = keys.slice(startIndex, end);
      return {
        entries: page.map((key) => ({ key, value: map.get(key) })),
        next: end < keys.length ? keys[end - 1] : undefined,
      };
    },
    _map: map,
  };
}

/**
 * Cria um fake ctx do OpenCode.
 * `models`: lista de modelos disponiveis (string "provider/id" ou objetos Model.Info).
 * `agents`: lista de agentes disponiveis (strings ou {id}).
 * `session`: estado inicial da sessao: { agent, model: {providerID, id} }.
 * `switchBehavior`: { switchModelError?, switchAgentError? } para injetar falhas.
 * `location`: diretorio do ctx.location (contorno do dispatcher).
 * `workerBehavior`: { outcome?, messages?, waitBlocks? } para o fake runtime de
 *   worker sessions (usado pelo dispatcher via ctx.session.create/prompt/wait/...).
 */
export function makeCtx({
  models = [],
  agents = ["build", "plan"],
  session = { agent: "build", model: { providerID: "opencode", id: "big-pickle" } },
  storage,
  options = {},
  switchBehavior = {},
  integrationList = [],
  location = "/fake/project",
  workerBehavior = {},
} = {}) {
  const hooks = { session: {}, tool: {} };
  const tools = {};
  let state = session ? { ...session, model: session.model ? { ...session.model } : session.model } : null;
  const calls = { switchModel: [], switchAgent: [], jevBodies: [] };
  const errorCounts = {};
  const loc = typeof location === "string" ? { directory: location } : location ?? { directory: "/fake/project" };

  // Worker sessions (runtime falso do dispatcher): separadas da sessao principal
  // (que representa o usuario). Toda criacao via ctx.session.create ganha um id
  // novo; os efeitos ficam observaveis em `workerCalls` / `workerSessions`.
  const workerSessions = new Map();
  const workerCalls = { create: [], prompt: [], wait: [], get: [], context: [], interrupt: [] };
  let workerSeq = 0;
  const defaultWorkerMessages = [
    {
      id: "wmsg-1",
      type: "assistant",
      agent: "build",
      model: { providerID: "opencode", id: "big-pickle" },
      content: [{ type: "text", text: "ORCHESTRATION_WORKER_OK" }],
      time: { created: 1, completed: 2 },
      finish: "stop",
    },
  ];

  function workerInfo(input = {}) {
    workerSeq += 1;
    const id = `worker-${workerSeq}`;
    return {
      id,
      projectID: "fake",
      agent: input.agent,
      model: { ...(input.model ?? { providerID: "opencode", id: "big-pickle" }) },
      outcome: workerBehavior.outcome ?? "succeeded",
      metadata: input.metadata,
      location: input.location ?? { directory: loc.directory },
      time: { created: Date.now(), updated: Date.now() },
      messages: null, // preenchido no create abaixo
      prompts: [],
    };
  }

  const ctx = {
    options,
    storage,
    location: loc,
    agent: {
      list: async () =>
        agents.map((a) => (typeof a === "string" ? { id: a, name: a } : a)),
    },
    model: {
      list: async () =>
        models.map((m) =>
          typeof m === "string"
            ? (() => {
                const [providerID, ...rest] = m.split("/");
                return { providerID, id: rest.join("/") };
              })()
            : m,
        ),
    },
    session: {
      get: async (idOrOpts) => {
        if (switchBehavior.getError) throw switchBehavior.getError;
        const sessionID = typeof idOrOpts === "string" ? idOrOpts : idOrOpts?.sessionID;
        if (sessionID && workerSessions.has(sessionID)) {
          const w = workerSessions.get(sessionID);
          return {
            id: w.id,
            agent: w.agent,
            model: w.model,
            outcome: w.outcome,
            metadata: w.metadata,
            location: w.location,
          };
        }
        return state
          ? {
              id: "main",
              agent: { id: state.agent },
              model: { providerID: state.model.providerID, id: state.model.id },
            }
          : undefined;
      },
      create: async (input = {}) => {
        workerCalls.create.push(input);
        const info = workerInfo(input);
        info.messages = workerBehavior.messages ?? defaultWorkerMessages;
        workerSessions.set(info.id, info);
        return { ...info };
      },
      prompt: async ({ sessionID, text, metadata } = {}) => {
        workerCalls.prompt.push({ sessionID, text, metadata });
        const w = workerSessions.get(sessionID);
        if (w) w.prompts.push({ text, metadata });
      },
      wait: async ({ sessionID } = {}) => {
        workerCalls.wait.push({ sessionID });
        const w = workerSessions.get(sessionID);
        const blocked =
          workerBehavior.waitBlocks &&
          (!Array.isArray(workerBehavior.blockedSessions) ||
            workerBehavior.blockedSessions.includes(sessionID));
        if (blocked) {
          return await new Promise(() => {}); // wait bloqueado (timeout testavel)
        }
      },
      context: async ({ sessionID } = {}) => {
        workerCalls.context.push({ sessionID });
        const w = workerSessions.get(sessionID);
        return w?.messages ?? [];
      },
      interrupt: async ({ sessionID } = {}) => {
        workerCalls.interrupt.push({ sessionID });
        const w = workerSessions.get(sessionID);
        if (w) w.interrupted = true;
      },
      switchModel: async ({ sessionID, model }) => {
        calls.switchModel.push({ sessionID, model });
        if (typeof switchBehavior.switchModelError === "function") {
          const e = switchBehavior.switchModelError(calls.switchModel.length);
          if (e) throw e;
        } else if (switchBehavior.switchModelError) {
          throw switchBehavior.switchModelError;
        }
        if (!state) state = { agent: "build", model: { providerID: model.providerID, id: model.id } };
        else state.model = { providerID: model.providerID, id: model.id };
      },
      switchAgent: async ({ sessionID, agent }) => {
        calls.switchAgent.push({ sessionID, agent });
        if (typeof switchBehavior.switchAgentError === "function") {
          const e = switchBehavior.switchAgentError(calls.switchAgent.length);
          if (e) throw e;
        } else if (switchBehavior.switchAgentError) {
          throw switchBehavior.switchAgentError;
        }
        if (!state) state = { agent, model: { providerID: "opencode", id: "big-pickle" } };
        else state.agent = agent;
      },
      hook: (name, cb) => {
        hooks.session[name] = cb;
      },
    },
    tool: {
      hook: (name, cb) => {
        hooks.tool[name] = cb;
      },
      transform: (cb) => {
        const editor = {
          namespace() {},
          add(t) {
            tools[t.name] = t;
          },
        };
        cb(editor);
      },
    },
    integration: {
      list: async () => integrationList,
    },
  };
  return { ctx, hooks, tools, calls, storage, getState: () => state, errorCounts, workerSessions, workerCalls };
}

// —— Stub do Jev (global fetch) ——

export function stubFetch(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    return responder({ url, init, body, index: calls.length - 1 });
  };
  return {
    calls,
    bodies: () => calls.map((c) => c.body),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export function okJev(answers) {
  return { ok: true, status: 200, json: async () => ({ model: "jev-1.13-free", answers, usage: {} }) };
}

export function rateLimitedJev() {
  return { ok: false, status: 429, text: async () => "rate limited", json: async () => ({}) };
}

export function failJev(message = "network down") {
  throw new Error(message);
}

// —— Construtores de respostas SystemOne ——

export const choice = (c, confidence = 0.9) => ({
  type: "choice",
  choice: c,
  probabilities: {},
  confidence,
});
export const noul = (v) => ({ type: "noul", noul: v });
export const score = (v, confidence = 0.8) => ({
  type: "score",
  score: v,
  legend: {},
  probabilities: {},
  confidence,
});

export function routeAnswers({
  route = "fast-coding",
  agent = "build",
  model = "opencode/big-pickle",
  risky = 0,
  complexity = 0,
  confidence = 0.9,
} = {}) {
  return {
    route: choice(route, confidence),
    agent: choice(agent),
    model: choice(model),
    is_risky: noul(risky),
    complexity: score(complexity),
  };
}

export function escalateAnswers(model) {
  return { next_model: choice(model) };
}

export function recoverAnswers(action = "retry", keepModel = 1) {
  return { action: choice(action), keep_model: noul(keepModel) };
}

const $ = async (p) => p;
export { $ };