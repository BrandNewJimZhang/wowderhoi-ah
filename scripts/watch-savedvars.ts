// Watches the WoW SavedVariables file written by the WoWderhoiAH addon
// and posts each new scan to the terminal import endpoint. In-game
// history accumulates inside the addon itself (WoWderhoiAH_Points).
// Run alongside the game client:  npm run addon:watch
import { readFileSync, watchFile } from "node:fs";
import { parseSavedVariables } from "@/lib/addon-scan";

// Nothing else in this process loads .env (the Prisma import that did so
// as a side effect is gone), so load it explicitly before reading config.
process.loadEnvFile();

const savedVarsPath = process.env.AQT_SAVEDVARS_PATH;
if (!savedVarsPath) {
  throw new Error(
    "AQT_SAVEDVARS_PATH is not set. Point it at the WoW SavedVariables file, e.g. " +
      "<WoW install dir>\\_anniversary_\\WTF\\Account\\<ACCOUNT>\\SavedVariables\\WoWderhoiAH.lua"
  );
}
const importUrl = process.env.AQT_IMPORT_URL ?? "http://localhost:3000/api/import/addon-scan";

let lastImportedScanAt = 0;


async function importLatestScan() {
  const parsed = parseSavedVariables(readFileSync(savedVarsPath!, "utf8"));
  const scan = parsed.WoWderhoiAH_ScanData as { scannedAt?: number; dataVersion?: number } | undefined;
  if (!scan || typeof scan.scannedAt !== "number") {
    console.log("No WoWderhoiAH_ScanData in SavedVariables yet; waiting for the first /wahscan.");
    return;
  }
  if (scan.dataVersion !== 2) {
    console.log("Stale scan from an old addon version on disk — rescan in game (/wahscan) to produce current-pipeline data.");
    return;
  }
  if (scan.scannedAt <= lastImportedScanAt) return;

  const response = await fetch(importUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scan)
  });
  const body = await response.json();
  if (!response.ok && response.status !== 409) {
    throw new Error(`Import failed (${response.status}): ${JSON.stringify(body)}`);
  }
  lastImportedScanAt = scan.scannedAt;
  console.log(
    response.status === 409
      ? `Scan ${new Date(scan.scannedAt * 1000).toISOString()} already imported, skipping.`
      : `Imported ${body.imported} items from scan ${body.scannedAt}.`
  );
}

async function main() {
  console.log(`Watching ${savedVarsPath}`);
  console.log(`Posting new scans to ${importUrl}`);
  await importLatestScan().catch((error) => console.error(error));
  // WoW rewrites SavedVariables on logout//reload; mtime polling is enough.
  watchFile(savedVarsPath!, { interval: 5000 }, () => {
    void importLatestScan().catch((error) => console.error(error));
  });
}

void main();
