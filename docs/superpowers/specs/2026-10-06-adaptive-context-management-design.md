# Adaptive Context Management: canonical design for Issue #4

**Status:** design for maintainer review; no runtime implementation is part of this change.
**Base:** canonical `main` SHA `96cef8b8e454260040e68dd2123aa487d4d3cd7f`.
**Sequencing:** #3 complete, #5 OBSERVE foundation complete, #29 merged, #4 is the current planning slice.
**Authority rule:** the worker executes; Jev judges; the kernel governs.

## 1. Problem and objectives

Long OpenCode sessions accumulate tool calls, results, repeated reads, stale listings, and large payloads. Those messages increase later model requests and can bring native context compaction forward. Issue #4 asks OPJEV to measure and conservatively reduce redundant tool context before OpenCode's existing compaction runs, while retaining the runtime's compaction as its safety net.

The intended pipeline is:

```text
tool execution hooks
  -> bounded Context Asset observations
  -> bounded Context Ledger
  -> deterministic protection and pruning
  -> optional bounded Jev decision for deterministic ambiguities
  -> request-local context projection / compaction guidance
  -> OpenCode native compaction remains authoritative
```

The first implementation must make candidate selection explainable and fail closed. The work is successful only if required evidence and orchestration authority remain intact; context savings are secondary.

## 2. Non-goals

- No pruning implementation, active `DROP`, active payload truncation, or Jev pruning call is included in this design change.
- No change to `ExecutionContract`, `EvidencePacket`, acceptance, `maxRounds`, FREE_POOL, routing, recovery, dispatch locks, idempotency, or human escalation.
- No deletion or rewriting of durable OpenCode transcript history. No broad rewriting of assistant prose.
- No removal, summary, rewrite, or semantic compaction of human messages.
- No replacement or reimplementation of OpenCode native compaction; no compaction loop, new orchestration, or new round.
- No new Resource Usage Ledger, router, scheduler, authority, model-selection behavior, or dependency.
- No promotion of Issue #5 beyond its shipped OBSERVE foundation; no update to Issue #2 in this slice.
- No implementation plan until the maintainer approves this written spec.

## 3. Current-state evidence

### Repository and sequencing

- GitHub reports `main` at `96cef8b8e454260040e68dd2123aa487d4d3cd7f`, the merge commit for PR #42 / Issue #29. Its first parent is `74716a6029ca520b7055352f4703326a19cedead`; the local managed worktree is detached at PR head `e7971dbde1f09cf2f1569bd101517704192bf46d`, whose tree contains the #29 modularization. The shared Git metadata is read-only, so local `git fetch` cannot update `FETCH_HEAD`. The PR #42 merge diff shows the README architecture-path wording adjustment in addition to the branch tree; design conclusions below concern the inspected code and are cross-checked against the canonical merged commit metadata.
- Issue #2 remains open and still says #3 is the first recommended slice. Live Issue #4 remains open and READY FOR PLANNING. Issue #4's body has the required bounded semantic path, evidence protection, native compaction, and conservative scope.
- `package.json` and `package-lock.json` pin `@opencode/plugin` to `2.0.7`. Project docs and E2E scripts identify OpenCode server `2.0.11` as the tested runtime.

### OPJEV runtime and authority seams

- `src/hooks.ts` registers `tool.execute.before` for internal tool authority, `tool.execute.after` for tool error observation, `session.hook("prompt")` for prompt admission/routing, `session.hook("context")` for model-request context instructions, and `session.hook("retry")` for provider retry policy. The current `context` registration is nested under `enableAutoRoute`; a future context-management registration must be independent of that routing option. The repo does not register a compaction hook or subscribe to compaction events.
- `src/plugin-runtime.ts` builds worker, critic, and orchestrator runtimes and supplies the dispatcher's `resourceBudget` and bounded `observeResource` seams. `src/worker-hooks.ts` provides role-specific instructions; workers do not self-approve, critics remain read-only, and orchestrators only propose bounded contract revisions.
- `src/orchestration/types.ts` defines bounded `ExecutionContract` and `EvidencePacket`. `src/orchestration/state-machine.ts` is a pure deterministic transition function, validates evidence round identity, requires evidence before verdict, and owns terminal/recovery/human boundaries. `src/orchestration/dispatcher.ts` owns worker/critic execution, checkpoint persistence, evidence construction, Jev judgement calls, and resource-policy checks. `src/orchestration/critic.ts` is a pure bounded verifier parser/prompt builder; invalid critic output is a verification failure, not approval.
- The dispatcher persists run checkpoints through `orchestration/run/<runID>` with lifecycle kinds including worker-created, evidence-ready, verdict-applied, human-awaiting, human-decision, and run-failed. Its `observeResource` seam is best-effort and bounded; the Resource Governor enforces separately.
- `src/resource-governor/usage-ledger.ts` is a sanitized fixed-capacity observation ring. `src/resource-governor/storage-sink.ts` stores it at `resource/usage-ledger/v1`, capacity 2,048, with a 256-write process-local pending limit. `src/resource-governor/runtime-policy.ts` reads it under the quota-enforcement lock. `src/resource-governor/pressure-estimator.ts` emits separate quota, rate, context, execution, and availability signals; missing evidence stays `unknown`, and this version has no evidence-backed `normal` profile. `budget-policy.ts` authorizes spend only; it never chooses a route or executor.
- `docs/resource-budget-governor.md` says context overflow remains with native OpenCode compaction and that no completed compaction is fabricated when the runtime does not expose it. `docs/model-performance-intelligence-observe.md` confirms #5 reads the same resource ring without creating another ledger or affecting execution.
- The existing tests cover state-machine evidence/round invariants, dispatcher ordering and budget boundaries, read-only critic behavior, and bounded governor storage/policy. They do not test a context pruner because none exists.

### OpenCode hooks actually available to the project

Evidence is the project's locked `@opencode/plugin@2.0.7` declarations installed from `package-lock.json`, the project plugin registration in `index.ts`, and the runtime/version assertions in `scripts/e2e-gateway.mjs`, `scripts/e2e-multiround-real.mjs`, and `README.md`:

- The SDK's `SessionHooks` has `context`, `compaction`, and `retry`. Both `SessionContext` and `SessionCompaction` expose mutable request `system` and `messages`; `SessionCompaction` additionally has an optional `result.summary` which skips the native model request. A context or compaction hook therefore edits the request presented to that operation. It does not replace durable session history.
- The SDK's tool hooks are `execute.before` and `execute.after`. The after event identifies `tool`, `sessionID`, `agent`, `messageID`, call `id`, `input`, and either completed `result` or `error`. These are observation seams, not a history-deletion API.
- The locked client's event type includes `session.compaction.started`, `.ended`, and `.failed`; `ctx.event.subscribe` can observe them. The completed event carries native compaction text/recent-context and optional usage/cost fields, but is post-compaction observation, not a pre-compaction filter or authority to change the native result.
- The existing project uses the SDK domains `ctx.session.hook(...)` and `ctx.tool.hook(...)`, rather than the older returned V1 plugin-object event form. Current OpenCode docs also describe newer API generations; they are not used as proof of the project's v2.0.11 behavior.
- The compaction SDK field `result` can short-circuit the native summarizer. V1 must leave it unset. The future bridge can add bounded preservation guidance to the native compaction request and the `context` hook can re-inject canonical OPJEV state into later primary requests. Neither action claims to control the exact prose generated by OpenCode's summarizer.

The pinned SDK declarations prove the request hooks and field shapes used by this package; the repository's documented real E2E target is OpenCode 2.0.11. This design does not claim a new live 2.0.11 compaction-hook E2E observation. The implementation's promotion gate must exercise the exact installed 2.0.11 binary, including both hooks and native compaction.

## 4. Invariants

1. The orchestration kernel is the only authority for `ExecutionContract`, `EvidencePacket`, deterministic checks, round, acceptance/verdict, recovery, and human escalation. Context Management is a projection/retention advisor only.
2. Every asset tied to current or binding evidence is `KEEP`. Ambiguous or unmappable protection is `KEEP`. Jev cannot change a protection result.
3. Pruning changes only the outgoing model request representation. Durable OpenCode history remains intact and recoverable; there is no direct storage-history mutation.
4. A tool call and its result/failure form one indivisible pruning group. A group is removed or payload-projected as a whole, or kept as a whole. Unpaired, malformed, or partially observed tool interactions are kept.
5. Human messages are immutable. Normal agent text is not a generic candidate. Only tool call/result parts and separately identified artifacts derived from tool results can be candidates.
6. All storage, candidate batches, input descriptors, and summaries are bounded. Raw prompts, full tool inputs, arbitrary outputs, secrets, and model chain-of-thought are never copied into the ledger or Jev request.
7. Deterministic rules run before semantic review. Jev sees only a bounded set the deterministic pass marked genuinely ambiguous. Low confidence, timeout, unavailable Jev, malformed/incomplete response, cache miss with exhausted budget, or policy denial means `KEEP`.
8. Resource Governor answers whether a bounded Jev pruning call is affordable. It does not decide which executor/model/route is used and does not decide evidence protection.
9. Native compaction remains OpenCode's safety net. OPJEV never recursively invokes compaction or changes its model, routing, or orchestration state.
10. No metric or promotion gate rewards more bytes dropped at the expense of acceptance, evidence validity, or recovery correctness.

## 5. Alternatives evaluated

| Approach | Advantages | Costs and risks | Decision |
|---|---|---|---|
| A. Request-local projection in `session.hook("context")` and `session.hook("compaction")`, backed by a bounded asset index | Uses the exact SDK seams the project already consumes; keeps durable transcript untouched; deterministic functions can be pure and independently tested; preserves native compaction; does not enter routing or kernel transitions | Requires request-time pairing and evidence lookup; missing/stale ledger data must default to KEEP; native compaction guidance is not a promise about generated prose | **Recommend.** It is the narrowest authority expansion and is directly supported by the locked SDK. |
| B. Rewrite or delete durable session messages through storage/RPC | Could permanently reduce transcript size and expose a canonical retained history | The public SDK in use has no supported durable-history replacement API; private RPC/core internals would create version coupling, break call/result integrity, risk human-message mutation, and compete with native compaction | Reject for v1. Do not infer or invent a history-mutation API. Revisit only if OpenCode publishes a safe public replacement contract. |
| C. Put all tool assets and pruning policy inside the orchestration dispatcher/kernel | Evidence relationships are visible at run boundaries; enforcement can be tightly coupled to `EvidencePacket` | Misses ordinary user-session tool context, bloats the dispatcher/kernel, makes hook behavior dependent on orchestration, and risks introducing new kernel authority | Reject as primary architecture. Use a narrow internal checkpoint-to-protection adapter only to project protection facts; never put pruning decisions in the kernel. |

Approach A best satisfies low trust expansion, low coupling, testability, request-cost control (metadata-only batches), natural hook integration, and compatibility with OpenCode's native compaction lifecycle.

## 6. Chosen architecture

Keep `src/hooks.ts` as registration/wiring. Implement future pure components under a small `src/context-management/` boundary, with runtime adapters in `plugin-runtime.ts` only where existing dependency construction requires them:

```text
context-management/types.ts                 bounded contracts and enums
context-management/ledger.ts                schema, keyed upsert, capacity, TTL
context-management/protection.ts            deterministic protected-set projection
context-management/deterministic-pruner.ts  pure KEEP/TRUNCATE/DROP candidates
context-management/semantic-boundary.ts     batch/cache/response validation only
context-management/compaction-bridge.ts     bounded state guidance for native hook
context-management/metrics.ts               bounded aggregate context metrics
```

The context hook adapter observes tool lifecycle, reads one bounded ledger snapshot, protects first, plans deterministic actions, optionally asks Jev through one bounded boundary, then projects only allowlisted tool groups into the outgoing request. The compaction hook uses the same protection and projection pipeline for the native summarization request, adds a short state-preservation instruction, and leaves `event.result` unset. No component schedules work or starts orchestration.

An internal adapter maps the dispatcher's existing persisted run checkpoint/session identity to a bounded protection snapshot. It must not alter public kernel contracts. If an exact mapping cannot be proven, mark that worker session's tool assets unknown/protected. Critic and orchestrator session messages are always protected; V1 does not prune their tool context.

## 7. Conceptual contracts and bounded fields

All limits below are V1 design ceilings. A later implementation may choose smaller limits after measuring fixtures; it must not silently increase them without a spec revision. Text descriptors are allowlisted labels, never arbitrary source payloads.

```ts
type RetentionAction = "KEEP" | "KEEP_IDENTITY_TRUNCATE_PAYLOAD" | "DROP";
type ProtectionState = "protected" | "clear" | "unknown";
type EvidenceRole =
  | "none" | "required-evidence" | "deterministic-check"
  | "evidence-packet" | "critic-finding" | "binding-decision" | "unknown";

interface ContextAssetV1 {
  schema: 1;
  assetID: string;               // 64 hex SHA-256, stable for this observed part
  groupID: string;               // 64 hex, atomic tool call/result identity
  sessionRef: string;            // 64 hex; do not persist raw session ID
  runRef?: string;               // 64 hex only when dispatch linkage is proven
  round?: number;                // positive bounded integer
  role: "user-session" | "worker" | "critic" | "orchestrator" | "unknown";
  source: "tool-call" | "tool-result" | "tool-failure" | "tool-artifact";
  tool: string;                  // allowlisted identifier, <= 80 chars
  callRef: string;               // 64 hex; links call, result, and failure
  messageRef?: string;           // 64 hex message ID fingerprint
  entityRef?: string;            // 64 hex normalized entity/path fingerprint
  payloadBytes?: number;         // measured UTF-8 bytes, clamped to safe integer
  fingerprint?: string;          // 64 hex over bytes observed in memory
  createdAt: number;
  lastReferencedAt?: number;
  supersededBy?: string;         // assetID, only on a deterministic exact relation
  evidenceRoles: EvidenceRole[]; // max 8, stable enum only
  protection: ProtectionState;
  retention: RetentionAction;
  confidence?: "high" | "medium" | "low"; // semantic decision only; absent otherwise
}
```

`Context Asset` represents metadata about a part/group, not a copy of that part. For future call events, compute fingerprints transiently; persist only the digest, byte count, stable identifiers, safe labels, and enumerated policy result. Never persist raw tool input/output, message text, shell commands, paths, credentials, headers, prompts, or Jev reasoning. For path equality, use a keyed or ordinary cryptographic digest of a normalized path; do not persist the path itself. A missing tool-specific normalization means `entityRef` is absent and no same-entity rule applies.

Reject malformed records as unusable metadata. Do not repair them by guessing. Unknown schema/version, missing call/result linkage, missing timestamp, oversized identifier, invalid enum, or expired record yields `KEEP` for the matching request content.

## 8. Ownership and authority boundaries

- **Hook adapter:** observes events and transforms only the outgoing request's tool parts. It has no authority over orchestration commands.
- **Context Ledger:** owns asset metadata and last bounded retention outcome. It is not the resource/accounting source, not run state, and not an evidence store.
- **Protection projector:** reads persisted kernel-owned run state and determines an allowlist of assets that may be considered. It cannot author or revise a contract, evidence packet, verdict, or recovery decision.
- **Deterministic pruner:** emits conservative candidate classifications and allowed actions. It cannot call Jev, inspect secrets, alter resource policy, or mutate source history.
- **Semantic boundary:** may adjudicate only deterministic `AMBIGUOUS` candidates and only return a subset of requested candidate IDs plus allowed retention enums. It cannot remove protection or add IDs.
- **Resource Governor:** grants/denies semantic-call budget based on existing pressure facts plus current request-size observation. It cannot choose the candidate action or route.
- **OpenCode:** remains owner of active request lifecycle and native compaction.
- **Kernel/dispatcher:** remain sole authority for run lifecycle, `ExecutionContract`, `EvidencePacket`, round budgets, acceptance, recovery, and human gates.

No changes to public `ExecutionContract` or `EvidencePacket` are needed or allowed for convenience. Future provenance is an internal sidecar keyed by hashed session/call identities and derived from existing dispatcher checkpoint events.

## 9. Context Ledger contract

The proposed store is `context/asset-ledger/v1`, schema `1`. It contains only a fixed-size ring of up to **2,048 tool invocation groups total** (each group has a maximum of one call record and one result/failure record, each record at most 512 serialized bytes), with a **24-hour metadata TTL**. It may retain fewer entries when a per-session cap of **256 groups** is reached. It has no raw asset payload. Eviction order is oldest observation first; stale, malformed, unknown-role, and incomplete groups never become pruning permission.

The Context Ledger is a distinct contract because it models the identity/linkage/retention state of tool-context assets. It does not record requests, token usage, pressure, retries, provider errors, or outcomes. Those remain exclusively in `resource/usage-ledger/v1`, which #5 also consumes. Resource Governor reads the existing resource ledger and quota latch; it does not read or aggregate a second resource-usage stream from the Context Ledger. Context-specific before/after sizes and decisions belong only in bounded context metrics.

Write keying is stable: session, message, call, and part identifiers are hashed to fixed-length references. Upsert by `groupID` and event identity is idempotent. Serialize updates through one process-local owner queue/lock, with a pending limit of **128 writes**; if saturated, drop the observation, count an overflow metric, and treat the asset as unknown/KEEP. A read-modify-write failure, competing generation, stale version, or suspected cross-process race disables enforcement for affected data. The public storage API does not provide cross-process compare-and-swap; active enforcement is therefore permitted only where the runtime provides a single-writer plugin storage process. Never claim cross-process atomicity from the existing process-local lock.

## 10. Evidence protection: hard invariant

Protection is computed before deterministic or semantic pruning. The projector consumes the canonical persisted run state and maps it to the following protected categories:

1. **`ExecutionContract.requiredEvidence`:** evidence labels remain canonical in the kernel state. Assets proven by explicit run/session/call/artifact linkage to an outstanding requirement are protected. If the mapping is absent or ambiguous, all tool groups from the current worker session/round are protected.
2. **Current deterministic checks:** the specific inputs/results referenced by each current check remain protected through evidence creation and judgement. Without exact linkage, protect all tool groups for that worker round.
3. **`EvidencePacket`:** the complete normalized packet, its `deterministicChecks`, `criticFindings`, `artifacts`, and `resultSummary` remain in the canonical `orchestration/run/<runID>` checkpoint. Any asset directly referenced by those packet fields is protected. Since the current packet carries bounded summaries rather than a full provenance graph, unknown correspondence protects the whole originating round's tool groups.
4. **Material critic findings:** every finding remains protected while its verdict/recovery is pending. At minimum critical and important findings are material; V1 conservatively treats all findings as material. Related assets stay protected until a later kernel-owned checkpoint proves the decision is no longer binding. If the asset cannot be tied to a finding, protect the full round.
5. **Binding decisions and recovery:** pending verdict, repair/fresh/switch/replan, human-awaiting request, human decision, or incomplete dispatch state protects the assets those decisions rely on. Until the next persisted state transition clears the binding decision, the full associated round stays protected.

Protection proof is a deterministic per-group result with a reason code and source checkpoint version. The check is fail-closed:

```text
any protected evidence reference     -> protected / KEEP
active orchestration, mapping unclear -> unknown / KEEP
critic or orchestrator session       -> protected / KEEP
ledger/checkpoint unavailable/stale  -> unknown / KEEP
only a complete, exact, unbound group -> eligible for pruner classification
```

Jev is never sent a protected/unknown group. A valid Jev response cannot name an ID outside the deterministic ambiguous batch; invalid IDs and any attempted protection override invalidate the full batch and yield KEEP. V1 cannot claim that every tool result is outside the proof chain merely because a summary exists.

## 11. Deterministic Pruner V1

The output for each atomic group is exactly one of `KEEP`, `KEEP_IDENTITY_TRUNCATE_PAYLOAD`, or `DROP`. Apply rules in this order: protection/role, recent-window, pair integrity, exact deterministic equivalence, supported supersession, bounded payload projection. The first matching `KEEP` barrier wins. Do not turn a likelihood into a deterministic fact.

| Case | `KEEP` | `KEEP_IDENTITY_TRUNCATE_PAYLOAD` | `DROP` |
|---|---|---|---|
| Incomplete call/result/failure group; unknown tool/result shape; failed lookup; expired or stale ledger | Always | Never | Never |
| Required evidence, active deterministic check, packet, critic finding, binding decision/recovery, or unknown protection | Always | Never | Never |
| Recent context: newest 8 complete tool invocation groups in the session/request | Always | Never | Never |
| Exact duplicate fingerprint | If either group is protected/recent, call semantics are not allowlisted read-only, the part is not a complete pair, or stable group IDs are missing | Never by default | Only the older complete pair if both are exact byte-identical read-only observations, neither is protected/recent, both call and result can be removed together, and no canonical record refers to the older group |
| Repeated tool output with different calls | If tool is not allowlisted pure/read-only or arguments/entity digest differ | Never | Only under the exact duplicate conditions above; equal result bytes alone do not prove the calls are interchangeable |
| Older successful read superseded by later read of same entity | If path/range/query/tool identity differ, later read is partial/truncated/error, a write occurred between them, tool purity is unknown, or evidence protection is unknown | Never solely because a later read exists | Only the earlier complete pair when an allowlisted read tool confirms exact same normalized entity and query, the source supplies a monotonic generation/version proving the later read is current, and neither group is protected/recent. Equal fingerprints alone prove byte identity, not freshness. |
| Old directory/listing output followed by a file read | Keep by default: one later entity read does not supersede a listing of other entities | Never solely on this relation | Drop only an older complete listing when an allowlisted later complete listing has the same directory and exact filters/query, the source supplies a monotonic generation/version proving the later listing is current, and neither group is protected/recent; a read of one child never qualifies. |
| Same entity re-read after an observed write/mutation | Keep both: order alone is not proof of equivalence | Never | Never in V1 |
| Large result | Keep if payload can contain proof, unique details, an error, or if safe identity reconstruction is unknown | Permitted only when unprotected, outside recent window, call/result IDs are retained, the result is classified non-evidence by a deterministic tool adapter, and a stable bounded placeholder can be substituted in the outgoing request while durable history still contains the original | Never because of size alone |
| Failure/error followed by later successful check | Keep failure while any recovery, critic finding, deterministic check, or decision remains binding, or if later check is not the same operation/scope | Never solely because the later check passed | Only when the exact same scope is conclusively checked by a later deterministic pass, the failure's consequence is persisted/cleared by kernel state, neither is evidence, and both are outside recent protection; otherwise keep or mark ambiguous |

The initial tool-specific allowlist should be empty except for tools whose type and semantics are verified in E2E fixtures. Built-in tool names do not imply purity: shell commands, writes, network calls, and opaque MCP tools are never considered idempotent/read-only by name matching alone. When no explicit allowlist rule proves the relation, classify it `AMBIGUOUS` for potential semantic review only if it is unprotected, complete, and not recent; otherwise KEEP.

`KEEP_IDENTITY_TRUNCATE_PAYLOAD` must preserve the original call identity and a paired result envelope, replacing only the tool-result payload in the outgoing request with a fixed OPJEV marker containing a bounded `assetID`, safe tool label, and reason code. It must not replace the result with a fabricated success or alter any call argument. Durable OpenCode history stays original. If the runtime's message structure cannot preserve the same call/result linkage, KEEP.

## 12. Tool call/result integrity

Pair by OpenCode's observed tool call `id` within the same `sessionID` and associated `messageID`; use hashed forms in storage. Do not pair solely by order, tool name, text, or adjacent messages. A tool result or error without a known call is protected/unknown. A call without a completed result/error is protected/unknown. A result envelope must remain with its call whenever the operation consumer needs the pair.

Before projecting, validate the candidate message parts against the hook's current request snapshot. Reject projection for any group that is missing either side, duplicated inconsistently, malformed, or no longer matches the ledger fingerprints. `DROP` removes the call part and paired result/error together from this request. `KEEP_IDENTITY_TRUNCATE_PAYLOAD` preserves both linked parts and changes only the result content. Mixed assistant messages retain all non-tool text and every non-candidate part unchanged. A failed tool's identity and bounded failure class stay visible until the failure has no live consequence and the deterministic release conditions in Section 11 hold.

## 13. Semantic Pruner boundary (design only)

The deterministic pruner returns an `AMBIGUOUS` batch only after excluding protected, unknown, recent, malformed, and deterministically KEEP/DROP/TRUNCATE groups. A future Jev request receives descriptors only: pseudonymous candidate IDs, safe tool category, byte-size bucket, timestamps/age bucket, exact deterministic relation codes, and current eligibility state. It receives neither history nor payload, path, prompt, argument, secret, or evidence text.

V1 ceilings:

- Maximum **16 candidates** in one batch.
- Maximum **one Jev call per session per context/compaction cycle**, with a shared cooldown of **60 seconds per session** and a total request descriptor ceiling of **4 KiB**.
- Never issue one request per asset. If more than 16 candidates exist, adjudicate the first bounded batch by stable oldest-first order; leave the remainder KEEP/ambiguous for this cycle.
- Cache by hash of ordered candidate descriptors + policy version for **10 minutes**. Cache only schema-valid decisions; cache miss or expiry never itself permits pruning.
- Accept only one result per submitted candidate, each result an allowed retention enum plus confidence. Reject duplicates, unknown IDs, omitted IDs, extra data, malformed JSON/schema, or attempted protection changes as a whole-batch failure.
- `confidence < 0.90`, missing confidence, timeout, unavailable Jev, resource denial, or any parse/transport error means KEEP. No retry inside the cycle.
- Jev can choose KEEP or a less-retentive action for an eligible ambiguous asset only. It cannot upgrade deterministic protection, expand the candidate set, change tool identity, mutate the kernel, or write to source history.

These limits cap context/cost exposure, not semantic correctness. The projection layer revalidates every result against the current request and protection snapshot immediately before use; changed version/fingerprint means KEEP.

## 14. Resource Governor integration

Resource Governor determines whether Jev pruning is worth the bounded cost. It consumes the existing resource ledger, quota latch, and current context-size observation; it creates no accounting stream. The decision is an internal spend permit for a single optional pruning call, not a route or action decision.

| Resource state | Context size | Semantic behavior |
|---|---|---|
| Any pressure signal critical, active quota latch, malformed enforcement record, or quota latch read failure | Any | Zero Jev calls for pruning. Deterministic rules only; native compaction stays available. |
| High pressure | High | Deterministic first. Semantic call only if a future explicit policy says the bounded call is allowed; V1 default is deny. |
| Low pressure with sufficient observed coverage | High | A semantic batch may be eligible only when its conservative estimated savings exceed the bounded descriptor plus expected response overhead. Governor permits spending; the boundary still defaults invalid/uncertain decisions to KEEP. |
| Moderate pressure, unknown pressure, missing coverage, storage error, or context size unknown | High or unknown | Deterministic only; no Jev pruning call. Unknown does not mean low. |
| Any pressure | Low | No semantic call. Deterministic safe projection may still run at its rollout stage. |

The current estimator deliberately leaves absent dimensions unknown and does not establish a low-pressure quota baseline. Therefore current evidence alone does **not** make semantic pruning eligible. A future spec-approved change may define sufficient low-pressure coverage using observed local signals; it must not invent a quota percentage or claim official remaining quota. A `context-prune` policy seam may be added later to the pure governor; it must use current pressure facts, must not widen `ExecutionContract.maxRounds`, and must never route, select models, agents, or recovery.

## 15. Compaction Bridge

OpenCode's native compaction remains the runtime's authority and safety net. The V1 bridge is a small `session.hook("compaction")` adapter using the SDK request fields that exist today:

1. Read the bounded latest canonical OPJEV run checkpoint, if the session is linked to an active run.
2. Add a compact, deterministic preservation instruction to the native compaction request's `system` context; include only fields already present in canonical state, with existing bounds.
3. Apply the same protection-first, paired tool projection to the compaction request's mutable `messages` only when the rollout stage allows it.
4. Leave `event.result` unset so OpenCode performs its native summary operation. Do not replace `event.prompt` (not a field of the locked SDK contract), call compact RPC, or ask the worker to continue.
5. After native compaction, `session.compaction.ended` may be counted as an observation if the runtime supplies the event. It does not authorize context pruning or alter run state.
6. On each later primary `context` request, re-inject the canonical bounded OPJEV state independently of the prose summary.

The canonical bridge payload preserves, when present: **objective; current round; executor identity (agent/model/session reference); relevant acceptance criteria; `requiredEvidence`; normalized current `EvidencePacket`; outstanding blockers; binding verdict/decision; recovery action/state; human-awaiting/request ID and decision state; and the next kernel-authorized step**. The payload is a bounded projection of stored kernel/dispatcher state, not a new interpretation. Do not include irrelevant prior rounds; include the minimum active facts and refer to older evidence by bounded identity when already available.

If canonical state cannot be loaded/validated or does not fit the established budget, fail closed for pruning and omit the bridge addition rather than substituting a guessed summary. Native compaction proceeds according to OpenCode. The next context hook still uses only validated persisted state; absent state remains absent.

The bridge MUST NOT set a fabricated native result, replace native compaction, create a compaction loop, call orchestration, create a round, change `maxRounds`, choose/change routing/model/agent, or reinterpret acceptance/verdict. It cannot guarantee that OpenCode's generated prose faithfully includes every preservation instruction; the canonical re-injection is the structural guarantee for OPJEV-owned run facts.

## 16. Lifecycle and data flow

1. **Before tool execution:** existing `execute.before` authority checks run unchanged. Context Management does not mutate tool arguments or authorize a tool.
2. **After tool completion/failure:** observe the SDK event's bounded identity fields; compute transient hashes/byte count; create or upsert an incomplete call record then atomically complete its group. Do not persist raw `input`, `result`, or `error`. Event/storage failure only loses an observation.
3. **Protection refresh:** use dispatcher-owned persisted state and explicit worker-session linkage. A missing link means role unknown and KEEP. Refresh protection after evidence-ready/verdict/recovery/human checkpoint changes.
4. **Before primary model request:** read one snapshot, validate version/TTL/pair linkage, classify protection, apply recent guard, generate deterministic decisions, and optionally call semantic boundary if governor permits and rollout allows. Revalidate and transform only tool call/result parts in the current outgoing `messages` array.
5. **Before native compaction request:** run the same pipeline against the compaction hook's request message array; attach canonical state instructions; leave native result unset.
6. **After compaction:** count native compaction only when `session.compacted` is observed. Do not mutate kernel or write inferred token savings.
7. **On termination/expiry:** retain bounded evidence facts in existing run checkpoint; expire asset metadata by TTL/capacity. An expired or evicted asset is not treated as safe to drop; its request counterpart stays KEEP.

## 17. Failure behavior

All errors fail closed for the affected decision:

- Tool hook emits malformed/unavailable data: no valid asset mapping, so KEEP.
- Storage unavailable, saturated, corrupt, stale, or version mismatch: deterministic projection disabled for affected groups; native compaction untouched.
- Run checkpoint missing or inconsistent with the session link: worker group protection becomes unknown; KEEP.
- Pair mismatch, fingerprint mismatch, result without call, call without result, or unsupported tool structure: KEEP the entire surrounding interaction.
- Deterministic classifier cannot prove a rule: KEEP or mark a bounded ambiguity only if all protection/recent checks pass.
- Governor read/latch error or quota latch: zero semantic Jev call; no policy override. Deterministic eligible actions remain subject to rollout mode.
- Jev timeout/unavailable/malformed/partial/low confidence: KEEP the full batch; no retry in the cycle.
- Native compaction hook failure: do not cancel/replace OpenCode compaction when the plugin can safely catch the expected failure; preserve the raw context request and let the native path proceed. If the host treats hook failure as fatal, a future exact-version E2E must prove the adapter never throws for expected errors.
- Projection inconsistency detected after plan: discard the whole affected plan and send original messages.

No fallback is allowed to a more aggressive action. `KEEP` is the universal error result.

## 18. Concurrency, identity, idempotency, and bounded retention

Stable digest identities use versioned canonical inputs and never rely on text similarity. `groupID` is derived from session hash + OpenCode call ID; `assetID` also includes part kind/message reference. Repeated hook delivery upserts the same group. A different content fingerprint for an already observed identity invalidates its prior decision and resets it to unknown/KEEP.

The Context Ledger read/modify/write queue is single-process and bounded as in Section 9. Request projection reads a snapshot with generation/time; any concurrent update changes generation and invalidates the pending projection plan. Hook ordering follows OpenCode registration order and does not grant cross-plugin exclusivity. If another plugin edits the same outgoing messages, OPJEV revalidates the exact parts immediately before its callback ends and otherwise keeps them.

No claim is made for multi-process shared-storage atomicity. A host deployment that runs multiple writers against the same session storage must remain OBSERVE/SHADOW until a true compare-and-swap or transaction primitive exists. Capacity pressure drops context metadata, never evidence or conversation history.

## 19. Security and secrets

The ledger is metadata-only. Never store human text, prompt text, shell command bodies, file contents, tool output text, stack traces, arbitrary metadata, credentials, tokens, headers, URLs with credentials, or Jev chain-of-thought. Hash equality identifiers with SHA-256; for potentially low-entropy secret-bearing input fingerprints, use a process/session-scoped HMAC key if available rather than a reusable raw SHA digest. Secret-safe hashing availability is a promotion dependency; if unavailable, omit the input fingerprint and disable rules that require it.

Do not send raw tool results or complete session history to Jev. The descriptors are minimized, count/size-capped, and validated against a strict response schema. Logs/metrics contain only enums, counts, bounded byte estimates, version numbers, and hashed IDs. Avoid logging hash material for low-entropy secret-bearing inputs. Apply TTL and capacity eviction to identifiers as well as decisions.

Tool content is untrusted data. It cannot set protection state, alter rule allowlists, forge call IDs, write ledger records, or inject instructions into the bridge. A tool's own text claiming it supersedes evidence is not proof.

## 20. Observability and metrics

Use a separate small bounded `context/metrics/v1` aggregate for context-specific measurements; it does not duplicate provider/request/token/resource observations in `resource/usage-ledger/v1`. Reuse the existing resource ledger for observed token usage, acceptance/failure outcomes, context-overflow events, and native compaction events when available. Missing runtime fields remain absent.

Required dimensions per bounded window/stage:

- Estimated outgoing request UTF-8 bytes before and after projection; token counts only when supplied by runtime. Any estimator-derived tokens must be labelled `estimated` with algorithm/version, never mixed with observed tokens.
- Asset group counts for KEEP, KEEP_IDENTITY_TRUNCATE_PAYLOAD, and DROP; separately count protected/unknown/recent groups that prevented pruning.
- Decision counts by deterministic vs semantic source and rule code; count cache hits, misses, Jev calls, timeouts, malformed responses, and policy-denied calls.
- Native compactions observed and context overflows observed; never infer a compaction merely from a large prompt.
- Acceptance/evidence regression observations joined to existing canonical outcomes by hashed run ID; show denominators and unknown/missing linkage. Do not attribute causation from an unpaired aggregate.
- Projection errors and storage/queue overflow counts.

Do not rank configurations by DROP count or bytes saved alone. Report savings beside protected asset counts, Jev cost, context overflow, acceptance, evidence validity, and uncertainty. A missing outcome/evidence link blocks promotion; it is not a zero-regression result.

## 21. Rollout and promotion gates

| Stage | Behavior and allowed authority | Telemetry | Promotion gate | Rollback/fail-closed |
|---|---|---|---|---|
| **OBSERVE** | Observe tool lifecycle and request sizes; populate bounded metadata; no decisions alter `messages`; no Jev pruning call | Asset coverage, pairing rate, storage loss, before bytes, current native compactions/overflow | Exact-v2.0.11 E2E confirms event identities/shapes; no human text/output persistence; bounded storage; linkage/coverage documented | Disable observer; existing routing/governor/compaction unchanged |
| **Deterministic SHADOW** | Compute protection and deterministic actions but send original messages unchanged; no Jev | Proposed action/reason, protected/unknown rates, estimated before/after sizes, pairedness | Fixture and real-host checks prove every action is pair-safe, evidence-protected, role-safe; unresolved cases remain KEEP; no missing evidence links | Return to OBSERVE; clear policy cache; no transcript rollback needed |
| **Deterministic ENFORCE** | Apply only deterministic pair removals/placeholders for exact safe allowlisted rules; never semantic actions | Same metrics plus actual request delta and acceptance/evidence/overflow comparisons | Maintainer gate: exact-host E2E for user immutability, pair integrity, evidence/recovery, native compaction; no acceptance/evidence regressions across agreed reference workload; measured net request reduction exceeds adapter overhead | One local feature/policy switch returns to SHADOW; original durable transcript is intact |
| **Semantic SHADOW** | For unprotected deterministic ambiguities only, governor may allow one cached/bounded Jev batch; do not change outgoing messages | Calls, cache, cost, confidence, proposed actions, and deterministic-vs-semantic comparison | Bounded one-batch invariants, schema rejection, timeout/unavailable/latch tests all KEEP; measured overhead less than estimated savings; maintainer approves semantic response contract | Disable boundary and return to deterministic ENFORCE or SHADOW |
| **Bounded Semantic ENFORCE** | Apply only schema-valid high-confidence decisions on eligible IDs after final protection/fingerprint recheck; no authority over anything else | Full metrics, decision provenance/version, outcome/evidence comparisons | Staged cohort/reference E2E and production observation show no evidence/acceptance regression; low-confidence/unknown coverage never pruned; explicit maintainer approval | Disable semantic enforcement immediately; retain deterministic mode only if its independent gate remains valid |

Do not skip stages. A feature/configuration error defaults to OBSERVE/KEEP. Promotion does not change routing or the #5 OBSERVE stage.

## 22. Test strategy for the future implementation

Pure unit tests: schema sanitization and bounds; digest identity/idempotent upsert; exact duplicate/supersession rules; every row in the deterministic table; evidence protection precedence; recent 8-group guard; tool allowlist semantics; pair integrity; malformed/stale schema fail-closed; governor eligibility across low/moderate/high/critical/unknown/latch; semantic batch size/cooldown/cache/TTL/strict full-response coverage/confidence; bounded metrics without token fabrication; canonical bridge field selection and byte cap.

Hook adapter tests: actual `SessionCompaction`/`SessionContext` request shapes from the locked SDK; tool-before authority ordering unchanged; tool-after success/failure, missing correlation IDs, out-of-order events, duplicate hook delivery, mutation of mixed assistant messages without changing their text parts, result placeholder linkage, no durable history mutation, no `event.result` assignment, and no call to compaction RPC.

Property/fuzz tests: arbitrary tool payloads, malformed IDs, oversized values, duplicate result groups, storage write races, corrupted ledger, malformed Jev output, and generation changes always produce original request/KEEP. Tests must assert user messages remain byte-equivalent and `ExecutionContract`/`EvidencePacket` state is untouched.

## 23. Future real OpenCode E2E required

Run with the exact OpenCode `2.0.11` server binary and real plugin packaging path exercised by `scripts/install-plugin.mjs`. Add a controllable test tool that produces a call, result, and failure with observable call IDs; drive multiple turns through actual context and compaction hooks.

Required proof: (1) human messages and normal assistant text remain byte-identical; (2) allowed DROP removes both matching call and result from outgoing request only while durable `session.context` history still includes originals; (3) placeholder keeps the call/result pair valid; (4) missing/invalid asset or run mapping sends original messages; (5) an active `requiredEvidence`, check, packet, critic finding, or recovery protects its linked round; (6) worker/critic/orchestrator roles retain their existing boundaries; (7) Jev gets only bounded ambiguous metadata, one call maximum, and every failure yields KEEP; (8) quota latch/critical pressure produces zero pruning Jev calls; (9) native compaction still executes with the same OpenCode operation and preserves canonical run facts into the next primary request; (10) no new round, routing change, acceptance reinterpretation, or compaction loop; and (11) byte/token/decision/compaction/overflow metrics reconcile with observed runtime events.

The current `e2e:matrix` and existing orchestration/governor tests remain regression gates, not substitutes for this real-host proof.

## 24. Known risks

- The current `EvidencePacket` has bounded summaries and artifact strings but no per-tool-part provenance graph. Until explicit mapping exists, whole worker rounds may be protected, reducing savings.
- The public SDK exposes mutable request messages but no durable transcript replacement. Native compaction still sees durable source history; filtering its summarization request only affects the summary request and must be carefully tested against runtime checkpoint behavior.
- Native summary generation is probabilistic. The bridge instruction alone cannot guarantee exact preservation; canonical re-injection is required and only applies to OPJEV state.
- Tool semantics, output truncation, and call/result message part shapes vary. An empty allowlist and KEEP behavior may be necessary initially.
- Resource Governor currently has no evidence-backed low-pressure baseline. Semantic pruning eligibility may remain false until additional observed coverage exists.
- Plugin hooks execute in registration order alongside other plugins. A concurrent/earlier/later context transformation may invalidate an OPJEV plan; final request-shape revalidation is mandatory.
- Process-local locking is not cross-process atomicity. Shared storage across server instances blocks enforcement absent a stronger primitive.
- Byte counts are not exact tokens. Estimates must not be presented as observed token savings.

## 25. Questions explicitly deferred

1. Which exact OpenCode built-in tools, if any, have proven read-only, complete, deterministic semantics suitable for same-entity supersession?
2. What runtime signal best proves a tool result is complete and not truncated, including MCP/provider-specific results?
3. What deterministic provenance format can link `requiredEvidence` and each `EvidencePacket` field to tool-call group IDs without changing public contracts?
4. What evidence coverage is sufficient to label Resource Governor pressure low for semantic-call eligibility, given current unknown dimensions?
5. Should the semantic confidence threshold or fixed cooldown change after measured Jev SystemOne behavior? Any change requires a new review; low confidence remains KEEP.
6. Does OpenCode 2.0.11 persist native compacted context in a way that can be proven byte-for-byte unchanged when OPJEV only edits compaction request messages? Exact runtime E2E must answer before enforcement.
7. Is there a future supported public API for durable message-window replacement? V1 does not depend on one.
8. What retention window for context metrics best supports acceptance/evidence regression analysis without expanding stored identifiers?

These questions do not block OBSERVE or deterministic SHADOW. Questions 2–4 and 6 block the corresponding enforce stages when their facts cannot be established.

## 26. Proposed implementation decomposition (not an implementation plan)

After written-spec approval, a separate implementation plan should consider these units in order:

1. Add bounded conceptual types, sanitizer, asset IDs, fixed-capacity context ledger, and metadata-only tests.
2. Add exact-version tool lifecycle capture and pairing with OBSERVE-only telemetry; characterize real event/message shape.
3. Add dispatcher/session-role linkage and a pure protection projector over persisted canonical run checkpoints; unknown mapping protects the whole affected round.
4. Add deterministic classifier/pruner and request-local pair-safe projection in SHADOW mode; no Jev calls.
5. Add native compaction guidance and post-compaction observation, proving `result` remains unset and native compaction is still executed.
6. Add governor eligibility seam and semantic batch/cache/schema boundary in SHADOW mode only after deterministic protection is proven.
7. Promote deterministic and then bounded semantic enforcement through the stages and gates in Section 21; each stage remains independently switchable and rollback-safe.

This decomposition is a boundary proposal only. It does not authorize writing a plan or implementing any stage before the maintainer reviews this spec.

## References

- [Issue #2 — adaptive resource and context governance](https://github.com/pedro-labsabs/opjev/issues/2)
- [Issue #4 — adaptive context management](https://github.com/pedro-labsabs/opjev/issues/4)
- [PR #42 / merge commit `96cef8b`](https://github.com/pedro-labsabs/opjev/commit/96cef8b8e454260040e68dd2123aa487d4d3cd7f)
- [OpenCode plugin documentation](https://opencode.ai/docs/plugins/) — current docs are not used as historical v2.0.11 API proof; locked `@opencode/plugin@2.0.7` types and repository E2E target are the project-specific evidence.
