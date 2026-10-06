import Ajv2020 from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';

const schemaUrl = new URL('../docs/routing-evaluation-fixture.schema.json', import.meta.url);
const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
const validator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// The harness itself is the single implementation registry for fixture
// failures. The startup parity check below keeps this in lockstep with schema.
export const FAILURE_MODE_HANDLERS = Object.freeze({
  network: async () => { throw new Error('simulated network failure'); },
  timeout: async () => { throw new Error('jev systemone: timeout simulated offline'); },
  'invalid-response': async () => new Response('{"unexpected":true}', { status: 200 }),
  'invalid-route': async (body) => {
    body.answers.route.choice = 'invented-lane';
    return jsonResponse(body);
  },
  'invalid-agent': async (body) => {
    body.answers.agent.choice = 'unlisted-agent';
    return jsonResponse(body);
  },
  'invalid-model': async (body) => {
    body.answers.model.choice = 'paid/arbitrary-model';
    return jsonResponse(body);
  },
});

export function getFailureModesFromSchema() {
  return [...schema.$defs.case.properties.input.properties.failure.enum].sort();
}

export function getImplementedFailureModes() {
  return Object.keys(FAILURE_MODE_HANDLERS).sort();
}

export function assertFailureModeParity() {
  const declared = getFailureModesFromSchema();
  const implemented = getImplementedFailureModes();
  if (JSON.stringify(declared) !== JSON.stringify(implemented)) {
    throw new Error(`routing fixture failure mode mismatch: schema=${declared.join(',')} evaluator=${implemented.join(',')}`);
  }
}

export function validateFixtureDocument(document) {
  validator(document);
  return (validator.errors ?? []).map(({ instancePath, keyword, message, params }) => ({
    instancePath,
    keyword,
    message,
    params,
  }));
}

export async function readAndValidateFixtureDocument(path) {
  const document = JSON.parse(await readFile(path, 'utf8'));
  const errors = validateFixtureDocument(document);
  if (errors.length > 0) {
    throw new Error(`routing fixture schema validation failed: ${JSON.stringify(errors)}`);
  }
  return document;
}

export { jsonResponse };
