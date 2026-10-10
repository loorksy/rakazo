import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createResearchGateway } from "./financial-egress.js";

describe("trusted research gateway financial containment", () => {
  let root: string;
  let gateway: http.Server;
  let research: http.Server;
  let proxyPort: number;
  let researchPort: number;
  const receipts: Array<{ method?: string; url?: string; auth?: string; cookie?: string }> = [];
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "financial-egress-fixture-"));
    research = http.createServer((req, res) => {
      receipts.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        cookie: req.headers.cookie,
      });
      res.setHeader("set-cookie", "sentinel-secret=private");
      res.end("public research fixture");
    });
    await new Promise<void>((r) => research.listen(0, "127.0.0.1", r));
    researchPort = (research.address() as AddressInfo).port;
    gateway = await createResearchGateway({
      origins: [`http://research.fixture:${researchPort}`, "https://research.fixture"],
      privateDirectory: path.join(root, "private"),
      publicDirectory: path.join(root, "public"),
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
  it("allows public research and strips credentials and browser storage headers", async () => {
    const result = await request(`http://research.fixture:${researchPort}/market-research`, "GET", {
      authorization: "Bearer sentinel-secret",
      cookie: "token=sentinel-secret",
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe("public research fixture");
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(receipts.at(-1)).toEqual({
      method: "GET",
      url: "/market-research",
      auth: undefined,
      cookie: undefined,
    });
  });
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "blocks %s even on a verified research origin",
    async (method) => {
      const before = receipts.length;
      expect((await request(`http://research.fixture:${researchPort}/buy`, method)).status).toBe(
        403,
      );
      expect(receipts.length).toBe(before);
    },
  );
  it.each([
    "https://broker.fixture/buy",
    "http://127.0.0.1/buy",
    "http://169.254.169.254/latest/meta-data",
    "http://research.fixture.evil/buy",
  ])("blocks financial/alternate destination %s", async (url) => {
    expect((await request(url)).status).toBe(403);
  });
  it("rejects opaque broker CONNECT tunnels", async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () =>
        socket.write("CONNECT broker.fixture:443 HTTP/1.1\r\nHost: broker.fixture\r\n\r\n"),
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
  it("fails closed on private DNS results in the production resolver", async () => {
    const locked = await createResearchGateway({
      origins: ["http://localhost"],
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
