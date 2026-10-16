/**
 * Read-only projection for the human-visible result panel.
 * The persisted kernel verdict, never a worker claim, authorizes visibility.
 * This is not a transcript and cannot re-enter orchestration.
 */
export interface AcceptedResult {
  available: boolean;
  text?: string;
}

export function projectAcceptedResult(record: unknown, sessionID: string, runID: string): AcceptedResult {
  const unavailable: AcceptedResult = { available: false };
  try {
    if (!record || typeof record !== "object" || Array.isArray(record)) return unavailable;
    const state = (record as { state?: any }).state;
    if (!state || state.phase !== "completed" || !Number.isInteger(state.round) || state.round < 1) return unavailable;
    if (state.contract?.sessionID !== sessionID || state.contract?.runID !== runID ||
      !Number.isInteger(state.contract?.maxRounds) || state.round > state.contract.maxRounds) return unavailable;
    if (state.lastVerdict?.nextAction !== "accept" || state.lastVerdict.done !== true) return unavailable;
    const evidence = state.evidence;
    if (!evidence || evidence.round !== state.round || !Array.isArray(evidence.deterministicChecks)) return unavailable;
    for (const required of ["worker-session-outcome", "worker-final-response", "critic-session-outcome"]) {
      if (evidence.deterministicChecks.filter((check: any) => check?.name === required && check?.status === "pass").length !== 1) {
        return unavailable;
      }
    }
    if (evidence.deterministicChecks.some((check: any) => check?.status !== "pass")) return unavailable;
    if (typeof evidence.resultSummary !== "string" || evidence.resultSummary.trim().length === 0 ||
      evidence.resultSummary.length > 500) return unavailable;
    return { available: true, text: evidence.resultSummary };
  } catch {
    return unavailable;
  }
}
