# Changelog

## v0.3.0 — 2026-11-05

### Changed

- Target WoW Forever (client 1.60.1, `Interface: 16001`). The repository
  now has two long-lived branches and no `main`: `forever` (default) and
  `anniversary` (TBC 2.5.6 maintenance). Shared work lands on `forever`
  and is merged into `anniversary`.
- The addon's scanner is rewritten for the modern `C_AuctionHouse` API:
  `ReplicateItems()` replaces the legacy `QueryAuctionItems` getAll path
  and the paged fallback. The per-frame cursor now advances *before* the
  budget check, fixing an off-by-one that skipped one row at every
  200-row boundary.
- The WAH trade page is a standalone panel anchored beside the modern
  auction house, opened from the addon compartment, `/wahtrade`, or
  automatically with the AH. It no longer injects an `AuctionFrame` tab.
- Buying goes through the modern API: item auctions are bought out by
  auction ID after re-reading the live buyout; commodities are purchased
  by quantity at the verified market price and confirmed in the client's
  own dialog.
- Sell prefill is replaced by `/wahprice` (cursor item or item link),
  because the modern client exposes no sell-slot query to addons.
- The Lua test suite now models the Forever client (modern AH API,
  `AuctionHouseFrame`) and covers replicate scanning, commodity buying,
  and the price guide.

### Added

- `docs/in-game-design-review.md` — feature-design review and roadmap.
- Addon compartment entry point (`AddonCompartmentFunc`).

## v0.2.1 — 2026-07-27

### Changed

- Vendor arbitrage deals no longer require the 5s profit floor: any
  listing below its NPC sell price is flagged, since reselling to the
  vendor is risk-free even on a 1c spread. The floor still gates
  median-discount deals, where reselling carries market risk.
- Deal-radar thresholds and the scan pipeline version now live in one
  source (`src/lib/market-rules.ts`), compiled into the addon's
  `GeneratedRules.lua`. A drift test fails CI if the two sides diverge,
  so the in-game radar and the desktop terminal can never classify the
  same scan differently.

### Fixed

- WAH tab draws its own opaque panel instead of showing whatever art the
  previous tab (or Auctionator) left behind.
- WAH search list refreshes after a buy completes, so a bought listing
  drops off without a manual re-search.

## v0.2.0 — 2026-07-27

### Changed

- Target the TBC Anniversary 2.5.6 client (`Interface: 20506`).
- Pricing pipeline reworked around the bottom decile (`dataVersion` 3).
  This realm's upper order book is thin and stale, so P50 tracked
  listings nothing ever traded against:
  - `marketPrice` is now the quantity-weighted **P10**, was P50. Every
    surface labelled "P50" — tooltip ladder, market table, item page,
    intraday chart, alert metrics — now reads P10.
  - Percentile ladder is **min / P5 / P10**, was P10 / P25 / P50. The
    `p25` field is gone and `p5` replaces it; the standalone `p10`
    field is gone too, since `marketPrice` now carries that number.
  - In-game price points store one close (`c`, the P10) instead of a
    P50/P10 pair. Points recorded by an older pipeline are dropped on
    the first scan after the bump — mixing P50 and P10 closes would
    poison the 7d median and the deal radar for a week.
- Scans stamped `dataVersion` 1 or 2 are rejected by the importer and
  the watcher; rescan in game with `/wahscan`.

## v0.1.0 — 2026-07-24

First public release of WoWderhoi AHelper.

### Added

- In-game addon `WoWderhoiAH` (Interface 20505, TBC Anniversary):
  - `/wahscan` full scan: getAll fast path with paged fallback,
    `/wahauto` auto-rescan on the 15-minute getAll cooldown
  - Quantity-weighted percentile price ladder (P10/P25/P50) per scan
    plus a depth-aware sell front; medians shrug off bait listings
  - Scan-to-scan price history (`WoWderhoiAH_Points`, 7 days x 192
    points): tooltip trend, 7d median, 3h/48h P10 chart windows
  - Tooltip market section led by the sell front, then min price,
    percentile ladder, supply, and history
  - **WAH auction house tab**: deal radar (vendor arbitrage + median
    discount), verified one-click buying, undercut sell prefill
  - Addon list icon and Auctions category, zhCN/enUS localization
- Desktop terminal (Next.js 16): server-side paged market monitor,
  intraday and daily item charts, price alerts and watchlists,
  crafting profit ranking, self-hosted item icons
- SavedVariables watcher (`npm run addon:watch`) importing each new
  scan into the terminal database; version-gated, duplicate-safe
- Deterministic perf harness (`scripts/perf/`) with latency budgets
- First-day onboarding tutorial (`docs/first-day.md`)
