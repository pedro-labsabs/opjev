# Resource/Budget Governor (Issue #3, first observational slice)

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
