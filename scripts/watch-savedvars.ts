// Watches the WoW SavedVariables file written by the WoWderhoiAH addon
// and posts each new scan to the terminal import endpoint. In-game
// history accumulates inside the addon itself (WoWderhoiAH_Series); the
// addon asks the client to flush the file after every scan.
// Run alongside the game client:  npm run addon:watch
import { readFileSync, watchFile } from "node:fs";
import { parseSavedVariables } from "@/lib/addon-scan";
import { journalRevision } from "@/lib/journal";
import { SCAN_PIPELINE_VERSION } from "@/lib/market-rules";

// Nothing else in this process loads .env (the Prisma import that did so
// as a side effect is gone), so load it explicitly before reading config.
process.loadEnvFile();

const savedVarsPath = process.env.AQT_SAVEDVARS_PATH;
if (!savedVarsPath) {
  throw new Error(
    "AQT_SAVEDVARS_PATH is not set. Point it at the WoW SavedVariables file, e.g. " +
      "<game data dir>\\WTF\\Account\\<ACCOUNT>\\SavedVariables\\WoWderhoiAH.lua"
  );
}
const importUrl = process.env.AQT_IMPORT_URL ?? "http://localhost:3000/api/import/addon-scan";

let lastImportedScanAt = 0;
// The mailbox flushes a sale between two scans. A scan timestamp that did
// not move can still carry new actions, so the journal revision is part of
// the "is there anything to import" test.
let lastJournalRevision = "";


async function importLatestScan() {
  const parsed = parseSavedVariables(readFileSync(savedVarsPath!, "utf8"));
  const scan = parsed.WoWderhoiAH_ScanData as { scannedAt?: number; dataVersion?: number } | undefined;
  if (!scan || typeof scan.scannedAt !== "number") {
    console.log("No WoWderhoiAH_ScanData in SavedVariables yet; waiting for the first /wahscan.");
    return;
  }
  if (scan.dataVersion !== SCAN_PIPELINE_VERSION) {
    console.log("Stale scan from an old addon version on disk — rescan in game (/wahscan) to produce current-pipeline data.");
    return;
  }
  const revision = journalRevision(parsed.WoWderhoiAH_Journal);
  if (scan.scannedAt <= lastImportedScanAt && revision === lastJournalRevision) return;

  const response = await fetch(importUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // The scan is the current observation; the series is the append-only
    // history of every scan the addon retained, including those completed
    // while this watcher was not running; the journal is the action record.
    body: JSON.stringify({
      scan,
      series: parsed.WoWderhoiAH_Series,
      journal: parsed.WoWderhoiAH_Journal
    })
  });
  const body = await response.json();
  if (!response.ok && response.status !== 409) {
    throw new Error(`Import failed (${response.status}): ${JSON.stringify(body)}`);
  }
  lastImportedScanAt = Math.max(lastImportedScanAt, scan.scannedAt);
  lastJournalRevision = revision;
  // A watcher restart replays the latest scan through the duplicate branch;
  // that replay is exactly when the missed scans are backfilled, so the
  // journal message must report it too.
  const backfillNote = body.backfilled > 0
    ? `; backfilled ${body.backfilled} missed scan(s) from the addon series${body.backfillSkipped > 0 ? `, ${body.backfillSkipped} left for a later import` : ""}`
    : "";
  console.log(
    response.status === 409
      ? `Scan ${new Date(scan.scannedAt * 1000).toISOString()} already imported, skipping.`
      : body.journalUpdated
        ? `Journal for scan ${body.scannedAt} updated without a new scan: ${body.positions} positions, ${body.trades} trades${backfillNote}.`
        : `Imported ${body.imported} items, ${body.positions} positions and ${body.trades} trades from scan ${body.scannedAt}${backfillNote || "."}`
  );
  // Replay errors mean the projected ledger is not the book the player sees:
  // a truncated lot, a sale whose posting is missing, or an event kind the
  // terminal does not understand. Counted by the route, printed here so the
  // divergence is visible instead of silently written to the database.
  if (typeof body.journalErrors === "number" && body.journalErrors > 0) {
    console.warn(`Journal replay reported ${body.journalErrors} error(s); positions and P&L may not match the in-game ledger.`);
  }
}

async function main() {
  console.log(`Watching ${savedVarsPath}`);
  console.log(`Posting new scans to ${importUrl}`);
  await importLatestScan().catch((error) => console.error(error));
  // The addon asks the client to flush SavedVariables after every scan;
  // mtime polling picks that up, and logout/reload still rewrites the file.
  watchFile(savedVarsPath!, { interval: 5000 }, () => {
    void importLatestScan().catch((error) => console.error(error));
  });
}

void main();
