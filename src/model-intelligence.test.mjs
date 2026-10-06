import { test } from "node:test";
import assert from "node:assert/strict";

import { buildObserveProfiles } from "./model-intelligence/profiles.ts";
import { sanitizeObservation } from "./resource-governor/usage-ledger.ts";

const base = { route: "fast-coding", role: "worker", agent: "build" };

test("profiles keep capability, efficiency, availability, and recovery independent", () => {
  const observations = [
    { ...base, at: 9_000, kind: "provider-error", model: "zen/model-a", failureDomain: "provider" },
    { ...base, at: 9_000, kind: "request", model: "zen/model-a" },
    { ...base, at: 9_000, kind: "round", model: "zen/model-a", round: 1 },
    { ...base, at: 9_000, kind: "recovery", model: "zen/model-a", round: 1, recoveryAction: "repair-same" },
    { ...base, at: 9_000, kind: "token-usage", model: "zen/model-a", round: 1, tokens: { input: 12, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 1 } },
    { ...base, at: 9_000, kind: "outcome", model: "zen/model-a", round: 1, acceptance: true, verificationPassed: true, failureClass: "none", recoveryAction: "repair-same" },
    { ...base, at: 9_000, kind: "outcome", model: "zen/model-a", round: 2, acceptance: false, verificationPassed: true, failureClass: "implementation" },
  ];
  const [profile] = buildObserveProfiles(observations, {
    from: 8_000, to: 10_000, now: 10_000, minCapabilitySamples: 3, staleAfterMs: 5_000,
  });

  assert.equal(profile.capability.samples, 2);
  assert.equal(profile.capability.accepted, 1);
  assert.equal(profile.capability.acceptanceRate, 0.5);
  assert.equal(profile.capability.uncertainty, "high");
  assert.equal(profile.efficiency.acceptedOutcomes, 1);
  assert.equal(profile.efficiency.requestsPerAccepted, 1);
  assert.equal(profile.efficiency.roundsPerAccepted, 1);
  assert.equal(profile.efficiency.inputTokensPerAccepted, 12);
  assert.equal(profile.efficiency.reasoningTokensPerAccepted, 2);
  assert.equal(profile.efficiency.cacheReadTokensPerAccepted, 3);
  assert.equal(profile.efficiency.cacheWriteTokensPerAccepted, 1);
  assert.equal(profile.availability.providerFailures, 1);
  assert.equal(profile.recovery.attempts, 1);
  assert.equal(profile.recovery.acceptedAfterRecovery, 1);
  assert.deepEqual(profile.recovery.actions, { "repair-same": 1 });
  assert.deepEqual(profile.freshness, { newestAt: 9_000, stale: false });
});

test("provider failures affect availability but never capability samples", () => {
  const profiles = buildObserveProfiles([
    { ...base, at: 4, kind: "provider-error", model: "zen/model-a", failureDomain: "provider" },
    { ...base, at: 4, kind: "outcome", model: "zen/model-a", acceptance: false, verificationPassed: false, failureClass: "implementation", failureDomain: "provider" },
  ], { from: 0, to: 5, now: 5 });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].capability.samples, 0);
  assert.equal(profiles[0].capability.acceptanceRate, undefined);
  assert.equal(profiles[0].availability.providerFailures, 1);
});

test("incompatible route cohorts and distinct model IDs never share evidence", () => {
  const profiles = buildObserveProfiles([
    { ...base, at: 1, kind: "outcome", model: "zen/model-a", acceptance: true, verificationPassed: true, failureClass: "none" },
    { ...base, at: 2, kind: "outcome", model: "zen/model-b", acceptance: false, verificationPassed: true, failureClass: "implementation" },
    { ...base, route: "research-docs", at: 3, kind: "outcome", model: "zen/model-a", acceptance: false, verificationPassed: true, failureClass: "implementation" },
  ], { from: 0, to: 10, now: 10 });
  assert.equal(profiles.length, 3);
  assert.deepEqual(profiles.map(x => [x.route, x.model, x.capability.samples]).sort(), [
    ["fast-coding", "zen/model-a", 1],
    ["fast-coding", "zen/model-b", 1],
    ["research-docs", "zen/model-a", 1],
  ]);
});

test("profiles are deterministic, expose freshness, and contain no execution authority", () => {
  const observations = [
    { ...base, at: 1, kind: "outcome", model: "zen/model-z", acceptance: true, verificationPassed: true, failureClass: "none", prompt: "secret" },
    { ...base, at: 2, kind: "outcome", model: "zen/model-z", acceptance: false, verificationPassed: true, failureClass: "implementation" },
  ];
  const options = { from: 0, to: 10, now: 10, staleAfterMs: 5, minCapabilitySamples: 2 };
  const first = buildObserveProfiles(observations, options);
  assert.deepEqual(first, buildObserveProfiles(observations, options));
  assert.equal(first[0].capability.uncertainty, "provisional");
  assert.equal(first[0].freshness.stale, true);
  assert.equal(JSON.stringify(first).includes("secret"), false);
  for (const key of ["modelChoice", "agentChoice", "nextAction", "budget", "maxRounds", "recommendation", "modelScore"]) {
    assert.equal(key in first[0], false, `profile must not expose ${key}`);
  }
});

test("sanitizer keeps only bounded OBSERVE facts and discards prompts and arbitrary metadata", () => {
  const safe = sanitizeObservation({
    at: 1, kind: "outcome", route: "fast-coding", model: "zen/model-a", agent: "build", round: 1,
    acceptance: true, verificationPassed: true, failureClass: "none", recoveryAction: "repair-same",
    prompt: "private", rawOutput: "private", metadata: { secret: "private" }, secret: "private",
  });
  assert.equal(safe.route, "fast-coding");
  assert.equal(safe.acceptance, true);
  assert.equal(safe.verificationPassed, true);
  assert.equal(safe.failureClass, "none");
  assert.equal(safe.recoveryAction, "repair-same");
  assert.equal(JSON.stringify(safe).includes("private"), false);
  assert.equal("metadata" in safe, false);
});
