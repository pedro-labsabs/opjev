import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
