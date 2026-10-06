import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FREE_POOL } from './config.ts';
import {
  getFailureModesFromSchema,
  getImplementedFailureModes,
  validateFixtureDocument,
} from '../scripts/routing-evaluation-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesPath = path.join(root, 'docs/routing-evaluation-fixtures.json');
const commandPath = path.join(root, 'scripts/evaluate-routing.mjs');

function evaluate() {
  const run = spawnSync(process.execPath, [commandPath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 15_000,
  });
  assert.equal(run.status, 0, `evaluation failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

test('routing evaluation loads every documented fixture and emits a result for each', async () => {
  const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'));
  const report = evaluate();
  assert.ok(Array.isArray(fixtures.cases));
  assert.ok(fixtures.cases.length > 0);
  assert.deepEqual(report.cases.map(({ id }) => id), fixtures.cases.map(({ id }) => id));
  assert.equal(report.summary.total, fixtures.cases.length);
});

test('routing evaluation compares selections and reports fallback correctness', () => {
  const report = evaluate();
  assert.equal(report.summary.correct, report.summary.total);
  assert.equal(report.summary.accuracy, 1);
  for (const item of report.cases) {
    assert.equal(typeof item.correct, 'boolean');
    assert.deepEqual(item.mismatches, []);
    assert.equal(item.actual.route, item.expected.route);
    assert.equal(item.actual.agent, item.expected.agent);
    assert.equal(Object.hasOwn(item, 'input'), false, 'reports omit fixture prompts and catalogs');
  }
  const fallbackCases = report.cases.filter(({ expected }) => expected.via === 'heuristic');
  assert.ok(fallbackCases.length > 0, 'fixtures should exercise heuristic fallback');
  assert.equal(report.summary.fallback.total, fallbackCases.length);
  assert.equal(report.summary.fallback.correct, fallbackCases.filter(({ correct }) => correct).length);
  assert.ok(fallbackCases.every(({ actual }) => actual.via === 'heuristic'));
});

test('routing evaluation reports finite informational per-case and aggregate timings', () => {
  const report = evaluate();
  const timing = report.summary.timing;
  assert.equal(timing.method, 'performance.now()');
  assert.equal(timing.informational, true);
  assert.ok(Number.isFinite(timing.totalMs) && timing.totalMs >= 0);
  assert.ok(Number.isFinite(timing.meanMs) && timing.meanMs >= 0);
  assert.ok(Number.isFinite(timing.minMs) && timing.minMs >= 0);
  assert.ok(Number.isFinite(timing.maxMs) && timing.maxMs >= timing.minMs);
  assert.ok(report.cases.every(({ elapsedMs }) => Number.isFinite(elapsedMs) && elapsedMs >= 0));
});

test('committed routing fixtures satisfy the committed JSON Schema', async () => {
  const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'));
  assert.deepEqual(validateFixtureDocument(fixtures), []);
});

test('fixture schema rejects unknown input fields, out-of-range confidence, invalid enums, and incomplete cases', async () => {
  const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'));
  const invalidDocuments = [
    (copy) => { copy.cases[0].input.unknownInput = true; },
    (copy) => { copy.cases[0].input.stubConfidence = 1.01; },
    (copy) => { copy.cases[0].category = 'other'; },
    (copy) => { copy.cases[0].input.failure = 'unimplemented'; },
    (copy) => { delete copy.cases[0].expected.route; },
  ];
  for (const mutate of invalidDocuments) {
    const copy = structuredClone(fixtures);
    mutate(copy);
    assert.notDeepEqual(validateFixtureDocument(copy), [], 'invalid fixture document must be rejected');
  }
});

test('invalid fixture input exits non-zero before emitting a routing report', async () => {
  const baseline = JSON.parse(await readFile(fixturesPath, 'utf8'));
  const invalidDocuments = [
    (copy) => { copy.cases[0].input.unrecognized = 'drift'; },
    (copy) => { copy.cases[0].input.stubConfidence = -0.01; },
    (copy) => { copy.cases[0].category = 'unknown-category'; },
    (copy) => { copy.cases[0].input.failure = 'unknown-failure'; },
    (copy) => { delete copy.cases[0].expected.route; },
  ];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'routing-fixture-invalid-'));
  try {
    for (let index = 0; index < invalidDocuments.length; index += 1) {
      const fixtures = structuredClone(baseline);
      invalidDocuments[index](fixtures);
      const invalidPath = path.join(directory, `fixtures-${index}.json`);
      await writeFile(invalidPath, JSON.stringify(fixtures));
      const run = spawnSync(process.execPath, [commandPath, '--fixtures', invalidPath], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env },
        timeout: 15_000,
      });
      assert.notEqual(run.status, 0);
      assert.equal(run.stdout, '', 'schema rejection must happen before any report is written');
      assert.match(run.stderr, /routing fixture schema validation failed/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('schema failure modes and evaluator simulation modes have exact parity', () => {
  assert.deepEqual(getFailureModesFromSchema(), getImplementedFailureModes());
});

test('invalid route, agent, and model fixtures exercise decideRoute guardrails', async () => {
  const report = evaluate();
  const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'));
  const fixtureById = new Map(fixtures.cases.map((item) => [item.id, item]));
  const byId = new Map(report.cases.map((item) => [item.id, item]));

  const invalidRoute = byId.get('fallback-invalid-route');
  assert.ok(invalidRoute);
  assert.equal(invalidRoute.actual.via, 'heuristic');
  assert.equal(invalidRoute.actual.fallbackReason, 'jev systemone: resposta choice invalida para route');

  const invalidAgent = byId.get('guardrail-invalid-agent');
  assert.ok(invalidAgent);
  assert.equal(invalidAgent.actual.agent, 'build');
  assert.equal(invalidAgent.actual.via, 'jev');
  assert.equal(invalidAgent.actual.overridden, true);
  assert.equal(invalidAgent.actual.attemptedAgent, 'unlisted-agent');
  const validAgents = fixtureById.get('guardrail-invalid-agent').input.validAgents;
  assert.ok(validAgents.includes(invalidAgent.actual.agent));
  assert.ok(!validAgents.includes(invalidAgent.actual.attemptedAgent));

  const invalidModel = byId.get('guardrail-invalid-model');
  assert.ok(invalidModel);
  assert.equal(invalidModel.actual.model, 'opencode/nemotron-3.5-lightning-free');
  assert.equal(invalidModel.actual.via, 'jev');
  assert.equal(invalidModel.actual.overridden, true);
  assert.ok(FREE_POOL.includes(invalidModel.actual.model));
  assert.equal(JSON.stringify(report).includes('paid/arbitrary-model'), false, 'reports omit the rejected stub answer');
});
