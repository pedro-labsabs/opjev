const REQUIRED_SCENARIO_COUNT = 17;
const DIAGNOSTIC_LIMIT = 12;
const DIAGNOSTIC_LENGTH_LIMIT = 240;

export const REQUIRED_SCENARIO_IDS = Object.freeze(
  Array.from({ length: REQUIRED_SCENARIO_COUNT }, (_, index) => index + 1),
);

const SUMMARY_FIELDS = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];

function truncateDiagnostic(message) {
  const text = String(message);
  return text.length > DIAGNOSTIC_LENGTH_LIMIT
    ? `${text.slice(0, DIAGNOSTIC_LENGTH_LIMIT - 1)}…`
    : text;
}

function boundedDiagnostics(diagnostics) {
  const visible = diagnostics.slice(0, DIAGNOSTIC_LIMIT).map(truncateDiagnostic);
  if (diagnostics.length > DIAGNOSTIC_LIMIT) {
    visible.push(`… ${diagnostics.length - DIAGNOSTIC_LIMIT} additional gate diagnostic(s) omitted`);
  }
  return visible;
}

function parseScenarioTitle(title) {
  const match = /^Cenário ([1-9]\d*): (.+)$/u.exec(title);
  return match ? { id: Number(match[1]), title } : null;
}

/**
 * Accept only the Node --test TAP shape emitted by the required 17-case suite.
 * The process result is part of the evidence, not a substitute for TAP parsing.
 */
export function evaluateMatrixEvidence(evidence, expectedScenarioIds = REQUIRED_SCENARIO_IDS) {
  const diagnostics = [];
  const addDiagnostic = (message) => {
    if (diagnostics.length < 100) diagnostics.push(String(message));
  };

  const expectedIds = Array.isArray(expectedScenarioIds) ? expectedScenarioIds : [];
  const expectedIdsAreCanonical =
    expectedIds.length === REQUIRED_SCENARIO_COUNT &&
    expectedIds.every((id, index) => id === REQUIRED_SCENARIO_IDS[index]);
  if (!expectedIdsAreCanonical) {
    addDiagnostic(`scenario definition must contain exactly IDs 1..${REQUIRED_SCENARIO_COUNT}`);
  }

  const stdout = typeof evidence?.stdout === "string" ? evidence.stdout : "";
  const stderr = typeof evidence?.stderr === "string" ? evidence.stderr : "";
  if (evidence?.stdoutTruncated) addDiagnostic("child stdout exceeded the capture limit; TAP evidence is truncated");
  if (evidence?.stderrTruncated) addDiagnostic("child stderr exceeded the capture limit");
  if (stderr.trim()) addDiagnostic(`child stderr was not empty: ${stderr.trim().slice(0, 400)}`);
  if (evidence?.spawnError) {
    const message = evidence.spawnError?.message ?? String(evidence.spawnError);
    addDiagnostic(`child process failed to start: ${message}`);
  }
  if (evidence?.signal !== null && evidence?.signal !== undefined) {
    addDiagnostic(`child process terminated by signal ${evidence.signal}`);
  }
  if (evidence?.code !== 0) {
    addDiagnostic(`child process exit code was ${String(evidence?.code)}, expected 0`);
  }

  const lines = stdout.split(/\r?\n/u);
  const versionLines = [];
  const rootDeclarations = [];
  const scenarioDeclarations = [];
  const records = [];
  const plans = [];
  const summaryOccurrences = new Map(SUMMARY_FIELDS.map((field) => [field, []]));
  const durationLines = [];

  for (const [lineIndex, line] of lines.entries()) {
    if (line === "" && lineIndex === lines.length - 1) continue;

    if (/^TAP version\b/u.test(line)) versionLines.push({ line, lineIndex });

    const rootSubtest = /^# Subtest: (.+)$/u.exec(line);
    if (rootSubtest) rootDeclarations.push(rootSubtest[1]);

    const scenarioSubtest = /^    # Subtest: (.+)$/u.exec(line);
    if (scenarioSubtest) scenarioDeclarations.push(scenarioSubtest[1]);

    const plan = /^(    )?1\.\.(0|[1-9]\d*)$/u.exec(line);
    if (plan) plans.push({ indent: plan[1] ?? "", count: Number(plan[2]), lineIndex });

    const summary = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (0|[1-9]\d*)$/u.exec(line);
    if (summary) summaryOccurrences.get(summary[1]).push(Number(summary[2]));

    const duration = /^# duration_ms (\d+(?:\.\d+)?)$/u.exec(line);
    if (duration) durationLines.push(Number(duration[1]));

    const record = /^(\s*)(not ok|ok) ([1-9]\d*) - (.+)$/u.exec(line);
    if (record) {
      records.push({
        indent: record[1],
        status: record[2],
        number: Number(record[3]),
        title: record[4],
        lineIndex,
      });
    } else if (/^\s*(?:not )?ok(?:\s|$)/u.test(line)) {
      addDiagnostic(`malformed TAP test record on line ${lineIndex + 1}`);
    }

    if (/^Bail out!/u.test(line)) addDiagnostic(`TAP bailout on line ${lineIndex + 1}`);

    const isKnownTAPLine =
      line === "TAP version 13" ||
      Boolean(rootSubtest) ||
      Boolean(scenarioSubtest) ||
      Boolean(plan) ||
      Boolean(summary) ||
      Boolean(duration) ||
      Boolean(record) ||
      /^Bail out!/u.test(line) ||
      /^(?:  |      )(?:---|\.\.\.|duration_ms: \d+(?:\.\d+)?|type: '(?:suite|test)')$/u.test(line);
    if (line !== "" && !isKnownTAPLine) {
      addDiagnostic(`unexpected non-TAP output on line ${lineIndex + 1}: ${line.slice(0, 160)}`);
    }
  }

  if (versionLines.length !== 1 || versionLines[0]?.lineIndex !== 0 || versionLines[0]?.line !== "TAP version 13") {
    addDiagnostic("expected exactly one TAP version 13 header at the start of stdout");
  }
  if (rootDeclarations.length !== 1) {
    addDiagnostic(`expected one root suite declaration, found ${rootDeclarations.length}`);
  }
  if (scenarioDeclarations.length !== REQUIRED_SCENARIO_COUNT) {
    addDiagnostic(`expected ${REQUIRED_SCENARIO_COUNT} scenario declarations, found ${scenarioDeclarations.length}`);
  }

  const rootPlans = plans.filter((plan) => plan.indent === "");
  const scenarioPlans = plans.filter((plan) => plan.indent === "    ");
  if (rootPlans.length !== 1 || rootPlans[0]?.count !== 1) {
    addDiagnostic("expected one root TAP plan of 1..1");
  }
  if (scenarioPlans.length !== 1 || scenarioPlans[0]?.count !== REQUIRED_SCENARIO_COUNT) {
    addDiagnostic(`expected one nested TAP plan of 1..${REQUIRED_SCENARIO_COUNT}`);
  }

  const rootRecords = records.filter((record) => record.indent === "");
  const scenarioRecords = records.filter((record) => record.indent === "    ");
  const unexpectedlyIndentedRecords = records.filter(
    (record) => record.indent !== "" && record.indent !== "    ",
  );
  if (records.length !== REQUIRED_SCENARIO_COUNT + 1) {
    addDiagnostic(`expected ${REQUIRED_SCENARIO_COUNT + 1} TAP result records including the root suite, found ${records.length}`);
  }
  if (rootRecords.length !== 1 || rootRecords[0]?.number !== 1 || rootRecords[0]?.status !== "ok") {
    addDiagnostic("expected exactly one passing root suite result: ok 1");
  }
  if (rootDeclarations.length === 1 && rootRecords.length === 1 && rootRecords[0].title !== rootDeclarations[0]) {
    addDiagnostic("root suite declaration and result names disagree");
  }
  if (scenarioRecords.length !== REQUIRED_SCENARIO_COUNT) {
    addDiagnostic(`expected ${REQUIRED_SCENARIO_COUNT} direct scenario result records, found ${scenarioRecords.length}`);
  }
  if (scenarioRecords.some((record, index) => record.number !== REQUIRED_SCENARIO_IDS[index])) {
    addDiagnostic("scenario TAP result numbering is not exactly 1..17 in order");
  }
  const declaredScenarioIds = scenarioDeclarations.map((title) => parseScenarioTitle(title)?.id ?? null);
  if (declaredScenarioIds.some((id, index) => id !== REQUIRED_SCENARIO_IDS[index])) {
    addDiagnostic("scenario declarations are not exactly IDs 1..17 in order");
  }
  if (unexpectedlyIndentedRecords.length) {
    addDiagnostic(`found ${unexpectedlyIndentedRecords.length} result record(s) at an unexpected TAP nesting level`);
  }

  const scenarioRows = expectedIds.map((id) => {
    const declared = scenarioDeclarations
      .map((title) => parseScenarioTitle(title))
      .filter((parsed) => parsed?.id === id);
    const matchingNumberRecords = scenarioRecords.filter((record) => record.number === id);
    const recordTitle = matchingNumberRecords.length === 1
      ? parseScenarioTitle(matchingNumberRecords[0].title)
      : null;
    const uniqueDeclaration = declared.length === 1 ? declared[0] : null;
    const isPass =
      matchingNumberRecords.length === 1 &&
      matchingNumberRecords[0].status === "ok" &&
      recordTitle?.id === id &&
      uniqueDeclaration?.id === id &&
      recordTitle.title === uniqueDeclaration.title &&
      !/\s+#\s*(?:SKIP|TODO)\b/iu.test(matchingNumberRecords[0].title);

    if (declared.length === 0) addDiagnostic(`scenario ${id} declaration is missing`);
    if (declared.length > 1) addDiagnostic(`scenario ${id} declaration is duplicated (${declared.length} occurrences)`);
    if (matchingNumberRecords.length === 0) addDiagnostic(`scenario ${id} result is missing`);
    if (matchingNumberRecords.length > 1) addDiagnostic(`scenario ${id} result is duplicated (${matchingNumberRecords.length} occurrences)`);
    if (matchingNumberRecords.some((record) => record.status !== "ok")) {
      addDiagnostic(`scenario ${id} has a not ok TAP result`);
    }
    if (matchingNumberRecords.length === 1 && recordTitle?.id !== id) {
      addDiagnostic(`scenario ${id} result has an invalid or contradictory identity`);
    }
    if (recordTitle && uniqueDeclaration && recordTitle.title !== uniqueDeclaration.title) {
      addDiagnostic(`scenario ${id} declaration and result names disagree`);
    }
    if (matchingNumberRecords.some((record) => /\s+#\s*(?:SKIP|TODO)\b/iu.test(record.title))) {
      addDiagnostic(`scenario ${id} is marked SKIP or TODO`);
    }

    return { id, status: isPass ? "PASS" : "FAIL" };
  });

  const summary = {};
  for (const field of SUMMARY_FIELDS) {
    const occurrences = summaryOccurrences.get(field);
    if (occurrences.length !== 1) {
      addDiagnostic(`expected exactly one Node TAP summary field '# ${field}', found ${occurrences.length}`);
      continue;
    }
    summary[field] = occurrences[0];
  }
  if (durationLines.length !== 1) {
    addDiagnostic(`expected one Node TAP duration summary, found ${durationLines.length}`);
  }

  if (summary.tests !== REQUIRED_SCENARIO_COUNT) {
    addDiagnostic(`Node TAP summary reports ${String(summary.tests)} tests, expected ${REQUIRED_SCENARIO_COUNT}`);
  }
  if (summary.suites !== 1) addDiagnostic(`Node TAP summary reports ${String(summary.suites)} suites, expected 1`);
  if (summary.pass !== REQUIRED_SCENARIO_COUNT) {
    addDiagnostic(`Node TAP summary reports ${String(summary.pass)} passes, expected ${REQUIRED_SCENARIO_COUNT}`);
  }
  for (const field of ["fail", "cancelled", "skipped", "todo"]) {
    if (summary[field] !== 0) addDiagnostic(`Node TAP summary reports ${String(summary[field])} ${field}, expected 0`);
  }
  if (SUMMARY_FIELDS.every((field) => Number.isInteger(summary[field]))) {
    const accountedFor = summary.pass + summary.fail + summary.cancelled + summary.skipped + summary.todo;
    if (accountedFor !== summary.tests) {
      addDiagnostic(`Node TAP summary counts contradict: tests=${summary.tests}, outcomes=${accountedFor}`);
    }
  }

  const passedCount = scenarioRows.filter((row) => row.status === "PASS").length;
  return {
    ok: diagnostics.length === 0 && passedCount === REQUIRED_SCENARIO_COUNT,
    expectedCount: REQUIRED_SCENARIO_COUNT,
    passedCount,
    failedCount: REQUIRED_SCENARIO_COUNT - passedCount,
    rows: scenarioRows,
    summary,
    diagnostics: boundedDiagnostics(diagnostics),
  };
}
