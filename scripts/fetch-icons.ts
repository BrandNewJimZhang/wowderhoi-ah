// One-shot icon fetcher: resolves each item's icon name via the Wowhead
// tooltip API and downloads the image from zamimg into public/icons/
// <itemId>.jpg for local self-hosting. Both hosts are region-blocked
// here, so every request goes through the local proxy (AQT_PROXY,
// default the Clash port). Existing files are skipped — rerun anytime:
//   npm run icons:fetch
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
process.loadEnvFile();

import { prisma } from "@/lib/prisma";

const execFileAsync = promisify(execFile);
const proxy = process.env.AQT_PROXY ?? "http://127.0.0.1:7890";
const iconsDir = join(process.cwd(), "public", "icons");
const CONCURRENCY = 2; // Wowhead rate-limits bursts; keep it gentle
const THROTTLE_MS = 400; // pause between requests per worker

// curl handles the proxy reliably on Windows; Node's fetch ignores
// HTTP(S)_PROXY without extra agents.
async function curl(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("curl", ["-s", "--max-time", "15", "-x", proxy, ...args], {
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout;
}

async function fetchIcon(itemId: number): Promise<"ok" | "skip" | "fail"> {
  const target = join(iconsDir, `${itemId}.jpg`);
  if (existsSync(target)) return "skip";
  const payload = await curl([`https://nether.wowhead.com/tooltip/item/${itemId}?dataEnv=4&locale=4`]);
  let iconName: string | undefined;
  try {
    iconName = (JSON.parse(payload) as { icon?: string }).icon;
  } catch {
    return "fail"; // region page or malformed payload — leave for a rerun
  }
  if (!iconName) return "fail";
  await curl(["-o", target, `https://wow.zamimg.com/images/wow/icons/large/${iconName}.jpg`]);
  return existsSync(target) ? "ok" : "fail";
}

async function main() {
  mkdirSync(iconsDir, { recursive: true });
  const items = await prisma.item.findMany({ select: { itemId: true }, orderBy: { itemId: "asc" } });
  console.log(`Fetching icons for ${items.length} items via ${proxy} ...`);
  let ok = 0, skip = 0, fail = 0, done = 0, failStreak = 0;
  const MAX_FAIL_STREAK = 30; // Wowhead rate limit kicked in — stop burning the list
  const queue = [...items];
  async function worker() {
    for (;;) {
      if (failStreak >= MAX_FAIL_STREAK) return;
      const item = queue.shift();
      if (!item) return;
      const result = await fetchIcon(item.itemId).catch(() => "fail" as const);
      // Throttle only real network requests; cached skips are free.
      if (result !== "skip") await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
      if (result === "ok") { ok += 1; failStreak = 0; }
      else if (result === "skip") { skip += 1; }
      else { fail += 1; failStreak += 1; }
      done += 1;
      if (done % 200 === 0) console.log(`${done}/${items.length} (ok ${ok}, cached ${skip}, fail ${fail})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (failStreak >= MAX_FAIL_STREAK) {
    console.log(`Rate limited after ${ok} new downloads (${skip} cached). Wait ~10 minutes and rerun: npm run icons:fetch`);
  } else {
    console.log(`Done: ${ok} downloaded, ${skip} already cached, ${fail} failed (rerun to retry).`);
  }
  await prisma.$disconnect();
}

void main();
