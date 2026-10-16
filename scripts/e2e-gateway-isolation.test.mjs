import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const gatewaySource = fs.readFileSync(path.join(REPO, "scripts/e2e-gateway.mjs"), "utf8");

test("npm e2e:gateway goes through the isolated launcher", () => {
  assert.match(packageJson.scripts["e2e:gateway"], /e2e-gateway-isolated\.mjs/);
});

test("direct gateway entry verifies effective network confinement before fixture setup", () => {
  const mainAt = gatewaySource.indexOf("async function main()");
  const verifyAt = gatewaySource.indexOf("verifyNetworkIsolation(", mainAt);
  const firstFilesystemSetup = gatewaySource.indexOf("fs.mkdirSync(RUN_DIR", mainAt);
  const firstProviderServer = gatewaySource.indexOf("http.createServer(", mainAt);
  const firstSpawn = gatewaySource.indexOf("spawnCapture(", mainAt);
  assert.notEqual(mainAt, -1, "gateway main exists");
  assert.notEqual(verifyAt, -1, "network isolation verifier is called");
  assert.ok(verifyAt < firstFilesystemSetup, "preflight runs before artifact or fixture setup");
  assert.ok(verifyAt < firstProviderServer, "preflight runs before provider/jev servers");
  assert.ok(verifyAt < firstSpawn, "preflight runs before OpenCode/gateway subprocesses");
});

test("versioned isolated launcher exists", () => {
  assert.ok(fs.existsSync(path.join(REPO, "scripts/e2e-gateway-isolated.mjs")));
  assert.ok(fs.existsSync(path.join(REPO, "scripts/e2e-gateway-preflight.mjs")));
  assert.ok(fs.existsSync(path.join(REPO, "scripts/e2e-network-preflight.mjs")));
});

const NODE = process.execPath;
const ISOLATED_LAUNCHER = path.join(REPO, "scripts/e2e-gateway-isolated.mjs");
const PREFLIGHT = path.join(REPO, "scripts/e2e-gateway-preflight.mjs");
const GATEWAY_ENTRY = path.join(REPO, "scripts/e2e-gateway.mjs");
const BASE_ENV = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  OPENCODE_BIN: "/tmp/opencode-2.0.11/package/bin/opencode",
  E2E_ROOT: "/tmp/opjev-isolation-preflight-test",
};

test("unconfined preflight rejects before starting its target child", () => {
  const hostNamespace = fs.readlinkSync("/proc/self/ns/net");
  const result = spawnSync(NODE, [PREFLIGHT, hostNamespace, NODE, "-e", "console.log('TARGET_STARTED')"], {
    cwd: REPO,
    env: BASE_ENV,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /BLOCKED.*not in a distinct network namespace/);
  assert.doesNotMatch(result.stdout + result.stderr, /TARGET_STARTED/);
});

test("direct gateway invocation refuses unconfined execution before fixture/process startup", () => {
  const result = spawnSync(NODE, [GATEWAY_ENTRY], {
    cwd: REPO,
    env: BASE_ENV,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout + result.stderr, /network namespace|network isolation/i);
  assert.doesNotMatch(result.stdout + result.stderr, /Jev SystemOne mock|OpenCode local completion fixture|subindo upstream|gateway em http/);
});

test("isolated launcher proves loopback and no external IPv4/IPv6 routes before target", () => {
  const result = spawnSync(NODE, [ISOLATED_LAUNCHER, "--preflight-only"], {
    cwd: REPO,
    env: BASE_ENV,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith("[e2e-isolation] PASS "));
  assert.ok(line, result.stdout);
  const proof = JSON.parse(line.slice("[e2e-isolation] PASS ".length));
  assert.notEqual(proof.effectiveNamespace, fs.readlinkSync("/proc/self/ns/net"));
  assert.equal(proof.differsFromHostNamespace, true);
  assert.equal(proof.ipv4ExternalRoutes, 0);
  assert.equal(proof.ipv6ExternalRoutes, 0);
  assert.equal(proof.loopbackIPv4, true);
});

test("public npm e2e:gateway entry completes preflight-only in the verified namespace", () => {
  const result = spawnSync("npm", ["run", "e2e:gateway", "--", "--preflight-only"], {
    cwd: REPO,
    env: BASE_ENV,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[e2e-isolation\] PASS .*"ipv4ExternalRoutes":0.*"ipv6ExternalRoutes":0.*"loopbackIPv4":true/);
  assert.doesNotMatch(result.stdout + result.stderr, /Jev SystemOne mock|OpenCode local completion fixture|subindo upstream/);
});

test("launcher fails closed when Bubblewrap is unavailable", () => {
  const result = spawnSync(NODE, [ISOLATED_LAUNCHER, "--preflight-only"], {
    cwd: REPO,
    env: { ...BASE_ENV, PATH: "" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /BLOCKED Bubblewrap network isolation is unavailable/);
  assert.doesNotMatch(result.stdout + result.stderr, /\[e2e-isolation\] PASS/);
});
