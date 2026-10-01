// Fronteira de admission do gateway (#24): parse BOUNDED do prompt interceptado
// e decisao deterministica de modo. Puro — sem rede, sem efeito upstream.
//
// - rejeicao 400/413 acontece ANTES de qualquer chamada upstream;
// - marcadores internos (worker/critic/orchestrator) zeram a admissao
//   (workers nunca atravessam o gateway; isto fecha a porta de recursao);
// - modo orchestrate e opt-in por regra/default da config (stub deterministico
//   admitido para controlar a decisao de admission nesta fatia).

import type { AdmissionMode, AdmissionRule } from "./config.ts";
import {
  hasInternalCriticPromptMarker,
  hasInternalOrchestratorPromptMarker,
  hasInternalPromptMarker,
} from "../worker-hooks.ts";

export type ParseResult =
  | {
      ok: true;
      body: Record<string, unknown>;
      text: string;
      metadata: Record<string, unknown> | undefined;
    }
  | { ok: false; status: 400 | 413; code: string; message: string };

/**
 * Parse do corpo de `POST /api/session/:sid/prompt`. O teto de bytes e
 * checado ANTES de qualquer parse; corpo malformado vira 400 bounded.
 * Campos passados adiante sao somente os conhecidos do contrato público
 * (text/files/metadata/delivery/id) — nada de campos arbitrarios.
 */
export function parsePromptPayload(raw: Buffer, maxBodyBytes: number): ParseResult {
  if (raw.byteLength > maxBodyBytes) {
    return {
      ok: false,
      status: 413,
      code: "payload-too-large",
      message: `corpo do prompt excede ${maxBodyBytes} bytes`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, status: 400, code: "malformed-json", message: "corpo do prompt nao e JSON valido" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, code: "invalid-prompt", message: "corpo do prompt deve ser um objeto JSON" };
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.text !== "string" || body.text.length < 1) {
    return { ok: false, status: 400, code: "invalid-prompt", message: "text deve ser string nao-vazia" };
  }
  if (
    body.metadata !== undefined &&
    (body.metadata === null || typeof body.metadata !== "object" || Array.isArray(body.metadata))
  ) {
    return { ok: false, status: 400, code: "invalid-prompt", message: "metadata deve ser objeto" };
  }
  if (body.id !== undefined && typeof body.id !== "string") {
    return { ok: false, status: 400, code: "invalid-prompt", message: "id deve ser string" };
  }
  if (body.delivery !== undefined && body.delivery !== "steer" && body.delivery !== "queue") {
    return { ok: false, status: 400, code: "invalid-prompt", message: "delivery deve ser steer|queue" };
  }
  return {
    ok: true,
    body,
    text: body.text,
    metadata: body.metadata === undefined ? undefined : (body.metadata as Record<string, unknown>),
  };
}

export interface AdmissionDecision {
  mode: AdmissionMode;
  via: string;
}

/**
 * Decisao deterministica de modo. Qualquer falha inesperada => normal
 * (fail-closed para execucao nativa, nunca orchestrate forcado).
 */
export function decideAdmissionMode(input: {
  text: string;
  metadata: Record<string, unknown> | undefined;
  rules: AdmissionRule[];
  defaultMode: AdmissionMode;
}): AdmissionDecision {
  try {
    if (
      input.metadata !== undefined &&
      (hasInternalPromptMarker(input.metadata) ||
        hasInternalCriticPromptMarker(input.metadata) ||
        hasInternalOrchestratorPromptMarker(input.metadata))
    ) {
      return { mode: "normal", via: "internal-bypass" };
    }
    for (const rule of input.rules) {
      if (input.text.startsWith(rule.prefix)) {
        return { mode: rule.mode, via: "config-rule" };
      }
    }
    return { mode: input.defaultMode, via: "config-default" };
  } catch {
    return { mode: "normal", via: "fail-closed" };
  }
}

/** Campos conhecidos do contrato de prompt — o resto nunca e reenviado. */
export function admissionForwardFields(body: Record<string, unknown>): {
  text: string;
  files?: unknown;
  metadata?: unknown;
  delivery?: string;
  id?: string;
} {
  const out: { text: string; files?: unknown; metadata?: unknown; delivery?: string; id?: string } = {
    text: String(body.text ?? ""),
  };
  if (body.files !== undefined) out.files = body.files;
  if (body.metadata !== undefined) out.metadata = body.metadata;
  if (typeof body.delivery === "string") out.delivery = body.delivery;
  if (typeof body.id === "string") out.id = body.id;
  return out;
}
