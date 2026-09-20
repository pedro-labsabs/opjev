// Pool de modelos gratuitos do OpenCode Zen (verificados no escopo MVP).
// IDs no formato provider/model para uso com ctx.session.switchModel().
export const FREE_POOL = [
  "opencode/big-pickle",
  "opencode/mimo-v2.5-free",
  "opencode/ling-3.0-flash-fin-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/muse-spark-1.3-contributor-free",
] as const;

export type FreeModel = (typeof FREE_POOL)[number];

export type RouteKind = "fast-coding" | "heavy-reasoning" | "research-docs";

export const ROUTE_DEFAULT_MODEL: Record<RouteKind, FreeModel> = {
  "fast-coding": "opencode/nemotron-3.5-lightning-free",
  "heavy-reasoning": "opencode/muse-spark-1.3-contributor-free",
  "research-docs": "opencode/ling-3.0-flash-fin-free",
};

// Fallback em cadeia por rota. Jev escolhe a rota; se o modelo falhar
// (retry hook), andamos para o proximo da cadeia.
// Otimizado com base nos benchmarks de cada modelo (pesquisa 2026-09).
export const FALLBACK_CHAIN: Record<RouteKind, FreeModel[]> = {
  "fast-coding": [
    "opencode/nemotron-3.5-lightning-free",  // 670 tok/s - MAIS RAPIDO do pool
    "opencode/big-pickle",                     // Rapido, bom boilerplate
    "opencode/mimo-v2.5-free",                 // Equilibrado (15B ativos)
  ],
  "heavy-reasoning": [
    "opencode/muse-spark-1.3-contributor-free", // DeepSWE 75.4% #1, Terminal-Bench 88.8% #1, Intel 61 #1
    "opencode/nemotron-3-ultra-free",           // SWE-Bench Verified 71.9% #1, PinchBench 90 #1, RULER 1M 94.7%
    "opencode/mimo-v2.5-free",                  // Claw-Eval 62.3%, LiveCodeBench 81.5%, equilibrado
    "opencode/nemotron-3.5-lightning-free",     // PinchBench 85.4, rapido
  ],
  "research-docs": [
    "opencode/ling-3.0-flash-fin-free",         // GPQA Diamond 86.3%, especializado pesquisa/docs, 262K ctx
    "opencode/muse-spark-1.3-contributor-free", // MRCR 1M 98.1% #1 long-context retrieval, 1M ctx
    "opencode/nemotron-3-ultra-free",           // RULER 1M 94.7%, 1M ctx
    "opencode/mimo-v2.5-free",                  // GPQA 81.6%, multimodal docs
  ],
};

export interface RouterOptions {
  /** Modelo SystemOne (Jev) no Zen. Default: jev-1.13-free (gratis por tempo limitado) */
  jevModel?: string;
  /** Endpoint SystemOne. Default: https://opencode.ai/zen/v1/systemone (usa a mesma key do Zen) */
  jevEndpoint?: string;
  /** Nome da env com a chave. Default: OPENCODE_API_KEY (mesma do Zen) */
  apiKeyEnv?: string;
  /** Abaixo disso, escala para heavy-reasoning. Default: 0.55 */
  confidenceThreshold?: number;
  /** Desliga roteamento automatico via hooks, mantem so as tools. Default: true */
  enableAutoRoute?: boolean;
  /** Timeout (ms) das chamadas ao Jev SystemOne. Default: 15000 */
  jevTimeoutMs?: number;
}

export function resolveOptions(raw: Record<string, unknown> = {}): Required<RouterOptions> {
  return {
    jevModel: (raw.jevModel as string) ?? "jev-1.13-free",
    jevEndpoint: (raw.jevEndpoint as string) ?? "https://opencode.ai/zen/v1/systemone",
    apiKeyEnv: (raw.apiKeyEnv as string) ?? "OPENCODE_API_KEY",
    confidenceThreshold: (raw.confidenceThreshold as number) ?? 0.55,
    enableAutoRoute: (raw.enableAutoRoute as boolean) ?? true,
    jevTimeoutMs: (raw.jevTimeoutMs as number) ?? 15000,
  };
}

// Ref no formato provider/model, compativel com ctx.session.switchModel()
// que exige { providerID, id } (ver tipos do @opencode/plugin 2.0.7).
export function splitModelRef(ref: string): { providerID: string; id: string } {
  const slash = ref.indexOf("/");
  if (slash < 0) return { providerID: "opencode", id: ref };
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export function isFreeModel(ref: string): ref is FreeModel {
  return (FREE_POOL as readonly string[]).includes(ref);
}
