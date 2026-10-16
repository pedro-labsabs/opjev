import assert from "node:assert/strict";

export function assertCompletedContextRun(phase) {
  assert.equal(phase, "completed", "deterministic context run must complete");
}

export function assertContextPairing(pairing, groupCount, requestCount) {
  assert.ok(pairing >= 2, "context must observe at least two valid tool pairs");
  assert.ok(pairing <= groupCount * requestCount,
    `pairing metric exceeded observed group/request bounds: ${pairing}`);
}
