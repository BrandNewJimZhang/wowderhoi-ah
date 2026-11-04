// Single source of truth for every market rule and the scan pipeline
// version. The in-game addon (Lua) cannot import this at runtime — the
// game has no build step — so scripts/gen-lua-rules.ts compiles these
// values into addon/WoWderhoiAH/GeneratedRules.lua, and a drift test
// (scripts/gen-lua-rules.test.ts) asserts the committed Lua matches. Every
// TS consumer imports the constants here directly; nothing re-declares them.

// Pricing pipeline version, stamped into every scan. Consumers (tooltip,
// radar, desktop importer) reject any other value: a bump means the
// meaning of the stored prices changed, not just their values.
export const SCAN_PIPELINE_VERSION = 4;

// Auction house cut on a successful sale. Deposits are refunded on sale
// and lost only on expiry/cancel, so they never enter this rate.
export const AH_FEE_RATE = 0.05;

// The addon's auto-rescan cadence. Flow estimates and the terminal's
// elapsed-time floor both resolve at this granularity; the Lua side keeps
// its own timer, so a change here only needs a matching addon edit.
export const SCAN_INTERVAL_MINUTES = 15;

// Fallback daily capital when AQT_BUDGET_COPPER is unset. One value for the
// cockpit, the signal bundle and the production network.
export const DEFAULT_BUDGET_COPPER = 1_000_000;

// Depth-aware sell front. The upper book is noise (thin, stale listings
// nobody trades against), so sellP is the cheapest price with real
// quantity behind it, then undercut by one copper.
export const sellFrontRules = {
  alpha: 0.03, // depth target as a share of listed supply
  noiseMultiple: 3, // listings above 3x the quantity-weighted median are noise
  undercutCopper: 1, // listP = max(vendor + 1, sellP - 1)
  itemDepth: 3, // item auctions: the third-cheapest buyout, by listing count
  minDepthEarly: 1, // ignition: a single unit of depth is all that exists
  minDepth: 3 // wave and later: three units before the front is credible
} as const;

export type MarketPhase = "ignition" | "wave" | "settle" | "steady";
export type MarketType = "vendor" | "commodity" | "item";

// Phase is derived from data age and market breadth, never from the
// calendar: a server restart or a late scan would make dates lie.
export const phaseBoundaries = {
  ignitionHours: 6,
  waveHours: 48,
  settleHours: 168,
  ignitionBreadth: 80, // listed item kinds
  waveBreadth: 400,
  settleBreadth: 800
} as const;

// History window and sample floor per phase. Ignition deliberately has no
// history requirement: the first hours are the most profitable and the
// least observable, so structural priors must carry the decision.
export const phaseHistory: Record<MarketPhase, { windowHours: number; minSamples: number }> = {
  ignition: { windowHours: 0, minSamples: 0 },
  wave: { windowHours: 6, minSamples: 6 },
  settle: { windowHours: 24, minSamples: 12 },
  steady: { windowHours: 168, minSamples: 48 }
};

export type MarketTypeRule = {
  minListings: number; // buyable listings before the book is real
  minSellers: number; // distinct owners; falls back to listings when hidden
  minSpread: number; // sellP vs minP, below this the trade is noise
  maxSpread: number; // above this the reference broke, not the listing cheap
  minNet: number; // total net profit in copper, fees deducted
  minUnitProfit: number; // per-unit floor used to derive the price cap
};

// Rules tighten as a market matures: early phases tolerate wide spreads
// because price discovery is genuinely wild, later phases demand depth
// and a larger absolute edge because competition has arrived.
export const marketTypeRules: Record<MarketPhase, Record<MarketType, MarketTypeRule>> = {
  ignition: {
    vendor: { minListings: 1, minSellers: 1, minSpread: 0, maxSpread: 1, minNet: 0, minUnitProfit: 0 },
    commodity: { minListings: 1, minSellers: 1, minSpread: 0.2, maxSpread: 0.85, minNet: 5000, minUnitProfit: 50 },
    item: { minListings: 1, minSellers: 1, minSpread: 0.25, maxSpread: 0.8, minNet: 10000, minUnitProfit: 100 }
  },
  wave: {
    vendor: { minListings: 1, minSellers: 1, minSpread: 0, maxSpread: 1, minNet: 0, minUnitProfit: 0 },
    commodity: { minListings: 3, minSellers: 2, minSpread: 0.12, maxSpread: 0.6, minNet: 10000, minUnitProfit: 75 },
    item: { minListings: 2, minSellers: 1, minSpread: 0.18, maxSpread: 0.7, minNet: 20000, minUnitProfit: 150 }
  },
  settle: {
    vendor: { minListings: 1, minSellers: 1, minSpread: 0, maxSpread: 1, minNet: 0, minUnitProfit: 0 },
    commodity: { minListings: 5, minSellers: 3, minSpread: 0.08, maxSpread: 0.5, minNet: 20000, minUnitProfit: 100 },
    item: { minListings: 3, minSellers: 1, minSpread: 0.15, maxSpread: 0.6, minNet: 30000, minUnitProfit: 200 }
  },
  steady: {
    vendor: { minListings: 1, minSellers: 1, minSpread: 0, maxSpread: 1, minNet: 0, minUnitProfit: 0 },
    commodity: { minListings: 8, minSellers: 4, minSpread: 0.06, maxSpread: 0.4, minNet: 30000, minUnitProfit: 125 },
    item: { minListings: 3, minSellers: 1, minSpread: 0.12, maxSpread: 0.5, minNet: 50000, minUnitProfit: 250 }
  }
};

// Position sizing and spending limits. Sample counts below the floor mean
// the Kelly fraction is not estimable, so the phase default applies.
export const portfolioRules = {
  kellyFraction: 0.25,
  minKellySamples: 10,
  maxItemExposure: 0.25, // share of deployable capital in one item
  dailyBudget: 0.5 // share of deployable capital committed per day
} as const;

export const marketTypes: readonly MarketType[] = ["vendor", "commodity", "item"];
export const marketPhases: readonly MarketPhase[] = ["ignition", "wave", "settle", "steady"];
