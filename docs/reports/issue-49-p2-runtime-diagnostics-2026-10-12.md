# Issue #49 P2 runtime diagnostics — 2026-10-12

## Scope and disposition

Base HEAD was `a1b0a082a9d649f59be0a3204fe9fdd4d5e591fd` on `fix/issue-49-real-tui-dogfood`; it is the baseline, not the complete verification input. The live task and pre-commit checks ran against a modified working tree based on that HEAD. Relevant code deltas were `scripts/e2e-context-contract.mjs`, `src/e2e-context-contract.test.mjs`, `scripts/e2e-context-management.mjs`, and `scripts/e2e-multiround-real.mjs`; the first context E2E observation predates the final reviewer-added call/terminal tool-name equality. Post-commit gates will exercise the committed source. Runtime was pinned OpenCode v2.0.11 (`0ed7d8546cf24acc41e6371ec30928ed931ec1474e1a54bbecdde8e0dd801d2f`), Node v22.23.2.

The P2 failed-phase regression is fixed and its guard passes. The required P2 lower-bound signal remains **FAILED**: the completed context E2E observed two paired tool-level groups but zero context-level paired groups. The strict context assertion was retained; the weaker tool metric was not substituted. Real dogfood acceptance is **BLOCKED**: one governed task reached worker and critic, but both rounds failed on generic provider errors and Jev returned valid `fresh-same`/environment decisions, not acceptance. No third round or second task was attempted.

Sanitized machine-readable evidence: [`artifacts/issue-49-p2-runtime-diagnostics-2026-10-12.json`](artifacts/issue-49-p2-runtime-diagnostics-2026-10-12.json). It contains identifiers and enum/timing evidence only; no provider credentials, prompt dumps, raw PTY, database, or session-message bodies.

## A. P2 guards and context E2E

Added the shared deterministic phase and pairing assertions in `scripts/e2e-context-contract.mjs`, four focused tests in `src/e2e-context-contract.test.mjs`, and integrated them into `scripts/e2e-context-management.mjs`. The phase guard requires `completed`; the pairing guard preserves both the lower bound (`>= 2`) and upper bound (`<= groups × requests`).

- RED: `node --test src/e2e-context-contract.test.mjs` exited 1 against the previously permissive behavior: three expected regressions failed; the upper-bound test passed.
- GREEN: same command exited 0, 4/4 tests passed.
- Mutation checks: making phase validation permissive exited 1 on the failed-phase regression; removing the pairing lower bound exited 1 on both 0/1-pair regressions. Phase and upper-bound checks still passed in the pairing mutation.
- Valid-input smoke: `completed` and 2/8 pairs accepted; 9/8 rejected.

The first strengthened E2E execution exited 1 at a mistaken runtime-history representation assumption. On the pinned host, persisted runtime tool parts are `type=tool` with `id`, `name`, and `state.status`, not `tool-call`/`tool-result` session-message rows; the E2E was corrected to assert the observed host representation. The next `npm run e2e:context` completed its governed run and all run/selection/evidence/verdict/history/critic/tool identity joins, then exited 1 at the strict context pairing guard:

```text
context.pairedGroups=0
context tool-call parts=0
context terminal parts=0
tool.pairedGroups=2
observed groups=2; requests=4
```

Shell result and read failure terminals were both present in the joined worker tool groups. The absence of context-level pairs is real observed output; its cause is not established. Do not infer a specific hook or event cause from this mismatch. P2-A is fixed; P2-B is not satisfied. No production projection code was changed.

## B. Isolated live task and persisted critic evidence

The exact runtime binary was copied into a mode-700 disposable home/profile; the run used an empty mode-700 project and inherited the API credential only through the child environment. No task files were pre-created. The single user task was:

> Create `add.mjs` exporting `add(a, b) { return a + b; }` and `add.test.mjs` using `node:test`. Verify `add(2, 3) === 5` and `add(-2, 2) === 0` with `node --test add.test.mjs`. Change no other files. Report the test result. Do not approve your own work.

The launcher/TUI driver exited 0, and its single Jev authentication preflight succeeded. Jev selected `build` / `opencode/ling-3.0-flash-fin-free`. One orchestration run used that same model for both worker rounds and both critic rounds. The first valid Jev answer requested `fresh-same` within `maxRounds=3`; this explains the second worker round and is not a hidden retry or duplicate run. Both workers and both critic checks failed. The final run state was `run-failed`, phase `failed`, round 2; no verdict was applied. The two valid Jev answers classified `environment`, with `doneNoul=0.03`, `nextAction=fresh-same`, and repair likelihoods 0.49 then 0.13. They do not represent acceptance.

A read-only profile audit found one canonical run, one outcome (acceptance false, environment), one evidence packet, one failed critic check, one recovery, four requests, four generic `provider-error` observations, zero operational failures, zero applied verdicts, and no missing run/evidence links, round-limit violations, or evidence inconsistencies. Provider observations expose only `failureDomain=provider` / `errorCode=provider-error`; role and status code are absent. The exact provider/auth/quota/runtime cause is **UNATTRIBUTED**. The separate `node --test add.test.mjs` command exited 1 because `add.test.mjs` did not exist; this confirms the task was not completed, not that a submitted implementation failed its tests.

Critic timing was durable for both rounds. Round 1: created 6 ms, prompt-sent 12 ms, wait-settled 326 ms, session-read 332 ms; derived intervals 6/314/6 ms. Round 2: created 8 ms, prompt-sent 19 ms, wait-settled 601 ms, session-read 607 ms; derived intervals 11/582/6 ms. These are orchestration-boundary intervals, **not** pure provider RPC latency. First-stream/first-token timing is **UNOBSERVABLE**. Four token-usage observations exist, while audit token totals are zero; this does not establish zero provider cost.

The launcher did not capture initial shutdown gateway counters, so those counters are **UNOBSERVABLE**. Canonical profile state independently shows one session binding and one orchestration record; both rounds are linked to the valid recovery. No duplicate run was found.

## C. Reopen, UI state, and unresolved ownership/model-switch reports

Reopened the same parent session once without submitting another prompt. The driver exited 0. Its session snapshot showed `status=idle`, inbox API available with zero pending items, and a summary for the same failed run; the failure summary rendered and refreshed four times. The trace records idle status/render and a failed-run summary. The accumulated PTY dump contains `Orchestration` / `Failed` and ten Braille glyphs corresponding to the candidate spinner frame set in its final 64 KiB. The driver does not timestamp PTY chunks or reconstruct a time-correlated final screen, so whether those glyphs persisted after the idle snapshot is **UNPROVEN**; the renderer component is **UNATTRIBUTED**.

Persistent state still held the original user steer and one synthetic steer record; the harness issued no acknowledgement or cancellation. The parent still had zero assistant messages. Reopen gateway counters were all zero (intercept, admission, dispatch, duplicate suppression, fail-closed); the database remained at one run and 26 observations. The trace proves a failure summary was shown; reopening did not create a new run or wake/dispatch the parent. Spinner persistence after idle is unproven. No inbox cancellation, deletion, synthetic assistant response, or parent-wake behavior was added.

The historical model-switch report remains **UNATTRIBUTED**. The named historical trace was unavailable; current attempt selection and both rounds used one model. Available evidence does not correlate a switch to an emitter, Jev/kernel decision, provider request/session message, or host hook event.

Input ownership/acknowledgement semantics remain **NEEDS_APPROVAL**. A future change would need an explicit persist-first, idempotent terminal acknowledgement with crash/concurrency behavior and no implicit parent wake/dispatch. This run does not authorize changing inbox semantics.

## D. Artifact path, preservation, and final disposition

`scripts/e2e-multiround-real.mjs` now writes its evidence below its unique `RUN_DIR` rather than the tracked `docs/reports/artifacts/issue-14-real-e2e-evidence.json` path. The final multiround gate is run once on the committed HEAD; its recorded exit and generated destination are reported with the final gate results. The issue-14 artifact hashes before this work were `a82199530994f0d4a1caae88fc9d15054196dfdd086c66da382f9c0ccce30f7c` in this worktree and `48f32df780b2d7d6cb5f7958a59ca24107389455338decc42e889199d1ea97b9` in the original checkout. The final gate checks verify preservation.

At report creation, post-commit final gates have not yet run. Final gate commands and exit codes, final source SHA, and artifact destination are recorded in the PR update after those checks. No live task retry is planned: the single task reached critic and failed, so a second task attempt would exceed the approved diagnostic scope. Dogfood remains blocked; P2-B remains failed/open; PR #50 stays Draft and issue #49 stays open.
