import { autoAdmissionRunID } from "../src/orchestration/admission.ts";

const MAX_DIAGNOSTICS = 12;
const MAX_DRIVER_EVENTS = 32;
const MAX_ID_LENGTH = 200;

function validID(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/** Parse only the driver's allowlisted, content-free progress records. */
export function parseTuiDriverProgress(output) {
  const parsed = [];
  for (const line of String(output ?? "").split(/\r?\n/u)) {
    if (line.length === 0 || line.length > 1000 || parsed.length >= MAX_DRIVER_EVENTS) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value?.source !== "opjev-e2e-tui" || !Number.isInteger(value.step) || value.step < 0 || value.step > 1000) continue;
    if (value.event === "pty-write" && Number.isInteger(value.bytesRequested) && Number.isInteger(value.bytesWritten)) {
      parsed.push({ event: value.event, step: value.step, bytesRequested: value.bytesRequested, bytesWritten: value.bytesWritten });
    } else if (value.event === "enter-sent" && Number.isInteger(value.bytesWritten)) {
      parsed.push({ event: value.event, step: value.step, bytesWritten: value.bytesWritten });
    }
  }
  return parsed;
}

/**
 * A clean PTY driver exit proves only that its scripted input steps completed.
 * Acceptance requires a fresh, uniquely correlated gateway evidence chain.
 */
export function evaluateTuiAdmissionEvidence({
  events,
  baselineIndex = 0,
  driverExitCode,
  driverSignal = null,
  driverOutput = "",
  expectedSessionID,
  expectedSubmitStep = 0,
}) {
  const diagnostics = [];
  const add = (message) => {
    if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(message);
  };
  const allEvents = Array.isArray(events) ? events : [];
  const baselineValid = Number.isSafeInteger(baselineIndex) && baselineIndex >= 0 && baselineIndex <= allEvents.length;
  if (!baselineValid) add("gateway event baseline is missing or captured after the event stream");
  if (!validID(expectedSessionID)) add("TUI sessionID was not observed");
  const freshEvents = baselineValid ? allEvents.slice(baselineIndex) : [];
  const driverProgress = parseTuiDriverProgress(driverOutput);
  const submitWrites = driverProgress.filter((event) => event.event === "pty-write" && event.step === expectedSubmitStep);
  const submitEnters = driverProgress.filter((event) => event.event === "enter-sent" && event.step === expectedSubmitStep);

  if (driverExitCode !== 0 || driverSignal !== null) add("PTY driver did not exit normally with code 0");
  if (submitWrites.length !== 1 || submitWrites[0]?.bytesRequested < 1 || submitWrites[0]?.bytesWritten !== submitWrites[0]?.bytesRequested) {
    add("orchestration PTY step did not record exactly one complete byte write");
  }
  if (submitEnters.length !== 1 || submitEnters[0]?.bytesWritten !== 1) {
    add("orchestration PTY step did not record exactly one Enter write");
  }

  const orchestrateIntercepts = freshEvents.filter((event) => event?.type === "intercept" && event.mode === "orchestrate");
  const admissions = freshEvents.filter((event) => event?.type === "admitted");
  const dispatches = freshEvents.filter((event) => event?.type === "rpc-dispatched");
  const failureEvents = freshEvents.filter((event) => [
    "admission-rejected",
    "admission-unknown",
    "admission-identity-missing",
    "rpc-failed",
  ].includes(event?.type));

  if (orchestrateIntercepts.length !== 1) add(`expected exactly one intercept(mode=orchestrate), observed ${orchestrateIntercepts.length}`);
  if (admissions.length !== 1) add(`expected exactly one admitted event, observed ${admissions.length}`);
  if (dispatches.length !== 1) add(`expected exactly one rpc-dispatched event, observed ${dispatches.length}`);
  if (failureEvents.length > 0) add("gateway recorded a rejected or failed admission/dispatch event");

  let identity = null;
  if (orchestrateIntercepts.length === 1 && admissions.length === 1 && dispatches.length === 1) {
    const intercept = orchestrateIntercepts[0];
    const admitted = admissions[0];
    const dispatched = dispatches[0];
    const sessionID = intercept.sessionID;
    const messageID = admitted.messageID;
    const runID = admitted.runID;

    if (!validID(sessionID) || !validID(admitted.sessionID) || !validID(messageID) || !validID(runID) || !validID(dispatched.runID)) {
      add("gateway admission chain lacks a bounded sessionID, messageID, or runID");
    } else {
      identity = { sessionID, messageID, runID };
      if (sessionID !== admitted.sessionID) add("intercept sessionID does not match admitted sessionID");
      if (expectedSessionID !== undefined && expectedSessionID !== null && sessionID !== expectedSessionID) {
        add("intercept sessionID does not match the TUI session");
      }
      if (autoAdmissionRunID(sessionID, messageID) !== runID) add("admitted runID does not derive from its sessionID and messageID");
      if (dispatched.runID !== runID) add("rpc-dispatched runID does not match admitted runID");
      if (freshEvents.indexOf(intercept) >= freshEvents.indexOf(admitted) || freshEvents.indexOf(admitted) >= freshEvents.indexOf(dispatched)) {
        add("gateway evidence order is not intercept, admitted, then rpc-dispatched");
      }
    }
  }

  return {
    ok: diagnostics.length === 0,
    driver: {
      exitCode: Number.isInteger(driverExitCode) ? driverExitCode : null,
      signal: typeof driverSignal === "string" ? driverSignal : null,
    },
    counts: {
      gatewayEventBaselineIndex: baselineValid ? baselineIndex : null,
      ptyBytesWritten: submitWrites.reduce((total, event) => total + Math.max(0, event.bytesWritten), 0),
      ptyEnterSent: submitEnters.length,
      orchestrateIntercept: orchestrateIntercepts.length,
      admitted: admissions.length,
      rpcDispatched: dispatches.length,
      failureEvents: failureEvents.length,
      gatewayEventsSinceBaseline: freshEvents.length,
    },
    identity,
    diagnostics,
  };
}
