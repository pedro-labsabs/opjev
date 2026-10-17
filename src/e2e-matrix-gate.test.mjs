import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMatrixEvidence,
  REQUIRED_SCENARIO_IDS,
} from "../scripts/e2e-matrix-gate.mjs";

const names = new Map(REQUIRED_SCENARIO_IDS.map((id) => [id, `Cenário ${id}: synthetic case ${id}`]));

function makeNodeTap({
  records = REQUIRED_SCENARIO_IDS.map((id) => ({ id, number: id, status: "ok", title: names.get(id) })),
  declarations = records.map((record) => record.title),
  rootStatus = "ok",
  nestedPlan = 17,
  rootPlan = 1,
  summary = {},
  extraLines = [],
} = {}) {
  const passCount = records.filter((record) => record.status === "ok").length;
  const failCount = records.filter((record) => record.status === "not ok").length;
  const defaults = {
    tests: records.length,
    suites: 1,
    pass: passCount,
    fail: failCount,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    ...summary,
  };
  const output = ["TAP version 13", "# Subtest: synthetic Issue #53 suite", ...extraLines];

  records.forEach((record, index) => {
    const declaration = declarations[index] ?? record.title;
    output.push(`    # Subtest: ${declaration}`);
    output.push(`    ${record.status} ${record.number} - ${record.title}`);
    output.push("      ---", "      duration_ms: 1", "      type: 'test'", "      ...");
  });

  output.push(`    1..${nestedPlan}`);
  output.push(`${rootStatus} 1 - synthetic Issue #53 suite`);
  output.push("  ---", "  duration_ms: 2", "  type: 'suite'", "  ...");
  output.push(`1..${rootPlan}`);
  for (const [field, value] of Object.entries(defaults)) output.push(`# ${field} ${value}`);
  output.push("# duration_ms 3");
  return `${output.join("\n")}\n`;
}

function evaluate(overrides = {}) {
  return evaluateMatrixEvidence({ stdout: makeNodeTap(), stderr: "", code: 0, signal: null, ...overrides });
}

test("accepts exact Node --test TAP evidence for all 17 required scenarios", () => {
  const result = evaluate();
  assert.equal(result.ok, true, result.diagnostics.join("\n"));
  assert.equal(result.passedCount, 17);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(result.rows.map((row) => row.status), Array(17).fill("PASS"));
});

test("rejects exit 0 with only 16 of the 17 required scenarios", () => {
  const records = REQUIRED_SCENARIO_IDS.slice(0, 16).map((id) => ({
    id,
    number: id,
    status: "ok",
    title: names.get(id),
  }));
  const result = evaluate({ stdout: makeNodeTap({ records, nestedPlan: 16 }) });
  assert.equal(result.ok, false);
  assert.equal(result.passedCount, 16);
  assert.equal(result.rows[16].status, "FAIL");
  assert.match(result.diagnostics.join("\n"), /scenario 17 result is missing/u);
});

test("rejects exit 0 with no recognizable scenario records", () => {
  const result = evaluate({ stdout: makeNodeTap({ records: [], nestedPlan: 0 }) });
  assert.equal(result.ok, false);
  assert.equal(result.passedCount, 0);
  assert.ok(result.rows.every((row) => row.status === "FAIL"));
});

test("rejects a duplicate scenario 1 and missing scenario 17", () => {
  const records = REQUIRED_SCENARIO_IDS.slice(0, 16).map((id) => ({
    id,
    number: id,
    status: "ok",
    title: names.get(id),
  }));
  records.push({ id: 1, number: 1, status: "ok", title: "Cenário 1: duplicate case" });
  const result = evaluate({ stdout: makeNodeTap({ records }) });
  assert.equal(result.ok, false);
  assert.equal(result.rows[0].status, "FAIL");
  assert.equal(result.rows[16].status, "FAIL");
  assert.match(result.diagnostics.join("\n"), /scenario 1 result is duplicated/u);
});

test("treats a not ok scenario record as FAIL, never as a substring PASS", () => {
  const records = REQUIRED_SCENARIO_IDS.map((id) => ({
    id,
    number: id,
    status: id === 1 ? "not ok" : "ok",
    title: names.get(id),
  }));
  const result = evaluate({ stdout: makeNodeTap({ records, rootStatus: "not ok" }) });
  assert.equal(result.rows[0].status, "FAIL");
  assert.equal(result.passedCount, 16);
  assert.equal(result.ok, false);
});

test("rejects positive TAP records when the child exits nonzero", () => {
  const result = evaluate({ code: 7 });
  assert.equal(result.passedCount, 17);
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join("\n"), /exit code was 7/u);
});

test("rejects positive TAP records when the child is terminated by signal", () => {
  const result = evaluate({ code: null, signal: "SIGTERM" });
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join("\n"), /signal SIGTERM/u);
});

test("rejects a child-process startup error", () => {
  const result = evaluate({ code: null, spawnError: new Error("spawn node ENOENT") });
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join("\n"), /failed to start: spawn node ENOENT/u);
});

test("does not accept diagnostic text containing positive-looking scenario markers", () => {
  const result = evaluate({
    stdout: makeNodeTap({
      records: [],
      nestedPlan: 0,
      extraLines: ["# diagnostic text: ok 1 - Cenário 1: not a test record"],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.passedCount, 0);
});

test("rejects unexpected stdout diagnostics even beside complete TAP records", () => {
  const result = evaluate({ stdout: `${makeNodeTap()}diagnostic: TAP was altered\n` });
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join("\n"), /unexpected non-TAP output/u);
});

test("rejects noncanonical zero-padded scenario numbering", () => {
  const stdout = makeNodeTap().replace("    ok 1 - Cenário 1:", "    ok 01 - Cenário 1:");
  const result = evaluate({ stdout });
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join("\n"), /unexpected non-TAP output/u);
});

test("rejects contradictory Node TAP global summary counts", () => {
  const result = evaluate({ stdout: makeNodeTap({ summary: { pass: 16 } }) });
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join("\n"), /reports 16 passes/u);
});

test("rejects truncated or stderr-contaminated process evidence", () => {
  const truncated = evaluate({ stdoutTruncated: true });
  const stderr = evaluate({ stderr: "warning: unexpected child output" });
  assert.equal(truncated.ok, false);
  assert.equal(stderr.ok, false);
});

test("bounds returned diagnostics for malformed evidence", () => {
  const result = evaluate({ stdout: "" });
  assert.ok(result.diagnostics.length <= 13);
  assert.ok(result.diagnostics.at(-1).length <= 240);
});
