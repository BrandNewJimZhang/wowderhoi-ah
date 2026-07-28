// Single source of truth for the deal-radar rules and the scan pipeline
// version. The in-game addon (Lua) cannot import this at runtime — the
// game has no build step — so scripts/gen-lua-rules.ts compiles these
// values into addon/WoWderhoiAH/GeneratedRules.lua, and a drift test
// (scripts/gen-lua-rules.test.ts) asserts the committed Lua matches. Every
// TS consumer imports the constants here directly; nothing re-declares them.

// Pricing pipeline version, stamped into every scan. Consumers (tooltip,
// deal radar, desktop importer) reject any other value: a bump means the
// meaning of the stored prices changed, not just their values.
export const SCAN_PIPELINE_VERSION = 3;

export const dealRadarRules = {
  minProfit: 500, // 5s absolute floor; sub-silver "deals" waste a trip
  discount: 0.85, // min price at 85% of med7 or lower
  minAuctions: 3, // liquidity guard: fewer sellers = no real market
  minHistory: 3, // the P10 median needs depth before it means anything
  // Credibility guards on med7 itself. minHistory counts samples but says
  // nothing about whether they mean anything: on a thin realm the bottom of
  // the book is often one camper, so every scan records that player's ask
  // and med7 becomes a price no listing ever traded against.
  minMed7Distinct: 2, // a flat 7d P10 series is one seller, not a market
  maxDiscount: 0.6 // past 60% off, the reference is broken, not the listing cheap
} as const;
