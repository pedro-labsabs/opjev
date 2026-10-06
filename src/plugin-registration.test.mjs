import { it } from "node:test";
import assert from "node:assert/strict";

import plugin from "../index.ts";
import { makeCtx, makeStorage } from "./harness.mjs";
import { CONTEXT_METRICS_KEY } from "./context-management/metrics.ts";

it("preserves the public Jev tool surface and hook registration order", async () => {
  const storage = makeStorage();
  const m = makeCtx({
    storage,
    options: { enableAutoRoute: true },
  });
  const sessionRegistrations = [];
  const registerSessionHook = m.ctx.session.hook;
  m.ctx.session.hook = async (name, callback, options) => {
    sessionRegistrations.push({ name, callback });
    return registerSessionHook(name, callback, options);
  };

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
  assert.deepEqual(sessionRegistrations.map((x) => x.name), ["retry", "prompt", "context", "context"]);
  const contextEvent = { sessionID: "main", system: [], messages: [], tools: {}, options: {}, model: {}, agent: "build" };
  await sessionRegistrations[2].callback(contextEvent);
  const afterExistingHook = structuredClone(contextEvent);
  sessionRegistrations[3].callback(contextEvent);
  assert.deepEqual(contextEvent, afterExistingHook);

  const dispatchedContext = { sessionID: "main", system: [], messages: [], tools: {}, options: {}, model: {}, agent: "build" };
  await m.hooks.session.context(dispatchedContext);
  assert.equal(dispatchedContext.system.length, 1);
  assert.ok(storage._map.has(CONTEXT_METRICS_KEY));

  await m.hooks.tool["execute.after"]({
    tool: "tools.shell", sessionID: "main", agent: "build", messageID: "message-1234", id: "call-1234",
    input: {}, status: "completed", result: { output: "ok" },
  });
  for (let i = 0; i < 20 && !storage._map.has("context/asset-ledger/v1"); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(storage._map.get("context/asset-ledger/v1").groups.length, 1);
});

it("registers Context Management context observation when auto-routing is disabled", async () => {
  const m = makeCtx({
    storage: makeStorage(),
    options: { enableAutoRoute: false },
  });
  const sessionRegistrations = [];
  const registerSessionHook = m.ctx.session.hook;
  m.ctx.session.hook = async (name, callback, options) => {
    sessionRegistrations.push(name);
    return registerSessionHook(name, callback, options);
  };

  await plugin.setup(m.ctx);

  assert.deepEqual(Object.keys(m.tools).sort(), [
    "decide",
    "escalate",
    "orchestrate_once",
    "orchestrate_resume",
    "route",
  ]);
  assert.deepEqual(Object.keys(m.hooks.tool), ["execute.before", "execute.after"]);
  assert.deepEqual(Object.keys(m.hooks.session), ["retry", "context"]);
  assert.deepEqual(sessionRegistrations, ["retry", "context"]);
});

it("supports the explicit Context Management rollback stage", async () => {
  const m = makeCtx({ storage: makeStorage(), options: { enableAutoRoute: false, contextManagementStage: "disabled" } });
  await plugin.setup(m.ctx);
  assert.deepEqual(Object.keys(m.hooks.session), ["retry"]);
  assert.deepEqual(Object.keys(m.hooks.tool), ["execute.before", "execute.after"]);
});
