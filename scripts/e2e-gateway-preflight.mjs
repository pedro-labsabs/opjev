import { spawn } from "node:child_process";
import { verifyNetworkIsolation } from "./e2e-network-preflight.mjs";

const [hostNamespace, ...target] = process.argv.slice(2);

try {
  const proof = await verifyNetworkIsolation(hostNamespace);
  process.stdout.write(`[e2e-isolation] PASS ${JSON.stringify(proof)}\n`);
} catch (error) {
  process.stderr.write(`[e2e-isolation] BLOCKED ${error instanceof Error ? error.message : "network preflight failed"}\n`);
  process.exit(2);
}

if (target.length === 0) process.exit(0);
const child = spawn(target[0], target.slice(1), { stdio: "inherit", env: process.env });
child.once("error", (error) => {
  process.stderr.write(`[e2e-isolation] BLOCKED target could not start: ${error.message}\n`);
  process.exitCode = 2;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 128 : 1);
});
