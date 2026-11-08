// Downloads the shared item icons named by data/items.forever.json into
// public/icons/<iconId>.webp. One file per icon id, not per item: the
// catalogue maps 16,939 items onto ~2,668 sprites.
//   npm run icons:fetch [-- --limit 500]
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseCatalogDataset } from "@/lib/item-catalog";
import { ICON_PATH, MIN_ICON_BYTES, iconFileName, iconUrl, uniqueIconIds } from "@/lib/item-icons";

process.loadEnvFile();

const execFileAsync = promisify(execFile);
const proxy = process.env.AQT_PROXY;
const CONCURRENCY = 8;
const MAX_FAIL_STREAK = 20;
const iconsDir = join(process.cwd(), ICON_PATH);

function numericArg(flag: string): number | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} needs a positive integer`);
  return value;
}

function cached(iconId: number): boolean {
  const path = join(iconsDir, iconFileName(iconId));
  return existsSync(path) && statSync(path).size >= MIN_ICON_BYTES;
}

async function download(iconId: number): Promise<boolean> {
  const target = join(iconsDir, iconFileName(iconId));
  const temporary = `${target}.part`;
  const args = ["-s", "--max-time", "45", "--retry", "2", "-o", temporary];
  if (proxy) args.push("-x", proxy);
  args.push(iconUrl(iconId));
  try {
    await execFileAsync("curl", args, { maxBuffer: 1024 * 1024 });
    if (existsSync(temporary) && statSync(temporary).size >= MIN_ICON_BYTES) {
      renameSync(temporary, target);
      return true;
    }
  } catch {
    // Fall through: a transport failure leaves no valid file.
  }
  if (existsSync(temporary)) unlinkSync(temporary);
  return false;
}

async function main() {
  mkdirSync(iconsDir, { recursive: true });
  const dataset = parseCatalogDataset(JSON.parse(readFileSync("data/items.forever.json", "utf8")));
  const all = uniqueIconIds(dataset.items);
  const targets = all.filter((iconId) => !cached(iconId)).slice(0, numericArg("--limit") ?? all.length);
  console.log(`${all.length} shared icons, ${targets.length} missing${proxy ? ` via ${proxy}` : ""}.`);

  let done = 0;
  let downloaded = 0;
  let failed = 0;
  let failStreak = 0;
  const queue = [...targets];
  async function worker() {
    for (;;) {
      if (failStreak >= MAX_FAIL_STREAK) return;
      const iconId = queue.shift();
      if (iconId === undefined) return;
      if (await download(iconId)) {
        downloaded += 1;
        failStreak = 0;
      } else {
        failed += 1;
        failStreak += 1;
      }
      done += 1;
      if (done % 100 === 0) console.log(`${done}/${targets.length} (downloaded ${downloaded}, failed ${failed})`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  console.log(`Done: ${downloaded} downloaded, ${failed} failed. ${all.length - targets.length} already cached.`);
  if (failStreak >= MAX_FAIL_STREAK) {
    console.log("Stopped early on a failure streak — check the network or proxy, then rerun.");
    process.exitCode = 1;
  }
}

void main();
