import { it } from "node:test";
import assert from "node:assert/strict";
import { assertCompletedContextRun, assertContextPairing } from "../scripts/e2e-context-contract.mjs";

it("rejects failed deterministic context orchestration", () => {
  assert.throws(() => assertCompletedContextRun("failed"), assert.AssertionError);
});
for (const count of [0, 1]) {
  it(`rejects context coverage with only ${count} valid pairs`, () => {
    assert.throws(() => assertContextPairing(count, 2, 4), assert.AssertionError);
  });
}
it("rejects pairing beyond observed group/request bounds", () => {
  assert.throws(() => assertContextPairing(9, 2, 4), assert.AssertionError);
});
