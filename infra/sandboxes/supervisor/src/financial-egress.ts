import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

export const FINANCIAL_EGRESS_REVISION = "financial-egress-v1";
const run = promisify(execFile);
function publicAddress(address: string) {
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
    a !== 192 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19 || b === 51)) &&
    !(a === 203 && b === 0)
  );
}
export interface ResearchGatewayOptions {
  origins: string[];
  privateDirectory: string;
  publicDirectory: string;
  /** Explicit dependency injection for isolated offline fixtures, never deployment configuration. */
  resolve?: (hostname: string) => Promise<{ address: string; family: number }>;
  upstreamCa?: string;
}
export async function createResearchGateway(options: ResearchGatewayOptions) {
  const origins = new Set(
    options.origins.map((origin) => {
      const url = new URL(origin);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        !/^[a-z0-9.-]+$/.test(url.hostname)
      )
        throw new Error("Invalid trusted research origin");
      return url.origin;
    }),
  );
  await mkdir(options.privateDirectory, { recursive: true, mode: 0o700 });
  await chmod(options.privateDirectory, 0o700);
  await mkdir(options.publicDirectory, { recursive: true });
  const key = path.join(options.privateDirectory, "ca.key");
  const cert = path.join(options.publicDirectory, "ca.crt");
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
  const certificates = new Map<string, Promise<{ key: Buffer; cert: Buffer }>>();
  async function certificate(hostname: string) {
    let value = certificates.get(hostname);
    if (!value) {
      value = (async () => {
        const prefix = path.join(
          options.privateDirectory,
          createHash("sha256").update(hostname).digest("hex"),
        );
        await writeFile(`${prefix}.ext`, `subjectAltName=DNS:${hostname}\n`);
        await run("openssl", [
          "req",
          "-new",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          `${prefix}.key`,
          "-out",
          `${prefix}.csr`,
          "-subj",
          `/CN=${hostname}`,
        ]);
        await chmod(`${prefix}.key`, 0o600);
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
        return { key: await readFile(`${prefix}.key`), cert: await readFile(`${prefix}.crt`) };
      })();
      certificates.set(hostname, value);
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
  async function forward(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (
      !origins.has(url.origin) ||
      url.username ||
      url.password ||
      !["GET", "HEAD"].includes(req.method ?? "") ||
      req.headers.upgrade ||
      req.headers["transfer-encoding"] ||
      (req.headers["content-length"] && req.headers["content-length"] !== "0") ||
      (req.url?.length ?? 0) > 8192
    ) {
      res.writeHead(403);
      res.end("STRUCTURED_FINANCIAL_EXECUTION_REQUIRED");
      return;
    }
    try {
      const address = await resolve(url.hostname);
      const transport = url.protocol === "https:" ? https : http;
      // Pin the validated lookup result. No redirects, cookies, auth or opaque tunnels.
      const upstream = transport.request(
        url,
        {
          method: req.method,
          headers: {
            host: url.host,
            accept: req.headers.accept ?? "*/*",
            "user-agent": "Rakazo Research",
          },
          hostname: address.address,
          family: address.family,
          servername: url.hostname,
          ...(options.upstreamCa ? { ca: options.upstreamCa } : {}),
          timeout: 15000,
        },
        (response) => {
          const headers = { ...response.headers };
          delete headers["set-cookie"];
          delete headers["proxy-authenticate"];
          res.writeHead(response.statusCode ?? 502, headers);
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
  gateway.on("connect", (req, socket, head) => {
    void (async () => {
      try {
        const url = new URL(`https://${req.url}`);
        if (
          !origins.has(url.origin) ||
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
