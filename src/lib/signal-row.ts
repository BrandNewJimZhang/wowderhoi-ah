// The stored shape of one materialised signal. Kept in its own module so
// the reader does not import the import pipeline (and fengari with it).
import type { MarketSignal } from "@/lib/analytics";
import type { CoreRow } from "@/lib/core/types";

export const SIGNAL_SCHEMA_VERSION = 1;

export type StoredSignalRow = {
  schemaVersion: number;
  signal: MarketSignal;
  // The core's own row for this item, when it passed the generation's
  // gates. The item page reads this instead of searching the evaluation.
  coreRow: CoreRow | null;
  // The previous series point's epoch seconds, the core input behind
  // elapsedHours. Stored so a journal-only recompute does not have to load
  // the whole series again.
  previousAt: number | null;
};

// A row written by an older schema is a decode error, not a row with
// missing fields: silently substituting defaults would price a trade from
// fields the writer never stored.
export function decodeSignalRow(raw: unknown): StoredSignalRow {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Stored signal row must be an object");
  }
  const row = raw as Partial<StoredSignalRow>;
  if (row.schemaVersion !== SIGNAL_SCHEMA_VERSION) {
    throw new Error(`Stored signal schema ${JSON.stringify(row.schemaVersion)} is not ${SIGNAL_SCHEMA_VERSION}`);
  }
  if (typeof row.signal !== "object" || row.signal === null || typeof row.signal.itemId !== "number") {
    throw new Error("Stored signal row carries no signal");
  }
  return {
    schemaVersion: row.schemaVersion,
    signal: row.signal as MarketSignal,
    coreRow: (row.coreRow ?? null) as CoreRow | null,
    previousAt: typeof row.previousAt === "number" ? row.previousAt : null
  };
}
