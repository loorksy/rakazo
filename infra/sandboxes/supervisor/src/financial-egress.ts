import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { isIP } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { FINANCIAL_CONTAINMENT_REVISION, financialResearchUrlAllowed } from "@rakazo/core";

export const FINANCIAL_EGRESS_REVISION = FINANCIAL_CONTAINMENT_REVISION;
const run = promisify(execFile);
/** Upstream requests in flight per gateway; more get 503 instead of queueing without bound. */
export const MAX_RESEARCH_REQUESTS = 64;
/** Hostname certificates kept in memory; older entries are evicted first. */
export const MAX_RESEARCH_CERTIFICATES = 512;
const TUNNEL_IDLE_MS = 120_000;
/** The only request headers forwarded. Cookies, authorization and custom headers never leave. */
const FORWARDED_HEADERS = [
  "accept",
  "accept-language",
  "cache-control",
  "if-modified-since",
  "if-none-match",
  "range",
  "referer",
] as const;

export function publicAddress(address: string) {
  // Deny mapped/transition IPv6 as well as local, reserved and documentation space.
  if (isIP(address) === 6)
    return /^2[0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0|2|10|20):/i.test(address);
  const bytes = address.split(".").map(Number);
  const [a, b] = bytes;
  return (
    bytes.length === 4 &&
    a !== undefined &&
    b !== undefined &&
    a > 0 &&
    a < 224 &&
    a !== 10 &&
    a !== 127 &&
    !(a === 192 && b === 168) &&
    !(a === 192 && b === 0) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19 || b === 51)) &&
    !(a === 203 && b === 0)
  );
}
export interface ResearchGatewayOptions {
  privateDirectory: string;
  publicDirectory: string;
  /** Explicit dependency injection for isolated offline fixtures, never deployment configuration. */
  policy?: (url: string, method: string) => boolean;
  resolve?: (hostname: string) => Promise<{ address: string; family: number }>;
  upstreamCa?: string;
}
export async function createResearchGateway(options: ResearchGatewayOptions) {
  const allowed = options.policy ?? financialResearchUrlAllowed;
  await mkdir(options.privateDirectory, { recursive: true, mode: 0o700 });
  await chmod(options.privateDirectory, 0o700);
  await mkdir(options.publicDirectory, { recursive: true });
  const key = path.join(options.privateDirectory, "ca.key");
  const cert = path.join(options.publicDirectory, "ca.crt");
  const leafKey = path.join(options.privateDirectory, "leaf.key");
  try {
    await readFile(key);
    await readFile(cert);
  } catch {
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "365",
      "-subj",
      "/CN=Rakazo Research Gateway",
    ]);
    await chmod(key, 0o600);
  }
  try {
    await readFile(leafKey);
  } catch {
    await run("openssl", ["genrsa", "-out", leafKey, "2048"]);
    await chmod(leafKey, 0o600);
  }
  const leafKeyBytes = await readFile(leafKey);
  const certificates = new Map<string, Promise<{ key: Buffer; cert: Buffer }>>();
  async function certificate(hostname: string) {
    let value = certificates.get(hostname);
    if (value) {
      certificates.delete(hostname);
      certificates.set(hostname, value);
      return value;
    }
    value = (async () => {
      const prefix = path.join(
        options.privateDirectory,
        createHash("sha256").update(hostname).digest("hex"),
      );
      try {
        return { key: leafKeyBytes, cert: await readFile(`${prefix}.crt`) };
      } catch {
        await writeFile(`${prefix}.ext`, `subjectAltName=DNS:${hostname}\n`);
        await run("openssl", [
          "req",
          "-new",
          "-key",
          leafKey,
          "-out",
          `${prefix}.csr`,
          "-subj",
          `/CN=${hostname}`,
        ]);
        await run("openssl", [
          "x509",
          "-req",
          "-in",
          `${prefix}.csr`,
          "-CA",
          cert,
          "-CAkey",
          key,
          "-set_serial",
          `0x${createHash("sha256").update(hostname).digest("hex").slice(0, 30)}`,
          "-out",
          `${prefix}.crt`,
          "-days",
          "30",
          "-extfile",
          `${prefix}.ext`,
        ]);
        await rm(`${prefix}.csr`, { force: true });
        await rm(`${prefix}.ext`, { force: true });
        return { key: leafKeyBytes, cert: await readFile(`${prefix}.crt`) };
      }
    })();
    value.catch(() => certificates.delete(hostname));
    certificates.set(hostname, value);
    while (certificates.size > MAX_RESEARCH_CERTIFICATES) {
      const oldest = certificates.keys().next().value;
      if (oldest === undefined) break;
      certificates.delete(oldest);
    }
    return value;
  }
  const resolve =
    options.resolve ??
    (async (hostname: string) => {
      const addresses = await lookup(hostname, { all: true });
      if (!addresses.length || addresses.some((row) => !publicAddress(row.address)))
        throw new Error("Untrusted destination");
      return addresses[0]!;
    });
  let inFlight = 0;
  async function forward(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (
      !allowed(url.href, req.method ?? "") ||
      req.headers.upgrade ||
      req.headers["transfer-encoding"] ||
      (req.headers["content-length"] && req.headers["content-length"] !== "0") ||
      (req.url?.length ?? 0) > 8192
    ) {
      res.writeHead(403);
      res.end("STRUCTURED_FINANCIAL_EXECUTION_REQUIRED");
      return;
    }
    if (inFlight >= MAX_RESEARCH_REQUESTS) {
      res.writeHead(503, { "retry-after": "1" });
      res.end("RESEARCH_GATEWAY_BUSY");
      return;
    }
    inFlight++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        inFlight--;
      }
    };
    res.on("close", release);
    try {
      const address = await resolve(url.hostname);
      const transport = url.protocol === "https:" ? https : http;
      const headers: Record<string, string> = {
        host: url.host,
        "user-agent": String(req.headers["user-agent"] ?? "Rakazo Research").slice(0, 256),
      };
      for (const name of FORWARDED_HEADERS) {
        const value = req.headers[name];
        if (typeof value === "string" && value.length <= 2048) headers[name] = value;
      }
      if (!headers.accept) headers.accept = "*/*";
      // Pin the validated lookup result. Redirects return to the client and are checked again.
      const upstream = transport.request(
        url,
        {
          method: req.method,
          headers,
          hostname: address.address,
          family: address.family,
          servername: url.hostname,
          ...(options.upstreamCa ? { ca: options.upstreamCa } : {}),
          timeout: 15000,
        },
        (response) => {
          response.on("error", () => {
            if (!res.headersSent) res.writeHead(502);
            res.end("RESEARCH_UPSTREAM_UNAVAILABLE");
          });
          const forwarded = { ...response.headers };
          delete forwarded["set-cookie"];
          delete forwarded["proxy-authenticate"];
          delete forwarded["alt-svc"];
          res.writeHead(response.statusCode ?? 502, forwarded);
          response.pipe(res);
        },
      );
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("RESEARCH_UPSTREAM_UNAVAILABLE");
      });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      upstream.end();
    } catch {
      release();
      res.writeHead(403);
      res.end("DESTINATION_UNVERIFIED");
    }
  }
  const gateway = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.end(JSON.stringify({ revision: FINANCIAL_EGRESS_REVISION, readOnly: true }));
      return;
    }
    try {
      void forward(req, res, new URL(req.url ?? ""));
    } catch {
      res.writeHead(403);
      res.end("DESTINATION_UNVERIFIED");
    }
  });
  gateway.on("upgrade", (_req, socket) => socket.destroy());
  gateway.on("clientError", (_error, socket) => socket.destroy());
  // Hijacked CONNECT sockets leave HTTP connection tracking; close them with everything else.
  const tunnels = new Set<Duplex>();
  const closeTracked = gateway.closeAllConnections.bind(gateway);
  gateway.closeAllConnections = () => {
    closeTracked();
    for (const tunnel of tunnels) tunnel.destroy();
  };
  const trackTunnel = (socket: Duplex) => {
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    // A peer reset must not become an unhandled error and take the gateway down.
    socket.on("error", () => socket.destroy());
  };
  gateway.on("connect", (req, socket, head) => {
    trackTunnel(socket);
    (socket as Socket).setTimeout(TUNNEL_IDLE_MS, () => socket.destroy());
    void (async () => {
      try {
        const url = new URL(`https://${req.url}`);
        if (
          !allowed(url.href, "GET") ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw new Error("Untrusted CONNECT");
        await resolve(url.hostname);
        const server = https.createServer(await certificate(url.hostname), (request, response) => {
          try {
            const target = new URL(request.url ?? "/", url);
            if (target.origin !== url.origin) throw new Error("Origin changed");
            void forward(request, response, target);
          } catch {
            response.writeHead(403);
            response.end("DESTINATION_UNVERIFIED");
          }
        });
        server.on("upgrade", (_req, upgraded) => upgraded.destroy());
        server.on("error", () => socket.destroy());
        server.on("clientError", (_error, client) => client.destroy());
        server.on("tlsClientError", () => socket.destroy());
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) socket.unshift(head);
        server.emit("connection", socket);
      } catch {
        socket.end(
          "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nSTRUCTURED_FINANCIAL_EXECUTION_REQUIRED",
        );
      }
    })();
  });
  gateway.requestTimeout = 20000;
  gateway.headersTimeout = 10000;
  return gateway;
}
