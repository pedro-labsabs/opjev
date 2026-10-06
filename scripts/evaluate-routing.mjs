#!/usr/bin/env node
/** Deterministic offline routing evaluation. All Jev traffic is intercepted locally. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const fixturePath = new URL('../docs/routing-evaluation-fixtures.json', import.meta.url);
const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
const routerUrl = pathToFileURL(new URL('../src/router.ts', import.meta.url).pathname);
const { decideRoute, heuristicRoute } = await import(routerUrl.href);

function choice(choice, confidence = 0.95) {
  return { type: 'choice', choice, confidence, probabilities: { [choice]: 1 } };
}
function response(testCase) {
  // The offline model stand-in derives its answer from prompt text using the
  // router's deterministic prompt classifier, never fixture IDs/expectations.
  const inferred = heuristicRoute(testCase.input.prompt);
  const { route, agent } = inferred;
  const model = testCase.input.freeCandidates[0];
  return {
    model: 'offline-fixture-stub',
    answers: {
      route: choice(route, testCase.input.stubConfidence ?? 0.95),
      agent: choice(agent), model: choice(model),
      is_risky: { type: 'noul', noul: 0 },
      complexity: { type: 'score', score: 0, confidence: 0.95, probabilities: {}, legend: {} },
    },
  };
}

const originalFetch = globalThis.fetch;
const results = [];
try {
  for (const testCase of fixtures.cases) {
    globalThis.fetch = async () => {
      if (testCase.input.failure === 'network') throw new Error('simulated network failure');
      if (testCase.input.failure === 'timeout') throw new Error('jev systemone: timeout simulated offline');
      if (testCase.input.failure === 'invalid-response') return new Response('{"unexpected":true}', { status: 200 });
      return new Response(JSON.stringify(response(testCase)), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    // Measure only the routing decision, excluding fixture setup and reporting.
    const startedAt = performance.now();
    const result = await decideRoute({
      prompt: testCase.input.prompt,
      validAgents: testCase.input.validAgents ?? [],
      freeCandidates: testCase.input.freeCandidates ?? [],
      route: 'unknown', jevModel: 'offline-stub', jevEndpoint: 'http://offline.invalid',
      apiKey: undefined, confidenceThreshold: 0.55,
    });
    const elapsedMs = performance.now() - startedAt;
    const expected = testCase.expected;
    const actual = { route: result.route, agent: result.agent, via: result.via };
    if (expected.model !== undefined) actual.model = result.model;
    if (expected.overridden !== undefined) actual.overridden = Boolean(result.overridden);
    if (expected.fallbackReason !== undefined) actual.fallbackReason = result.error;
    const fields = ['route', 'agent', 'model', 'via', 'overridden', 'fallbackReason'].filter((field) => expected[field] !== undefined);
    const mismatches = fields.filter((field) => actual[field] !== expected[field]);
    results.push({ id: testCase.id, expected, actual, correct: mismatches.length === 0, mismatches, elapsedMs });
  }
} finally { globalThis.fetch = originalFetch; }

const correct = results.filter((item) => item.correct).length;
const fallbackResults = results.filter((item) => item.expected.via === 'heuristic');
const elapsedValues = results.map((item) => item.elapsedMs);
const elapsedTotalMs = elapsedValues.reduce((sum, value) => sum + value, 0);
console.log(JSON.stringify({
  version: 1,
  summary: { total: results.length, correct, accuracy: results.length ? correct / results.length : 1,
    timing: { method: 'performance.now()', informational: true, totalMs: elapsedTotalMs,
      meanMs: results.length ? elapsedTotalMs / results.length : 0,
      minMs: results.length ? Math.min(...elapsedValues) : 0,
      maxMs: results.length ? Math.max(...elapsedValues) : 0 },
    fallback: { total: fallbackResults.length, correct: fallbackResults.filter((item) => item.correct).length } },
  cases: results,
}, null, 2));
if (correct !== results.length) process.exitCode = 1;
