/** Human-visible, bounded rendering of a read-only, kernel-verified result. */
import type { AcceptedResult } from "./accepted-result.ts";

const clean = (s: string): string =>
  s.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");

export function formatReadOnlyResultPanel(input: {
  runID?: string;
  result?: AcceptedResult;
}): string {
  if (!input.result?.available || typeof input.result.text !== "string" ||
    !input.result.text.trim() || input.result.text.length > 500) {
    return "Nenhum resultado aceito disponivel para esta sessao.";
  }
  const run = typeof input.runID === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(input.runID)
    ? input.runID.slice(-45) : "desconhecido";
  return `Resultado aceito pelo Jev · ${run}\n\n${clean(input.result.text).slice(0, 500)}`;
}
