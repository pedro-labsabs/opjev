import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { acquireLock, parseSessionArgs, summarizeAudit } from "../scripts/opjev.mjs";
import { sanitizeObservation } from "../src/resource-governor/usage-ledger.ts";
const OPJEV_STORAGE_PREFIX = "plugin:006a00650076002d0066007200650065002d0072006f0075007400650072:";


test("launcher allows session continuation without permitting a gateway bypass", () => {
  assert.deepEqual(parseSessionArgs(["--continue"]), ["--continue"]);
  assert.deepEqual(parseSessionArgs(["--session", "session-safe-id"]), ["--session", "session-safe-id"]);
  assert.throws(() => parseSessionArgs(["--server", "http://127.0.0.1:9999"]), /unsupported/);
  assert.throws(() => parseSessionArgs(["--prompt", "run outside the TUI"]), /unsupported/);
  assert.throws(() => parseSessionArgs(["--continue", "--session", "id"]), /combine/);
});

test("launcher preserves a stale lock instead of racing to reap it", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opjev-lock-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "active.json");
  const stale = { pid: Number.MAX_SAFE_INTEGER, startedAt: 1, serverPid: null, gatewayPid: null };
  fs.writeFileSync(lockPath, JSON.stringify(stale));

  assert.throws(() => acquireLock(lockPath), /stale|preserved/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), stale);
});

function createAuditDb(t, observations, runs) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT, time_created INTEGER, time_updated INTEGER)");
  db.prepare("INSERT INTO kv VALUES (?, ?, ?, ?)").run(
    `${OPJEV_STORAGE_PREFIX}resource/usage-ledger/v1`,
    JSON.stringify({ schema: 1, capacity: 2048, observations }),
    0,
    0,
  );
  for (const run of runs) {
    db.prepare("INSERT INTO kv VALUES (?, ?, ?, ?)").run(
      `${OPJEV_STORAGE_PREFIX}orchestration/run/${run.id}`,
      JSON.stringify(run.record),
      run.updatedAt,
      run.updatedAt,
    );
  }
  t.after(() => db.close());
  return db;
}

function auditRun(id, { phase = "stopped", model = `model-${id}`, maxRounds = 3, round = 1, evidence = true, verdict = true } = {}) {
  const workerSessionID = evidence ? `session-${id}` : undefined;
  return {
    id,
    updatedAt: 1,
    record: {
      selection: { via: "jev", model, agent: "build", route: "fast-coding" },
      criticSessionID: "critic",
      ...(workerSessionID ? { workerSessionID } : {}),
      state: {
        phase,
        round,
        contract: { runID: id, maxRounds },
        ...(workerSessionID ? { executor: { agent: "build", model, sessionID: workerSessionID } } : {}),
        evidence: evidence ? {
          executor: { model, agent: "build", sessionID: workerSessionID },
          round,
          deterministicChecks: [{ name: "critic-session-outcome", status: "pass" }],
        } : undefined,
        lastVerdict: verdict ? { nextAction: phase === "completed" ? "accept" : "continue" } : undefined,
      },
    },
  };
}

function linkedObservations(id, round, model, agent = "build") {
  return [
    { kind: "round", runID: id, role: "worker", round, model, agent, sessionID: `session-${id}`, route: "fast-coding" },
    { kind: "request", runID: id, role: "worker", round, model, agent, sessionID: `session-${id}`, route: "fast-coding" },
    { kind: "outcome", runID: id, role: "worker", round, model, agent, sessionID: `session-${id}`, route: "fast-coding", acceptance: true, failureClass: "none" },
  ];
}

test("audit fails terminal runs without evidence and orphaned ledger run IDs", t => {
  const missingEvidence = auditRun("missing-evidence", { phase: "completed", evidence: false });
  const observations = [
    ...linkedObservations("valid", 1, "model-valid"),
    { kind: "request", runID: "orphaned-run", role: "worker", round: 1, model: "model-orphan", agent: "build" },
  ];
  const db = createAuditDb(t, observations, [
    auditRun("valid", { phase: "completed", model: "model-valid" }),
    missingEvidence,
  ]);

  const summary = summarizeAudit(db);
  assert.equal(summary.missingLinks, 2);
  assert.equal(summary.orphanedRunLinks, 1);
  assert.equal(summary.auditFailed, true);
});

test("audit reports failed runs with no worker evidence as pre-worker failures", t => {
  const run = auditRun("before-worker", { phase: "failed", evidence: false, verdict: false });
  const summary = summarizeAudit(createAuditDb(t, [], [run]));

  assert.equal(summary.preWorkerFailures, 1);
  assert.equal(summary.missingLinks, 0);
  assert.equal(summary.auditFailed, false);
});

test("audit treats persisted worker identity as evidence that a failed run reached the worker", t => {
  const run = auditRun("dropped-round", { phase: "failed", evidence: false, verdict: false });
  run.record.workerSessionID = "worker-session-dropped";
  run.record.state.executor = { agent: "build", model: "model-dropped", sessionID: "worker-session-dropped" };
  const summary = summarizeAudit(createAuditDb(t, [], [run]));

  assert.equal(summary.preWorkerFailures, 0);
  assert.equal(summary.missingLinks, 1);
  assert.equal(summary.auditFailed, true);
});

test("audit classifies a linked operational failure before evidence without calling it a missing link", t => {
  const run = auditRun("governed-before-evidence", { phase: "failed", evidence: false, verdict: false });
  run.record.checkpoint = "run-failed";
  run.record.workerSessionID = "session-governed-before-evidence";
  run.record.state.executor = { agent: "build", model: "model-governed-before-evidence", sessionID: run.record.workerSessionID };
  const observations = [{
    kind: "operational-failure", runID: run.id, role: "worker", round: 1,
    sessionID: run.record.workerSessionID, model: "model-governed-before-evidence", agent: "build", errorCode: "provider-error", failureDomain: "provider",
  }];
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.governedPreEvidenceFailures, 1);
  assert.equal(summary.missingLinks, 0);
  assert.equal(summary.auditFailed, false);
});
test("audit fails when governed pre-evidence failures contain malformed round observations", t => {
  const run = auditRun("governed-malformed-fact", { phase: "failed", evidence: false, verdict: false });
  run.record.checkpoint = "run-failed";
  run.record.workerSessionID = "session-governed-malformed-fact";
  run.record.state.executor = { agent: "build", model: "model-governed-malformed-fact", sessionID: run.record.workerSessionID };
  const observations = [
    {
      kind: "operational-failure", runID: run.id, role: "worker", round: 1,
      sessionID: run.record.workerSessionID, model: "model-governed-malformed-fact", agent: "build",
      errorCode: "provider-error", failureDomain: "provider",
    },
    { kind: "request", runID: run.id, role: "worker", round: 1, model: "model-governed-malformed-fact", agent: "build" },
  ];
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.governedPreEvidenceFailures, 1);
  assert.equal(summary.roundViolations, 1);
  assert.equal(summary.evidenceInconsistencies, 1);
  assert.equal(summary.missingLinks, 1);
  assert.equal(summary.auditFailed, true);
});

test("audit requires current round and request identity after evidence even before verdict", t => {
  const run = auditRun("before-verdict-missing-request", { phase: "failed", evidence: true, verdict: false });
  run.record.checkpoint = "run-failed";
  const observations = [{
    kind: "round", runID: run.id, role: "worker", round: 1,
    model: run.record.state.evidence.executor.model, agent: "build", sessionID: run.record.workerSessionID,
  }];
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.postEvidencePreVerdictFailures, 1);
  assert.equal(summary.evidenceInconsistencies, 1);
  assert.equal(summary.missingLinks, 1);
  assert.equal(summary.auditFailed, true);
});

test("audit preserves requested and observed model identities before a verdict", t => {
  const run = auditRun("before-verdict-model-substitution", { phase: "failed", model: "observed-model", evidence: true, verdict: false });
  run.record.checkpoint = "run-failed";
  const observations = [
    { kind: "round", runID: run.id, role: "worker", round: 1, model: "requested-model", agent: "build", sessionID: run.record.workerSessionID, route: "fast-coding" },
    { kind: "request", runID: run.id, role: "worker", round: 1, model: "requested-model", agent: "build", sessionID: run.record.workerSessionID, route: "fast-coding" },
  ];
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.postEvidencePreVerdictFailures, 1);
  assert.equal(summary.linked, 0);
  assert.equal(summary.missingLinks, 0);
  assert.equal(summary.auditFailed, false);
});
test("audit classifies evidence without an applied verdict as a post-evidence failure", t => {
  const run = auditRun("before-verdict", { phase: "failed", evidence: true, verdict: false });
  run.record.checkpoint = "run-failed";
  const observations = [
    { kind: "round", runID: run.id, role: "worker", round: 1, model: run.record.state.evidence.executor.model, agent: "build", sessionID: run.record.workerSessionID },
    { kind: "request", runID: run.id, role: "worker", round: 1, model: run.record.state.evidence.executor.model, agent: "build", sessionID: run.record.workerSessionID },
  ];
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.postEvidencePreVerdictFailures, 1);
  assert.equal(summary.missingLinks, 0);
  assert.equal(summary.auditFailed, false);
});

test("audit separates an unconfirmed interrupt from a governed terminal failure", t => {
  const run = auditRun("interrupt-unknown", { phase: "running", evidence: false, verdict: false });
  run.record.checkpoint = "run-failed";
  run.record.workerSessionID = "session-interrupt-unknown";
  run.record.state.executor = { agent: "build", model: "model-interrupt-unknown", sessionID: run.record.workerSessionID };
  const observations = [{
    kind: "operational-failure", runID: run.id, role: "worker", round: 1,
    sessionID: run.record.workerSessionID, errorCode: "interrupt-unconfirmed", failureDomain: "operational",
  }];
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.ambiguousInterruptions, 1);
  assert.equal(summary.ambiguousRuns, 1);
  assert.equal(summary.missingLinks, 0);
  assert.equal(summary.auditFailed, true);
});

test("audit links every applied multi-round outcome to its persisted history and final evidence", t => {
  const run = auditRun("multi-linked", { phase: "completed", model: "model-final", round: 2 });
  run.record.state.history = [
    { round: 1, executor: { agent: "build", model: "model-first" }, outcome: "failed", verdict: { nextAction: "repair-same", failureClass: "implementation" } },
    { round: 2, executor: { agent: "build", model: "model-final" }, outcome: "succeeded", verdict: { nextAction: "accept", failureClass: "none" } },
  ];
  const observations = [
    ...linkedObservations("multi-linked", 1, "model-first").map(item => ({ ...item, acceptance: false, failureClass: "implementation" })),
    ...linkedObservations("multi-linked", 2, "model-final"),
  ];
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.missingLinks, 0);
  assert.equal(summary.linked, 1);
  assert.equal(summary.auditFailed, false);
});

test("audit joins multi-round history to observed models after OpenCode substitutions", t => {
  const run = auditRun("multi-model-substitution", { phase: "completed", model: "observed-final", round: 2 });
  run.record.state.history = [
    { round: 1, executor: { agent: "build", model: "observed-first" }, outcome: "failed", verdict: { nextAction: "repair-same", failureClass: "implementation" } },
    { round: 2, executor: { agent: "build", model: "observed-final" }, outcome: "succeeded", verdict: { nextAction: "accept", failureClass: "none" } },
  ];
  const observations = [
    ...linkedObservations(run.id, 1, "requested-first").map(item => ({
      ...item,
      ...(item.kind === "outcome" ? { model: "observed-first", acceptance: false, failureClass: "implementation" } : {}),
    })),
    ...linkedObservations(run.id, 2, "requested-final").map(item => ({
      ...item,
      ...(item.kind === "outcome" ? { model: "observed-final" } : {}),
    })),
  ];
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.linked, 1);
  assert.equal(summary.missingLinks, 0);
  assert.equal(summary.roundViolations, 0);
  assert.equal(summary.auditFailed, false);
});

test("audit does not treat a previous-round worker as started in a failed new-round selection", t => {
  const run = auditRun("new-round-selection-failure", {
    phase: "failed", model: "model-prior", round: 2, evidence: true, verdict: false,
  });
  run.record.checkpoint = "run-failed";
  run.record.state.evidence.round = 1;
  run.record.state.history = [{
    round: 1,
    executor: { agent: "build", model: "model-prior" },
    outcome: "failed",
    verdict: { nextAction: "switch-model", failureClass: "wrong-model" },
  }];
  const observations = linkedObservations(run.id, 1, "model-prior").map(item => item.kind === "outcome"
    ? { ...item, acceptance: false, failureClass: "wrong-model" }
    : item);

  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.preWorkerFailures, 1);
  assert.equal(summary.evidenceInconsistencies, 0);
  assert.equal(summary.missingLinks, 0);
  assert.equal(summary.auditFailed, false);
});

test("audit recognizes a current-round failure on a reused prior-round worker session", t => {
  const run = auditRun("repair-round-provider-failure", {
    phase: "failed", model: "model-prior", round: 2, evidence: true, verdict: false,
  });
  run.record.checkpoint = "run-failed";
  run.record.state.evidence.round = 1;
  run.record.state.history = [{
    round: 1,
    executor: { agent: "build", model: "model-prior" },
    outcome: "failed",
    verdict: { nextAction: "repair-same", failureClass: "implementation" },
  }];
  const observations = [
    ...linkedObservations(run.id, 1, "model-prior").map(item => item.kind === "outcome"
      ? { ...item, acceptance: false, failureClass: "implementation" }
      : item),
    {
      kind: "provider-error", runID: run.id, role: "worker", round: 2,
      sessionID: run.record.workerSessionID, model: "model-prior", agent: "build", failureDomain: "provider",
    },
  ];

  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.preWorkerFailures, 0);
  assert.equal(summary.governedPreEvidenceFailures, 1);
  assert.equal(summary.evidenceInconsistencies, 0);
  assert.equal(summary.missingLinks, 0);
  assert.equal(summary.auditFailed, false);
});
test("audit reports in-flight runs separately without treating them as evidence loss", t => {
  const run = auditRun("pending-run", { phase: "running", evidence: false, verdict: false });
  const summary = summarizeAudit(createAuditDb(t, [], [run]));

  assert.equal(summary.pendingRuns, 1);
  assert.equal(summary.missingLinks, 0);
  assert.equal(summary.auditFailed, false);
});

test("audit fails a completed run whose applied verdict lacks its linked outcome", t => {
  const run = auditRun("missing-final-outcome", { phase: "completed", model: "model-outcome" });
  const observations = linkedObservations("missing-final-outcome", 1, "model-outcome").slice(0, 2);
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.evidenceInconsistencies, 1);
  assert.equal(summary.missingLinks, 1);
  assert.equal(summary.auditFailed, true);
});

test("audit flags multiple worker sessions dispatched in one round", t => {
  const run = auditRun("duplicate-round", { phase: "completed", model: "model-duplicate" });
  const observations = [
    ...linkedObservations("duplicate-round", 1, "model-duplicate"),
    ...linkedObservations("duplicate-round", 1, "model-duplicate").map(item => ({ ...item, sessionID: "duplicate-session" })),
  ];
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.roundViolations, 1);
  assert.equal(summary.auditFailed, true);
});

test("audit requires round, request, and outcome to join to the persisted worker session", t => {
  const run = auditRun("session-mismatch", { phase: "completed", model: "model-session" });
  const observations = linkedObservations("session-mismatch", 1, "model-session");
  observations[1].sessionID = "other-request-session";
  observations[2].sessionID = "other-outcome-session";
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.missingLinks, 1);
  assert.equal(summary.auditFailed, true);
});

test("audit rejects a missing outcome from an earlier worker round", t => {
  const run = auditRun("missing-prior-outcome", { phase: "completed", model: "model-final", round: 2 });
  const observations = [
    ...linkedObservations("missing-prior-outcome", 1, "model-first").slice(0, 2),
    ...linkedObservations("missing-prior-outcome", 2, "model-final"),
  ];
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.linked, 0);
  assert.equal(summary.missingLinks, 1);
  assert.equal(summary.auditFailed, true);
});

test("audit rejects a missing prior worker-round record", t => {
  const run = auditRun("missing-prior-round", { phase: "completed", model: "model-final", round: 2 });
  const observations = linkedObservations("missing-prior-round", 2, "model-final");
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.linked, 0);
  assert.equal(summary.missingLinks, 1);
  assert.equal(summary.auditFailed, true);
});

test("audit links observed executor to evidence when runtime model differs from request", t => {
  const selectedModel = "opencode/ling-3.0-flash-fin-free";
  const observedModel = "opencode/nemotron-3.5-lightning-free";
  const run = auditRun("runtime-model-substitution", { phase: "completed", model: observedModel });
  run.record.selection.model = selectedModel;
  const observations = linkedObservations("runtime-model-substitution", 1, selectedModel);
  observations[2].model = observedModel;
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.linked, 1);
  assert.equal(summary.missingLinks, 0);
  assert.equal(summary.auditFailed, false);
});

test("audit preserves complete run IDs containing path separators", t => {
  const run = auditRun("team/task", { phase: "completed", model: "model-nested" });
  const summary = summarizeAudit(createAuditDb(t, linkedObservations("team/task", 1, "model-nested"), [run]));

  assert.equal(summary.invalidRunRecords, 0);
  assert.equal(summary.missingLinks, 0);
  assert.equal(summary.auditFailed, false);
});

test("audit rejects EvidencePacket linked to a different worker session", t => {
  const run = auditRun("evidence-session-mismatch", { phase: "completed", model: "model-evidence" });
  run.record.state.evidence.executor.sessionID = "different-evidence-session";
  const observations = linkedObservations("evidence-session-mismatch", 1, "model-evidence");
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.missingLinks, 1);
  assert.equal(summary.auditFailed, true);
});

test("audit links contract-max run and session IDs without ledger truncation", t => {
  const runID = "r".repeat(200);
  const sessionID = "s".repeat(200);
  const run = auditRun(runID, { phase: "completed", model: "model-long-id" });
  run.record.workerSessionID = sessionID;
  run.record.state.executor.sessionID = sessionID;
  run.record.state.evidence.executor.sessionID = sessionID;
  const observations = linkedObservations(runID, 1, "model-long-id")
    .map(item => sanitizeObservation({ ...item, sessionID }));
  const summary = summarizeAudit(createAuditDb(t, observations, [run]));

  assert.equal(summary.missingLinks, 0);
  assert.equal(summary.auditFailed, false);
});

test("audit rejects and suppresses unrecognized run phases", t => {
  const privatePhase = "private prompt text";
  const run = auditRun("invalid-phase", { phase: privatePhase });
  const summary = summarizeAudit(createAuditDb(t, [], [run]));

  assert.equal(summary.invalidRunRecords, 1);
  assert.equal(Object.hasOwn(summary.phases, privatePhase), false);
  assert.equal(summary.auditFailed, true);
});

test("audit rejects a ledger larger than its declared bounded capacity", t => {
  const observations = Array.from({ length: 2049 }, () => ({ kind: "request" }));
  const db = createAuditDb(t, observations, []);

  assert.throws(() => summarizeAudit(db), /capacity|bounded/i);
});

test("audit selects the 100 most recently updated runs, not the oldest row IDs", t => {
  const runs = Array.from({ length: 101 }, (_, index) => ({
    ...auditRun(`run-${index}`, { phase: "stopped", model: `model-${index}`, evidence: false, verdict: false }),
    updatedAt: index,
  }));
  runs[0].updatedAt = 101;
  const summary = summarizeAudit(createAuditDb(t, [], runs));

  assert.equal(summary.canonicalRunsInspected, 100);
  assert.ok(summary.models.includes("model-0"));
  assert.equal(summary.models.includes("model-1"), false);
});

test("audit fails when observed worker rounds exceed maxRounds", t => {
  const run = auditRun("over-budget", { phase: "failed", model: "model-over", maxRounds: 1, round: 2 });
  const summary = summarizeAudit(createAuditDb(t, linkedObservations("over-budget", 2, "model-over"), [run]));

  assert.equal(summary.roundLimitViolations, 1);
  assert.equal(summary.auditFailed, true);
});

test("launcher refuses a symlinked install root before reading or writing state", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opjev-root-symlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const outside = path.join(root, "outside");
  fs.mkdirSync(path.join(home, ".local", "share"), { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(home, ".local", "share", "opjev-dogfood"), "dir");

  const result = spawnSync(process.execPath, [path.resolve("scripts/opjev.mjs"), "status"], {
    cwd: process.cwd(),
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(path.join(outside, "active.json")), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(outside), false);
});
