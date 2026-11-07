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

// Bumped when a scan's inferred flow starts excluding another source of
// self-contamination. The addon stamps it on every scan and the calibration
// only trusts rows at or above this version; a literal in either place would
// let the two drift apart.
export const OBSERVATION_VERSION = 2;

// Auction house cut on a successful sale. Deposits are refunded on sale
// and lost only on expiry/cancel, so they never enter this rate.
export const AH_FEE_RATE = 0.05;

// The addon's auto-rescan cadence. Flow estimates and the terminal's
// elapsed-time floor both resolve at this granularity, and the compiled
// rule carries it into the addon ticker, so the two sides cannot disagree.
export const SCAN_INTERVAL_MINUTES = 15;

// A scan older than this is labelled stale in the in-game tooltip and in
// the terminal banner. One value: the player must not see the same scan
// marked expired on one surface and fresh on the other.
export const SCAN_STALE_MINUTES = 30;

// Fallback daily capital when AQT_BUDGET_COPPER is unset. One value for the
// cockpit, the signal bundle and the production network.
export const DEFAULT_BUDGET_COPPER = 1_000_000;

// Evidence window for own fills. A collected sale is the only clean label
// the client ever gives; the addon ledger and the terminal query must read
// the same window or their fill estimates describe different populations.
//
// horizonHours is the window every fill chance is quoted for -- the radar,
// the item chart, the sell plan and the review calibration. Measuring an
// outcome over a different window (72h used to be applied to a 24h
// prediction) compares two different questions and biases the calibration.
export const fillRules = { ownSalesWindowDays: 7, horizonHours: 24 } as const;

// Fill-rate priors per phase and market type, as expected sales per hour
// expressed as a share of listed supply. The core shrinks an observed zero
// toward this prior instead of treating "nothing disappeared" as missing
// data: priorStrengthHours is the prior's weight in unit-hours, so a book
// with real depth quickly overrides the table while a thin or unobservable
// one falls back to it. scripts/calibrate-fill-priors.ts prints suggested
// values from scans stamped observationVersion >= 2; a human edits this
// table and reruns `npm run gen:lua-rules`.
export const fillPrior = {
  // 50 unit-hours: a typical item's book (hundreds of units) observed over
  // one scan interval already outweighs the prior, while a thin book or a
  // single unit still leans on it.
  priorStrengthHours: 50,
  hazard: {
    ignition: { commodity: 0.35, item: 0.08 },
    wave: { commodity: 0.2, item: 0.06 },
    settle: { commodity: 0.12, item: 0.04 },
    steady: { commodity: 0.08, item: 0.03 }
  }
} as const;

// Seller concentration. A book held by one player can be repriced under you
// in minutes, so the score discounts rows whose supply is concentrated.
// Only applied when owner names are visible; hidden owners mean the measure
// is unavailable, not that competition is absent.
export const concentrationRules = { weight: 0.15 } as const;

// Rough player time per action, in minutes. Ranking divides by the effort
// an opportunity costs, so a 10k flip that takes one trip beats a 12k flip
// that takes four. The numbers are deliberately round: they order trades,
// they do not pretend to a stopwatch.
export const timeCostRules = {
  overheadMinutes: 10, // a round trip to the auction house
  buyMinutes: 2, // buying the allocated quantity
  postMinutes: 2 // listing a position, used by the sell plan's per-minute net
} as const;

// Depth-aware sell front. The upper book is noise (thin, stale listings
// nobody trades against), so sellP is the cheapest price with real
// quantity behind it, then undercut by one copper.
export const sellFrontRules = {
  alpha: 0.03, // depth target as a share of listed supply
  noiseMultiple: 3, // listings above 3x the quantity-weighted median are noise
  undercutCopper: 1, // listP = max(vendor + 1, sellP - 1)
  undercutWarnRatio: 0.02, // an owned listing above sellP * (1 + ratio) is undercut
  itemDepth: 3, // item auctions: the third-cheapest buyout, by listing count
  minDepthEarly: 1, // ignition: a single unit of depth is all that exists
  minDepth: 3 // wave and later: three units before the front is credible
} as const;

export type MarketPhase = "ignition" | "wave" | "settle" | "steady";
// The types the gate matrix applies to. Vendor arbitrage is not a gate: the
// NPC always buys, so the core takes that branch before any rule lookup.
export type MarketType = "commodity" | "item";

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

type MarketTypeRule = {
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
    commodity: { minListings: 1, minSellers: 1, minSpread: 0.2, maxSpread: 0.85, minNet: 5000, minUnitProfit: 50 },
    item: { minListings: 1, minSellers: 1, minSpread: 0.25, maxSpread: 0.8, minNet: 10000, minUnitProfit: 100 }
  },
  wave: {
    commodity: { minListings: 3, minSellers: 2, minSpread: 0.12, maxSpread: 0.6, minNet: 10000, minUnitProfit: 75 },
    item: { minListings: 2, minSellers: 1, minSpread: 0.18, maxSpread: 0.7, minNet: 20000, minUnitProfit: 150 }
  },
  settle: {
    commodity: { minListings: 5, minSellers: 3, minSpread: 0.08, maxSpread: 0.5, minNet: 20000, minUnitProfit: 100 },
    item: { minListings: 3, minSellers: 1, minSpread: 0.15, maxSpread: 0.6, minNet: 30000, minUnitProfit: 200 }
  },
  steady: {
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

export const marketPhases: readonly MarketPhase[] = ["ignition", "wave", "settle", "steady"];
