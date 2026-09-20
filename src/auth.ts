// Resolve a chave do Zen para chamar o Jev SystemOne.
// Ordem: env (ex: OPENCODE_API_KEY) -> credential do `/connect` (integration do Zen).
// Credential.Value do OpenCode V2: { type: "key", key } | { type: "oauth", access }.
// Retorna undefined quando nao ha chave: o roteador cai para a heuristica local.
export async function resolveApiKey(ctx: any, envName: string): Promise<string | undefined> {
  if (process.env[envName]) return process.env[envName];
  try {
    const listed = await ctx.integration.list();
    const items: any[] = Array.isArray(listed) ? listed : (listed?.data ?? listed?.integrations ?? []);
    const zen = items.find((i) =>
      /zen|opencode/i.test(String(i?.id ?? "")) || /zen|opencode/i.test(String(i?.name ?? "")),
    );
    if (!zen?.id) return undefined;
    const conn = await ctx.integration.connection.active(zen.id);
    if (!conn) return undefined;
    const cred: any = await ctx.integration.connection.resolve(conn);
    if (typeof cred === "string") return cred;
    if (cred && typeof cred === "object") {
      if (typeof cred.key === "string") return cred.key;
      if (typeof cred.access === "string") return cred.access;
      return cred.token ?? cred.value ?? cred.apiKey ?? undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
