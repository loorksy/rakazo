import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { financialResearchUrlAllowed } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createResearchGateway, publicAddress } from "./financial-egress.js";

describe("trusted research gateway financial containment", () => {
  let root: string;
  let gateway: http.Server;
  let research: http.Server;
  let proxyPort: number;
  let researchPort: number;
  const receipts: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders }> = [];
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "financial-egress-fixture-"));
    research = http.createServer((req, res) => {
      receipts.push({ method: req.method, url: req.url, headers: req.headers });
      res.setHeader("set-cookie", "sentinel-secret=private");
      res.end("public research fixture");
    });
    await new Promise<void>((r) => research.listen(0, "127.0.0.1", r));
    researchPort = (research.address() as AddressInfo).port;
    gateway = await createResearchGateway({
      privateDirectory: path.join(root, "private"),
      publicDirectory: path.join(root, "public"),
      // The production predicate, with only the fixture's ephemeral port mapped to the default.
      policy: (url, method) =>
        financialResearchUrlAllowed(url.replace(`:${researchPort}/`, "/"), method),
      resolve: async () => ({ address: "127.0.0.1", family: 4 }),
    });
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
    proxyPort = (gateway.address() as AddressInfo).port;
  });
  afterAll(async () => {
    gateway.closeAllConnections();
    research.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => gateway.close(() => r())),
      new Promise<void>((r) => research.close(() => r())),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const request = (url: string, method = "GET", headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
      (resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: proxyPort, path: url, method, headers },
          (res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
  it.each(["research.fixture", "news.example.org", "calendar.example.com"])(
    "allows anonymous public research on %s and forwards no credentials or storage",
    async (host) => {
      const result = await request(`http://${host}:${researchPort}/market-research`, "GET", {
        authorization: "Bearer sentinel-secret",
        cookie: "token=sentinel-secret",
        "x-api-key": "sentinel-secret",
        "proxy-authorization": "Basic sentinel-secret",
        "accept-language": "en-GB",
      });
      expect(result.status).toBe(200);
      expect(result.body).toBe("public research fixture");
      expect(result.headers["set-cookie"]).toBeUndefined();
      const receipt = receipts.at(-1)!;
      expect(receipt).toMatchObject({ method: "GET", url: "/market-research" });
      expect(receipt.headers["accept-language"]).toBe("en-GB");
      expect(JSON.stringify(receipt.headers)).not.toContain("sentinel-secret");
    },
  );
  it.each(["POST", "PUT", "PATCH", "DELETE"])("blocks %s on any destination", async (method) => {
    const before = receipts.length;
    expect((await request(`http://research.fixture:${researchPort}/buy`, method)).status).toBe(403);
    expect(receipts.length).toBe(before);
  });
  it.each([
    "https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/a/trade",
    "https://api-fxtrade.oanda.com/v3/accounts",
    "http://127.0.0.1/buy",
    "http://169.254.169.254/latest/meta-data",
    "http://supervisor:7091/computers",
    "http://research.fixture:8443/buy",
    "http://news.example.org/feed?apiKey=sentinel-secret",
  ])("blocks financial, internal or authenticated destination %s", async (url) => {
    const before = receipts.length;
    expect((await request(url)).status).toBe(403);
    expect(receipts.length).toBe(before);
  });
  it.each([
    "mt-client-api-v1.new-york.agiliumtrade.ai:443",
    "research.fixture:8443",
    "10.0.0.5:443",
  ])("rejects CONNECT tunnel to %s", async (target) => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () =>
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
      );
      let data = "";
      socket.on("data", (d) => (data += d));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(response).toContain("403 Forbidden");
  });
  it("inspects HTTPS inside CONNECT instead of providing an opaque financial tunnel", async () => {
    const ca = await readFile(path.join(root, "public/ca.crt"));
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () =>
        socket.write("CONNECT research.fixture:443 HTTP/1.1\r\nHost: research.fixture\r\n\r\n"),
      );
      socket.once("data", () => {
        const secure = tls.connect({ socket, servername: "research.fixture", ca }, () =>
          secure.write(
            "POST /orders HTTP/1.1\r\nHost: research.fixture\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
          ),
        );
        let data = "";
        secure.on("data", (d) => (data += d));
        secure.on("end", () => resolve(data));
        secure.on("error", reject);
      });
      socket.on("error", reject);
    });
    expect(response).toContain("403 Forbidden");
    expect(response).toContain("STRUCTURED_FINANCIAL_EXECUTION_REQUIRED");
  });
  it("mints per-host certificates from one leaf key and reuses them", async () => {
    const ca = await readFile(path.join(root, "public/ca.crt"));
    const peer = async (host: string) =>
      new Promise<tls.PeerCertificate>((resolve, reject) => {
        const socket = net.connect(proxyPort, "127.0.0.1", () =>
          socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}\r\n\r\n`),
        );
        socket.once("data", () => {
          const secure = tls.connect({ socket, servername: host, ca }, () => {
            resolve(secure.getPeerCertificate());
            secure.destroy();
          });
          secure.on("error", reject);
        });
        socket.on("error", reject);
      });
    const first = await peer("one.example.org");
    const second = await peer("two.example.org");
    const again = await peer("one.example.org");
    expect(first.subjectaltname).toBe("DNS:one.example.org");
    expect(second.subjectaltname).toBe("DNS:two.example.org");
    expect(again.fingerprint256).toBe(first.fingerprint256);
    expect(first.pubkey?.equals(second.pubkey!)).toBe(true);
  });
  it.each([
    ["8.8.8.8", true],
    ["192.30.255.113", true],
    ["2606:4700:4700::1111", true],
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.20.0.1", false],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["100.100.100.200", false],
    ["::1", false],
    ["::ffff:127.0.0.1", false],
    ["fd00::1", false],
  ])("production resolver treats %s as public=%s", (address, expected) => {
    expect(publicAddress(address)).toBe(expected);
  });
  it("fails closed on private DNS results in the production resolver", async () => {
    const locked = await createResearchGateway({
      privateDirectory: path.join(root, "dns-private"),
      publicDirectory: path.join(root, "dns-public"),
    });
    await new Promise<void>((r) => locked.listen(0, "127.0.0.1", r));
    const port = (locked.address() as AddressInfo).port;
    const code = await new Promise<number>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "http://localhost/order" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
    });
    locked.closeAllConnections();
    await new Promise<void>((r) => locked.close(() => r()));
    expect(code).toBe(403);
  });
});
