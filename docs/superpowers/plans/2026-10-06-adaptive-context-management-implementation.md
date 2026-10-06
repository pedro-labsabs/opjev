# Adaptive Context Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Issue #4 as a bounded, deterministic-first context-management pipeline that observes tool context, protects kernel evidence, prunes only proven-safe request-local tool groups, preserves OpenCode native compaction, and never gives pruning authority to workers, providers, adapters, or Jev.

**Architecture:** Context Management is a separate metadata/projection subsystem under `src/context-management/`. It observes tool lifecycle and outgoing request shape, derives protection from canonical orchestration metadata/checkpoints, classifies deterministic candidates, and only later projects proven-safe tool groups in outgoing requests. OpenCode owns durable history and native compaction; the kernel/dispatcher retain all execution authority.

**Tech Stack:** TypeScript/ESM, Node.js built-ins (`node:crypto`, `node:test`, `node:sqlite` in E2E scripts), `@opencode/plugin@2.0.7`, authoritative OpenCode runtime `2.0.11`.

**Spec:** `docs/superpowers/specs/2026-10-06-adaptive-context-management-design.md`

## Global Constraints

- Preserve `ExecutionContract`, `EvidencePacket`, kernel transitions, `maxRounds`, FREE_POOL, routing/recovery, dispatch idempotency, human escalation, critic read-only, and worker no-autoapproval.
- Durable OpenCode history is never rewritten or deleted. Pruning may only change the outgoing request representation.
- Human messages and ordinary assistant text are byte-preserved in V1. Candidates are tool call/result/failure parts and explicitly identified tool-derived artifacts only.
- Tool call + terminal result/failure are one atomic group. Missing, malformed, duplicated inconsistently, stale, or unmappable groups are `KEEP`.
- Protected or unknown evidence is always `KEEP`; Jev never receives protected/unknown groups and cannot override protection.
- Context metadata is bounded: 2,048 groups total, 256 groups/session, 24-hour TTL, at most 128 queued writes, maximum 512 serialized bytes per asset record.
- Recent guard: newest 8 complete tool groups in a request/session are `KEEP`.
- Persist no raw human text, prompt text, shell command bodies, file contents, tool output, stack traces, arbitrary metadata, credentials, headers, secrets, or Jev reasoning in the Context Ledger.
- Use ordinary SHA-256 only for high-entropy IDs. Payload/content fingerprints use a process-scoped HMAC key; after restart, unmatched prior fingerprints fail closed to `KEEP`.
- Context-specific metrics live under `context/metrics/v1`; resource/provider/token/accounting facts remain in `resource/usage-ledger/v1`.
- Resource Governor can authorize semantic spend only. It cannot choose candidates, retention actions, route, model, agent, recovery, or evidence protection.
- OpenCode native compaction remains the safety net. The bridge never sets `SessionCompaction.result`, never calls compaction recursively, never creates a round, and never fabricates native-compaction success.
- No new runtime dependency unless the maintainer explicitly approves one.
- Exact OpenCode `2.0.11` runtime evidence is mandatory before promotion beyond OBSERVE and again before any ENFORCE stage.
- Rollout is monotonic and gated: OBSERVE → deterministic SHADOW → deterministic ENFORCE → semantic SHADOW → bounded semantic ENFORCE. No stage may be skipped.
- **Multi-PR rule:** each PR boundary below is a separate branch, separate maintainer review, and separate promotion decision. An executor must stop at the end of the assigned PR boundary.
- Issue #4 remains open until every authorized stage is complete or explicitly descoped by Pedro.

## Review Focus

1. **Duplicated/out-of-order/missing tool lifecycle identity:** repeated `execute.after`, missing call ID, or terminal result without a stable pair must not create pruning permission. Task 2 owns explicit tests.
2. **Process restart / fingerprint key rotation:** persisted metadata whose payload fingerprint can no longer be reproduced must become unknown/`KEEP`, never a stale DROP. Tasks 1 and 4 own explicit tests.
3. **Request changed after classification:** another plugin or concurrent hook mutation between plan and apply must invalidate the plan and send the original request. Tasks 5 and 8 own explicit tests.
4. **Storage corruption, queue saturation, or multi-process ambiguity:** observation may be lost, but enforcement must disable for affected groups and canonical conversation/evidence must survive. Tasks 1, 2, and 8 own explicit tests.
5. **OpenCode 2.0.11 compaction shape/lifecycle mismatch:** hook or event differences must leave `result` unset and allow native compaction to proceed; no inferred completion. Tasks 3 and 7 own exact-runtime tests.

---

## PR Boundary A — OBSERVE foundation

**Purpose:** add bounded metadata contracts, ledger, safe identity/fingerprinting, OBSERVE-only tool/request telemetry, and exact-runtime evidence. No pruning classification changes any outgoing request.

**Suggested branch:** `feat/issue-4-context-observe`

**Suggested PR title:** `feat(context): add bounded OBSERVE foundation (#4)`

### Task 1: Context contracts, identity, and bounded ledger

**Files:**
- Create: `src/context-management/types.ts`
- Create: `src/context-management/identity.ts`
- Create: `src/context-management/ledger.ts`
- Create: `src/context-management/storage-sink.ts`
- Test: `src/context-management-ledger.test.mjs`

**Interfaces:**
- Produces:
  - `ContextRolloutStage = "disabled" | "observe" | "deterministic-shadow" | "deterministic-enforce" | "semantic-shadow" | "semantic-enforce"`
  - `RetentionAction = "KEEP" | "KEEP_IDENTITY_TRUNCATE_PAYLOAD" | "DROP"`
  - `ProtectionState = "protected" | "clear" | "unknown"`
  - `ContextAssetV1` with the fields and enums fixed by the spec.
  - `ContextToolGroupV1` containing exactly one call asset plus at most one result/failure asset and bounded timestamps.
  - constants: `CONTEXT_SCHEMA = 1`, `CONTEXT_LEDGER_GROUP_CAPACITY = 2048`, `CONTEXT_LEDGER_SESSION_CAPACITY = 256`, `CONTEXT_LEDGER_TTL_MS = 86_400_000`, `CONTEXT_ASSET_MAX_SERIALIZED_BYTES = 512`, `CONTEXT_LEDGER_PENDING_LIMIT = 128`, `CONTEXT_RECENT_GROUPS = 8`.
  - `hashStableRef(value: string): string` for high-entropy IDs.
  - `createPayloadFingerprintKey(): Uint8Array` and `fingerprintPayload(value: unknown, key: Uint8Array): string | undefined` using HMAC-SHA-256.
  - `sanitizeContextAsset(value: unknown): ContextAssetV1 | undefined`.
  - `ContextLedger` with `upsertGroup`, `snapshot`, and `replace`, enforcing total/session/TTL bounds.
  - `CONTEXT_LEDGER_KEY = "context/asset-ledger/v1"`.
  - `createContextAssetSink(owner, storage, options?)` with serialized read-modify-write and 128 pending writes maximum.
- Consumes: no orchestration authority APIs.

- [ ] **Step 1: Write failing contract/sanitizer tests**

Test exact enum acceptance, 64-hex ID bounds, max 8 evidence roles, positive round/timestamps, 512-byte record ceiling, malformed schema rejection, and absence of arbitrary/raw fields.

- [ ] **Step 2: Run focused test and confirm RED**

Run: `node --test src/context-management-ledger.test.mjs`

Expected: FAIL because the new context-management modules do not exist.

- [ ] **Step 3: Implement the types and sanitizer**

Implement only the signatures above. Unknown schema, invalid enum, oversized record, malformed pair identity, or unsafe free-form fields return `undefined`; never coerce invalid records into pruning permission.

- [ ] **Step 4: Add identity/fingerprint tests**

Assert stable ID hashes are deterministic, payload HMACs are deterministic only under the same process key, different keys differ, and no raw input appears in serialized asset records.

- [ ] **Step 5: Implement identity helpers with `node:crypto`**

Do not persist the HMAC key. A restart intentionally invalidates old payload-equivalence proof.

- [ ] **Step 6: Add ledger bound/idempotency/TTL tests**

Assert:
- repeated delivery of the same group upserts instead of duplicating;
- a changed fingerprint for the same identity resets retention/protection to conservative unknown/KEEP;
- >2,048 groups evicts oldest metadata only;
- >256 groups for one session evicts that session's oldest groups;
- expired groups do not become permission;
- queue saturation drops observation rather than blocking or growing unbounded.

- [ ] **Step 7: Implement `ContextLedger` and `createContextAssetSink`**

Follow the resource-ledger sink pattern but use the context-specific key and 128-write limit. Never reuse `resource/usage-ledger/v1` for asset metadata.

- [ ] **Step 8: Run focused tests**

Run: `node --test src/context-management-ledger.test.mjs`

Expected: PASS.

- [ ] **Step 9: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/context-management src/context-management-ledger.test.mjs
git commit -m "feat(context): add bounded context asset ledger"
```

### Task 2: OBSERVE-only runtime capture and metrics

**Files:**
- Create: `src/context-management/observer.ts`
- Create: `src/context-management/metrics.ts`
- Create: `src/context-management/runtime-hooks.ts`
- Modify: `src/config.ts`
- Modify: `index.ts`
- Modify: `src/plugin-registration.test.mjs`
- Test: `src/context-management-observe.test.mjs`

**Interfaces:**
- Consumes: Task 1 asset/ledger/identity contracts.
- Produces:
  - `resolveContextManagementStage(value: unknown): ContextRolloutStage`; missing/invalid/unimplemented configuration resolves to `"observe"`; `"disabled"` is an explicit rollback value. Maintain `IMPLEMENTED_CONTEXT_STAGES`, initially exactly `["disabled", "observe"]`; a correctly spelled future stage is still treated as unimplemented until the PR that implements it expands this set.
  - `observeToolAfter(event, deps): Promise<void>`.
  - `observeContextRequest(event, deps): Promise<void>`.
  - `ContextMetricsV1` and a bounded `context/metrics/v1` aggregate containing enums/counts/byte estimates only.
  - `registerContextManagementHooks(ctx, opts): Promise<void>`.
- Authority: OBSERVE callbacks must not change `event.messages`, `event.system`, tool input/result, routing, or kernel state.

- [ ] **Step 1: Write failing config and observation tests**

Cover missing/invalid stage → observe, explicit disabled, user/worker/critic/orchestrator role classification, completed/error `execute.after`, duplicated event idempotency, missing IDs, storage failure, queue overflow, and canary secrets/raw text absent from ledger/metrics.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test src/context-management-observe.test.mjs src/plugin-registration.test.mjs`

Expected: FAIL before implementation.

- [ ] **Step 3: Extend `RouterOptions` with `contextManagementStage?: string`**

Resolve through `resolveContextManagementStage`; do not couple context-management registration to `enableAutoRoute`.

- [ ] **Step 4: Implement OBSERVE lifecycle capture**

For each terminal `execute.after` event:
- read session metadata best-effort to derive role plus `jev-run-id`/`jev-round` when present;
- derive stable hashed session/message/call/group refs;
- compute byte counts and process-HMAC fingerprints transiently;
- write call+result/failure as one completed group;
- on any identity/session/storage ambiguity, record only bounded loss/unknown metrics and create no pruning permission.

Do not register a second `execute.before`; existing local tool authority remains first and unchanged.

- [ ] **Step 5: Implement request observation**

On `session.hook("context")`, measure serialized outgoing request bytes and pairing coverage without mutating `system` or `messages`. Token counts remain absent unless the runtime supplies them.

- [ ] **Step 6: Register hooks independently of auto-routing**

In `index.ts`, keep existing order:
1. `registerToolAuthorityHook`
2. tools/RPC setup
3. `registerSessionHooks`
4. `registerContextManagementHooks`

Update registration tests to prove existing Jev tools remain unchanged and Context Management does not remove/reorder the existing authority/retry/prompt/context hooks.

- [ ] **Step 7: Run focused tests**

Run: `node --test src/context-management-ledger.test.mjs src/context-management-observe.test.mjs src/plugin-registration.test.mjs`

Expected: PASS.

- [ ] **Step 8: Run regression gates**

Run:
```bash
npm run typecheck
npm test
npm run evaluate:routing
npm run e2e:matrix
git diff --check
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add index.ts src/config.ts src/plugin-registration.test.mjs src/context-management
git add src/context-management-observe.test.mjs
git commit -m "feat(context): observe bounded tool context"
```

### Task 3: Exact OpenCode 2.0.11 OBSERVE E2E

**Files:**
- Create: `scripts/e2e-context-management.mjs`
- Modify: `package.json`
- Modify only if runtime evidence requires a bounded fix: Task 1/2 files.

**Interfaces:**
- Reuse `scripts/install-plugin.mjs`, the authoritative `OPENCODE_BIN` pattern, and direct SQLite `kv` inspection already used by `e2e-gateway.mjs` / `e2e-multiround-real.mjs`.
- Produces npm script: `e2e:context`.

- [ ] **Step 1: Write the real-host OBSERVE scenario**

The script must:
- refuse any OpenCode version other than `2.0.11`;
- install the actual OPJEV plugin through the existing packaging path;
- drive at least one completed tool call and one failed tool call using a controlled provider/tool path;
- execute more than one turn so the real `context` hook runs;
- inspect real SQLite storage for `context/asset-ledger/v1` and `context/metrics/v1`;
- use unique canary strings in human text, tool input, tool result, and error, then prove none are persisted in the context records;
- prove no outgoing human/assistant text was changed in OBSERVE;
- prove duplicate hook delivery/storage replay does not create duplicate groups;
- report pairing coverage and exact observed OpenCode message/event shapes without turning observations into policy.

- [ ] **Step 2: Run the E2E and require RED/diagnostic if assumptions are wrong**

Run:
```bash
OPENCODE_BIN=/tmp/opencode-2.0.11/package/bin/opencode npm run e2e:context
```

Expected before any necessary repair: either PASS or a concrete shape mismatch. A mismatch is not permission to weaken the spec.

- [ ] **Step 3: Make at most one bounded compatibility repair**

Only adjust observation/parsing seams. Do not introduce pruning, message mutation, Jev calls, or private OpenCode APIs.

- [ ] **Step 4: Re-run E2E and full gates**

Run:
```bash
OPENCODE_BIN=/tmp/opencode-2.0.11/package/bin/opencode npm run e2e:context
npm run typecheck
npm test
npm run evaluate:routing
npm run e2e:matrix
git diff --check
```

Expected: all PASS; `e2e:context` explicitly states real OpenCode 2.0.11 and OBSERVE-only behavior.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-context-management.mjs package.json package-lock.json src/context-management
git commit -m "test(context): prove observe path on opencode 2.0.11"
```

### PR Boundary A gate

Before opening the PR:
- full suite, routing and matrix green;
- real `e2e:context` green on 2.0.11;
- no request mutation;
- no Jev pruning call;
- ledger/metrics contain no raw canaries or secrets;
- no second resource ledger;
- Issue #4 remains open.

After maintainer merge, update #4 status to **OBSERVE MERGED — READY FOR DETERMINISTIC SHADOW**. Do not begin Boundary B without that review.

---

## PR Boundary B — Protection + deterministic SHADOW

**Suggested branch:** `feat/issue-4-context-deterministic-shadow`

**Suggested PR title:** `feat(context): add protected deterministic shadow pruning (#4)`

### Task 4: Canonical evidence-protection projector

**Files:**
- Create: `src/context-management/protection.ts`
- Test: `src/context-management-protection.test.mjs`

**Interfaces:**
- Produces:
  - `ContextProtectionReason` stable enums.
  - `ContextProtectionSnapshot` containing role, runRef, round, checkpoint identity/version, and per-group `protected|clear|unknown` results.
  - `ContextProtectionDeps = { getSessionMetadata(sessionID): Promise<unknown>; getRun(runID): Promise<unknown> }`.
  - `projectContextProtection(deps, sessionID, groups): Promise<ContextProtectionSnapshot>`.
- The runtime adapter supplies these two reads from `ctx.session.get` and `ctx.storage.get`; the protection module itself does not import/own `ctx`.
- Reads session metadata `jev-role`, `jev-run-id`, and `jev-round` already created by the dispatcher, then reads `orchestration/run/<jev-run-id>`.
- Does not create a second authority index and does not modify the canonical checkpoint.

- [ ] **Step 1: Write failing protection tests**

Cover:
- worker with valid run/round/checkpoint;
- requiredEvidence and current EvidencePacket;
- deterministic checks and critic findings;
- pending verdict/recovery/human state;
- critic/orchestrator always protected;
- session metadata lookup failure;
- missing/malformed/stale checkpoint;
- run/round mismatch;
- process restart fingerprint mismatch.

Expected for every ambiguous case: unknown/`KEEP`.

- [ ] **Step 2: Run focused test and confirm RED**

Run: `node --test src/context-management-protection.test.mjs`

- [ ] **Step 3: Implement projector using existing session metadata + canonical run storage**

Do not change `ExecutionContract`, `EvidencePacket`, `RunState`, or dispatcher authority. If current bounded summaries cannot prove per-group non-evidence, protect the whole worker round.

- [ ] **Step 4: Run focused tests and typecheck**

Run:
```bash
node --test src/context-management-protection.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context-management/protection.ts src/context-management-protection.test.mjs
git commit -m "feat(context): project canonical evidence protection"
```

### Task 5: Deterministic classifier and request-plan SHADOW

**Files:**
- Create: `src/context-management/deterministic-pruner.ts`
- Create: `src/context-management/request-projection.ts`
- Modify: `src/context-management/runtime-hooks.ts`
- Modify: `src/context-management/metrics.ts`
- Test: `src/context-management-deterministic.test.mjs`
- Test: `src/context-management-projection.test.mjs`

**Interfaces:**
- Produces:
  - `DeterministicDecision = { groupID; action; reason; source: "deterministic" }`.
  - `classifyContextGroups(input): DeterministicDecision[]`.
  - `buildRequestProjectionPlan(messages, ledger, protection): ProjectionPlan`.
  - `applyProjectionPlan(...)` exists but in deterministic-shadow must return/send the original messages unchanged.
- The initial production tool allowlist is empty unless Task 3 real-runtime evidence proves a specific tool's semantics. Tool name alone is never sufficient.

- [ ] **Step 1: Write the deterministic rule-table tests from spec §11**

Pin every row: incomplete group, protected/unknown, recent 8, exact duplicate, repeated output/different call, supersession, listing, observed mutation, large result, old failure + later check.

- [ ] **Step 2: Run test and confirm RED**

Run: `node --test src/context-management-deterministic.test.mjs`

- [ ] **Step 3: Implement pure deterministic classifier**

Probability/semantic similarity never becomes deterministic proof. Unsupported relation returns `KEEP` or bounded `AMBIGUOUS` internally; only clear groups outside protection/recent guards can become ambiguous.

- [ ] **Step 4: Write request-shape and pair-integrity tests using the exact shapes captured by Task 3**

Tests must prove:
- match by real call ID/session/message identity, not text/order;
- mixed assistant text remains byte-equivalent;
- user messages remain byte-equivalent;
- pair mismatch or changed fingerprint invalidates the whole plan;
- another-plugin/concurrent mutation after plan creation yields original messages;
- shadow stage records proposed deltas but returns the original message array/content.

- [ ] **Step 5: Implement request-plan parser/revalidator**

Do not invent unsupported OpenCode message-part shapes. Keep all unknown shapes.

- [ ] **Step 6: Wire deterministic-shadow**

When configured `deterministic-shadow`, protection + classification + projection-plan computation run, metrics record proposed KEEP/TRUNCATE/DROP, but outgoing `messages` remain unchanged and Jev is never called.

- [ ] **Step 7: Run focused tests and regressions**

Run:
```bash
node --test src/context-management-*.test.mjs
npm run typecheck
npm test
npm run evaluate:routing
npm run e2e:matrix
git diff --check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/context-management src/context-management-deterministic.test.mjs src/context-management-projection.test.mjs
git commit -m "feat(context): compute deterministic pruning in shadow"
```

### Task 6: Real deterministic-SHADOW E2E

**Files:**
- Modify: `scripts/e2e-context-management.mjs`

- [ ] **Step 1: Add exact-host SHADOW assertions**

Prove on OpenCode 2.0.11:
- request bytes/text before and after are identical;
- protected worker round groups are never proposed DROP/TRUNCATE;
- critic/orchestrator groups are protected;
- newest 8 groups remain KEEP;
- malformed/missing linkage remains KEEP;
- proposed actions are bounded and reconciled with ledger groups.

- [ ] **Step 2: Run exact E2E and all gates**

Run:
```bash
OPENCODE_BIN=/tmp/opencode-2.0.11/package/bin/opencode npm run e2e:context
npm run typecheck
npm test
npm run evaluate:routing
npm run e2e:matrix
git diff --check
```

Expected: PASS, with zero request mutation.

- [ ] **Step 3: Commit**

```bash
git add scripts/e2e-context-management.mjs
git commit -m "test(context): prove deterministic shadow on opencode 2.0.11"
```

### PR Boundary B gate

Merge only if protected evidence, pair integrity, user immutability, role boundaries, stale data, and exact runtime SHADOW behavior are proven. Update #4 to **DETERMINISTIC SHADOW MERGED — READY FOR COMPACTION BRIDGE**.

---

## PR Boundary C — Native compaction bridge, still no pruning ENFORCE

**Suggested branch:** `feat/issue-4-context-compaction-bridge`

**Suggested PR title:** `feat(context): add bounded native compaction bridge (#4)`

### Task 7: Bounded canonical-state bridge and compaction observation

**Files:**
- Create: `src/context-management/compaction-bridge.ts`
- Modify: `src/context-management/runtime-hooks.ts`
- Modify: `src/context-management/metrics.ts`
- Test: `src/context-management-compaction.test.mjs`
- Modify: `scripts/e2e-context-management.mjs`

**Interfaces:**
- Produces:
  - `buildCompactionBridgePayload(checkpoint): string | undefined` with a fixed byte ceiling and only canonical fields from spec §15.
  - `appendCompactionGuidance(event, payload): void` that only appends a bounded system instruction and never sets `event.result`.
  - `appendCanonicalContextState(event, payload): void` for later primary `context` requests so OPJEV-owned state does not depend on probabilistic native-summary prose.
  - post-compaction observation that records a compaction only from actual runtime events.
- Runs only at `deterministic-shadow` or later; pruning of `messages` remains shadow/no-op in this PR.

- [ ] **Step 1: Write failing bridge tests**

Assert objective, round, executor, relevant acceptance criteria, requiredEvidence, current normalized EvidencePacket, blockers/binding decision/recovery/human state/next kernel step are bounded projections, not reinterpretations. Invalid/oversized checkpoint returns no bridge guidance.

- [ ] **Step 2: Add hook safety tests**

Assert:
- `session.hook("compaction")` leaves `event.result === undefined`;
- it never calls a compact RPC;
- expected adapter/storage failures do not throw into the host;
- no new orchestration/run/route/model/agent operation occurs;
- `session.compaction.ended` or the exact event proven by 2.0.11 is observational only.

- [ ] **Step 3: Implement bridge and event observation**

Use the locked SDK contract, not current-web assumptions. If the exact runtime exposes a different compaction-completion event than declarations suggest, record the observed event and adapt without fabricating completion.

- [ ] **Step 4: Expand real 2.0.11 E2E**

Trigger real native compaction and prove:
- compaction hook executes;
- `result` remains unset;
- OpenCode performs the native operation;
- canonical OPJEV bridge fields are available to the native request and are re-injected from validated persisted state into later primary context;
- no compaction loop or new run/round appears;
- durable original tool/history data remains available;
- pruning `messages` is still not enforced.

- [ ] **Step 5: Run full gates**

Run:
```bash
OPENCODE_BIN=/tmp/opencode-2.0.11/package/bin/opencode npm run e2e:context
npm run typecheck
npm test
npm run evaluate:routing
npm run e2e:matrix
npm run e2e:gateway
npm run e2e:multiround-real
git diff --check
```

The two real orchestration E2Es are mandatory here because compaction/context hooks now affect runtime request construction.

- [ ] **Step 6: Commit**

```bash
git add src/context-management src/context-management-compaction.test.mjs scripts/e2e-context-management.mjs
git commit -m "feat(context): bridge canonical state into native compaction"
```

### PR Boundary C gate

No deterministic ENFORCE until the maintainer confirms native compaction remains operational on exact 2.0.11 and canonical re-injection does not create loops or authority changes.

---

## PR Boundary D — Deterministic ENFORCE

**Suggested branch:** `feat/issue-4-context-deterministic-enforce`

**Suggested PR title:** `feat(context): enforce proven deterministic pruning (#4)`

### Task 8: Prove at least one production-safe tool adapter or stop

**Files:**
- Create only after proof: `src/context-management/tool-adapters.ts`
- Test: `src/context-management-tool-adapters.test.mjs`
- Modify: `scripts/e2e-context-management.mjs`

**Interfaces:**
- A tool adapter may expose only deterministic facts such as normalized entity/query identity, completeness, mutation generation/version, and read-only/pure status.
- Tool name matching alone is not proof.

- [ ] **Step 1: Characterize real OpenCode 2.0.11 candidate tools**

Use exact runtime fixtures to test built-in read/list semantics, completeness/truncation signal, stable query identity, and whether a monotonic generation/version exists where supersession requires it.

- [ ] **Step 2: Apply the hard gate**

If no production tool can prove the required semantics, **STOP this boundary as BLOCKED**. Keep deterministic SHADOW merged and do not create an allowlist by assumption.

- [ ] **Step 3: If proof exists, write adapter tests first**

Pin every accepted semantic fact and negative case.

- [ ] **Step 4: Implement only the proven adapter(s)**

No shell/write/network/opaque MCP tool becomes read-only by name.

- [ ] **Step 5: Commit adapter proof**

```bash
git add src/context-management/tool-adapters.ts src/context-management-tool-adapters.test.mjs scripts/e2e-context-management.mjs
git commit -m "feat(context): add proven deterministic tool adapters"
```

### Task 9: Pair-safe request-local enforcement

**Files:**
- Modify: `src/context-management/request-projection.ts`
- Modify: `src/context-management/runtime-hooks.ts`
- Modify: `src/context-management/metrics.ts`
- Test: `src/context-management-enforce.test.mjs`
- Modify: `scripts/e2e-context-management.mjs`

**Interfaces:**
- `applyProjectionPlan(messages, plan, currentSnapshot): messages` may apply only still-valid deterministic decisions from proven adapters.
- `KEEP_IDENTITY_TRUNCATE_PAYLOAD` preserves call/result linkage and substitutes a fixed bounded OPJEV result marker; it never fabricates success.
- `DROP` removes both call and terminal result/failure parts atomically.

- [ ] **Step 1: Write RED enforcement tests**

Cover exact duplicate safe group, placeholder integrity, user/assistant text byte identity, protected/recent groups, stale plan generation, fingerprint change, unknown part shape, storage failure, and concurrent mutation. Every invalidation must return the original request.

- [ ] **Step 2: Implement minimal deterministic enforcement**

Enable only under explicit `deterministic-enforce`. Default/malformed config remains OBSERVE; no semantic Jev calls exist yet.

- [ ] **Step 3: Expand exact 2.0.11 E2E**

Prove:
- safe candidate reduces outgoing bytes;
- both call/result sides disappear together for DROP;
- durable `session.context` still contains originals;
- placeholder keeps valid call/result structure;
- active evidence/recovery remains intact;
- native compaction still runs;
- no new run/round/routing/model/agent decision;
- measured saving exceeds adapter overhead on the agreed fixture.

- [ ] **Step 4: Run all gates**

Run:
```bash
OPENCODE_BIN=/tmp/opencode-2.0.11/package/bin/opencode npm run e2e:context
npm run typecheck
npm test
npm run evaluate:routing
npm run e2e:matrix
npm run e2e:gateway
npm run e2e:multiround-real
git diff --check
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context-management src/context-management-enforce.test.mjs scripts/e2e-context-management.mjs
git commit -m "feat(context): enforce deterministic request-local pruning"
```

### PR Boundary D gate

Maintainer must compare actual request reduction with adapter overhead and verify zero evidence/acceptance regression. If evidence is insufficient, remain in deterministic SHADOW.

---

## PR Boundary E — Semantic SHADOW (currently conditionally blocked)

**Current prerequisite:** spec §25 question 4 is unresolved: the Resource Governor has no evidence-backed low-pressure coverage contract. **Do not implement this boundary until a maintainer-approved spec amendment defines sufficient observed coverage for semantic spend.**

**Suggested branch after approval:** `feat/issue-4-context-semantic-shadow`

### Task 10: Add a non-routing `context-prune` budget seam

**Files after prerequisite approval:**
- Modify: `src/resource-governor/budget-policy.ts`
- Modify: `src/resource-governor/runtime-policy.ts`
- Modify: `src/resource-governor.test.mjs`

**Interfaces:**
- Extend `BudgetStage` with `"context-prune"` only after the low-pressure coverage contract is approved.
- Governor returns only allow/deny/reason/basis. It never returns a candidate or retention action.
- quota latch, malformed enforcement read, critical/high/unknown/missing coverage deny semantic pruning according to the approved policy.

- [ ] **Step 1: Add RED policy tests from the approved amendment**
- [ ] **Step 2: Implement the pure spend decision**
- [ ] **Step 3: Run governor/full tests**
- [ ] **Step 4: Commit `feat(context): gate semantic pruning spend`**

### Task 11: Bounded semantic boundary in SHADOW

**Files:**
- Create: `src/context-management/semantic-boundary.ts`
- Modify: `src/context-management/runtime-hooks.ts`
- Modify: `src/context-management/metrics.ts`
- Test: `src/context-management-semantic.test.mjs`
- Modify: `scripts/e2e-context-management.mjs`

**Interfaces fixed by spec:**
- max 16 candidates;
- max one Jev call/session/context-or-compaction cycle;
- 60s per-session cooldown;
- descriptor request <=4 KiB;
- 10-minute cache by ordered descriptors + policy version;
- strict one-result-per-candidate response;
- confidence >=0.90 required;
- timeout/unavailable/malformed/partial/unknown ID/extra ID/resource denial → whole batch KEEP;
- no retry inside the cycle;
- no raw history/payload/path/prompt/arguments/secrets sent to Jev.

- [ ] **Step 1: Write RED boundary tests for every bound/failure mode**
- [ ] **Step 2: Implement descriptor builder/cache/strict response parser**
- [ ] **Step 3: Wire semantic-shadow so outgoing messages remain unchanged**
- [ ] **Step 4: Run exact-host E2E with controlled Jev responses and prove one-call maximum/KEEP failures**
- [ ] **Step 5: Run full gates and commit**

### PR Boundary E gate

Merge only with explicit maintainer approval of the semantic response contract and evidence that measured expected savings exceed Jev overhead. Otherwise remain deterministic-only.

---

## PR Boundary F — Bounded Semantic ENFORCE

**Prerequisite:** Boundary E merged, reference workload evidence collected, and explicit maintainer approval. This stage is not implied by completing SHADOW.

### Task 12: Apply only revalidated high-confidence semantic decisions

**Files:**
- Modify: `src/context-management/request-projection.ts`
- Modify: `src/context-management/runtime-hooks.ts`
- Test: `src/context-management-semantic-enforce.test.mjs`
- Modify: `scripts/e2e-context-management.mjs`

- [ ] **Step 1: Write RED tests**

Assert semantic action applies only when candidate ID, descriptor hash, current protection snapshot, message fingerprints, generation, policy version, cache state, and >=0.90 confidence all still match. Any change → KEEP.

- [ ] **Step 2: Implement bounded semantic enforcement**

Enable only under explicit `semantic-enforce`; deterministic protection remains earlier and stronger.

- [ ] **Step 3: Run staged/reference E2E**

Compare acceptance/evidence validity, context overflow, native compaction, bytes/tokens where observed, Jev cost, and unknown linkage. Missing outcome/evidence linkage blocks promotion and is not counted as zero regression.

- [ ] **Step 4: Run all project and exact-runtime gates**

Run:
```bash
OPENCODE_BIN=/tmp/opencode-2.0.11/package/bin/opencode npm run e2e:context
npm run typecheck
npm test
npm run evaluate:routing
npm run e2e:matrix
npm run e2e:gateway
npm run e2e:multiround-real
git diff --check
```

- [ ] **Step 5: Commit and stop for final maintainer review**

Do not close #4 automatically. The maintainer closes it only after all agreed acceptance evidence is inspected.

---

## Required maintainer checkpoints

1. **After Boundary A:** OBSERVE facts are real, bounded, secret-safe, and zero-mutation.
2. **After Boundary B:** protection and deterministic classification are proven in SHADOW.
3. **After Boundary C:** native compaction bridge is proven on exact OpenCode 2.0.11.
4. **Before/after Boundary D:** at least one production tool adapter has deterministic semantic proof; otherwise enforcement is BLOCKED.
5. **Before Boundary E:** approve a spec amendment defining low-pressure coverage for Resource Governor semantic spend.
6. **Before Boundary F:** explicitly approve semantic enforcement based on SHADOW evidence.

## Issue/PR bookkeeping

- Every implementation PR uses `Refs #4`; no intermediate PR uses `Closes #4`.
- Each PR body states current rollout stage, authority changes (normally none), exact gates run, and the next promotion gate.
- Update #4 after each merged boundary with the merged SHA and next allowed stage.
- Keep #2 high-level only; do not duplicate every subtask there.
- #5 Model Intelligence remains OBSERVE-only and must not become a routing input through this work.

## Final acceptance for Issue #4

The issue may be closed only when the maintainer has evidence that the agreed final stage satisfies:
- human messages unchanged;
- protected evidence never eliminated;
- call/result integrity maintained;
- deterministic supersession/duplicate rules proven;
- all failures default to KEEP;
- Jev calls bounded and governor-gated where semantic mode is enabled;
- native compaction remains operational and non-recursive;
- context reduction is measured before/after without fabricated token claims;
- no kernel/Jev/dispatcher authority violation;
- full tests plus exact 2.0.11 E2E are green;
- docs match the shipped rollout stage.
