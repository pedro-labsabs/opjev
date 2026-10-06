# Active execution summaries in the TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show bounded live orchestration progress and recovery in the TUI, accurately summarize terminal phases, and preserve summaries through presentation retries.

**Architecture:** Add a read-only RPC that resolves a session's current run binding and returns a fail-closed summary projection of its persisted RunState. The TUI polls this surface with fixed bounds and presents only changed nonterminal snapshots; existing terminal delivery remains authoritative.

**Tech Stack:** TypeScript, Node.js test runner, OpenCode plugin RPC/TUI.

**Spec:** `docs/superpowers/specs/2026-10-05-active-execution-summary-design.md`

## Global Constraints

- The kernel and persisted `RunState` remain authoritative; TUI code only displays a bounded projection.
- The status query must not wake a session, dispatch work, resume a run, mutate storage, or call an executor.
- Unknown, malformed, stale, or unavailable state produces an unavailable summary and does not suppress the original notice.
- Polling has a fixed interval and bounded lifetime; repeated identical snapshots are not re-presented.
- Only canonical `RunPhase` values are accepted; `stopped` remains distinct from `failed`; `limit-reached` is derived only from valid exhausted `awaiting-human` state.

## Review Focus

- A binding points to a missing or malformed run record: return unavailable without falling back to an older run.
- A run changes phase or recovery history between polls: show a changed nonterminal snapshot before terminal completion, without duplicate unchanged toasts.
- A persisted unknown phase, including `limit-reached`, appears: fail closed rather than display an invented state.
- Storage is unavailable during terminal rendering: keep the original notice visible through retries and refreshes.
- The TUI route changes or setup is disposed during polling: stop polling and never present a snapshot in a different session.

---

### Task 1: Read-only active summary RPC and live TUI polling

**Files:**
- Create: `src/orchestration/execution-summary-rpc.ts`
- Create: `src/orchestration/active-summary-poller.ts`
- Create: `src/execution-summary-rpc.test.mjs`
- Create: `src/active-summary-poller.test.mjs`
- Modify: `index.ts`
- Modify: `tui.ts`

**Interfaces:**
- Produces: `ExecutionSummaryRpc`, `createExecutionSummaryHandler({ storage })`, and `getActiveSummary({ sessionID }) -> { summary: ExecutionSummary }`.
- The handler resolves `sessionBindingKey(sessionID)`, validates the bound `runID`, reads only `orchestration/run/<runID>`, and calls `summarizeExecutionRun`.
- Consumes: `summarizeExecutionRun` and the existing `ExecutionSummary` shape.
- Poll interval is 1500 ms and maximum active polling lifetime is 5 minutes per route; cleanup stops it sooner on route change, terminal state, or disposal.

- [ ] **Step 1: Write the failing RPC tests.** Verify a valid binding returns the persisted running summary, storage access consists only of `get`, missing/malformed binding is unavailable, and storage errors return unavailable.
- [ ] **Step 2: Run `node --test src/execution-summary-rpc.test.mjs src/active-summary-poller.test.mjs` and confirm these tests fail because the production modules are not implemented.**
- [ ] **Step 3: Implement the bounded read-only RPC schema and handler.** Validate `sessionID` and binding identity; never expose the persisted record or unrecognized fields.
- [ ] **Step 4: Register the query in `index.ts` and add the TUI client polling loop.** Poll the current session at a fixed interval for a bounded window; present changed valid nonterminal summaries only, stop on route change, terminal state, timeout, or disposal, and clear timers during cleanup.
- [ ] **Step 5: Add a deterministic polling test with successive `running` and `repairing` snapshots.** Assert the repair/recovery summary is rendered before any terminal snapshot, unchanged snapshots are deduplicated, and polling stops at its bound.
- [ ] **Step 6: Run `node --test src/execution-summary-rpc.test.mjs src/active-summary-poller.test.mjs`; expect all assertions to pass.**
- [ ] **Step 7: Commit the RPC, registration, polling, and focused tests.**

### Task 2: Canonical phase and terminal outcome projection

**Files:**
- Modify: `src/orchestration/summary.ts`
- Modify: `src/orchestration-summary.test.mjs`
- Test: `src/execution-summary-rpc.test.mjs`

**Interfaces:**
- Consumes: canonical `RunPhase` from `src/orchestration/types.ts`.
- Produces: `ExecutionSummary.outcome` in `src/orchestration/summary.ts` includes `stopped`; only canonical persisted phases are accepted.

- [ ] **Step 1: Add failing tests for `stopped`, invalid `limit-reached`, unknown phase, and exhausted/non-exhausted `awaiting-human`.** Assert stopped has outcome `stopped`, unknown/invented phases are unavailable, and the derived limit is only emitted for exhausted canonical state.
- [ ] **Step 2: Run `node --test src/orchestration-summary.test.mjs` and confirm the new assertions fail on the current projection.**
- [ ] **Step 3: Extend `ExecutionSummary.outcome` in `src/orchestration/summary.ts` with `stopped`; validate phase against canonical `RunPhase`; derive `limit-reached` from valid `awaiting-human` budget fields; preserve separate stopped outcome/detail.**
- [ ] **Step 4: Run `node --test src/orchestration-summary.test.mjs src/execution-summary-rpc.test.mjs`; expect all tests to pass.**
- [ ] **Step 5: Commit the phase projection and tests.**

### Task 3: Preserve the composed notice across route retries and toast refreshes

**Files:**
- Create: `src/orchestration/summary-presentation.ts`
- Create: `src/summary-presentation.test.mjs`
- Modify: `tui.ts`

**Interfaces:**
- Consumes: one computed `displayNotice` containing the optional summary plus original notice.
- Produces: every render attempt and refresh for a run uses the same composed notice.

- [ ] **Step 1: Add failing TUI flow tests for retry then shown, refresh after shown, and unavailable storage.** Assert summary text is retained for retry/refresh and original notice remains when storage is unavailable.
- [ ] **Step 2: Run the focused TUI test and confirm it fails because retry/refresh currently use the raw notice.**
- [ ] **Step 3: Pass the single computed `displayNotice` to every `renderOnce` retry and `refreshToast` invocation.**
- [ ] **Step 4: Run the focused TUI presentation tests; expect all assertions to pass.**
- [ ] **Step 5: Commit the retry/refresh fix and tests.**

### Final verification

- [ ] Run `npm run typecheck`; expect exit code 0.
- [ ] Run `npm test`; expect all tests to pass.
- [ ] Run `git diff --check origin/main...HEAD`; expect no whitespace errors.
- [ ] Run the relevant real TUI E2E with pinned OpenCode 2.0.11 only if it avoids live provider calls; otherwise report that limitation and rely on the focused read-query, poller, and notice-delivery tests.
- [ ] Review the complete branch diff against the acceptance criteria and update PR #37 with the verified branch.
