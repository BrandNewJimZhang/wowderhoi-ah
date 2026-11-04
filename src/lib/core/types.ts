// The contract between the terminal and Core.lua. These types mirror the
// tables addon/WoWderhoiAH/Core.lua reads and writes; the Lua file is the
// authority for behaviour, this file only names its shape.

export type MarketPhase = "ignition" | "wave" | "settle" | "steady";
export type MarketKind = "vendor" | "commodity" | "item";
export type Confidence = "high" | "medium" | "low";

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
  p5?: number;
  p10?: number;
  quantity?: number;
  numAuctions?: number;
  sellers?: number;
  sellersInvisible?: boolean;
  bidOnly?: number;
  tiers?: Tier[];
  inferredSold?: number;
  supplyGrowth?: number;
  elapsedHours?: number;
  marketType?: "commodity" | "item";
  history?: { sellRef?: number; samples?: number; latest?: number; distinct?: number };
};

export type CoreInput = {
  now: number;
  phaseOverride?: MarketPhase;
  market: {
    scannedAt?: number;
    firstScanAt?: number;
    items: Record<number, CoreMarketItem>;
    bids?: Record<number, { count: number; highest: number }>;
  };
  capital?: { cash?: number; mail?: number; escrow?: number; budget?: number };
  capacity?: { bagSlots?: number; stackSize?: number };
  positions?: Record<number, { qty: number; cost: number }>;
};

export type CoreRow = {
  itemId: number;
  name: string;
  quality?: number | string;
  marketType: "commodity" | "item";
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
  confidence: Confidence;
  supplyGrowth: number;
  bidOnly: number;
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

export type SellPlan = {
  itemId: number;
  quantity: number;
  sellP: number;
  listP: number;
  unitCost: number;
  deposit: number;
  netIfSold: number;
  sellBreakeven: number;
  expireBreakeven: number;
  lossIfExpired: number;
  feeIfSold: number;
};
