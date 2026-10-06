# Model Performance Intelligence: OBSERVE v1

OBSERVE reads the existing `resource/usage-ledger/v1` ring. It does not create
another ledger or write aggregate state. `buildObserveProfiles` sanitizes the
bounded observations it receives, filters them to a caller-supplied time window,
and calculates profiles on demand.

## Facts and cohorts

The dispatcher records bounded worker facts already available at runtime:
route when the router supplied one, exact model ID, agent, round, prompt/request
boundary, observed token counters, recovery action, and the acceptance and
failure class after the kernel applies a verdict. Existing structured
provider, throttle, and quota failures remain separate observations. Prompts,
messages, raw output, stack traces, credentials, and arbitrary metadata are
discarded by the shared ledger sanitizer.

V1 groups by `(route, role, agent, exact model ID)`. Missing route stays absent
and forms its own cohort. Different model IDs and incompatible routes never
share profile evidence. Family, complexity, language, context size, duration,
and tool-call count are not profiled because this runtime does not provide
reliable facts for them. The aggregator does not ask Jev to classify tasks.

## Independent dimensions

- **Capability** counts worker outcomes with a kernel-applied verdict, a known
  acceptance result, and a passing deterministic critic check. Outcomes with a
  failed verifier, environment issue, or bad contract are excluded. The
  profile reports accepted/rejected counts and their observed ratio.
- **Efficiency** reports observed worker requests, rounds, and input/output,
  reasoning, and cache tokens per accepted outcome in that cohort and window.
  Missing token counters stay absent; duration and tool-call costs are not
  inferred.
- **Availability** counts provider errors, throttles, and quota-limit facts.
  These observations never create capability samples.
- **Recovery** counts recovery rounds and actions, plus accepted outcomes that
  followed a recovery action.

Every dimension carries sample counts and an uncertainty label. The default
minimum of five capability or accepted-outcome samples is a provisional
OBSERVE policy and can be overridden in the pure aggregator. Fewer samples are
labelled `high` uncertainty; meeting the threshold is labelled `provisional`,
not scientific confidence. Freshness reports the newest observation time and
marks data stale after a configurable seven-day default. These defaults are
calibration points, not claims about model quality.

## Retention and authority

Raw observations remain in the shared fixed-capacity ring (2,048 facts) with a
256-write pending limit. Aggregates are computed from that bounded window and
are not persisted. The profile is descriptive data only: it contains no model
or agent choice, action, budget, retry, or routing instruction. OBSERVE does
not change `FREE_POOL`, static routes, executor selection, Jev calls, recovery,
kernel transitions, or Resource Governor decisions. With no profile consumer,
execution and routing remain unchanged.

SHADOW, recommendations, dynamic model selection, and any routing influence
remain outside this slice. Issue #5 is not complete.
