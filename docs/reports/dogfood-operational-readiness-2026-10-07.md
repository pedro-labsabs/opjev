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

**Status: PASS PARA REVISÃO DO MANTENEDOR.** This records a controlled operational acceptance smoke, not a maintainer decision that natural dogfood is ready.

### Root causes and corrections

- **Timeout:** the dispatcher waited for the timeout callback, which awaited the OpenCode interrupt RPC without an independent bound. An unresolved interrupt therefore defeated the worker/critic/orchestrator deadline. The timeout path now separately bounds interrupt confirmation, reports an interruption only when the host explicitly confirms it, and permanently fences the internal session before requesting interruption. Unconfirmed sessions cannot be reused; the runtime fails closed if its bounded fence registry fills. No retry, extra dispatch, or outcome is fabricated.
- **Audit:** the previous summary treated every failed post-worker run without evidence, verdict, and outcome as a missing-link defect. Canonical checkpoints and persisted run/round facts now distinguish governed pre-evidence failures, post-evidence/pre-verdict failures, pending runs, ambiguous interruption, inconsistent evidence, and actual missing links. Only supported persisted facts count; missing links, orphan records, malformed facts, and round violations remain visible failures.
- **TUI completion:** terminal notices could be marked delivered while the parent session was still busy, so the toast could be lost. The TUI now retries until the parent session is idle and only then marks the notice seen. A post-fix ordinary TUI smoke visibly displayed the completed outcome and bounded result.

The timeout regressions demonstrated RED before the fix (never-resolving interrupt kept the operation pending beyond the nominal deadline) and GREEN after it (bounded unconfirmed interruption; no later dispatch/judgment/outcome). Audit category regressions likewise failed before classification and passed after. The final full gates below ran after the TUI fix.

### Controlled ordinary-TUI smoke

The second acceptance attempt used the exact `opjev` launcher from the repository directory, ordinary TUI prompt entry, pinned OpenCode CLI/server 2.0.11, isolated OPJEV server/TUI profile, gateway `orchestrate`, and live authenticated Jev SystemOne. It was a unique read-only task and is **synthetic smoke**, not natural dogfood.

- The launcher preflight confirmed CLI/server 2.0.11 and Jev live authentication. The TUI displayed the task as progressing on round 1 of 3, then visibly displayed **Orchestration · Completed**, the selected route/model, completed outcome, and the bounded result.
- On clean close, sanitized gateway counters were `orchestrate-intercept=1`, `admission=1`, `dispatch=1`, `duplicate-suppressed=0`, `fail-closed=0`.
- The read-only audit then showed 6 canonical runs inspected: 2 completed and accepted, 3 governed failures, and 1 still pending from earlier attempts; live Jev selection on all 6, heuristic selection 0. It showed 3 evidence packets, 3 critic checks (2 pass, 1 fail), 2 verdicts, 2 linked run/evidence/verdict/outcome joins, 2 accepted outcomes, and no missing links, orphaned links, malformed records, evidence inconsistencies, ambiguous interruptions, round violations, or round-limit violations. Historic failed/pending data was retained.
- The same audit reported 33 of 2,048 bounded observations, including 6 round facts, 9 request facts, and 2 outcome facts; recovery count was 0. It contained no prompt/output text or run/session IDs. The controlled accepted run was linked to its canonical evidence, critic pass, Jev verdict, round, and accepted outcome; the TUI completion notice exposed only the bounded result.
- After closing and reopening with `opjev --continue`, the prior task result remained visible in the TUI and the read-only audit returned the same 33-observation count, 2 linked verdict/outcome joins, and 2 accepted outcomes. The reopen had zero new interception/admission/dispatch; it did not rerun the task. The launcher then stopped cleanly.
- No recovery was induced. The other three failed records remain classified as two governed pre-evidence failures and one post-evidence/pre-verdict failure. The one older pending run remains separately visible; it is not reported as completed or as dogfood.

The earlier operational attempt that completed in storage but failed to show its TUI terminal notice remains in the same profile. It is not counted as a successful TUI presentation. No ledger, session, or run was deleted to obtain these counts.

### Gates on the corrected HEAD

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm test` | **PASS** — 788 tests, 104 suites; 0 failures |
| `npm run evaluate:routing` | **PASS** — 11/11, fallback 4/4 |
| `npm run e2e:matrix` | **PASS** — 17 scenarios |
| `OPENCODE_BIN=/home/pedro/.local/share/opjev-dogfood/runtime/opencode-2.0.11 npm run e2e:gateway` | **PASS** — 60/60; server 2.0.11 |
| `OPENCODE_BIN=/home/pedro/.local/share/opjev-dogfood/runtime/opencode-2.0.11 npm run e2e:multiround-real` | **PASS** — 18/18; live Jev/SystemOne case and controlled timeout boundaries |
| `OPENCODE_BIN=/home/pedro/.local/share/opjev-dogfood/runtime/opencode-2.0.11 npm run e2e:context` | **PASS** — OpenCode 2.0.11; 2 turns, 4 requests |
| `git diff --check` | **PASS** |

These automated gates are distinct from the controlled ordinary-TUI smoke and from future natural dogfood. The stable executable is `/home/pedro/.local/share/opjev-dogfood/runtime/opencode-2.0.11`, SHA-256 `0ed7d8546cf24acc41e6371ec30928ed931ec1474e1a54bbecdde8e0dd801d2f`; the global OpenCode 2.0.18 installation remains untouched.

### Remaining limitations

- The ledger is bounded at 2,048 observations; eviction and observations lost before append cannot be independently counted.
- One historic pending run remains unresolved and visible. Audit does not convert it into a terminal result.
- The internal-session fence registry is capped at 4,096. If it fills with non-reusable fenced sessions, execution fails closed until runtime restart; no unsafe fence eviction is attempted.
- Both successful operational runs were controlled synthetic checks. Natural dogfood corpus collection has not started.
