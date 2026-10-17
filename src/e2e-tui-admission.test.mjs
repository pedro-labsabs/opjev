import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { autoAdmissionRunID } from "./orchestration/admission.ts";
import { evaluateTuiAdmissionEvidence } from "../scripts/e2e-tui-admission.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driver = path.join(repo, "scripts/e2e-tui.py");
const sessionID = "ses_issue57_tui";
const messageID = "msg_issue57_prompt";
const runID = autoAdmissionRunID(sessionID, messageID);
const driverOutput = [
  JSON.stringify({ source: "opjev-e2e-tui", event: "pty-write", step: 0, bytesRequested: 23, bytesWritten: 23 }),
  JSON.stringify({ source: "opjev-e2e-tui", event: "enter-sent", step: 0, bytesWritten: 1 }),
].join("\n");

function chain() {
  return [
    { type: "intercept", mode: "orchestrate", sessionID, t: 1 },
    { type: "admitted", sessionID, messageID, runID, t: 2 },
    { type: "rpc-dispatched", runID, t: 3 },
  ];
}

function evaluate(events, overrides = {}) {
  return evaluateTuiAdmissionEvidence({
    events,
    baselineIndex: 0,
    driverExitCode: 0,
    driverSignal: null,
    driverOutput,
    expectedSessionID: sessionID,
    ...overrides,
  });
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function waitForExitWithin(child, timeoutMs) {
  return new Promise((resolve) => {
    let timer;
    const onExit = (code, signal) => finish({ code, signal });
    const finish = (result) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(result);
    };
    child.once("exit", onExit);
    timer = setTimeout(() => finish(null), timeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({ code: child.exitCode, signal: child.signalCode });
    }
  });
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

function writeFakeDriverSpec(temp, { childSource, steps, bootMs = 250 }) {
  const pidFile = path.join(temp, "fake-child.pid");
  const specPath = path.join(temp, "spec.json");
  const source = `require("node:fs").writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(process.pid)); ${childSource}`;
  fs.writeFileSync(specPath, JSON.stringify({
    bin: process.execPath,
    args: ["-e", source],
    cwd: repo,
    env: { FAKE_CHILD_PID_FILE: pidFile },
    boot_ms: bootMs,
    steps,
    tail_ms: 50,
    dump_to: path.join(temp, "pty.bin"),
  }));
  return { pidFile, specPath };
}

test("write-only PTY driver exit 0 without gateway events is not submit acceptance", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "opjev-tui-admission-red-"));
  let fakePid;
  try {
    const { pidFile, specPath } = writeFakeDriverSpec(temp, {
      childSource: "setInterval(() => {}, 1000);",
      steps: [{ type: "write-only test bytes", enter: true, after_enter_ms: 50 }],
    });
    const result = spawnSync("python3", [driver, specPath], { encoding: "utf8", timeout: 10000 });
    fakePid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `controlled fake TUI should reproduce baseline driver exit 0: ${result.stderr}`);

    // The process reported only a completed PTY action. The authoritative gate
    // rejects it because no gateway event exists, even though bytes and Enter did.
    const evidence = evaluate([], { driverOutput: result.stdout });
    assert.equal(evidence.ok, false);
    assert.ok(evidence.counts.ptyBytesWritten > 0, "driver proves bytes were written, not admitted");
    assert.equal(evidence.counts.ptyEnterSent, 1);
    assert.equal(evidence.counts.orchestrateIntercept, 0);
    assert.equal(evidence.counts.admitted, 0);
    assert.equal(evidence.counts.rpcDispatched, 0);
    assert.ok(evidence.diagnostics.some((item) => item.includes("intercept(mode=orchestrate)")));
    assert.ok(evidence.diagnostics.some((item) => item.includes("admitted event")));
    assert.ok(evidence.diagnostics.some((item) => item.includes("rpc-dispatched")));
  } finally {
    if (Number.isInteger(fakePid) && fakePid > 1) {
      try { process.kill(fakePid, "SIGTERM"); } catch { /* child already reaped by driver */ }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("accepts only a single ordered intercept, admitted identity, and matching dispatch", () => {
  const evidence = evaluate(chain());
  assert.equal(evidence.ok, true, evidence.diagnostics.join("; "));
  assert.equal(evidence.counts.ptyBytesWritten, 23);
  assert.equal(evidence.counts.ptyEnterSent, 1);
  assert.deepEqual(evidence.identity, { sessionID, messageID, runID });
});

test("rejects missing intercept, admission, or dispatch independently", () => {
  const events = chain();
  for (const [name, candidate] of [
    ["intercept", events.slice(1)],
    ["admitted", events.filter((event) => event.type !== "admitted")],
    ["dispatch", events.filter((event) => event.type !== "rpc-dispatched")],
  ]) {
    const evidence = evaluate(candidate);
    assert.equal(evidence.ok, false, `${name} absence must fail closed`);
  }
});

test("rejects duplicate intercept, admission, or dispatch instead of taking the first match", () => {
  const events = chain();
  for (const [name, candidate] of [
    ["intercept", [events[0], { ...events[0] }, events[1], events[2]]],
    ["admitted", [events[0], events[1], { ...events[1] }, events[2]]],
    ["dispatch", [events[0], events[1], events[2], { ...events[2] }]],
  ]) {
    const evidence = evaluate(candidate);
    assert.equal(evidence.ok, false, `${name} duplication must fail closed`);
  }
});

test("rejects session, run, message, event-order, and TUI-session mismatches", () => {
  const events = chain();
  const variants = [
    ["admitted session", [events[0], { ...events[1], sessionID: "ses_other" }, events[2]]],
    ["dispatch run", [events[0], events[1], { ...events[2], runID: "run_other" }]],
    ["message-derived run", [events[0], { ...events[1], messageID: "msg_other" }, events[2]]],
    ["event order", [events[0], events[2], events[1]]],
  ];
  for (const [name, candidate] of variants) assert.equal(evaluate(candidate).ok, false, `${name} mismatch`);
  assert.equal(evaluate(events, { expectedSessionID: "ses_wrong" }).ok, false, "wrong TUI session");
});

test("rejects evidence before the pre-spawn baseline and invalid baseline offsets", () => {
  const events = chain();
  assert.equal(evaluate(events, { baselineIndex: 1 }).ok, false, "capturing baseline after intercept loses proof");
  assert.equal(evaluate(events, { baselineIndex: events.length + 1 }).ok, false, "baseline past EOF is invalid");
});

test("rejects PTY write/Enter gaps, nonzero exit, signal, and bounded timeout evidence", () => {
  const events = chain();
  assert.equal(evaluate(events, { driverOutput: "" }).ok, false, "missing PTY trace");
  assert.equal(evaluate(events, { driverExitCode: 1 }).ok, false, "child failure");
  assert.equal(evaluate(events, { driverExitCode: null, driverSignal: "SIGTERM" }).ok, false, "signal termination");
  assert.equal(evaluate([], { driverExitCode: 1, driverOutput }).ok, false, "gateway confirmation timeout");
  assert.equal(evaluate(events, { driverOutput: JSON.stringify({ source: "opjev-e2e-tui", event: "pty-write", step: 0, bytesRequested: 23, bytesWritten: 2 }) }).ok, false, "partial PTY write");
});

test("unready fake TUI that exits before submit cannot pass on PTY writes alone", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "opjev-tui-not-ready-test-"));
  let fakePid;
  try {
    const { pidFile, specPath } = writeFakeDriverSpec(temp, {
      childSource: "process.exit(0);",
      steps: [{ type: "enter before composer readiness", enter: true }],
      bootMs: 250,
    });
    const result = spawnSync("python3", [driver, specPath], { encoding: "utf8", timeout: 10000 });
    fakePid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0, "dead/unready PTY child is not a submitted prompt");
    assert.equal(evaluate([], { driverExitCode: result.status, driverOutput: result.stdout }).ok, false);
    assert.equal(isAlive(fakePid), false, "early-exiting child was reaped");
  } finally {
    if (Number.isInteger(fakePid) && fakePid > 1 && isAlive(fakePid)) {
      try { process.kill(fakePid, "SIGTERM"); } catch { /* already reaped */ }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("missing gateway acknowledgement reaches a bounded nonzero driver timeout", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "opjev-tui-ack-timeout-test-"));
  let fakePid;
  try {
    const { pidFile, specPath } = writeFakeDriverSpec(temp, {
      childSource: 'process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {}); setInterval(() => {}, 1000);',
      steps: [
        { type: "synthetic prompt with no gateway", enter: true, after_enter_ms: 10 },
        { wait_log: { file: path.join(temp, "gateway.jsonl"), regex: "rpc-dispatched", baseline: 0, min_extra: 1, timeout_ms: 100 } },
      ],
    });
    const startedAt = Date.now();
    const result = spawnSync("python3", [driver, specPath], { encoding: "utf8", timeout: 10000 });
    const elapsedMs = Date.now() - startedAt;
    fakePid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0, "no acknowledgement within deadline must fail");
    assert.ok(elapsedMs < 5000, `gateway timeout cleanup must remain bounded, elapsed ${elapsedMs}ms`);
    assert.match(result.stderr, /wait_log .*nao alcancou/u);
    assert.equal(evaluate([], { driverExitCode: result.status, driverOutput: result.stdout }).ok, false);
    assert.equal(isAlive(fakePid), false, "timeout cleanup reaped the child");
  } finally {
    if (Number.isInteger(fakePid) && fakePid > 1 && isAlive(fakePid)) {
      try { process.kill(fakePid, "SIGKILL"); } catch { /* fixture child already exited */ }
      await waitUntil(() => !isAlive(fakePid), 1500);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("driver cleans its PTY child when parent terminates it during a bounded wait", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "opjev-tui-termination-test-"));
  let driverChild;
  let fakePid;
  try {
    const { pidFile, specPath } = writeFakeDriverSpec(temp, {
      childSource: "setInterval(() => {}, 1000);",
      steps: [{ type: "termination test bytes", enter: true }, { sleep_ms: 10000 }],
      bootMs: 100,
    });
    driverChild = spawn("python3", [driver, specPath], { stdio: "ignore" });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(fs.existsSync(pidFile), "fake child started");
    fakePid = Number(fs.readFileSync(pidFile, "utf8"));
    driverChild.kill("SIGTERM");
    const exit = await waitForExitWithin(driverChild, 5000);
    assert.ok(exit, "driver exits within its parent-cancellation deadline");
    assert.equal(exit.code, 130, "driver handles parent termination after cleaning its child");
    assert.equal(isAlive(fakePid), false, "PTY child is reaped and does not outlive failed E2E");
  } finally {
    if (driverChild && driverChild.exitCode === null && driverChild.signalCode === null) {
      driverChild.kill("SIGKILL");
      await waitForExitWithin(driverChild, 1000);
    }
    if (Number.isInteger(fakePid) && fakePid > 1 && isAlive(fakePid)) {
      try { process.kill(fakePid, "SIGKILL"); } catch { /* fixture child already exited */ }
      await waitUntil(() => !isAlive(fakePid), 1500);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

for (const signalName of ["SIGTERM", "SIGINT"]) {
  test(`driver reaps a silent PTY child that ignores SIGTERM after parent ${signalName}`, async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "opjev-tui-resistant-child-test-"));
    let driverChild;
    let fakePid;
    let repeatSignalTimer;
    try {
      const { pidFile, specPath } = writeFakeDriverSpec(temp, {
        childSource: 'process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {}); setInterval(() => {}, 1000);',
        steps: [{ type: "resistant child test bytes", enter: true }, { sleep_ms: 10000 }],
        bootMs: 100,
      });
      driverChild = spawn("python3", [driver, specPath], { stdio: "ignore" });
      assert.equal(await waitUntil(() => fs.existsSync(pidFile), 5000), true, "silent fake TUI child started");
      fakePid = Number(fs.readFileSync(pidFile, "utf8"));
      driverChild.kill(signalName);
      repeatSignalTimer = setTimeout(() => {
        if (driverChild.exitCode === null && driverChild.signalCode === null) driverChild.kill(signalName);
      }, 100);

      const exit = await waitForExitWithin(driverChild, 2500);
      clearTimeout(repeatSignalTimer);
      assert.ok(exit, `driver must finish bounded cleanup after ${signalName}`);
      assert.equal(exit.code, 130, `driver should report cancellation after ${signalName}`);
      assert.equal(isAlive(fakePid), false, "resistant PTY child must be killed and reaped by the driver");
    } finally {
      clearTimeout(repeatSignalTimer);
      if (driverChild && driverChild.exitCode === null && driverChild.signalCode === null) {
        driverChild.kill("SIGKILL");
        await waitForExitWithin(driverChild, 1000);
      }
      if (Number.isInteger(fakePid) && fakePid > 1 && isAlive(fakePid)) {
        try { process.kill(fakePid, "SIGKILL"); } catch { /* fixture child already exited */ }
        await waitUntil(() => !isAlive(fakePid), 1500);
      }
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}
