// Watches the WoW SavedVariables file the addon writes and posts each new
// scan to the terminal. The state machine is split from the filesystem so
// the "should this file cause an import?" question is testable: the mailbox
// flushes a sale between scans, so a scan timestamp that did not move can
// still carry a new action.
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { parseSavedVariables } from "@/lib/addon-scan";
import { journalRevision } from "@/lib/journal";
import { SCAN_PIPELINE_VERSION } from "@/lib/market-rules";

export type ImportResponse = {
  imported?: number;
  skippedItems?: number;
  positions?: number;
  trades?: number;
  journalErrors?: number;
  journalUpdated?: boolean;
  seriesPoints?: number;
  duplicate?: boolean;
  error?: string;
};

type PostResult = { status: number; body: ImportResponse };

type ImporterDeps = {
  readFile: () => string;
  post: (body: unknown) => Promise<PostResult>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

type ImportOutcome = "idle" | "imported" | "duplicate" | "journal";

export function createSavedvarsImporter(deps: ImporterDeps) {
  // The timestamp and the journal revision are the two reasons a file is
  // worth a POST. A failed POST must not advance either: the next tick has
  // to retry the same scan.
  let lastImportedScanAt = 0;
  let lastJournalRevision = "";

  return {
    async tick(): Promise<ImportOutcome> {
      const parsed = parseSavedVariables(deps.readFile());
      const scan = parsed.WoWderhoiAH_ScanData as { scannedAt?: number; dataVersion?: number } | undefined;
      if (!scan || typeof scan.scannedAt !== "number") {
        deps.log?.("No WoWderhoiAH_ScanData in SavedVariables yet; waiting for the first /wahscan.");
        return "idle";
      }
      if (scan.dataVersion !== SCAN_PIPELINE_VERSION) {
        deps.log?.("Stale scan from an old addon version on disk — rescan in game (/wahscan) to produce current-pipeline data.");
        return "idle";
      }
      const revision = journalRevision(parsed.WoWderhoiAH_Journal);
      if (scan.scannedAt <= lastImportedScanAt && revision === lastJournalRevision) return "idle";

      const result = await deps.post({
        scan,
        series: parsed.WoWderhoiAH_Series,
        journal: parsed.WoWderhoiAH_Journal,
        source: "watcher"
      });
      if (result.status !== 200 && result.status !== 409) {
        throw new Error(`Import failed (${result.status}): ${JSON.stringify(result.body)}`);
      }
      lastImportedScanAt = Math.max(lastImportedScanAt, scan.scannedAt);
      lastJournalRevision = revision;
      if (result.status === 409) {
        deps.log?.(`Scan ${new Date(scan.scannedAt * 1000).toISOString()} already imported, skipping.`);
        return "duplicate";
      }
      if (result.body.journalUpdated) {
        deps.log?.(
          `Journal for scan ${new Date(scan.scannedAt * 1000).toISOString()} updated without a new scan: `
          + `${result.body.positions ?? 0} positions, ${result.body.trades ?? 0} trades.`
        );
        return "journal";
      }
      deps.log?.(
        `Imported ${result.body.imported ?? 0} items, ${result.body.positions ?? 0} positions and `
        + `${result.body.trades ?? 0} trades from scan ${new Date(scan.scannedAt * 1000).toISOString()} `
        + `(${result.body.seriesPoints ?? 0} series points${result.body.skippedItems ? `, ${result.body.skippedItems} unattributed rows skipped` : ""}).`
      );
      if ((result.body.journalErrors ?? 0) > 0) {
        deps.warn?.(`Journal replay reported ${result.body.journalErrors} error(s); positions and P&L may not match the in-game ledger.`);
      }
      return "imported";
    }
  };
}

type WatcherHandle = { stop: () => void };

// Polling is enough: the addon asks the client to flush SavedVariables
// after every scan, and mtime moves on that write. The in-flight guard
// keeps a slow import from overlapping the next tick.
export function startSavedvarsWatcher(options: {
  path: string;
  importUrl: string;
  intervalMs?: number;
}): WatcherHandle {
  const importer = createSavedvarsImporter({
    readFile: () => readFileSync(options.path, "utf8"),
    post: async (body) => {
      const response = await fetch(options.importUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    },
    log: (message) => console.log(message),
    warn: (message) => console.warn(message)
  });
  let inFlight = false;
  const tick = () => {
    if (inFlight) return;
    inFlight = true;
    void importer.tick()
      .catch((error) => console.error(error))
      .finally(() => { inFlight = false; });
  };
  console.log(`Watching ${options.path}`);
  console.log(`Posting new scans to ${options.importUrl}`);
  tick();
  const listener = () => tick();
  watchFile(options.path, { interval: options.intervalMs ?? 5000 }, listener);
  return { stop: () => unwatchFile(options.path, listener) };
}
