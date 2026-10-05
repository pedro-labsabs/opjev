import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDecisionExplanation } from "./orchestration/decision-explanation.ts";

describe("structured routing decision explanations", () => {
  it("exposes selected lane/agent/model with a reason and safe eligibility evidence", () => {
    const explanation = sanitizeDecisionExplanation({
      category: "routing",
      outcome: "selected",
      selected: { lane: "coding", agent: "builder", model: "provider/model" },
      reason: "Selected the eligible coding route",
      evidence: [
        { name: "lane-eligible", result: "eligible", detail: "Task classified as coding" },
        { name: "context-bound", result: "met", detail: "Within configured context limit" },
      ],
    });

    assert.deepEqual(explanation.selected, { lane: "coding", agent: "builder", model: "provider/model" });
    assert.equal(explanation.category, "routing");
    assert.equal(explanation.outcome, "selected");
    assert.match(explanation.reason, /eligible coding route/);
    assert.deepEqual(explanation.evidence, [
      { name: "lane-eligible", result: "eligible", detail: "Task classified as coding" },
      { name: "context-bound", result: "met", detail: "Within configured context limit" },
    ]);
  });

  it("records recovery action, outcome, route, and associated fallback context", () => {
    const explanation = sanitizeDecisionExplanation({
      category: "recovery",
      outcome: "recovered",
      selected: { lane: "coding", agent: "safe-agent", model: "model-v2" },
      reason: "Retry succeeded after switching model",
      recovery: {
        action: "switch-model-and-retry",
        outcome: "Retry succeeded",
        route: { lane: "coding", agent: "safe-agent", model: "model-v2" },
        fallback: {
          rejected: { agent: "primary-agent", model: "model-v1" },
          reason: "Provider unavailable",
          selected: { agent: "safe-agent", model: "model-v2" },
        },
      },
    });

    assert.equal(explanation.category, "recovery");
    assert.equal(explanation.outcome, "recovered");
    assert.equal(explanation.recovery.action, "switch-model-and-retry");
    assert.equal(explanation.recovery.outcome, "Retry succeeded");
    assert.deepEqual(explanation.recovery.route, { lane: "coding", agent: "safe-agent", model: "model-v2" });
    assert.equal(explanation.recovery.fallback.rejected.agent, "primary-agent");
    assert.equal(explanation.recovery.fallback.reason, "Provider unavailable");
  });

  it("drops extra properties at every explanation and nested context boundary", () => {
    const marker = "PRIVATE_EXTRA_MARKER_31ca";
    const explanation = sanitizeDecisionExplanation({
      category: "recovery",
      outcome: "continued",
      reason: "Retry continues",
      topSecret: marker,
      selected: { lane: "coding", selectedSecret: marker },
      evidence: [{ name: "retry-eligible", result: "met", evidenceSecret: marker }],
      fallback: {
        reason: "route rejected",
        fallbackSecret: marker,
        rejected: { agent: "primary", rejectedSecret: marker },
        selected: { model: "backup", fallbackRouteSecret: marker },
      },
      recovery: {
        action: "retry",
        outcome: "continued",
        recoverySecret: marker,
        route: { lane: "coding", recoveryRouteSecret: marker },
        fallback: {
          reason: "prior route",
          recoveryFallbackSecret: marker,
          rejected: { agent: "old", recoveryRejectedSecret: marker },
          selected: { model: "new", recoverySelectedSecret: marker },
        },
      },
    });
    const serialized = JSON.stringify(explanation);

    assert.doesNotMatch(serialized, /PRIVATE_EXTRA_MARKER_31ca/);
    for (const extraKey of [
      "topSecret", "selectedSecret", "evidenceSecret", "fallbackSecret",
      "rejectedSecret", "fallbackRouteSecret", "recoverySecret",
      "recoveryRouteSecret", "recoveryFallbackSecret", "recoveryRejectedSecret",
      "recoverySelectedSecret",
    ]) {
      assert.equal(serialized.includes(extraKey), false, `${extraKey} must not cross the explanation boundary`);
    }
  });

  it("caps evidence count, keeps the first items in order, and bounds serialized output", () => {
    const marker = "PRIVATE_EVIDENCE_EXTRA_MARKER_92ab";
    const explanation = sanitizeDecisionExplanation({
      category: "routing",
      outcome: "selected",
      reason: "Route selected",
      evidence: Array.from({ length: 5000 }, (_, index) => ({
        name: `evidence-${index}`,
        result: "met",
        detail: `detail-${index}`,
        evidenceSecret: marker,
      })),
    });
    const serialized = JSON.stringify(explanation);
    const serializedBytes = Buffer.byteLength(serialized, "utf8");

    assert.ok(explanation.evidence.length <= 8);
    assert.deepEqual(explanation.evidence.map((item) => item.name), [
      "evidence-0", "evidence-1", "evidence-2", "evidence-3",
      "evidence-4", "evidence-5", "evidence-6", "evidence-7",
    ]);
    assert.ok(serializedBytes < 8000, `serialized explanation was ${serializedBytes} bytes`);
    assert.doesNotMatch(serialized, /PRIVATE_EVIDENCE_EXTRA_MARKER_92ab|evidenceSecret/);
  });

  it("redacts representative credentials throughout explanation metadata and bounds sensitive prompt text", () => {
    const credential = "sk-1234567890abcdefghijklmnop";
    const explanation = sanitizeDecisionExplanation({
      category: "recovery",
      outcome: "failed",
      selected: { model: `model api_key=${credential}` },
      reason: `Recovery failed; Authorization: Bearer ${credential}`,
      evidence: [{ name: "credential-check", result: "met", detail: `password=hunter2; ${credential}` }],
      recovery: {
        action: "retry",
        outcome: `Retry outcome: ${"x".repeat(300)} private prompt content`,
        fallback: { reason: `secret=${credential}` },
      },
    });
    const serialized = JSON.stringify(explanation);

    assert.doesNotMatch(serialized, /1234567890|hunter2|private prompt content/);
    assert.match(explanation.reason, /Authorization=\[REDACTED\]/);
    assert.match(explanation.evidence[0].detail, /password=\[REDACTED\]/);
    assert.ok(explanation.recovery.outcome.length <= 240);
    assert.match(explanation.recovery.fallback.reason, /secret=\[REDACTED\]/);
  });
});

import { decideRoute, heuristicRoute } from "./router.ts";
import { FREE_POOL } from "./config.ts";

describe("actual route decision explanations", () => {
  const input = { prompt: "implement a small feature", validAgents: ["build", "plan"], freeCandidates: [...FREE_POOL], route: "unknown", jevModel: "jev", jevEndpoint: "https://example.invalid", apiKey: undefined, confidenceThreshold: 0.5 };
  it("explains a real deterministic normal route", () => {
    const result = heuristicRoute(input.prompt);
    assert.deepEqual(result.explanation.selected, { lane: result.route, agent: result.agent, model: result.model });
  });
  it("explains invalid route fallback from the actual decision function", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "bogus", confidence: 1 } } }), { status: 200 });
    const result = await decideRoute(input);
    assert.equal(result.explanation.category, "fallback");
    assert.equal(result.explanation.fallback.reason, "invalid-route-choice");
  });
  it("explains unavailable-service fallback from the actual decision function", async () => {
    globalThis.fetch = async () => { throw new Error("network unavailable"); };
    const result = await decideRoute(input);
    assert.equal(result.explanation.category, "fallback");
    assert.equal(result.explanation.fallback.reason, "decision-unavailable");
  });
});
