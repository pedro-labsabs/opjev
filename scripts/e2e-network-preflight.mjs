import fs from "node:fs";
import net from "node:net";

function readCurrentNetworkNamespace() {
  const value = fs.readlinkSync("/proc/self/ns/net");
  if (!/^net:\[\d+\]$/.test(value)) throw new Error("cannot identify effective network namespace");
  return value;
}

function readIPv4Routes() {
  const lines = fs.readFileSync("/proc/net/route", "utf8").trimEnd().split(/\r?\n/);
  if (!lines[0]?.startsWith("Iface\tDestination\tGateway")) {
    throw new Error("cannot verify IPv4 routing table");
  }
  return lines.slice(1).filter(Boolean).map((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) throw new Error("malformed IPv4 route table");
    return { interface: fields[0], destination: fields[1], mask: fields[7] };
  });
}

function readIPv6Routes() {
  const text = fs.readFileSync("/proc/net/ipv6_route", "utf8");
  if (typeof text !== "string") throw new Error("cannot verify IPv6 routing table");
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) throw new Error("malformed IPv6 route table");
    return { interface: fields[9], destination: fields[0], prefixLength: fields[1] };
  });
}

function verifyOnlyLoopbackRoutes(routes, family) {
  const nonLoopback = routes.filter((route) => route.interface !== "lo");
  if (nonLoopback.length > 0) {
    const names = [...new Set(nonLoopback.map((route) => route.interface))].sort().join(",");
    throw new Error(`${family} has non-loopback routes (${names})`);
  }
  return nonLoopback.length;
}

function probeIPv4Loopback() {
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = "";
    let client;
    const server = net.createServer((socket) => socket.end("opjev-loopback-ok"));
    const timer = setTimeout(() => finish(new Error("IPv4 loopback probe timed out")), 1500);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.destroy();
      const closed = () => error ? reject(error) : resolve(received === "opjev-loopback-ok");
      if (server.listening) server.close(closed);
      else closed();
    };
    server.once("error", finish);
    server.listen(0, "127.0.0.1", () => {
      client = net.createConnection({ host: "127.0.0.1", port: server.address().port });
      client.on("data", (chunk) => { received += chunk.toString("utf8"); });
      client.once("error", finish);
      client.once("end", () => {
        if (received !== "opjev-loopback-ok") return finish(new Error("IPv4 loopback returned unexpected data"));
        finish();
      });
    });
  });
}

/**
 * Verify the effective kernel network namespace, not a caller-provided env flag.
 * The expected host namespace is only a comparison anchor. Route-table inspection
 * and a real loopback handshake independently establish the usable boundary.
 */
export async function verifyNetworkIsolation(expectedHostNamespace) {
  if (typeof expectedHostNamespace !== "string" || !/^net:\[\d+\]$/.test(expectedHostNamespace)) {
    throw new Error("missing or malformed host network namespace anchor");
  }
  const effectiveNamespace = readCurrentNetworkNamespace();
  if (effectiveNamespace === expectedHostNamespace) {
    throw new Error("gateway E2E is not in a distinct network namespace; use npm run e2e:gateway");
  }

  const ipv4Routes = readIPv4Routes();
  const ipv6Routes = readIPv6Routes();
  const ipv4ExternalRoutes = verifyOnlyLoopbackRoutes(ipv4Routes, "IPv4");
  const ipv6ExternalRoutes = verifyOnlyLoopbackRoutes(ipv6Routes, "IPv6");
  const loopbackIPv4 = await probeIPv4Loopback();
  if (!loopbackIPv4) throw new Error("IPv4 loopback is unavailable");

  return {
    effectiveNamespace,
    differsFromHostNamespace: true,
    ipv4ExternalRoutes,
    ipv6ExternalRoutes,
    loopbackIPv4,
  };
}
