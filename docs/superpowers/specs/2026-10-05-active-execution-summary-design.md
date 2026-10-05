# Active execution summaries in the TUI

## Purpose

Make the current orchestration route, round progress, and recovery activity visible while a run is still in progress. Correct terminal outcome summaries and ensure retries or toast refreshes do not discard an attached summary.

## Constraints

- The kernel and persisted `RunState` remain authoritative. TUI code only displays a bounded projection.
- A status query is read-only: it must not wake a session, dispatch work, resume a run, mutate storage, or call an executor.
- Unknown, malformed, stale, or unavailable state produces an unavailable summary and does not suppress the original notice.
- Polling has a fixed interval and bounded lifetime; repeated identical snapshots are not re-presented.
- Only canonical `RunPhase` values are accepted. `stopped` remains distinct from `failed`; `limit-reached` is derived only from a valid `awaiting-human` state whose round budget is exhausted.

## Design

Add a small server RPC dedicated to execution-summary reads. Its input is the current parent `sessionID`; the handler reads that session's binding, then the persisted run record, validates canonical phase and summary fields, and returns only the existing bounded `ExecutionSummary` projection. Missing bindings, malformed data, storage errors, and unknown phases fail closed as unavailable. The method does not share the `orchestrate` handler path and has no write or dispatch dependencies.

The TUI registers this query and polls only while a session route is active. It renders an interim toast when a valid, nonterminal summary changes, including the active route, progress, and newly visible recovery events. It stops presenting interim updates when the query reports a terminal phase or becomes unavailable; the existing terminal notice event and durable reconciliation continue to deliver the final result. Polling is capped by a fixed interval and a per-route active window, and cleanup cancels the timer. Snapshot deduplication prevents repeated notices for unchanged state.

Terminal summary projection accepts only canonical `RunPhase` values. `completed`, `failed`, and `stopped` have matching outcomes. `limit-reached` is an outcome derived from `awaiting-human` plus valid round and max-round values showing exhaustion; it is never accepted as a persisted phase. Malformed phases or required state fields return `{ available: false }`.

The result presentation path builds one `displayNotice` by combining the optional summary and original notice. Every route retry and scheduled toast refresh reuses that same value. If storage or summary projection is unavailable, the original notice remains the displayed text.

## Scope

- Add the read-only execution-summary RPC definition, handler, and plugin registration.
- Add bounded active-summary polling and changed-snapshot presentation in `tui.ts`.
- Tighten phase validation and outcome projection in `src/orchestration/summary.ts`.
- Preserve the composed `displayNotice` in retry and refresh paths.
- Add focused tests for read-only/bounded querying, preterminal running-to-repairing visibility, canonical phases and outcomes, and TUI retry/refresh/storage-unavailable behavior.

## Acceptance criteria

1. A test observes at least one changed active summary, including recovery, before the run reaches a terminal phase.
2. The summary query performs reads only and returns unavailable for malformed, unknown, stale, or inaccessible state.
3. `stopped` is never summarized as `failed`, and persisted `limit-reached` is rejected as an invalid phase.
4. `limit-reached` appears only for valid `awaiting-human` state with exhausted round budget.
5. TUI route retry, toast refresh, and unavailable storage all preserve the correct composed notice; storage unavailability preserves the original notice.
6. Existing admission, kernel authority, durable notice, session role filtering, and result reconciliation behavior remain intact.
