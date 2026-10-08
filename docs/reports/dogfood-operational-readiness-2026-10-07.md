# OPJEV dogfood operational readiness — 2026-10-07

**Historical status on 2026-10-07: BLOCKED.** The isolated OpenCode environment started with OPJEV and authenticated live Jev selection, but an ordinary TUI task did not complete through the control plane. The timeout, audit-classification, and terminal-notice failures described below were repaired and reverified on 2026-10-08; see the dated update appended below.

## Scope and preserved state

- Repository baseline: `origin/main` at `6b16a37ad01def861e28644b77a23732de05ecc9`.
- Work branch: `fix/issue-5-dogfood-operational-setup`.
- The global OpenCode command, desktop installation, plugins, configs, sessions and credentials were not replaced. The pre-existing `.auto-claude/` worktree data was preserved.
- A dedicated wrapper `~/.local/bin/opjev` uses `scripts/opjev.mjs`; no daemon or system service is installed. Its private profile is `~/.local/share/opjev-dogfood/profile`. The launcher uses an isolated config/database and dynamically allocated loopback ports, starts the matching server and TUI, verifies `/api/info` and OPJEV Admission RPC before launch, and refuses a second active launcher.
- The helper refuses symlinked destination parents, preflights every plugin entry before copying, and preserves existing `node_modules`; the launcher fails closed on stale locks and on shutdown during port reservation instead of risking an unowned child process.
- OpenCode 2.0.11 came from the official `@opencode/cli-linux-x64@2.0.11` package. Stable executable SHA-256: `0ed7d8546cf24acc41e6371ec30928ed931ec1474e1a54bbecdde8e0dd801d2f`. Launcher preflight verifies CLI and server versions are exactly 2.0.11. Existing PATH OpenCode is 2.0.18 and the desktop installation is 2.0.22; both remain untouched. The former `/tmp` test binary is byte-identical to the installed executable. The same direct-binary E2E now reports server `/api/info` 2.0.11 and passes, so the selected runtime is verified; the historical 2.0.18 response cannot be causally attributed because its report did not preserve the old listener PID/command or port. The dedicated launcher avoids ambiguous global resolution and fails closed on a version mismatch.
- The isolated environment loads OPJEV server/TUI plugins, sets gateway mode to `orchestrate`, keeps automatic secondary routing disabled, and keeps Context Management and Model Intelligence in OBSERVE. The global provider key is read from the pre-existing protected environment source; no secret was copied, printed, or committed.
- Launcher preflight authenticated against the configured Zen/SystemOne Jev endpoint. All four inspected canonical runs record `selection.via=jev`; none records heuristic selection. This proves live executor selection, not successful completion of the Jev final-verdict path.

## Operational smoke

The smoke used the same `opjev` launcher and ordinary TUI input, not an internal orchestration tool. The work was explicitly synthetic and is not natural dogfood.

Sanitized state after four canonical test runs:

- Ledger: `resource/usage-ledger/v1`, schema 1, bounded capacity 2,048; 21 observations persisted and readable after the launcher stopped.
- Runs: 0 completed, 3 failed, 1 left running by an early-terminating harness; all four recorded live Jev selection. No round-limit violation was recorded (`maxRounds=3`).
- One controlled task created a canonical EvidencePacket and critic check, but the run failed before a verdict; no outcome was linked to its run/round/evidence. The read-only audit reports `pre-worker-failures=0`, `missing-link=3`, `orphaned-run-links=0`, `invalid-run-records=0`, and no round-limit violations; it exits nonzero because three failed terminal runs lack a complete evidence/verdict/outcome join. The TUI did not present a completed result, and the isolated fixture remained unchanged. The audit was rerun against the exact OpenCode 2.0.11 plugin namespace (`jev-free-router`) and read the real ledger; exit 1 reflects the missing links, not a storage lookup failure.
- Other test attempts included provider failures and two persisted worker-timeout failures. No recovery was observed. Runtime token records were present but totals were zero. The ledger had no acceptance or failure-class outcome observations for these runs.
- No prompt, output, run/session identifier, credential, or raw storage record is included here. Synthetic session data remains in the isolated profile for diagnosis and was not counted as dogfood.
- Restart check: after the smoke launcher stopped, `opjev --continue` opened the pinned 2.0.11 TUI with OPJEV and authenticated Jev preflight, then exited cleanly without submitting a prompt. Gateway counters remained zero; post-close `opjev status` was stopped and the same 21/2,048 ledger observations remained readable. This verifies launcher/session-database reopen and ledger persistence, not successful resumption of task output.

### Reproduced blocker

In `src/orchestration/dispatcher.ts`, `withTimeout` awaits `onTimeout` before rejecting; the worker callback in `src/plugin-runtime.ts` awaits `ctx.session.interrupt()`. In two ordinary TUI runs, the worker wait and interrupt did not settle while the TUI remained active for the full 360-second harness limit. Launcher shutdown finally persisted the worker-timeout failure. The existing real multiround E2E's controlled timeout scenario passes, but does not reproduce these ordinary TUI stalls. A separate TUI run reached EvidencePacket/critic generation but persisted no verdict or linked outcome. The operational timeout and outcome-linkage failures remain unproven safe for daily use.

**Required next change:** a narrowly scoped dispatcher correction that persists/rejects the timeout independently of a potentially non-settling interrupt and treats interruption as best-effort, with a regression test for a never-settling interrupt; then repair or diagnose why the failed-evidence path does not persist a verdict/outcome join. This changes dispatcher behavior, so it was not implemented under the task's explicit architecture boundary. Re-run the same-command TUI smoke and audit only after an authorized fix; do not count these synthetic attempts as natural dogfood.

## Launcher and audit use

- Start: `opjev`
- Status: `opjev status`
- Sanitized read-only ledger/run audit: `opjev audit` (currently exits nonzero on missing linkage)
- Stop: close the TUI normally; the launcher stops its own gateway/server and releases its lock. Do not kill global OpenCode processes.
- Reopen with `opjev`; the isolated profile preserves settings, sessions and ledger. Global `opencode` remains available but bypasses OPJEV and is not instrumented.
- Restore: rename only `~/.local/bin/opjev` to `~/.local/bin/opjev.disabled`; retain the isolated profile until its sessions/evidence are no longer needed. See `docs/dogfood-quickstart.md`.

The audit exposes bounded aggregate counts only. The ledger is the single factual shared store; it overwrites oldest observations at capacity and has no independent counter for observations lost before append or evicted under pressure. Missing run/outcome linkage is an audit failure, not a value to infer.

## Automated gates

| Command | Result |
|---|---|
| Controlled launcher interrupt during port reservation and admission-RPC preflight | **PASS** — SIGTERM through `opjev` returned sanitized `BLOCKED`; during the RPC delay no gateway was spawned, and no managed child or active lock remained. No prompt/run was created. |
| `npm ci` | **PASS** — 287 locked packages installed; only deprecation warnings. |
| `npm run typecheck` | **PASS** — `tsc --noEmit`, no diagnostics. |
| `npm test` | **PASS** — 774 tests, 104 suites; 0 failures, including audit multi-round/session joins, launcher safety, and non-destructive installer regressions. |
| `npm run evaluate:routing` | **PASS** — 11/11 correct; fallback 4/4. |
| `npm run e2e:matrix` | **PASS** — 17/17 controlled multi-round scenarios. |
| `OPENCODE_BIN=/home/pedro/.local/share/opjev-dogfood/runtime/opencode-2.0.11 npm run e2e:gateway` | **PASS** — 60/60; server API reports 2.0.11; real TUI client path exercises single intercept/admission/dispatch, `parent=0`, summary RPC and visible publication in the isolated E2E. Synthetic boundary, not the operational dogfood smoke. |
| `OPENCODE_BIN=/home/pedro/.local/share/opjev-dogfood/runtime/opencode-2.0.11 npm run e2e:multiround-real` | **PASS** — 18/18 on OpenCode 2.0.11; live Jev SystemOne scenario passed, remaining boundaries include controlled fault injection. |
| `OPENCODE_BIN=/home/pedro/.local/share/opjev-dogfood/runtime/opencode-2.0.11 npm run e2e:context` | **PASS** — controlled-provider Context Management E2E on OpenCode 2.0.11; 2 turns, plugin loaded, safety gates passed. |
| `git diff --check` | **PASS** — no whitespace errors. |

These gates proved the tested boundaries only and did not supersede the failed same-command operational TUI smoke at the time. The failed attempts remain in the isolated ledger and are not natural dogfood.

## Verification on 2026-10-08

**Status: PASS PARA REVISÃO DO MANTENEDOR (not READY FOR DOGFOOD).** Timeout/fencing and audit regressions pass. On this source HEAD, typecheck, 800 tests, routing, matrix, gateway (60/60), real multi-round (18/18), Context E2E (2 turns/4 requests), and `git diff --check` pass. A controlled ordinary-TUI accepted run remains linked and persisted; later tasks produced a malformed live Jev verdict (kernel failed closed) and one stopped pre-verdict run. These failures remain visible; no natural dogfood has been collected. This is not maintainer approval.

### Root causes and corrections

- **Timeout and session authority:** the dispatcher waited for the timeout callback, which awaited the OpenCode interrupt RPC without an independent bound. An unresolved interrupt therefore defeated the worker/critic/orchestrator deadline. The timeout path now separately bounds interrupt confirmation and reports interruption only when the host explicitly confirms it. Review also found a tool authorization already awaiting session metadata could resume after fencing, and a host-reused fenced session ID could be accepted; authority now rechecks the fence after lookup and refuses fenced-ID reuse before dispatch. Registry saturation blocks new/ambiguous internal authorization while unambiguously external TUI sessions remain usable. Unconfirmed sessions cannot be reused. No retry, extra dispatch, or outcome is fabricated.
- **Audit:** the previous summary treated every failed post-worker run without evidence, verdict, and outcome as a missing-link defect. Canonical checkpoints and persisted run/round facts now distinguish governed pre-evidence failures, post-evidence/pre-verdict failures, pending runs, ambiguous interruption, inconsistent evidence, and actual missing links. Malformed worker round facts still fail audit even alongside a valid operational failure. Before a verdict, outcome may be absent, but one round/request pair must link by session, round, agent, and route; scheduled model facts must agree. Multi-round history compares runtime-observed executor identity with observed outcome while round/request facts remain internally linked. OpenCode's observed model may differ from the scheduled model and remains recorded separately in the EvidencePacket. A further review-found false positive is fixed: a prior-round session ID is not proof a worker started in a failed new round; current-round facts/evidence control that classification.
- Current-round governed failure observations establish worker start for a reused `repair-same` session only when the session matches the canonical persisted worker session and expected agent/model. Empty, missing, or mismatched persisted/observed session identity is an evidence inconsistency, not a governed pre-evidence failure; a prior-round session ID alone never proves a new-round worker started.
- **TUI completion:** terminal notices could be marked delivered while the parent session was still busy, so the toast could be lost. The TUI now retries until the parent session is idle and only then marks the notice seen. A post-fix ordinary TUI smoke visibly displayed the completed outcome and bounded result.

RED-to-GREEN evidence: never-resolving worker/critic/orchestrator interrupts first exceeded the nominal timeout, then returned bounded and fenced without later dispatch/judgment/outcome. Review regressions reproduced authorization completing after a fence, reuse of a fenced session ID, external tools denied at internal-registry saturation, malformed facts hidden by pre-evidence classification, missing current round/request linkage after evidence, false historical mismatch on multi-round model substitution, prior-round identity misclassified as a new worker, a current-round reused-session provider failure misclassified as pre-worker, an unlinked current-round failure session accepted, a failure observation self-authorizing without persisted worker identity, and an empty session identity counted as valid; each passed after correction.

### Controlled ordinary-TUI smoke

The ordinary `opjev` launcher, pinned OpenCode 2.0.11 CLI/server, isolated server/TUI plugin, gateway `orchestrate`, and live authenticated Jev SystemOne were exercised with unique, read-only synthetic prompts. The earlier accepted smoke remains evidence of a completed path, but newer attempts expose an unresolved live-judge reliability issue.

- The earlier successful TUI smoke showed a completed accepted result; its canonical EvidencePacket, critic result, Jev verdict, round, and accepted outcome were linked. Closing and reopening preserved the TUI transcript and ledger. Its sanitized gateway counts were one intercept, one admission, one dispatch, and zero duplicate/fail-closed requests.
- A later TUI task reached worker success and critic/evidence but the live Jev returned contradictory fields: `done=true` with a non-`none` failure class. The strict validator rejected it; no verdict, acceptance, or outcome was fabricated.
- A subsequent unique read-only TUI task produced no visible progress before it was stopped. The launcher closed its own processes; audit classifies the persisted run as post-evidence/pre-verdict, not accepted or pending.
- The latest read-only audit reports 49/2,048 observations and 9 canonical runs: 3 completed/accepted, 5 failed, 1 pending; all 9 show live Jev selection and 0 heuristic selections. It reports 6 EvidencePackets and critic checks, 3 verdicts, 3 linked accepted outcomes, 0 missing links, 0 orphan links, 0 invalid records, 0 evidence inconsistencies, and 0 round/limit violations. Failure categories include 2 governed pre-evidence and 3 post-evidence/pre-verdict failures. No recovery was observed.
- The three accepted outcomes are controlled synthetic runs. The two latest attempts are also synthetic; none is natural dogfood. Historic failed and pending records remain in the isolated profile. No prompt/output content, secrets, or run/session IDs are included.
- After both new attempts, `opjev status` reported stopped and the sanitized audit remained readable. The accepted earlier result and ledger persistence after restart remain proven; the latest attempts themselves did not produce acceptance.

**Residual reliability risk:** one live Jev judgment returned contradictory fields (`done=true` with a non-`none` failure class). The strict validator rejected it; the kernel fabricated no verdict or acceptance. Automatic repair, retry, or derivation remains prohibited. The evidence proves a valid accepted path exists, while this malformed judgment remains for maintainer review.

The final ordinary TUI attempts therefore do not supersede the earlier successful synthetic evidence, but they prevent declaring the live path reliable. They are not natural dogfood.

The late audit regression also verifies multi-round history against the runtime-observed executor while separately requiring scheduled `round` and `request` model facts to agree. This avoids false missing links when OpenCode substitutes the observed model.

### Gates on the corrected HEAD

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm test` | **PASS** — 800 tests, 104 suites; 0 failures |
| `npm run evaluate:routing` | **PASS** — 11/11, fallback 4/4 |
| `npm run e2e:matrix` | **PASS** — 17 scenarios |
| `OPENCODE_BIN=/home/pedro/.local/share/opjev-dogfood/runtime/opencode-2.0.11 npm run e2e:gateway` | **PASS** — 60/60; all follow-up-consumption assertions passed on rerun |
| `OPENCODE_BIN=/home/pedro/.local/share/opjev-dogfood/runtime/opencode-2.0.11 npm run e2e:multiround-real` | **PASS** — 18/18; live Jev/SystemOne case and controlled timeout boundaries |
| `OPENCODE_BIN=/home/pedro/.local/share/opjev-dogfood/runtime/opencode-2.0.11 npm run e2e:context` | **PASS** — OpenCode 2.0.11; 2 turns, 4 requests |
| `git diff --check` | **PASS** |

The first gateway E2E attempt was 57/60: the two follow-up records remained unconsumed and the worker input lacked the follow-up. Read-only inspection of that isolated run showed `failed`, round 1, no critic/evidence/verdict/history, and a worker `operational-failure` 120,018 ms after its request; persisted and observed worker session/agent/model identities matched. This matches the fixture's configured 120,000 ms worker deadline. The model-side reason is not present in the sanitized ledger. The run ended before it could reach the next worker prompt, so that attempt did not prove a follow-up-delivery defect. A rerun on this HEAD passed 60/60, including all 13 follow-up assertions, durable consumption, and exactly-once delivery to the real OpenCode 2.0.11 worker input. Rerun summary: `/tmp/opjev-e2e/runs/2026-10-08T16-50-24-811Z/e2e-result.json`.

These automated gates are distinct from the controlled ordinary-TUI smoke and from future natural dogfood. The stable executable is `/home/pedro/.local/share/opjev-dogfood/runtime/opencode-2.0.11`, SHA-256 `0ed7d8546cf24acc41e6371ec30928ed931ec1474e1a54bbecdde8e0dd801d2f`; the global OpenCode 2.0.18 installation remains untouched.

### Remaining limitations

- The ledger is bounded at 2,048 observations; eviction and observations lost before append cannot be independently counted.
- One historic pending run remains unresolved and visible. Audit does not convert it into a terminal result.
- The internal-session fence registry is capped at 4,096. If it fills with non-reusable fenced sessions, execution fails closed until runtime restart; no unsafe fence eviction is attempted.
- The three accepted runs are controlled synthetic checks. Later controlled TUI attempts include one rejected contradictory live Jev verdict and one run stopped before verdict; historic failed and pending records remain. No natural dogfood has started. The malformed live-judge response is a reliability risk for maintainer review, not evidence of an accepted outcome.
