// Watches the WoW SavedVariables file the addon writes and posts each new
// observation or state revision to the terminal. The state machine is split
// from the filesystem so the "should this file cause an import?" question is
// testable.
//
// Two domains travel separately:
//   scan   the market observation, immutable per scannedAt
//   state  estate, journal facts and the game's plan, each idempotent
// A mailbox sale or a bag change moves only the state; a new scan moves both.
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
  journalEvents?: number;
  journalUpdated?: boolean;
  seriesPoints?: number;
  duplicate?: boolean;
  changed?: boolean;
  estateRevision?: number;
  planRevision?: string | null;
  error?: string;
};

type PostResult = { status: number; body: ImportResponse };

type ImporterDeps = {
  readFile: () => string;
  post: (body: unknown) => Promise<PostResult>;
  postState: (body: unknown) => Promise<PostResult>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

type ImportOutcome = "idle" | "imported" | "duplicate" | "state";

type SavedScan = {
  scannedAt?: number;
  dataVersion?: number;
  server?: string;
  faction?: string;
};

type SavedEstate = { revision?: number; observedAt?: number };
type SavedPlan = { revision?: string };

function marketOf(scan: SavedScan | undefined, journal: unknown): { server: string; faction: string } | null {
  if (scan && typeof scan.server === "string" && typeof scan.faction === "string") {
    return { server: scan.server, faction: scan.faction };
  }
  if (typeof journal !== "object" || journal === null) return null;
  const books = (journal as Record<string, unknown>).books;
  if (typeof books !== "object" || books === null) return null;
  const key = Object.keys(books as Record<string, unknown>)[0];
  if (!key) return null;
  const parts = key.split("|");
  return parts.length >= 2 ? { server: parts[0], faction: parts[1] } : null;
}

export function createSavedvarsImporter(deps: ImporterDeps) {
  // One watermark per domain. A failed POST must not advance its domain:
  // the next tick has to retry the same document.
  let lastImportedScanAt = 0;
  let lastJournalRevision = "";
  let lastEstateRevision = "";
  let lastPlanRevision = "";

  return {
    async tick(): Promise<ImportOutcome> {
      const parsed = parseSavedVariables(deps.readFile());
      const scan = parsed.WoWderhoiAH_ScanData as SavedScan | undefined;
      if (!scan || typeof scan.scannedAt !== "number") {
        deps.log?.("No WoWderhoiAH_ScanData in SavedVariables yet; waiting for the first /wahscan.");
        return "idle";
      }
      if (scan.dataVersion !== SCAN_PIPELINE_VERSION) {
        deps.log?.("Stale scan from an old addon version on disk — rescan in game (/wahscan) to produce current-pipeline data.");
        return "idle";
      }
      const journal = parsed.WoWderhoiAH_Journal;
      const estate = parsed.WoWderhoiAH_Estate as SavedEstate | undefined;
      const plan = parsed.WoWderhoiAH_Plan as SavedPlan | undefined;
      const journalRev = journalRevision(journal);
      const estateRev = estate && typeof estate.revision === "number"
        ? `${estate.revision}:${estate.observedAt ?? 0}`
        : "";
      const planRev = plan && typeof plan.revision === "string" ? plan.revision : "";

      const scanChanged = scan.scannedAt > lastImportedScanAt;
      const stateChanged = journalRev !== lastJournalRevision
        || estateRev !== lastEstateRevision
        || planRev !== lastPlanRevision;
      if (!scanChanged && !stateChanged) return "idle";

      let outcome: ImportOutcome = "idle";
      if (scanChanged) {
        const result = await deps.post({
          scan,
          series: parsed.WoWderhoiAH_Series,
          source: "watcher"
        });
        if (result.status !== 200 && result.status !== 409) {
          throw new Error(`Import failed (${result.status}): ${JSON.stringify(result.body)}`);
        }
        lastImportedScanAt = Math.max(lastImportedScanAt, scan.scannedAt);
        if (result.status === 409) {
          deps.log?.(`Scan ${new Date(scan.scannedAt * 1000).toISOString()} already imported, skipping.`);
          outcome = "duplicate";
        } else {
          deps.log?.(
            `Imported ${result.body.imported ?? 0} items and ${result.body.seriesPoints ?? 0} series points `
            + `from scan ${new Date(scan.scannedAt * 1000).toISOString()}.`
          );
          outcome = "imported";
        }
      }

      if (stateChanged) {
        const market = marketOf(scan, journal);
        if (!market) {
          deps.warn?.("State changed but the SavedVariables document names no market; skipping until the next scan.");
          return outcome;
        }
        // The state domain names its market; re-sending the whole scan on
        // every bag or mailbox change would move the market observation
        // bytes for a payload the route never reads.
        const result = await deps.postState({
          server: market.server,
          faction: market.faction,
          estate,
          journal,
          plan,
          source: "watcher"
        });
        if (result.status !== 200) {
          throw new Error(`State import failed (${result.status}): ${JSON.stringify(result.body)}`);
        }
        lastJournalRevision = journalRev;
        lastEstateRevision = estateRev;
        lastPlanRevision = planRev;
        deps.log?.(
          `State updated: ${result.body.journalEvents ?? 0} journal facts, `
          + `${result.body.trades ?? 0} new trades, estate revision ${result.body.estateRevision ?? 0}`
          + `${result.body.planRevision ? `, plan ${result.body.planRevision}` : ""}.`
        );
        if (outcome === "idle") outcome = "state";
      }
      if (!scanChanged && outcome === "idle" && stateChanged) outcome = "state";
      return outcome;
    }
  };
}

type WatcherHandle = { stop: () => void };

// Polling is enough: the addon asks the client to flush SavedVariables
// after every action and scan, and mtime moves on that write. The in-flight
// guard keeps a slow import from overlapping the next tick.
export function startSavedvarsWatcher(options: {
  path: string;
  importUrl: string;
  stateUrl?: string;
  intervalMs?: number;
}): WatcherHandle {
  const stateUrl = options.stateUrl ?? options.importUrl.replace(/addon-scan\/?$/, "addon-state");
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
    postState: async (body) => {
      const response = await fetch(stateUrl, {
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
  // A failed POST leaves the watermark where it was, so the same document
  // must be retried. Watching the file alone would only retry when the game
  // writes again — after the next action at the earliest. Retry on a
  // backoff instead, so a server that was down for a moment catches up.
  const baseDelay = options.intervalMs ?? 5000;
  let retryDelay = baseDelay;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    if (inFlight) return;
    inFlight = true;
    void importer.tick()
      .then(() => {
        retryDelay = baseDelay;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
      })
      .catch((error) => {
        console.error(error);
        if (retryTimer) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          tick();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 60_000);
      })
      .finally(() => { inFlight = false; });
  };
  console.log(`Watching ${options.path}`);
  console.log(`Posting new scans to ${options.importUrl}`);
  console.log(`Posting state to ${stateUrl}`);
  tick();
  const listener = () => tick();
  watchFile(options.path, { interval: options.intervalMs ?? 5000 }, listener);
  return {
    stop: () => {
      unwatchFile(options.path, listener);
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    }
  };
}
