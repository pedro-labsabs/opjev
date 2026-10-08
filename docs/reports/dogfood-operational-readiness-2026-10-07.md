# OPJEV dogfood operational readiness — 2026-10-07

**Status: BLOCKED.** The isolated OpenCode environment starts with OPJEV and authenticated live Jev selection, but an ordinary TUI task did not complete through the control plane. A 60-second worker timeout did not terminate promptly; another run persisted an EvidencePacket and critic check without a verdict or linked ledger outcome. Do not use this installation for natural dogfood until the bounded dispatcher/verdict path is repaired and re-proven.

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

These gates prove the tested boundaries only. They do not supersede the failed same-command operational TUI smoke or qualify its synthetic ledger entries as natural dogfood.
