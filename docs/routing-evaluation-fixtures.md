# Routing evaluation fixture contract

Evaluation fixtures are versioned JSON data, not executable tests or live provider transcripts. The contract is defined by [`routing-evaluation-fixture.schema.json`](./routing-evaluation-fixture.schema.json) (JSON Schema 2020-12, version 1).

The representative lane and boundary cases live in [`routing-evaluation-fixtures.json`](./routing-evaluation-fixtures.json). A fixture document has a `version` and a non-empty `cases` list. Each case has a stable kebab-case `id`, a `category` (`lane`, `boundary`, or `fallback`), controlled `input`, and `expected` selection. `input.prompt` is the only required runtime input; optional `validAgents` and `freeCandidates` represent deterministic runtime catalogs. Optional `failure` instructs an offline harness to simulate a transport/timeout/invalid-answer condition; it must never trigger a real request. Expected results record the route (the router's task lane), agent, selection source (`jev` or `heuristic`), and optionally model, override state, and fallback reason.

For successful Jev-path test cases, the harness supplies a deterministic stub response; fixture data must not contain API keys, endpoint secrets, or provider credentials. For fallback cases, the harness forces the named failure and asserts the heuristic outcome. An omitted model expectation means model selection is not part of that case's assertion. Case IDs should remain stable across edits so result reports can be compared; change an expectation only when the routing contract intentionally changes.

## Verification and limitations

Run `npm run evaluate:routing` to execute the deterministic evaluation without provider credentials or network access. At verification time it reported 8/8 cases correct (including 3/3 fallback cases); elapsed-time measurements use `performance.now()` and are informational, not a performance threshold.

Run `npm test` for the repository test suite. In this checkout, 651 of 652 tests passed; the unrelated `SCHEMA1` test requires `node_modules/@opencode/plugin/package.json`, which was absent. Install the project's dependencies before treating that full-suite failure as a product regression.

## Running the evaluation

From the repository root, run:

```sh
npm run evaluate:routing
```

This invokes `scripts/evaluate-routing.mjs` against the checked-in fixtures. For successful-path cases, the locally stubbed Jev answer is derived from prompt text by the router deterministic classifier (not fixture IDs or expected selections); fallback cases simulate failures. This evaluates deterministic prompt-to-route behavior and downstream validation, not live Jev/model quality. It does not require provider credentials or make network requests. The command prints a versioned JSON report to stdout containing per-case expected/actual selections, correctness, aggregate accuracy and fallback counts, and timing statistics. A mismatch exits with a non-zero status; elapsed times measured with `performance.now()` are informational rather than pass/fail thresholds, so reports can be captured and compared across changes without flaky latency gates.

## Fixture intent and expected outcomes

The current set is organized to make regressions diagnosable:

- `lane-*` cases represent the supported fast-coding, heavy-reasoning, and research/docs lanes. They establish the expected route and agent for a clear example of each lane, and pin the selected model where catalog candidates are provided.
- `boundary-*` cases exercise routing decisions near meaningful thresholds: routine work should remain fast, while an ambiguous low-confidence answer should activate the heavy-reasoning guardrail. The `overridden` expectation distinguishes the guardrail result from an ordinary classification.
- `fallback-*` cases cover network, timeout, and invalid-response failures. Each names a simulated failure and asserts that the local heuristic selects the expected route/agent and reports the corresponding `fallbackReason`.

The expected route is the task lane, not the agent name. `via` distinguishes Jev selection from heuristic fallback; `model` is asserted only when the fixture supplies a controlled candidate catalog and explicitly expects one. Descriptions explain the behavior each prompt is intended to probe; keep prompts focused so a changed result points to a routing change rather than multiple unrelated signals.

## Extending and maintaining the task set

When adding a lane, add at least one clear `lane` example and specify expected route and agent. Add separate `boundary` examples for important decision thresholds or guardrails, and `fallback` examples for failure modes the router handles. When a model catalog or candidate ranking changes, update controlled `freeCandidates` and model expectations only if the new catalog is intentional; avoid changing lane/agent expectations merely to accommodate a model rename. Review the routing implementation and supported-agent constraints before editing expectations, and run the evaluation after changes. Give each new case a unique, stable ID, explain its purpose in `description`, and ensure fixture JSON still conforms to the schema. Do not use live provider responses to generate expected values: the fixture is a reviewed routing contract, not a transcript. Remove obsolete cases only when the behavior they protect is no longer supported, and note intentional expectation changes in the change review.
