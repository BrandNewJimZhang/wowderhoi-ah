// The contract between the terminal and Core.lua. These types mirror the
// tables addon/WoWderhoiAH/Core.lua reads and writes; the Lua file is the
// authority for behaviour, this file only names its shape. Phase and market
// type unions come from the rule source so the two declarations cannot drift.
import type { MarketPhase, MarketType } from "@/lib/market-rules";

type Confidence = "high" | "medium" | "low";
export type FillBasis = "own" | "proxy" | "observed-zero" | "prior" | "vendor";
// Why a candidate row received no copper. The core decides this; a UI must
// not infer "the purse was too small" from a zero quantity.
type UnfundedReason = "kelly" | "exposure" | "purse" | "depth" | "slots";

// Clean fill labels per item: collected auction sales only, within a window.
// `exposedHours` sums each listing's time on the book before its sale was
// observed, which is the denominator the queue model needs.
export type OwnSales = Record<number, { qty: number; samples: number; exposedHours: number }>;

export type Tier = { p: number; q: number };

// The item's identity is its key in `market.items`: Core.evaluate reads
// `pairs(items)` and never opens an item's own id field, and the Lua bridge
// turns numeric object keys into Lua numbers. A copy inside the record was
// a leftover of the string-keyed bridge and had no reader on either side.
export type CoreMarketItem = {
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
  // True when the persisted ladder is a truncated top-of-book; the core then
  // cannot treat the last visible rung as the end of the queue.
  tierTruncated?: boolean;
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
  history?: { samples?: number; spanHours?: number };
};

export type CorePosition = {
  qty: number;
  cost: number;
  // Units the player can list now (bag or reagent bag). Absent means the
  // whole position is sellable, the pre-estate behaviour.
  sellableQty?: number;
  // False when some consumed lots have no booked cost; the sell action then
  // reports realised P&L as unknown instead of pretending the basis is 0.
  costKnown?: boolean;
  requiresBank?: boolean;
};

export type CoreInput = {
  now: number;
  phaseOverride?: MarketPhase;
  // The immutable identity this plan is evaluated under:
  // realm|faction|genEpoch:estateRevision:ledgerRevision:character.
  planRevision?: string;
  market: {
    // Only used when no phaseOverride is supplied; every production caller
    // resolves the phase from the store and hands it down.
    firstScanAt?: number;
    items: Record<number, CoreMarketItem>;
  };
  // The core reads cash (the client estate's purse) and budget (the
  // planning cap). Mail and escrow are ledger facts, not decision inputs.
  capital?: { cash?: number; budget?: number };
  capacity?: { bagSlots?: number; stackSize?: number; freeSlots?: number };
  positions?: Record<number, CorePosition>;
};

export type CoreRow = {
  itemId: number;
  name: string;
  quality?: number | string;
  marketType: MarketType;
  vendor: boolean;
  minPrice: number;
  candidateUnitPrice: number;
  candidateQty: number;
  // Quantity the shared allocator grants after ranking every row against
  // one purse. Actions and both UIs use this, never candidateQty.
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
  // Set when the row passed every gate but the allocator granted no copper.
  unfunded?: UnfundedReason;
  sellP: number;
  listP: number;
  vendorP: number;
  samples: number;
  highestBid: number;
  spreadPercent: number;
  candidateNet: number;
  candidateNetPerUnit: number;
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
      cost?: number;
      expectedNet: number;
      // Allocated net divided by the round-trip minutes a buy costs.
      netPerMinute: number;
      fillProb: number;
      fillBasis: FillBasis;
      allocQty: number;
      allocUnitPrice: number;
      stop?: { kind: "abort"; ifPriceAbove: number };
      // Resources after the preceding plan step, before and after this one.
      // Optional so generations written before the plan contract still
      // decode; the core always emits them.
      cashBefore?: number;
      cashAfter?: number;
      slotsBefore?: number;
      slotsAfter?: number;
      reason: string;
    }
  | {
      kind: "sell";
      itemId: number;
      name?: string;
      qty: number;
      price: number;
      expectedNet: number;
      // Historical cost is reported, never subtracted from the decision
      // value; `realizedPnl` is null when the basis is unknown.
      realizedPnl?: number | null;
      costKnown?: boolean;
      fillProb?: number;
      fillBasis?: string;
      // Net divided by the round-trip minutes a listing costs.
      netPerMinute: number;
      requiresBank?: boolean;
      cashBefore?: number;
      cashAfter?: number;
      slotsBefore?: number;
      slotsAfter?: number;
      reason: string;
    };

type UnplannedStep = {
  itemId: number;
  reason: string;
};

type CorePlan = {
  revision: string;
  steps: CoreAction[];
  resources: {
    cashBefore: number;
    cashAfter: number;
    slotsBefore: number;
    slotsAfter: number;
  };
  unplanned: UnplannedStep[];
};

export type CoreOutput = {
  phase: MarketPhase;
  // Candidates that passed every gate, funded or not.
  rows: CoreRow[];
  // The funded layer: rows the shared allocator actually gave copper. Every
  // "buy this now" surface renders this list, so its quantity, price and
  // net all describe the same trade.
  opportunities: CoreRow[];
  // The executable sequence: sells and buys in one order, each step carrying
  // the resources before and after it. `actions` is the same list for the
  // surfaces that already render it.
  actions: CoreAction[];
  // Present on every evaluation written after the plan contract; optional
  // so a generation stored before it still decodes.
  plan?: CorePlan;
  // Why rows fell out of the radar, keyed by gate, and why a candidate got
  // no copper, keyed by cause.
  diagnostics: {
    excluded: Record<string, number>;
    unfunded: Record<Exclude<UnfundedReason, "slots">, number> & { slots?: number };
  };
};

