import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const suite =
  process.env.RUN_FINANCIAL_CONTAINMENT_DOCKER === "1" ? describe.sequential : describe.skip;
const image = "node:24.19.0-bookworm"; // Cached image only; tests never pull or contact brokers.
suite("hostile Computer subprocess containment (real isolated Docker fixtures)", () => {
  const prefix = `rakazo-containment-fixture-${randomUUID().slice(0, 8)}`;
  const computer = `${prefix}-computer`;
  const gateway = `${prefix}-gateway`;
  const research = `${prefix}-research`;
  const broker = `${prefix}-broker`;
  const isolated = `${prefix}-isolated`;
  const uplink = `${prefix}-uplink`;
  let directory: string;
  let brokerIp: string;
  const docker = async (...args: string[]) =>
    (
      await run("docker", ["--host=unix:///var/run/docker.sock", ...args], {
        env: { PATH: process.env.PATH },
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  const execute = (source: string) =>
    docker("exec", computer, "node", "--input-type=module", "-e", source);
  beforeAll(async () => {
    await docker("image", "inspect", image); // Explicit failure rather than pulling an image.
    directory = await mkdtemp(path.join(tmpdir(), prefix));
    await mkdir(path.join(directory, "public"), { mode: 0o755 });
    await mkdir(path.join(directory, "private"), { mode: 0o700 });
    await docker("network", "create", "--internal", isolated);
    await docker("network", "create", "--internal", uplink);
    const server = `const http=require('http');let calls=0;http.createServer((req,res)=>{if(req.url==='/count'){res.end(String(calls));return}calls++;res.end('public market research')}).listen(8080,'0.0.0.0')`;
    for (const name of [research, broker])
      await docker(
        "run",
        "-d",
        "--name",
        name,
        "--network",
        uplink,
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--env",
        "BROKER_TOKEN=fixture-broker-secret-sentinel",
        image,
        "node",
        "-e",
        server,
      );
    brokerIp = JSON.parse(await docker("inspect", broker))[0].NetworkSettings.Networks[uplink]
      .IPAddress;
    await writeFile(
      path.join(directory, "gateway.mjs"),
      `import {createResearchGateway} from '/fixture/financial-egress.ts';import {lookup} from 'node:dns/promises';const server=await createResearchGateway({origins:['http://research.fixture:8080'],privateDirectory:'/private',publicDirectory:'/public',resolve:()=>lookup('${research}')});server.listen(8080,'0.0.0.0');`,
    );
    await writeFile(
      path.join(directory, "financial-egress.ts"),
      await readFile(path.resolve("infra/sandboxes/supervisor/src/financial-egress.ts")),
    );
    await writeFile(
      path.join(directory, "Dockerfile"),
      `FROM ${image}\nCOPY gateway.mjs financial-egress.ts /fixture/\n`,
    );
    await docker("build", "--pull=false", "--network=none", "-t", `${prefix}:fixture`, directory);
    await docker(
      "run",
      "-d",
      "--name",
      gateway,
      "--network",
      uplink,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid",
      "--mount",
      `type=volume,source=${prefix}-private,target=/private`,
      "--mount",
      `type=volume,source=${prefix}-public,target=/public`,
      `${prefix}:fixture`,
      "node",
      "--experimental-strip-types",
      "/fixture/gateway.mjs",
    );
    await docker("network", "connect", "--alias", "rakazo-research", isolated, gateway);
    await docker(
      "run",
      "-d",
      "--name",
      computer,
      "--network",
      isolated,
      "--user",
      "1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--env",
      "HTTPS_PROXY=http://rakazo-research:8080",
      "--mount",
      `type=volume,source=${prefix}-public,target=/etc/rakazo/research-trust,readonly`,
      image,
      "node",
      "-e",
      "setInterval(()=>{},1000)",
    );
    await execute(
      `for(let i=0;i<40;i++){try{const r=await fetch('http://rakazo-research:8080/health');if(r.ok)break}catch{}if(i===39)throw Error('gateway failed');await new Promise(r=>setTimeout(r,100));}`,
    );
  }, 60000);
  afterAll(async () => {
    for (const name of [computer, gateway, research, broker])
      await docker("rm", "-f", name).catch(() => undefined);
    for (const network of [isolated, uplink])
      await docker("network", "rm", network).catch(() => undefined);
    for (const volume of [`${prefix}-private`, `${prefix}-public`])
      await docker("volume", "rm", volume).catch(() => undefined);
    await docker("image", "rm", `${prefix}:fixture`).catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 60000);
  it("allows normal public research by the same Computer", async () => {
    expect(
      await execute(
        `import http from 'node:http';http.get({host:'rakazo-research',port:8080,path:'http://research.fixture:8080/markets'},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>console.log(res.statusCode+':'+b))})`,
      ),
    ).toBe("200:public market research");
  });
  it("blocks broker web Buy/Sell and scripts via the proxy", async () => {
    for (const method of ["GET", "POST"]) {
      expect(
        await execute(
          `import http from 'node:http';const req=http.request({host:'rakazo-research',port:8080,path:'http://${broker}:8080/buy',method:'${method}'},res=>{res.resume();res.on('end',()=>console.log(res.statusCode))});req.end();`,
        ),
      ).toBe("403");
    }
  });
  it("blocks direct network calls after removing every proxy variable", async () => {
    expect(
      await execute(
        `for(const k of Object.keys(process.env))if(k.toLowerCase().includes('proxy'))delete process.env[k];try{await fetch('http://${brokerIp}:8080/buy',{method:'POST',signal:AbortSignal.timeout(1000)});throw Error('BYPASS')}catch(e){if(e.message==='BYPASS')throw e;console.log('BLOCKED')}`,
      ),
    ).toBe("BLOCKED");
  });
  it("blocks indirect child-process network attempts", async () => {
    expect(
      await execute(
        `import {execFileSync} from 'node:child_process';console.log(execFileSync(process.execPath,['-e',"fetch('http://${brokerIp}:8080/buy',{method:'POST',signal:AbortSignal.timeout(1000)}).then(()=>{process.exitCode=2}).catch(()=>console.log('BLOCKED'))"],{encoding:'utf8',env:{PATH:process.env.PATH}}).trim())`,
      ),
    ).toBe("BLOCKED");
  });
  it("provides neither broker sentinel credentials nor private gateway keys/host controls", async () => {
    expect(
      await execute(
        `import fs from 'node:fs';const env=JSON.stringify(process.env);if(env.includes('fixture-broker-secret-sentinel'))throw Error('SECRET');for(const p of ['/private/ca.key','/var/run/docker.sock','/workspace/.aws/credentials'])if(fs.existsSync(p))throw Error('HOST SECRET');console.log('ISOLATED')`,
      ),
    ).toBe("ISOLATED");
    const info = JSON.parse(await docker("inspect", computer))[0];
    expect(info.HostConfig.CapDrop).toContain("ALL");
    expect(info.HostConfig.SecurityOpt).toContain("no-new-privileges:true");
    expect(info.Config.User).toBe("1000:1000");
    expect(Object.keys(info.NetworkSettings.Networks)).toEqual([isolated]);
  });
  it("leaves the fake broker with zero mutation requests", async () => {
    expect(
      await docker(
        "exec",
        broker,
        "node",
        "-e",
        "fetch('http://localhost:8080/count').then(r=>r.text()).then(console.log)",
      ),
    ).toBe("0");
  });
});
