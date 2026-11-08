// One-shot item metadata pass: fills names the client never loaded and
// downloads the matching icon. Wowhead's tooltip endpoint returns both in
// one response, so name and icon resolve together. Resolved names and
// existing files are skipped, which makes reruns cheap:
//   npm run items:enrich -- --limit 500
// The proxy is required because both hosts are region-blocked here.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
process.loadEnvFile();

import { prisma } from "@/lib/prisma";
import { isPlaceholderItemName } from "@/lib/item-name";
import { parseWowheadTooltip } from "@/lib/item-meta";

const execFileAsync = promisify(execFile);
const proxy = process.env.AQT_PROXY ?? "http://127.0.0.1:7890";
const iconsDir = join(process.cwd(), "public", "icons");
const CONCURRENCY = 8;
const THROTTLE_MS = 100;
const MAX_FAIL_STREAK = 30; // Wowhead rate limit kicked in — stop burning the list
const NAME_FLUSH_SIZE = 50;
const MIN_ICON_BYTES = 1_000; // smaller is an error page, not an icon

function numericArg(flag: string): number | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} needs a positive integer`);
  return value;
}

function iconPath(itemId: number): string {
  return join(iconsDir, `${itemId}.jpg`);
}

function isIconCached(itemId: number): boolean {
  const path = iconPath(itemId);
  return existsSync(path) && statSync(path).size >= MIN_ICON_BYTES;
}

// curl handles the proxy reliably on Windows; Node's fetch ignores
// HTTP(S)_PROXY without extra agents.
async function curl(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("curl", ["-s", "--max-time", "15", "-x", proxy, ...args], {
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout;
}

async function request(url: string): Promise<{ status: number; body: string }> {
  const stdout = await curl(["-w", "\n%{http_code}", url]);
  const splitAt = stdout.lastIndexOf("\n");
  return { status: Number(stdout.slice(splitAt + 1)), body: stdout.slice(0, splitAt) };
}

type TooltipResult =
  | { kind: "ok"; meta: NonNullable<ReturnType<typeof parseWowheadTooltip>> }
  | { kind: "missing" }
  | { kind: "transient" };

// dataEnv=4 is Classic Era and covers most of this realm's items, but the
// realm also ships TBC-and-later ids that only the modern dataset knows.
// A 404 there is a miss in that dataset, not a missing item; a second
// environment resolves it. Two misses mean no public record (realm-only).
async function fetchTooltip(itemId: number): Promise<TooltipResult> {
  for (const dataEnv of [4, 1]) {
    const { status, body } = await request(
      `https://nether.wowhead.com/tooltip/item/${itemId}?dataEnv=${dataEnv}&locale=4`
    );
    if (status === 200) {
      const meta = parseWowheadTooltip(body);
      return meta ? { kind: "ok", meta } : { kind: "transient" };
    }
    if (status !== 404) return { kind: "transient" };
  }
  return { kind: "missing" };
}

async function main() {
  mkdirSync(iconsDir, { recursive: true });
  const limit = numericArg("--limit") ?? Number.POSITIVE_INFINITY;
  const items = await prisma.item.findMany({
    select: { itemId: true, name: true },
    orderBy: { itemId: "asc" }
  });
  const targets = items
    .filter((item) => isPlaceholderItemName(item.name, item.itemId) || !isIconCached(item.itemId))
    .slice(0, limit);

  console.log(`${items.length} items, ${targets.length} need metadata via ${proxy} ...`);
  const queue = [...targets];
  const pendingNames: Array<{ itemId: number; name: string }> = [];
  let namesFilled = 0;
  let iconsDownloaded = 0;
  let tooltipFailed = 0;
  let iconFailed = 0;
  let missing = 0;
  let done = 0;
  let failStreak = 0;
  const failedIds: number[] = [];

  async function flushNames() {
    if (pendingNames.length === 0) return;
    const batch = pendingNames.splice(0);
    await prisma.$transaction(
      batch.map((pending) => prisma.item.update({ where: { itemId: pending.itemId }, data: { name: pending.name } }))
    );
  }

  async function worker() {
    for (;;) {
      if (failStreak >= MAX_FAIL_STREAK) return;
      const item = queue.shift();
      if (!item) return;

      let result: TooltipResult;
      try {
        result = await fetchTooltip(item.itemId);
      } catch {
        result = { kind: "transient" };
      }

      if (result.kind === "missing") {
        // No public record for this id. Deterministic, so it must not trip
        // the rate-limit guard and stall the rest of the queue.
        missing += 1;
      } else if (result.kind === "transient") {
        tooltipFailed += 1;
        failedIds.push(item.itemId);
        failStreak += 1;
      } else {
        const meta = result.meta;
        if (isPlaceholderItemName(item.name, item.itemId)) {
          pendingNames.push({ itemId: item.itemId, name: meta.name });
          namesFilled += 1;
          if (pendingNames.length >= NAME_FLUSH_SIZE) await flushNames();
        }
        const hadIcon = isIconCached(item.itemId);
        if (!hadIcon) {
          try {
            await curl(["-o", iconPath(item.itemId), `https://wow.zamimg.com/images/wow/icons/large/${meta.icon}.jpg`]);
          } catch {
            // curl writes nothing on a transport failure; the size check below
            // also rejects an error page written with a 200.
          }
        }
        if (isIconCached(item.itemId)) {
          if (!hadIcon) iconsDownloaded += 1;
          failStreak = 0;
        } else {
          iconFailed += 1;
          failedIds.push(item.itemId);
          failStreak += 1;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
      done += 1;
      if (done % 100 === 0) {
        console.log(
          `${done}/${targets.length} (names ${namesFilled}, icons ${iconsDownloaded}, missing ${missing}, failed ${tooltipFailed + iconFailed})`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await flushNames();

  const after = await prisma.item.findMany({ select: { itemId: true, name: true } });
  const remaining = after.filter(
    (item) => isPlaceholderItemName(item.name, item.itemId) || !isIconCached(item.itemId)
  ).length;

  console.log(
    `Done: ${namesFilled} names filled, ${iconsDownloaded} icons downloaded, `
    + `${tooltipFailed} tooltip failures, ${iconFailed} icon failures, ${missing} without a public record.`
  );
  if (failedIds.length > 0) {
    console.log(`Failed item ids (rerun to retry): ${failedIds.slice(0, 40).join(", ")}${failedIds.length > 40 ? " ..." : ""}`);
  }
  if (failStreak >= MAX_FAIL_STREAK) {
    console.log("Stopped early on a failure streak — check the proxy, then rerun.");
  } else {
    console.log(`${remaining} items still need metadata; run again to continue.`);
  }
  await prisma.$disconnect();
}

void main();
