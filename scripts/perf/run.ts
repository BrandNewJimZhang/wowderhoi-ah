// Perf run driver: starts a production server against a seeded perf DB,
// measures the key routes, optionally exercises import + contention, and
// evaluates gate budgets. Stop the regular dev server first — the run
// builds into .next and needs the machine quiet for honest numbers.
//   npm run perf:run -- [--db prisma/perf.db] [--port 3105] [--skip-build]
//                       [--explore] [--requests 30] [--label gate-1x]
//                       [--items-x 1] [--depth-x 1]
import { execFileSync, execSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { performance } from "node:perf_hooks";
import { evaluateGate, percentile, type PerfReport } from "./budgets";
import { buildScanPayload, generateMarket } from "./fixtures";

const { values } = parseArgs({
  options: {
    db: { type: "string", default: "prisma/perf.db" },
    port: { type: "string", default: "3105" },
    label: { type: "string", default: "gate" },
    requests: { type: "string", default: "30" },
    "items-x": { type: "string", default: "1" },
    "depth-x": { type: "string", default: "1" },
    "skip-build": { type: "boolean", default: false },
    explore: { type: "boolean", default: false }
  }
});
const port = Number(values.port);
const requestCount = Number(values.requests);
const baseUrl = `http://localhost:${port}`;
const databaseUrl = `file:${process.cwd()}/${values.db!}`;
// Explore runs probe cliffs: fewer requests, generous per-request timeout.
const requestTimeoutMs = values.explore ? 120_000 : 30_000;

type Sample = { ms: number; bytes: number; ok: boolean };

async function measure(url: string): Promise<Sample> {
  const start = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    const body = await response.arrayBuffer();
    return { ms: Math.round(performance.now() - start), bytes: body.byteLength, ok: response.ok };
  } catch {
    return { ms: Math.round(performance.now() - start), bytes: 0, ok: false };
  }
}

function summarize(samples: Sample[]) {
  const okSamples = samples.filter((sample) => sample.ok);
  const failures = samples.length - okSamples.length;
  if (okSamples.length === 0) {
    return { p50Ms: requestTimeoutMs, p95Ms: requestTimeoutMs, bytes: 0, failures };
  }
  return {
    p50Ms: percentile(okSamples.map((sample) => sample.ms), 0.5),
    p95Ms: percentile(okSamples.map((sample) => sample.ms), 0.95),
    bytes: Math.max(...okSamples.map((sample) => sample.bytes)),
    failures
  };
}

function nodeProcessCount(): number {
  try {
    return execSync('tasklist /FI "IMAGENAME eq node.exe" /NH', { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes("node.exe")).length;
  } catch {
    return -1;
  }
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(115_000) });
      if (response.status < 500) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Perf server on port ${port} did not become ready within 120s`);
}

async function main() {
  const portBusy = execSync(`netstat -ano -p TCP`, { encoding: "utf8" }).includes(`:${port} `);
  if (portBusy) {
    throw new Error(`Port ${port} is already in use — stop the stale perf server first`);
  }

  if (!values["skip-build"]) {
    console.log("Building production bundle (next build)...");
    execFileSync("npm", ["run", "build"], { stdio: "inherit", shell: true });
  }

  console.log(`Starting next start -p ${port} against ${databaseUrl}`);
  const server = spawn("npx", ["next", "start", "-p", String(port)], {
    env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "production" },
    stdio: "ignore",
    shell: true,
    detached: false
  });
  try {
    await waitForServer();

    const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    const itemRows = await prisma.item.findMany({ select: { itemId: true }, take: 400 });
    const itemCount = await prisma.item.count();
    const depthProbe = await prisma.auctionSnapshot.count({ where: { itemId: itemRows[0]?.itemId ?? 0 } });
    await prisma.$disconnect();
    if (itemRows.length === 0) {
      throw new Error("Perf DB has no items — run perf:seed first");
    }
    const itemIds = Array.from({ length: 20 }, (_, index) => itemRows[Math.floor((index * itemRows.length) / 20)].itemId);

    console.log(`S1: ${requestCount} homepage + ${requestCount} item-page requests...`);
    const homepageSamples: Sample[] = [];
    for (let i = 0; i < requestCount; i += 1) homepageSamples.push(await measure(`${baseUrl}/`));
    const itemSamples: Sample[] = [];
    for (let i = 0; i < requestCount; i += 1) {
      itemSamples.push(await measure(`${baseUrl}/items/${itemIds[i % itemIds.length]}`));
    }

    console.log("S3: full-size scan import...");
    const market = generateMarket({ itemCount, depth: 1, seed: 99 });
    const importStart = performance.now();
    const importResponse = await fetch(`${baseUrl}/api/import/addon-scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildScanPayload(market, 0, Math.floor(Date.now() / 1000))),
      signal: AbortSignal.timeout(600_000)
    });
    const importMs = Math.round(performance.now() - importStart);
    if (!importResponse.ok) {
      throw new Error(`Import failed with ${importResponse.status}: ${await importResponse.text()}`);
    }
    // The first homepage render after a scan rebuilds the signal cache;
    // measure it as its own stage so S2 sees steady-state reads and the
    // rebuild cost stays visible under its own budget.
    const rebuildSample = await measure(`${baseUrl}/`);
    const postImportRebuildMs = rebuildSample.ok ? rebuildSample.ms : requestTimeoutMs;

    console.log("S2: homepage loop during a concurrent import...");
    const contentionImport = fetch(`${baseUrl}/api/import/addon-scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildScanPayload(market, 0, Math.floor(Date.now() / 1000) + 900)),
      signal: AbortSignal.timeout(600_000)
    });
    const stalls: number[] = [];
    let importSettled = false;
    void contentionImport.finally(() => { importSettled = true; });
    while (!importSettled) stalls.push((await measure(`${baseUrl}/`)).ms);
    await contentionImport;
    // The final request overlaps the import's commit and pays the next
    // generation's cache rebuild — that cost has its own stage above, so
    // it is excluded from the during-import stall metric.
    stalls.pop();

    const report: PerfReport = {
      label: values.label!,
      scale: { itemsX: Number(values["items-x"]), depthX: Number(values["depth-x"]) },
      homepage: summarize(homepageSamples),
      itemPages: summarize(itemSamples),
      importMs,
      postImportRebuildMs,
      contentionMaxStallMs: stalls.length > 0 ? Math.max(...stalls) : null
    };
    const machine = {
      cpus: cpus().length,
      freeMemMB: Math.round(freemem() / 1_048_576),
      totalMemMB: Math.round(totalmem() / 1_048_576),
      nodeProcesses: nodeProcessCount(),
      dataset: { items: itemCount, snapshotsPerItem: depthProbe }
    };

    mkdirSync("scripts/perf/reports", { recursive: true });
    const reportPath = `scripts/perf/reports/${values.label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(reportPath, JSON.stringify({ report, machine }, null, 2));
    console.log(JSON.stringify({ report, machine }, null, 2));
    console.log(`Report written to ${reportPath}`);

    if (!values.explore) {
      const verdict = evaluateGate(report);
      if (!verdict.pass) {
        console.error(`GATE FAILED:\n- ${verdict.breaches.join("\n- ")}`);
        process.exitCode = 1;
      } else {
        console.log("GATE PASSED: all budgets met.");
      }
    }
  } finally {
    // next's CLI wrapper spawns the actual server; kill the whole tree.
    if (server.pid) execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: "ignore" });
  }
}

void main();
