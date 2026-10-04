# Resource/Budget Governor (Issue #3)

## Adaptive enforcement (policy v1)

`src/resource-governor/budget-policy.ts` converts the independent estimator
signals into deterministic spend restrictions. Its evaluation window is the
15 minutes immediately before evaluation (`[now - 15m, now]`), a local runtime
heuristic and not a claim about any provider's quota or reset window. Facts
outside that interval expire naturally, so policy recovers when old pressure
observations leave the window. `unknown` remains unknown and preserves existing
contract and provider hard limits.

The policy returns only `allowed`, the bounded stage, an effective round cap,
reason, and evidence basis. It never emits an executor, route, model, agent,
or `nextAction`. The cap is always at most the current `ExecutionContract.maxRounds`;
the contract remains the absolute ceiling. Moderate rate, execution, or
availability pressure caps a run at two rounds; a switch/replan can still be
considered before the cap. High rate/execution pressure and critical quota
deny additional spending. The kernel checks before executor
selection, each worker round (including resume), and each Jev judgement. A denied
spend follows the existing bounded kernel failure/persistence path. A human
resume passes the same checks and cannot override an active signal.

Quota-limit evidence is critical. The provider retry hook records it and sets
`retry:false` immediately: there is no Jev escalation, model switch, or retry.
Global 429/529/throttle errors never call Jev or switch models. The hook permits
at most two retries across the runtime in the same 15 minute local window,
using one fixed-key counter with a timestamp and integer count, with bounded
backoff. A failed/malformed enforcement-state read denies the retry. High rate or
execution pressure blocks another Jev decision, round, switch, or replan, so a
Jev verdict cannot authorize `repair-same`, `fresh-same`, `switch-model`,
`switch-agent`, or `replan` past the hard budget.

Context overflow remains a separate context signal and leaves native provider
compaction in control; this policy does not invent a fallback. Availability
failures remain separate from capability. Provider 500 behavior can continue
through the existing escalation path while other policy dimensions allow it.
The policy cannot infer official remaining quota, provider reset times, or
fan-out the runtime does not report. Telemetry storage stays bounded and
sanitized. A policy evaluation failure fails closed at the kernel boundary;
observational sink failures remain isolated from authority decisions.

The runtime writes factual observations through the dispatcher's optional
`observeResource` seam to the shared `resource/usage-ledger/v1` storage record.
The record is a fixed-capacity ring of 2,048 observations. Appends are serialized
per plugin context with at most 256 queued writes. The dispatcher waits at most
50 ms for each asynchronous observation before continuing. Storage or telemetry
failures are isolated from orchestration; under storage pressure, new facts may
be dropped rather than creating an unbounded queue.

## Facts and estimates

`UsageObservation` is a whitelist of bounded scalar facts: timestamp, kind,
run/session, model/agent/role, round/retry, status/signal, coarse failure domain,
and token counters exposed by the runtime. Prompts, messages, raw outputs, stack
traces, arbitrary error text and unrecognized error codes are discarded. Missing
values stay absent; malformed event kinds become `unknown` and do not count as
operational failures. Observations without a known timestamp are retained as
facts but excluded from time-window estimates.

`aggregateUsage` selects a caller-specified time window and sums observed facts.
Token counters stay absent if no runtime counter was provided. The dispatcher
currently observes worker, critic and orchestrator prompt boundaries, rounds,
recoveries, escalations, provider retry-hook failures, retry decisions and
token usage exposed by those sessions. It does not fabricate fan-out, completed
compactions or usage data that OpenCode does not expose at those boundaries.

`estimateResourcePressure` derives five separate dimensions: quota, rate,
context, execution and availability. Each contains a level, confidence,
provenance and (where applicable) the observed count. Quota is `unknown` until
an explicit quota-limit error is observed; this is not a remaining-quota
estimate. Provider failures contribute to availability only when the thrown
value carries structured HTTP/provider provenance; ambiguous errors are
operational failures and are not classified as model capability failures. A
deterministic maximum dimension maps observed pressure to `conservative`,
`scarce` or `survival`. `unknown` is used when dimensions lack evidence or the
observations do not establish an authoritative low-pressure baseline. This
slice does not emit `normal`: absence of quota/capacity evidence cannot certify
normal operation. Profiles carry no routing, retry, model, agent or
`maxRounds` instruction.

Initial thresholds are local signal heuristics: an observed quota-limit maps to
critical quota pressure; one or two throttles map to moderate rate pressure and
three or more to high; one context overflow maps to high context pressure and
repeated overflow to critical; five or more retry/operational events in the
selected window map to high execution pressure; repeated provider failures map
to high availability pressure. These are counts of observed events in the
supplied window, not provider quota limits, daily request assumptions or
percentages.

## Authority and reuse

The ledger and estimator are pure reusable modules under
`src/resource-governor/`; #5 can consume the same `UsageObservation` facts and
derive capability/efficiency interpretations separately. The kernel and
dispatcher remain the only execution authority. `FREE_POOL`, hard
`ExecutionContract.maxRounds`, critic read-only policy, and explicit Jev
recovery verdicts are unchanged. There is no governor scheduler or implicit
fallback path in this slice.

This PR is `Refs #3`: it delivers the shared bounded facts, aggregation,
independent pressure estimates and observational profiles. It does not yet
apply adaptive hard-budget policies to fan-out, retries or rounds, nor observe
every provider/Jev internal request, native compaction, or subagent event.
