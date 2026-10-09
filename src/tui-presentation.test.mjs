import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deliverExecutionNoticeWithRetry,
  renderExecutionNoticeIfReady,
} from "./orchestration/summary-presentation.ts";

test("delivers a terminal notice only after the parent TUI session is idle", async () => {
  let status = "running";
  const rendered = [];
  let waits = 0;
  const result = await deliverExecutionNoticeWithRetry({
    displayNotice: "Orchestration completed.",
    render(notice) {
      return renderExecutionNoticeIfReady(status, () => rendered.push(notice));
    },
    refresh() {},
    deadline: 1000,
    now: () => 0,
    retryIntervalMs: 200,
    async wait(ms) {
      waits += 1;
      assert.equal(ms, 200);
      assert.deepEqual(rendered, [], "the result remains pending while the TUI session is running");
      status = "idle";
    },
  });

  assert.equal(result, "shown");
  assert.equal(waits, 1);
  assert.deepEqual(rendered, ["Orchestration completed."]);
  assert.equal(renderExecutionNoticeIfReady("running", () => assert.fail("running session rendered")), "retry");
});
