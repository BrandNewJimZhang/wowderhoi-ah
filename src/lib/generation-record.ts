// The read-side shape of a materialised generation. Prisma returns the
// price index and the core output as Json; decoding and validating them
// once here keeps every page from asserting a shape it does not own.
import type { CoreOutput } from "@/lib/core/types";
import type { PriceIndex } from "@/lib/deflator";
import type { MarketPhase } from "@/lib/market-rules";

export type GenerationRecord = {
  id: string;
  marketId: string;
  scannedAt: Date;
  phase: MarketPhase;
  breadth: number;
  staleCount: number;
  firstScanAt: Date | null;
  priceIndex: PriceIndex;
  core: CoreOutput;
  gapMinutes: number | null;
};

type GenerationRowLike = {
  id: string;
  marketId: string;
  scannedAt: Date;
  phase: string;
  breadth: number;
  staleCount: number;
  firstScanAt: Date | null;
  priceIndex: unknown;
  core: unknown;
  gapMinutes: number | null;
};

function decodePriceIndex(raw: unknown): PriceIndex {
  if (typeof raw !== "object" || raw === null) throw new Error("Generation priceIndex must be an object");
  const index = raw as Partial<PriceIndex>;
  if (!Array.isArray(index.dates) || !Array.isArray(index.values) || typeof index.baseDate !== "string") {
    throw new Error("Generation priceIndex is malformed");
  }
  return { dates: index.dates, values: index.values, baseDate: index.baseDate };
}

function decodeCore(raw: unknown): CoreOutput {
  if (typeof raw !== "object" || raw === null) throw new Error("Generation core must be an object");
  const core = raw as Partial<CoreOutput>;
  if (typeof core.phase !== "string" || !Array.isArray(core.rows) || !Array.isArray(core.opportunities) || !Array.isArray(core.actions)) {
    throw new Error("Generation core is malformed");
  }
  return core as CoreOutput;
}

export function decodeGeneration(row: GenerationRowLike): GenerationRecord {
  return {
    id: row.id,
    marketId: row.marketId,
    scannedAt: row.scannedAt,
    phase: row.phase as MarketPhase,
    breadth: row.breadth,
    staleCount: row.staleCount,
    firstScanAt: row.firstScanAt,
    priceIndex: decodePriceIndex(row.priceIndex),
    core: decodeCore(row.core),
    gapMinutes: row.gapMinutes
  };
}
