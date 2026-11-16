# OPJEV — Dual Decision Intelligence: design proposal and gated implementation plan

Date: 2026-11-16 | Status: PROPOSED / BLOCKED BY DOGFOOD | Tracking: #60
Baseline inspected: main@55888bbcdb4d87c4b45e8967811411f18e4e79d6.
Maintainer requested recording the design and phase plan; no runtime implementation, live API test, promotion, or merge is authorized by this document.

## 1. Context and decision

OPJEV is an independent experimental OpenCode orchestration and decision-intelligence lab (#38), not a Runstead dependency. Preserve its deterministic kernel, execution contracts, worker/critic separation, resource governor (#3), context governor (#4), factual ledger and model performance intelligence (#5). Extend decision intelligence to multiple providers without changing execution authority. The initial hypothesis is Jev for tactical routing and Gemini for evaluation/diagnosis. Neither model has been demonstrated superior in these roles. Keep the existing Jev-only behavior as baseline and rollback. Reject wholesale replacement now, mandatory double judging, and model-votes-as-proof.

### Provider facts (documentation snapshot, not live evidence)

| Property | Jev 1.13 Free | Gemini Decision 1 |
|---|---|---|
| Provider | TypeSafe model via OpenCode Console | Google Gemini API / AI Studio |
| Model ID | jev-1.13-free | gemini-decision-1 |
| Operation | Structured, non-generative | Structured, non-generative |
| Question families | noul, choice, score | noul, choice, score |
| Input | state; verify exact modalities and effective limits of free endpoint | input; text/image/audio/video/PDF; up to 256K tokens |
| Batch | multiple independent questions; existing OPJEV tools cap at 8 | up to 1,000 independent questions; not an OPJEV limit |
| Price | limited-time free; paid Jev separate | official no-cost prototyping tier; paid $0.10/M input, zero output |
| Auth | OPENCODE_API_KEY / existing OpenCode credential resolution | separate GEMINI_API_KEY (never reuse OpenCode key) |
| Endpoint | documented https://opencode.ai/inference/systemone/v1/systemone | native Decisions API; candidate https://generativelanguage.googleapis.com/v1beta/decisions, verify exact REST contract before implementation |

The current src/config.ts and README use https://opencode.ai/zen/v1/systemone and 15s Jev timeout. Compatibility of old endpoint is untested in this review; migration of that endpoint is a separate compatibility slice only if necessary and authorized. Do not assume TypeSafe direct API extended context, modalities, or limits are available through OpenCode free. Google advertises 150–250 ms latency, not an OPJEV SLA. The Google free tier is not unlimited or guaranteed permanent; exact model/project/region RPM/TPM/RPD and billing eligibility must be verified at implementation. Gemini via OpenCode is paid; use native Google for the proposed no-cost experiment. No paid fallback, account rotation, or quota circumvention.

Sources (2026-11-16):
- https://opencode.ai/docs/console/models/ (catalog, System One endpoint, question types).
- https://blog.google/innovation-and-ai/technology/developers-tools/gemini-decisions-api/ (2026-11-11 launch, context, batch, modalities, pricing/free tier).
- https://docs.typesafe.ai/concepts/system-one (provider protocol).
- https://ai.google.dev/gemini-api/docs/rate-limits (verify actual project limits).
- https://ai.google.dev/gemini-api/terms (verify data treatment/region terms).
- https://aistudio.google.com/ (project-level quota/availability).
Exact wire schema, supported authentication, model availability, terms, quotas and compatibility must be captured as versioned fixtures before any real invocation. Do not infer native Google response structure from OpenCode's System One translation.

## 2. Actual code baseline and proposed responsibilities

README and src/config.ts define FREE_POOL, ROUTE_DEFAULT_MODEL, FALLBACK_CHAIN, RouterOptions, Jev endpoint/auth and route/agent behavior. src/orchestration/judgement.ts builds the bounded RoundJudgementState and four canonical questions; parseRoundVerdict and validateVerdict enforce typed answers and cross-field invariants. src/orchestration/types.ts defines ExecutionContract, EvidencePacket, JevVerdict, failure classes and next actions; dispatcher.ts coordinates runtime, state-machine.ts is pure. Do not rename public types or move directories merely to fit the proposed design. Inspect current HEAD and pending fixes again before implementation.

| Category | Initial owner after activation | Deterministic boundary |
|---|---|---|
| Intent, task family, lane, model, agent | Jev | Eligible free candidates only; session affinity; existing policy |
| Candidate fallback / escalation selection | Jev | Only authorized remaining candidates; budget and catalog |
| Evidence sufficiency, semantic contract fit | Gemini | Objective checks, critic findings, input frontier, contract invariants |
| Failure classification and recovery action | Gemini | Deterministic known facts first; legal actions only |
| Tool recovery / context relevance | Jev baseline | Existing hooks and #4 stages unchanged; no broad reassignment |
| Ambiguity / disagreement | Optional independent second provider later | Bounded, policy-authorized, no majority acceptance |
| Execution and authorization | Kernel exclusively | No provider can mutate state, run tools or grant authority |

Jev remains operational on all existing decision sites until gated activation. Gemini initially evaluates synthetic, public or explicitly permitted minimized evidence off the active path. The existing critic is an independent generative reviewer, not replaced by Gemini. A provider recommends the recovery action (e.g. switch-model); selection of the actual eligible model is a distinct tactical decision. A deterministic outcome should not require an AI call when the facts suffice.

## 3. Architecture / boundary contract

```text
OpenCode TUI -> admission -> deterministic kernel/dispatcher
    -> decision router -> Jev adapter (tactical)
    -> worker -> independent critic -> EvidencePacket
    -> decision router -> Gemini adapter (evaluative, gated)
    -> normalized verdict -> existing deterministic validators -> transition
                   |                         |
              shared factual ledger       resource governor
```

Proposed typed boundary (illustrative, not approved API):
```ts
interface DecisionProvider {
  readonly id: string;
  readonly model: string;
  decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;
}
```
DecisionRequest: versioned decision category, bounded sanitized input, typed question IDs/instructions/criteria, allowed options, correlation/revision, deadline and budget reservation. Keep internal identifiers local; project only approved fields to wire. DecisionResult: success with normalized answers and provenance, or discriminated failure (unavailable, auth, quota, timeout, cancellation, invalid response, unsupported, policy denied). Usage/latency metadata optional/unknown when not returned, never invented. Use separate adapter translation for input vs state, auth, question encoding, response mapping, errors. Strictly validate ID set, types, finite numeric ranges, choices, required answers, cross-field coherence; no synthesized verdict or confidence. No new generic tools or worker access to secrets.

Round judgement keeps done (noul), failure_class (choice), same_executor_can_repair (noul), next_action (choice). Preserve existing threshold semantics, parsing, validation and next-action enums (accept, repair-same, fresh-same, switch-model, switch-agent, replan, human, stop); any change requires a new explicit design decision. Bind verdict to exact run/round/input revision; discard stale/late responses. Never accept on pending follow-ups, failed mandatory checks, missing required evidence or blocking findings; verify current kernel enforcement and close any gap in a separate authorized safety slice. An unknown critical fact is not proof. No advisor may loosen the contract or hard budgets.

Router: deterministic, versioned category mapping + capability + approved data route + availability + remaining resource budget. Default Jev-only; Gemini disabled by default. Separate provider error from worker error. Never loop provider calls or recursively ask which provider should decide. Reserve attempts before dispatch, cap time/tokens/requests, account once including failures, honor cancellation and fencing. Rollback via opt-in flag to baseline, without clearing ledger or profile. For unvalidated Gemini results: no operational effect. Future fallback only for approved categories and transient faults; auth/policy/schema violations are not reasons to bypass restrictions. No silent accept on exhaustion. When two recommendations disagree, re-check deterministic facts, reject unsafe proposals, and use bounded independent review/human/stop if unresolved. Agreement is not evidence. No extra retries or budget increases without policy.

## 4. Privacy, security and observability

Google no-cost service may use submitted content for product improvement under applicable terms; review current regional terms and project configuration. Default-deny outbound data: synthetic/public cases only initially, authorized data class and provider route later. Do not send private code, raw diffs, full prompts or conversations, credentials, personal data, raw logs, internal session IDs or follow-up text. Existing RoundJudgementState includes bounded free-text summaries/objective/criteria/findings and optional pendingFollowups text/messageID: bounded is NOT sanitized. Create an explicit projection and data classification policy; deny rather than guess/redact uncertain sensitive content. Never send an incomplete projection as sufficient evidence; use current authorized baseline or abstain. Do not expand to multimodal files until separate risk/cost/data approval. No real key discovery, env dump, profile read, or authenticated test under this document.

Use existing shared factual ledger (#3/#5); no parallel ledger. Record bounded provider/model/version (unknown if undisclosed), decision category, policy version, stage, cohort, request correlation digest, attempt, outcome, latency, usage when known, error class, disagreement, reference outcome. No raw payloads or secrets; preserve retention, decay, idempotency and audit links. Distinguish availability from cognitive error, adjudication from execution, and observed vs counterfactual. A shadow decision cannot create accepted run/outcome or change runtime, wake parent, consume worker retry, or alter session state. Its own bounded budget must be accounted.

## 5. Phased plan and gates

### P0 — Record architecture now (documentation only)
Deliver this proposal and #60, draft docs PR, review by maintainer. Reconcile #2/#3/#4/#5/#38/#49/#59; preserve existing work. Gate: design traceable, scope and privacy policy explicit, phase approvals separate. No runtime changes.

### P1 — Stabilize dogfood and obtain valid OBSERVE corpus (critical path)
Finish #59 based on authorized #58 HEAD after revalidation; respect exact #59 requirements (opt-in bounded sanitized trace, local fixtures, no authenticated test, one Draft PR). Candidate subsequently combines #55/#56 and #57/#58 with #50; integrate read-only result panel #51/#52 via maintainer-approved order. Verify current heads and dependencies. Request fresh explicit authorization for bounded authenticated dogfood; prior authorization consumed. Show correlated TUI intercept/admission/dispatch, real worker, independent critic, evidence, valid judgement, terminal outcome and persistent result display; classify provider failure without pretending a synthetic smoke proves live operation.
Gate: #49 resolved by evidence and maintainer decision; natural varied OBSERVE corpus sufficient per #5/#38 (quality/diversity/comparability, no magic sample count). If blocked continue dogfood fixes; no Gemini feature or SHADOW. Check existing free worker catalog separately; no pool changes here.

### P2 — Extract provider boundary (after explicit release from freeze)
One leaf issue/branch/Draft PR; inventory Jev callers, wrap existing client, keep public tools/config behavior, typed errors and kernel contracts. No Gemini network/config active. RED/GREEN contract tests and existing Jev fixtures; verify baseline request/response behavior, failures, budget/accounting, concurrency, cancellation, no extra calls, rollback. Gate: independent review, all applicable local gates/CI green, no behavior regression, maintainer acceptance.

### P3 — Native Google adapter, offline and default off
Separate leaf. Confirm native REST/SDK schemas, model/limits/auth/pricing/terms; mocked transport, exact fixtures (success/error/malformed), explicit outbound allowlist, timeout, limits and credential separation. No billing enablement; synthetic/public only; no real auth without a new scope approval. Gate: strict parser equivalence, no network when disabled, redaction/deny tests, bounded errors, no paid path, no baseline regressions. Optional authorized synthetic live probe is a separate evidence gate; document model availability, quota, sanitized response and measured latency rather than trusting marketing.

### P4 — SHADOW comparative experiment (separate promotion approval)
Only after P1 and #5 gate. Compare Jev and Gemini using identical permitted inputs and question semantics, independent ground truth (deterministic checks, blinded human/critic adjudication where needed), paired results on held-out cases. Freeze model/version, policy, evaluation dataset and metrics before scoring. Use cohorts by task/complexity/evidence/context size/language; stratify provider failures and selection bias. Include adversarial text, contradictory evidence, missing evidence, provider outage, follow-up/revision, and recovery examples. No real private transfer; if no permitted comparable corpus, remain blocked.
Metrics: false accept/reject, per-category accuracy and confusion, safety violations, calibration (if probabilities available), abstention/disagreement, coverage, p50/p95 latency, requests/tokens and expected resource cost per verified outcome, availability. Report sample counts, uncertainty intervals, paired differences, failures/unknowns, version and recency. Pre-register meaningful non-regression/benefit tolerances and sufficient cohort coverage with maintainer; zero hard-invariant violations in tested cases, no fabricated evidence. Do not declare safety from zero observed events or choose winner by point estimate alone. Gate: measured benefit/non-regression vs Jev baseline with uncertainty and approved thresholds; no runtime effect or leakage. If inconclusive, continue evaluation or retain Jev.

### P5 — ASSIST then bounded static specialization (separate approvals)
First surface advisory Gemini results under explicit validation; no automatic authority. Only after successful ASSIST evaluation and explicit maintainer gate enable narrow static category mapping: Jev routing, Gemini round assessment, kernel final. Start with allowlisted categories/data; preserve worker/critic and existing validation, deterministic baseline/rollback. Test mixed provider failures, stale answers, invalid responses, blocked gates, no secret leakage and no resource inflation. Gate: real verified outcomes non-regression, improved targeted metrics, working rollback, documented operator control. No automatic influence merely because SHADOW is green.

### P6 — BOUNDED ADAPTIVE, independent second opinion and fallback
Separate designs/issues and approvals for each. Versioned per-cohort capability/efficiency/reliability profiles; confidence, decay, low-sample uncertainty; no global score and no feedback loop. Second opinion only for defined ambiguity/risk, with independent input and bounded budget. Fallback authorized by category/data class, only when safe; no paid fallback or recursive calls. Compare against static policy, prove measurable benefit/non-regression, audit and rollback. Kernel remains sovereign. No Runstead integration without separate Runstead evidence and #38 graduation decision.

## 6. Verification and executor discipline

Each future implementation issue covers a coherent complete slice, with approved scope/base SHA/dependencies, one branch, one Draft PR, RED then GREEN regression tests, independent reviewer in fresh context who did not implement, and orchestrator coordinates rather than self-approving. Preserve test history and existing branches. Report exact HEAD, commands, exits, CI, evidence, unresolved findings, limitations and rollback. For OPJEV run applicable npm run typecheck, npm test, npm run evaluate:routing, npm run e2e:matrix, npm run test:e2e-isolation, npm run e2e:gateway with local fixtures/network isolation, git diff --check; never run authenticated E2E or touch personal profile under this proposal. Revalidate exact OpenCode version and gates from authorized issue. No automatic merge, issue closure, reviewer self-approval, or changes to trust boundaries. If gate fails, stop and report BLOCKED/NEEDS_APPROVAL; don't silently weaken acceptance.

## 7. Open decisions / limitations

- Confirm real Gemini native API, no-cost quota and project privacy eligibility; no authenticated call done.
- Verify actual Jev free endpoint compatibility, modalities/limits and current worker availability.
- Define data class policy and exact allowed fields, retention, cohort definitions and quantitative promotion tolerances before experimentation.
- Determine whether Gemini improves evaluation and whether Jev remains best for routing; no benchmark has been run.
- No new runtime capabilities, branch merges, profile changes, or Runstead integration are authorized here.
- This document does not supersede #5/#38 or the authorized #59 specification. Next execution remains #59; #60 is blocked proposal until the dogfood gate is released.
