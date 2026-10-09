# OPJEV dogfood quickstart
> **Controlled accepted TUI smoke verified 2026-10-08; PASS PARA REVISÃO DO MANTENEDOR only.** Three controlled synthetic outcomes remain linked and persisted. The latest unique ordinary-TUI smoke completed admission/dispatch once and showed a governed failure after worker success and critic/evidence: live Jev returned contradictory verdict fields, rejected without fabricating verdict or outcome. Two such contradictory Jev responses and one stopped run remain visible. No natural dogfood or maintainer approval is claimed; see `docs/reports/dogfood-operational-readiness-2026-10-07.md`.

## Start and resume

From any project directory, run the dedicated command:

```sh
cd /path/to/project
opjev
```

`opjev` uses the pinned OpenCode 2.0.11 binary and a private profile under `~/.local/share/opjev-dogfood/profile`. It starts one loopback OpenCode server and one local gateway, connects the TUI with `--server <gateway>`, and stops both children when the TUI exits. The gateway default is explicitly `orchestrate`; ordinary prompts need no prefix or internal tool call. The server/TUI plugin is installed into the isolated profile, not into global OpenCode or the project. The project's files and `opencode.json` are not modified.

To continue the last session after restarting:

```sh
cd /path/to/project
opjev --continue
```

To resume a known OpenCode session:

```sh
opjev --session SESSION_ID
```

The session database persists at `~/.local/share/opjev-dogfood/profile/.local/share/opencode/opencode.db`. Closing the TUI normally, or pressing Ctrl-C, stops only processes launched by this foreground command. No daemon or systemd service is installed.

The launcher checks the pinned CLI SHA-256/version, server `/api/info`, admission RPC registration, and an authenticated structured Jev response before opening the TUI. It reads `OPENCODE_API_KEY` from the current environment or the existing private `~/.config/opencode/env`; it never copies the key into the profile, configuration, command arguments, or logs. A failed Jev check blocks startup. The server plugin is configured for `jev-1.13-free` at `https://opencode.ai/zen/v1/systemone`, and Context Management is explicitly `observe`; Model Intelligence remains in its existing observe-only behavior. The plugin's separate auto-route hook is disabled so the gateway is the only user-prompt admission path.

## Confirm operation

While the TUI is open, in another terminal:

```sh
opjev status
```

`opjev` status in another terminal reports the active launcher and loopback ports. When the TUI closes, the foreground `opjev` terminal prints sanitized gateway totals: orchestrate interceptions, admissions, RPC dispatches, duplicate suppression, and fail-closed requests. An earlier controlled synthetic TUI run completed with linked EvidencePacket, critic result, live Jev verdict, accepted outcome, and persistence after restart. Later live Jev responses were contradictory and correctly rejected without fabricating outcomes. The pinned gateway E2E now passes 60/60 using 45 completions from an ephemeral local model fixture; it verifies the real OpenCode 2.0.11 TUI/gateway path, single admission/dispatch, bounded summary RPC, and visible result. Its Jev is mocked; it is not the live-Jev smoke or natural dogfood. See the dated report.

For a sanitized, read-only aggregate of collection quality:

```sh
opjev audit
```

The audit reads only the canonical `resource/usage-ledger/v1` and canonical run records. It reports the latest 100 runs by update time, ledger schema/capacity and size, live Jev versus heuristic selection, evidence/critic/verdict status, round-limit violations, per-kind observation counts, distinct session count, agent/model/route names, acceptance/failure-class aggregates, recovery counts, and runtime-provided token totals. It emits no prompts, result text, session IDs, or run IDs. Failure categories distinguish pre-worker failures, governed failures before evidence, failures after evidence but before verdict, pending runs, ambiguous interruption/run state, inconsistent evidence, round violations, orphaned links, invalid records, and genuine missing links.
Known failures before evidence or verdict are not automatically missing-link defects. A failed run counts as governed only when its canonical record has `state.phase="failed"`, checkpoint `run-failed`, and a nonempty `state.lastError`; otherwise it is inconsistent and fails audit, except an unconfirmed interruption remains ambiguous and fails its own gate. A current-round worker failure additionally requires nonempty persisted and observed worker session IDs that match, with agent/model matching the expected executor. Empty, missing, or mismatched identity fails audit. Unexplained missing links on completed/judged runs, malformed or duplicate round facts, evidence inconsistent with canonical state, orphaned ledger data, and round-limit violations fail audit. Pending and ambiguous runs remain separately visible.
Terminal `lastVerdict` must structurally match the latest persisted history verdict; where history is absent, its acceptance and failure class must match the final linked ledger outcome. A `completed` run must have an `accept` verdict. The accepted aggregate counts only completed, linked, internally consistent runs within `maxRounds`; round-limit violations remain audit failures and are not counted as accepted. A mismatch fails audit; no verdict, outcome, acceptance, or failure class is inferred.

Each accepted run is persisted under `orchestration/run/<runID>` with its bounded EvidencePacket/verdict and the initial executor-decision provenance (`selection.via` distinguishes `jev` from the deterministic heuristic). Resource observations use the same `runID` and round, permitting the audit to check the join. Storage inspection is read-only; do not dump the database or clear the ledger.

## Daily dogfood

Use ordinary tasks in varied real projects: small implementation changes, tests, debugging, and documentation work. Submit them normally in the TUI; do not add an orchestration prefix, invoke an internal tool, or choose a collection mode. Let a task finish or produce its governed failure, then close the TUI normally. The gateway intercepts each user prompt; worker/critic/orchestrator sessions remain internal and use the existing contract, FREE_POOL, and round limit. Natural tasks, not the controlled smoke, are the dogfood corpus. Keep private project content, prompts, outputs, credentials, and raw database records out of reports.

After a task batch, run `opjev audit`. A nonzero heuristic-selection count means at least one task used the local decision fallback; it is not evidence of a live Jev selection. Known pre-evidence/pre-verdict failures are reported by stage only when the failed phase, `run-failed` checkpoint, nonempty canonical error, and required worker links agree; contradictory records fail audit. An unexplained missing link for a run whose canonical state requires an outcome remains a failure; do not infer or fabricate the missing fact.
Provider throttles and `resource-budget` denials are governed failures, not accepted outcomes. Preserve the ledger; do not clear it or bypass the budget to force an E2E or smoke pass.


## Version and gateway diagnosis

Use `opjev`, not the global `opencode`, for instrumented work. The global command remains unchanged and is not routed through OPJEV. Verify the installed binary without exposing credentials:

```sh
~/.local/share/opjev-dogfood/runtime/opencode-2.0.11 --version
sha256sum ~/.local/share/opjev-dogfood/runtime/opencode-2.0.11
opjev status
```
The version-pinned executable was installed from the official `@opencode/cli-linux-x64@2.0.11` package. Expected SHA-256: `0ed7d8546cf24acc41e6371ec30928ed931ec1474e1a54bbecdde8e0dd801d2f`. The `opjev` wrapper lives at `~/.local/bin/opjev`; the global `opencode` executable is untouched.


Expected CLI output is `opencode v2.0.11`; the server is independently checked at `/api/info` before TUI startup. A `BLOCKED` startup message identifies the failing preflight without printing process logs or credential contents. Gateway interception/dispatch counts of zero mean no ordinary prompt passed through the gateway. A heuristic-selection count means Jev was not used for that run; inspect only sanitized audit aggregates and resolve authentication/connectivity before continuing dogfood.

The gateway and server bind to `127.0.0.1` on dynamically allocated ports. `opjev status` reports a running session or refuses an additional launcher while one is active. A normal TUI close releases the launcher lock; after a forced shutdown, the launcher fails closed if any recorded PID is active. A stale lock is never removed automatically: if `opjev status` reports a stale lock and all managed PIDs are confirmed absent, remove only `~/.local/share/opjev-dogfood/active.json` before restarting. Do not kill the global OpenCode processes.

## Restore

The existing global OpenCode binary, configuration, plugins, sessions, and credentials are not changed. To disable the dedicated launcher while preserving its session history and evidence, close the TUI and rename only its wrapper:

```sh
mv ~/.local/bin/opjev ~/.local/bin/opjev.disabled
```

The global `opencode` command then remains available as before, but is uninstrumented and does not collect OPJEV observations. Keep the isolated profile/database as a backup. If removing the dogfood installation later, first close the launcher and move `~/.local/share/opjev-dogfood` to a backup location; do not delete it until its sessions and evidence are no longer needed. The generated isolated OpenCode config refuses unexpected edits instead of overwriting them.
