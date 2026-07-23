# Changelog

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
