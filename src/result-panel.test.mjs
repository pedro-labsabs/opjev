import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReadOnlyResultPanel } from "./orchestration/result-panel.ts";

test("accepted panel displays the persisted bounded result without fabricating a new assistant answer", () => {
  const text = formatReadOnlyResultPanel({ runID: "run-safe-1", result: { available: true, text: "Verified line 1\nVerified line 2" } });
  assert.match(text, /Verified line 1\nVerified line 2/);
  assert.match(text, /aceito/i);
  assert.equal(text.includes("undefined"), false);
});

test("unavailable and unsafe result never discloses worker payload", () => {
  assert.doesNotMatch(formatReadOnlyResultPanel({ runID: "run-safe-1", result: { available: false, text: "SHOULD_NOT_RENDER" } }), /SHOULD_NOT_RENDER/);
  const text = formatReadOnlyResultPanel({ runID: "bad\u001b[31m", result: { available: true, text: "\u001b[31mHELLO\u0007" } });
  assert.doesNotMatch(text, /\u001b|\u0007/);
  assert.match(text, /HELLO/);
  assert.ok(text.length <= 900);
});
