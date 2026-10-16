#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFLIGHT = path.join(REPO, "scripts/e2e-gateway-preflight.mjs");
const GATEWAY_E2E = path.join(REPO, "scripts/e2e-gateway.mjs");
const DEFAULT_BIN = "/tmp/opencode-2.0.11/package/bin/opencode";
const preflightOnly = process.argv.includes("--preflight-only");

function fail(message) {
  process.stderr.write(`[e2e-isolation] BLOCKED ${message}\n`);
  process.exit(2);
}

let hostNamespace;
try {
  hostNamespace = fs.readlinkSync("/proc/self/ns/net");
} catch {
  fail("cannot identify host network namespace");
}
if (!/^net:\[\d+\]$/.test(hostNamespace)) fail("host network namespace identity is malformed");

const e2eRoot = path.resolve(process.env.E2E_ROOT ?? "/tmp/opjev-e2e");
if (e2eRoot !== "/tmp" && !e2eRoot.startsWith("/tmp/")) {
  fail("E2E_ROOT must be inside /tmp, the only writable bind mount");
}

const env = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  OPENCODE_BIN: process.env.OPENCODE_BIN ?? DEFAULT_BIN,
  E2E_ROOT: e2eRoot,
};
const preflightTarget = preflightOnly
  ? []
  : [process.execPath, GATEWAY_E2E, "--expected-host-netns", hostNamespace];
const args = [
  "--unshare-net",
  "--die-with-parent",
  "--ro-bind", "/", "/",
  "--bind", "/tmp", "/tmp",
  "--dev-bind", "/dev", "/dev",
  "--proc", "/proc",
  "--",
  process.execPath,
  PREFLIGHT,
  hostNamespace,
  ...preflightTarget,
];

const child = spawn("bwrap", args, { cwd: REPO, env, stdio: "inherit" });
child.once("error", (error) => {
  fail(`Bubblewrap network isolation is unavailable: ${error.message}`);
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 128 : 1);
});
