// The contract between the terminal and Core.lua. These types mirror the
// tables addon/WoWderhoiAH/Core.lua reads and writes; the Lua file is the
// authority for behaviour, this file only names its shape. Phase and market
// type unions come from the rule source so the two declarations cannot drift.
import type { MarketPhase, MarketType } from "@/lib/market-rules";

export type Confidence = "high" | "medium" | "low";
export type FillBasis = "own" | "proxy" | "prior" | "vendor";

// Clean fill labels per item: collected auction sales only, within a window.
export type OwnSales = Record<number, { qty: number; samples: number; elapsedHours: number }>;

export type Tier = { p: number; q: number };

export type CoreMarketItem = {
  itemId: number;
  name: string;
  quality?: number | string;
  itemClass?: string;
  itemSubClass?: string;
  vendorP?: number;
  minPrice: number;
  sellP?: number;
  quantity?: number;
  numAuctions?: number;
  sellers?: number;
  sellersInvisible?: boolean;
  bidOnly?: number;
  tiers?: Tier[];
  inferredSoldLow?: number;
  inferredSoldHigh?: number;
  supplyGrowth?: number;
  elapsedHours?: number;
  ownSold?: number;
  ownSamples?: number;
  ownElapsedHours?: number;
  demandPrior?: number;
  marketType?: Exclude<MarketType, "vendor">;
  history?: { samples?: number };
};

export type CoreInput = {
  now: number;
  phaseOverride?: MarketPhase;
  market: {
    scannedAt?: number;
    firstScanAt?: number;
    items: Record<number, CoreMarketItem>;
  };
  capital?: { cash?: number; mail?: number; escrow?: number; budget?: number };
  capacity?: { bagSlots?: number; stackSize?: number };
  positions?: Record<number, { qty: number; cost: number }>;
};

export type CoreRow = {
  itemId: number;
  name: string;
  quality?: number | string;
  marketType: Exclude<MarketType, "vendor">;
  vendor: boolean;
  minPrice: number;
  ladderPrice: number;
  execQty: number;
  sellP: number;
  listP: number;
  spreadPercent: number;
  netProfit: number;
  netPerUnit: number;
  fillProb: number;
  fillProbLow: number;
  fillProbHigh: number;
  fillBasis: FillBasis;
  confidence: Confidence;
  supplyGrowth: number;
  bidOnly: number;
  inferredSoldLow: number;
  inferredSoldHigh: number;
  demandPrior: number;
  reason: string;
  score?: number;
};

export type CoreAction =
  | {
      kind: "buy";
      itemId: number;
      name: string;
      qty: number;
      maxUnitPrice: number;
      expectedNet: number;
      fillProb: number;
      confidence: Confidence;
      exit: "vendor" | "auction";
      stop?: { kind: "abort"; ifPriceAbove: number };
      reason: string;
    }
  | {
      kind: "sell";
      itemId: number;
      qty: number;
      price: number;
      netIfSold: number;
      reason: string;
    };

export type CoreOutput = {
  phase: MarketPhase;
  ageHours: number;
  breadth: number;
  dataAgeMinutes: number;
  rows: CoreRow[];
  actions: CoreAction[];
  diagnostics: {
    considered: number;
    matched: number;
    excluded: Record<string, number>;
  };
};

