// Cliente HTTP proprio do gateway para o upstream OpenCode (#24).
// Usado SOMENTE para as chamadas de control-plane do gateway (admissao
// persist-first, catalogos, switches de route, RPC do plugin) — o trafego
// normal de clientes passa pelo proxy transparente, nao por aqui.
//
// Semantica de falha:
//   - resposta HTTP (qualquer status) = resultado DEFINITO (chamador decide
//     passthrough nativo);
//   - rejeicao de fetch (timeout/rede) = resultado AMBIGUO (chamador nunca
//     re-tenta: poderia duplicar admissao — fail-closed).
// Credencial: de env, nunca logada.

export class UpstreamHttpError extends Error {
  readonly status: number;
  readonly body: Buffer;

  constructor(status: number, body: Buffer, message: string) {
    super(message);
    this.name = "UpstreamHttpError";
    this.status = status;
    this.body = body;
  }
}

export interface UpstreamClientOptions {
  origin: string;
  password?: string;
  timeoutMs: number;
}

function boundedMessage(prefix: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return `${prefix}: ${raw.split("\n")[0]!.slice(0, 200)}`;
}

export class UpstreamClient {
  private readonly origin: string;
  private readonly password: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: UpstreamClientOptions) {
    this.origin = opts.origin;
    this.password = opts.password;
    this.timeoutMs = opts.timeoutMs;
  }

  private authHeader(): string | undefined {
    if (this.password === undefined || this.password === "") return undefined;
    return `Basic ${Buffer.from(`opencode:${this.password}`, "utf8").toString("base64")}`;
  }

  /**
   * Request JSON ao upstream. Resolve com {status, body} em qualquer resposta
   * HTTP; so lanca (erro de rede/timeout = AMBIGUO) quando nada foi recebido.
   */
  async request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<{ status: number; body: Buffer; json: () => unknown }> {
    const headers: Record<string, string> = { accept: "application/json" };
    const auth = this.authHeader();
    if (auth !== undefined) headers.authorization = auth;
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload, "utf8"));
    }
    let res: Response;
    try {
      res = await fetch(`${this.origin}${path}`, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      throw new Error(boundedMessage("upstream inacessivel (resultado ambiguo)", err));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      body: buf,
      json: () => JSON.parse(buf.toString("utf8")) as unknown,
    };
  }

  private async requestOk(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<{ status: number; body: Buffer; json: () => unknown }> {
    const out = await this.request(method, path, body, timeoutMs);
    if (out.status < 200 || out.status >= 300) {
      throw new UpstreamHttpError(
        out.status,
        out.body,
        `upstream HTTP ${out.status} em ${method} ${path.split("?")[0]}`,
      );
    }
    return out;
  }

  async listModels(): Promise<Array<{ id: string; providerID: string }>> {
    const out = await this.requestOk("GET", "/api/model");
    const parsed = out.json() as { data?: unknown };
    if (!Array.isArray(parsed?.data)) throw new Error("catalogo de modelos com forma inesperada");
    return parsed.data.filter(
      (m): m is { id: string; providerID: string } =>
        m !== null &&
        typeof m === "object" &&
        typeof (m as { id?: unknown }).id === "string" &&
        typeof (m as { providerID?: unknown }).providerID === "string",
    );
  }

  async listAgents(): Promise<Array<{ id: string }>> {
    const out = await this.requestOk("GET", "/api/agent");
    const parsed = out.json() as { data?: unknown };
    if (!Array.isArray(parsed?.data)) throw new Error("catalogo de agentes com forma inesperada");
    return parsed.data
      .filter((a): a is { id: string } => a !== null && typeof a === "object" && typeof (a as { id?: unknown }).id === "string")
      .map((a) => ({ id: a.id }));
  }

  async switchModel(sessionID: string, model: { providerID: string; id: string }): Promise<void> {
    await this.requestOk("POST", `/api/session/${encodeURIComponent(sessionID)}/model`, { model });
  }

  async switchAgent(sessionID: string, agent: string): Promise<void> {
    await this.requestOk("POST", `/api/session/${encodeURIComponent(sessionID)}/agent`, { agent });
  }

  /**
   * Leitura best-effort do estado da sessao (para rollback de route parcial e
   * guarda de papel interno). Parse defensivo: model pode vir como string
   * "prov/id", como Model.Ref {providerID,id}, ou nao vir (ausencia =>
   * undefined, sem throw); metadata ausente/ilegivel => undefined.
   */
  async getSession(sessionID: string): Promise<{
    model?: { providerID: string; id: string };
    agent?: string;
    metadata?: Record<string, unknown>;
  }> {
    const out = await this.requestOk("GET", `/api/session/${encodeURIComponent(sessionID)}`);
    let data: unknown;
    try {
      const parsed = out.json() as { data?: unknown };
      data = parsed?.data;
    } catch {
      return {};
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
    const d = data as Record<string, unknown>;
    const result: { model?: { providerID: string; id: string }; agent?: string; metadata?: Record<string, unknown> } = {};
    const m = d.model;
    if (typeof m === "string" && m.includes("/")) {
      const sep = m.indexOf("/");
      const providerID = m.slice(0, sep);
      const id = m.slice(sep + 1);
      if (providerID.length > 0 && id.length > 0) result.model = { providerID, id };
    } else if (m !== null && typeof m === "object" && !Array.isArray(m)) {
      const mm = m as Record<string, unknown>;
      const providerID = typeof mm.providerID === "string" ? mm.providerID : undefined;
      const id = typeof mm.id === "string" ? mm.id : typeof mm.modelID === "string" ? mm.modelID : undefined;
      if (providerID && id) result.model = { providerID, id };
    }
    const a = d.agent;
    if (typeof a === "string" && a.length > 0) result.agent = a;
    else if (a !== null && typeof a === "object" && !Array.isArray(a) && typeof (a as { id?: unknown }).id === "string") {
      result.agent = (a as { id: string }).id;
    }
    const meta = d.metadata;
    if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
      result.metadata = meta as Record<string, unknown>;
    }
    return result;
  }

  /**
   * Admissao persist-first: prompt com resume:false. Campos passados sao
   * somente os conhecidos do contrato (texto/files/metadata/delivery/id real).
   * Resposta nativa devolvida verbatim para o cliente.
   */
  async admitPrompt(
    sessionID: string,
    fields: { text: string; files?: unknown; metadata?: unknown; delivery?: string; id?: string },
  ): Promise<{ status: number; body: Buffer }> {
    const out = await this.requestOk("POST", `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      ...fields,
      resume: false,
    });
    return { status: out.status, body: out.body };
  }

  /** Seam RPC publica do plugin (unico caminho de runOrchestrationOnce). */
  async rpc(rpcID: string, method: string, input: unknown, timeoutMs: number): Promise<unknown> {
    const out = await this.requestOk(
      "POST",
      `/api/rpc/${encodeURIComponent(rpcID)}/${encodeURIComponent(method)}`,
      { input },
      timeoutMs,
    );
    const parsed = out.json() as { output?: unknown };
    return parsed?.output;
  }
}
