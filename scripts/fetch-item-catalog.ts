// Fetches the client item catalogue from wuxianwow and writes the committed
// dataset used by `npm run items:catalog:import`. The public file is served
// chunked and occasionally stalls, so the download resumes with Range
// requests and only accepts a body that parses as complete JSON.
//
// One-off data refresh. Nothing at runtime calls the network: the committed
// dataset is the authority.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeCatalogDataset } from "@/lib/item-catalog";

const ENDPOINT = "https://wuxianwow.com/data/items.json";
const OUTPUT = fileURLToPath(new URL("../data/items.forever.json", import.meta.url));
const RAW_CACHE = fileURLToPath(new URL("../.tmp/items.raw.json", import.meta.url));
const BUILD = process.env.AQT_CATALOG_BUILD ?? "1.60.1.70862";
const MAX_ATTEMPTS = 12;

function readCompleteJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// A truncated body is the normal failure mode; resuming is cheaper than
// restarting and the server does honour Range requests.
function download(): unknown {
  let lastSize = -1;
  let stalled = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const parsed = readCompleteJson(RAW_CACHE);
    if (parsed !== null) return parsed;
    const before = existsSync(RAW_CACHE) ? statSync(RAW_CACHE).size : 0;
    execFileSync(
      "curl",
      ["-s", "-C", "-", "--max-time", "120", "-o", RAW_CACHE, ENDPOINT],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
    const after = existsSync(RAW_CACHE) ? statSync(RAW_CACHE).size : 0;
    console.log(`Download attempt ${attempt}: ${after} bytes`);
    stalled = after === before || after === lastSize ? stalled + 1 : 0;
    lastSize = after;
    if (stalled >= 3) throw new Error("Catalogue download stalled three times; rerun when the host recovers");
  }
  throw new Error("Catalogue download did not complete; rerun to resume");
}

function main() {
  const fromIndex = process.argv.indexOf("--from");
  const raw = fromIndex === -1
    ? download()
    : JSON.parse(readFileSync(process.argv[fromIndex + 1], "utf8"));
  const dataset = normalizeCatalogDataset(raw, {
    build: BUILD,
    fetchedAt: new Date().toISOString()
  });
  const temporary = `${OUTPUT}.tmp`;
  writeFileSync(temporary, JSON.stringify(dataset));
  renameSync(temporary, OUTPUT);
  const priced = dataset.items.filter((item) => item.vendorPrice > 0).length;
  const icons = new Set(dataset.items.map((item) => item.iconId)).size;
  console.log(
    `Wrote ${dataset.items.length} catalogue items (build ${dataset.build}, ${priced} with a vendor price, ${icons} distinct icons) to ${OUTPUT}.`
  );
}

main();
