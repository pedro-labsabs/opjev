import { it } from "node:test";
import assert from "node:assert/strict";

import plugin from "../index.ts";
import { makeCtx, makeStorage } from "./harness.mjs";

it("preserves the public Jev tool surface and hook registration order", async () => {
  const m = makeCtx({
    storage: makeStorage(),
    options: { enableAutoRoute: true },
  });

  await plugin.setup(m.ctx);

  assert.deepEqual(Object.keys(m.tools).sort(), [
    "decide",
    "escalate",
    "orchestrate_once",
    "orchestrate_resume",
    "route",
  ]);
  for (const tool of Object.values(m.tools)) {
    assert.equal(tool.options.namespace, "jev");
    assert.equal(tool.options.codemode, true);
    assert.equal(typeof tool.execute, "function");
  }

  assert.deepEqual(Object.keys(m.hooks.tool), ["execute.before", "execute.after"]);
  assert.deepEqual(Object.keys(m.hooks.session), ["retry", "prompt", "context"]);
});
