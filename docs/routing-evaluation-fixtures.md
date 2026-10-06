# Routing evaluation fixture contract

Evaluation fixtures are versioned JSON data, not executable tests or live provider transcripts. The contract is defined by [`routing-evaluation-fixture.schema.json`](./routing-evaluation-fixture.schema.json) (JSON Schema 2020-12, version 1).

The representative lane and boundary cases live in [`routing-evaluation-fixtures.json`](./routing-evaluation-fixtures.json). A fixture document has a `version` and between 1 and 100 cases. Each case has a stable kebab-case `id`, a `category` (`lane`, `boundary`, or `fallback`), controlled `input`, and `expected` selection. `input.prompt` is the only required runtime input (up to 4,000 characters); optional `validAgents` and `freeCandidates` represent deterministic runtime catalogs. Optional `stubConfidence` is constrained to 0–1 and controls the confidence answer in the offline stub. Optional `failure` selects a registered offline simulation; it never triggers a real request. Expected results record the route (the router's task lane), agent, selection source (`jev` or `heuristic`), and optionally model, override state, fallback reason, and rejected `attemptedAgent` for audit.

`npm run evaluate:routing` validates the actual fixture document against the committed JSON Schema with Ajv 8's Draft 2020-12 implementation before it imports `decideRoute` or emits a report. A schema error exits non-zero and writes diagnostics to stderr without writing a routing report to stdout. `node scripts/evaluate-routing.mjs --fixtures <path>` runs the same gate against another JSON document for validation checks. The startup parity gate also compares the schema's `failure` enum to the harness's registered simulation handlers, so a mode cannot be accepted by one and omitted by the other.

For successful Jev-path test cases, the harness supplies a deterministic stub response; fixture data must not contain API keys, endpoint secrets, or provider credentials. For fallback cases, the harness forces the named failure and asserts the heuristic outcome. An omitted model expectation means model selection is not part of that case's assertion. Case IDs should remain stable across edits so result reports can be compared; change an expectation only when the routing contract intentionally changes.

## Verification and limitations

Run `npm run evaluate:routing` to execute the deterministic evaluation without provider credentials or network access. Elapsed-time measurements use `performance.now()` and are informational, not a performance threshold. The report omits fixture inputs and raw Jev response bodies.

Run `node --test src/routing-evaluation.test.mjs` for the focused suite. It validates the committed document and rejects unknown input fields, out-of-range confidence, invalid category/failure values, and incomplete cases. It also checks schema/evaluator parity and verifies invalid route, agent, and model behavior through the real `decideRoute` implementation.

## Running the evaluation

From the repository root, run:

```sh
npm run evaluate:routing
```

This invokes `scripts/evaluate-routing.mjs` against the checked-in fixtures. For successful-path cases, the locally stubbed Jev answer is derived from prompt text by the router deterministic classifier (not fixture IDs or expected selections); named failure modes mutate or reject that stub response locally. This evaluates deterministic prompt-to-route behavior and downstream guardrails, not live Jev/model quality. It does not require provider credentials or make provider/network requests. The command prints a versioned JSON report to stdout containing per-case expected/actual selections, correctness, aggregate accuracy and fallback counts, and timing statistics. A mismatch exits with a non-zero status; elapsed times measured with `performance.now()` are informational rather than pass/fail thresholds, so reports can be captured and compared across changes without flaky latency gates.

## Fixture intent and expected outcomes

The current set is organized to make regressions diagnosable:

- `lane-*` cases represent the supported fast-coding, heavy-reasoning, and research/docs lanes. They establish the expected route and agent for a clear example of each lane, and pin the selected model where catalog candidates are provided.
- `boundary-*` cases exercise routing decisions near meaningful thresholds: routine work should remain fast, while an ambiguous low-confidence answer should activate the heavy-reasoning guardrail. The `overridden` expectation distinguishes the guardrail result from an ordinary classification.
- `fallback-*` cases cover network, timeout, invalid response, and invalid route. Invalid routes are rejected by `decideRoute`, which uses its local heuristic and reports the corresponding reason.
- `guardrail-*` cases cover invalid agents and models. An invalid agent is replaced by the lane default while remaining auditable as `attemptedAgent`; an invalid model is replaced by the lane fallback from the `FREE_POOL`. These decisions keep `via: "jev"` because the valid route still came from the stub.

The expected route is the task lane, not the agent name. `via` distinguishes Jev selection from heuristic fallback; `model` is asserted only when the fixture supplies a controlled candidate catalog and explicitly expects one. Descriptions explain the behavior each prompt is intended to probe; keep prompts focused so a changed result points to a routing change rather than multiple unrelated signals. Fixtures and the bounded report contain no API keys, provider transcripts, or raw response bodies. The evaluator is evidence tooling only: it does not change production routing, routing authority, budgets, providers, or execution policy, and it does not promote an operating mode.

## Extending and maintaining the task set

When adding a lane, add at least one clear `lane` example and specify expected route and agent. Add separate `boundary` examples for important decision thresholds or guardrails, and `fallback` examples for failure modes the router handles. When a model catalog or candidate ranking changes, update controlled `freeCandidates` and model expectations only if the new catalog is intentional; avoid changing lane/agent expectations merely to accommodate a model rename. Review the routing implementation and supported-agent constraints before editing expectations, and run the evaluation after changes. Give each new case a unique, stable ID, explain its purpose in `description`, and ensure fixture JSON still conforms to the schema. Do not use live provider responses to generate expected values: the fixture is a reviewed routing contract, not a transcript. Remove obsolete cases only when the behavior they protect is no longer supported, and note intentional expectation changes in the change review.
