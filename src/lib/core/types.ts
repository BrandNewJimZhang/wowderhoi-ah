// The contract between the terminal and Core.lua. These types mirror the
// tables addon/WoWderhoiAH/Core.lua reads and writes; the Lua file is the
// authority for behaviour, this file only names its shape. Phase and market
// type unions come from the rule source so the two declarations cannot drift.
import type { MarketPhase, MarketType } from "@/lib/market-rules";

export type Confidence = "high" | "medium" | "low";
export type FillBasis = "own" | "proxy" | "observed-zero" | "prior" | "vendor";

// Clean fill labels per item: collected auction sales only, within a window.
// `exposedHours` sums each listing's time on the book before its sale was
// observed, which is the denominator the queue model needs.
export type OwnSales = Record<number, { qty: number; samples: number; exposedHours: number }>;

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
  ownerVisible?: boolean;
  sellerHHI?: number | null;
  topSellerShare?: number | null;
  bidOnly?: number;
  tiers?: Tier[];
  inferredSoldLow?: number;
  inferredSoldHigh?: number;
  // False when the scan had no previous capture of the item; Core.isObservable
  // then treats the zero interval as missing data.
  flowObserved?: boolean;
  supplyGrowth?: number;
  elapsedHours?: number;
  ownSold?: number;
  ownSamples?: number;
  ownExposedHours?: number;
  highestBid?: number;
  demandPrior?: number;
  marketType?: MarketType;
  history?: { samples?: number };
};

export type CoreInput = {
  now: number;
  phaseOverride?: MarketPhase;
  market: {
    // Only used when no phaseOverride is supplied; every production caller
    // resolves the phase from the store and hands it down.
    firstScanAt?: number;
    items: Record<number, CoreMarketItem>;
  };
  // The core reads cash (the scanned purse) and budget (the planning cap).
  // Mail and escrow are ledger facts, not decision inputs.
  capital?: { cash?: number; budget?: number };
  capacity?: { bagSlots?: number; stackSize?: number };
  positions?: Record<number, { qty: number; cost: number }>;
};

export type CoreRow = {
  itemId: number;
  name: string;
  quality?: number | string;
  marketType: MarketType;
  vendor: boolean;
  minPrice: number;
  ladderPrice: number;
  execQty: number;
  // Quantity the shared allocator grants after ranking every row against
  // one purse. Actions and both UIs use this, never execQty.
  allocQty: number;
  allocNet: number;
  // Copper actually spent on the allocated quantity, priced from the cheap
  // end of the ladder the row's quantity was taken from.
  allocCost: number;
  // Average unit price of the allocated quantity (`allocCost / allocQty`).
  // The radar's buy column and the action list describe one trade, so they
  // use this price, not the full-depth average the row was ranked from.
  allocUnitPrice: number;
  // The allocator's own thin-evidence label (samples below the Kelly
  // floor). The cockpit renders it instead of comparing counts itself.
  exploratory: boolean;
  sellP: number;
  listP: number;
  vendorP: number;
  samples: number;
  highestBid: number;
  spreadPercent: number;
  netProfit: number;
  netPerUnit: number;
  // Allocated net divided by the round-trip minutes the action costs.
  netPerMinute: number;
  sellerHHI?: number | null;
  topSellerShare?: number | null;
  fillProb: number;
  fillProbLow: number;
  fillProbHigh: number;
  // The book share per hour behind fillProb -- the unit the calibration
  // script measures, not a per-listing rate. Absent on vendor rows, which
  // have no market fill estimate. Charts anchor their curve to this value.
  fillHazard?: number;
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
      // Average price of the allocated quantity: the price the action pays,
      // not the deep-ladder average the row was ranked from.
      unitPrice: number;
      expectedNet: number;
      // Allocated net divided by the round-trip minutes a buy costs.
      netPerMinute: number;
      fillProb: number;
      fillBasis: FillBasis;
      allocQty: number;
      allocUnitPrice: number;
      confidence: Confidence;
      exit: "vendor" | "auction";
      stop?: { kind: "abort"; ifPriceAbove: number };
      reason: string;
    }
  | {
      kind: "sell";
      itemId: number;
      name?: string;
      qty: number;
      price: number;
      expectedNet: number;
      // Net divided by the round-trip minutes a listing costs.
      netPerMinute: number;
      reason: string;
    };

export type CoreOutput = {
  phase: MarketPhase;
  rows: CoreRow[];
  actions: CoreAction[];
  // Why rows fell out of the radar, keyed by gate. Read by the core's own
  // tests; the UIs explain exclusions per row instead.
  diagnostics: { excluded: Record<string, number> };
};

