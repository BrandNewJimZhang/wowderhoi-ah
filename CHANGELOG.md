# Changelog

## Unreleased

### Added

- `/wahdiag` splits a scan into wait, client API, Lua, finish and save
  milliseconds and prints their shares; the finish phase now runs across
  frames and the SavedVariables write is deferred by one frame.
- `Core.allocate` reports `row.unfunded` (`kelly`, `exposure`, `purse`,
  `depth`) and `diagnostics.unfunded`, and publishes the funded rows as
  `output.opportunities`. Both UIs render that list and explain an empty
  one from the same diagnostics instead of guessing the purse.
- A shared search fixture (`data/search-parity.json`) runs the same cases
  through `Core.rankSearch` and `src/lib/search.ts`.
- Scans stamp `historySamples` on each priced item, and the importer,
  snapshot and core input carry it; older rows fall back to the terminal's
  sell-sample count.
- Scans mark `tierTruncated` when the book had more than the persisted top
  eight rungs; the core then counts the unseen book as queue ahead.
- A 170,000-listing scan gate in the perf stage: 6,000 item books, the
  real per-frame budget path, flow capture and series write. A companion
  gate evaluates the 6,000-item market through the shared core.
- Search accepts item ids (`4338`, `item:4338`), whitespace-separated name
  tokens in any order, and ranks exact and prefix names above substrings.
  The server browse fallback opens the closest matching name instead of
  the cheapest row.

### Changed

- `execQty`, `netProfit`, `netPerUnit` and `ladderPrice` are now
  `candidateQty`, `candidateNet`, `candidateNetPerUnit` and
  `candidateUnitPrice`; `allocQty`/`allocNet` remain the funded layer.
  The names state which quantity and profit a view is showing.
- Rows the risk model refuses to fund are excluded from candidates and
  counted as `diagnostics.excluded.sizing`, so every surviving row is
  fundable and a zero allocation has an actionable cause.
- The terminal table ranks a search by relevance unless the player clicked
  a column; `item:4338` is accepted there too.
- The scanner caches normalized owner names, keeps the distinct-seller
  count and supply in one table, and encodes each (owner, price) flow pair
  as one number instead of a nested table. The capture shape is now
  `owner-price-packed`; the first scan after upgrading starts a fresh
  disappearance baseline.
- `Core.executableQtySorted` walks a ladder the caller already sorted; the
  evaluator and allocator no longer copy and re-sort every book.
- Series retention returns the series untouched while every point is
  inside the per-scan window, instead of rebuilding five arrays per item.
- The in-game radar and the terminal opportunity list omit rows the purse
  cannot fund; a zero quantity is not an executable opportunity, and the
  radar says the purse is the limit rather than the gates.

### Fixed

- A second search typed while a browse is in flight is queued: the older
  answer is discarded and the newest query is sent, instead of the first
  response being scored against the new text.
- A browse page where no row matches now reports a failed search instead of
  opening an arbitrary first row.
- The fill model no longer overstates the chance of a listing on a book
  whose persisted ladder was truncated; unseen units count as queue.
- The trader tooltip section and its chart no longer appear on talent,
  character or other spell/unit tooltips. Only a hyperlink that is itself
  an item may carry them; the shared tooltip can still report the previous
  item through `GetItem()`, which is no longer trusted. Link parsing is
  anchored, so a battle-pet link or a string merely containing `item:` is
  rejected too.

## v0.6.0 — 2026-11-05

### Added

- Observation hygiene: the scan excludes the player's own listings (by
  owner name, falling back to the owned-auction list when owners are
  hidden) from the book, seller count and flow, and subtracts the player's
  own purchases from the inferred disappearance. Scans carry
  `observationVersion = 2`; the calibration only reads those.
- Fill estimation distinguishes "nothing disappeared" from "could not
  see": an observable zero shrinks the phase prior with Gamma–Poisson
  weight instead of falling back to it (`fillBasis = observed-zero`).
  The priors now live in the rule source and compile to
  `WAH.RULES.fillPrior`.
- `npm run calibrate` prints suggested priors per phase and market type
  from clean scans; it never edits the rule file.
- The game cockpit renders the core's conditional plans behind a "下一步"
  button, including the sell plan of each held position.
- Every decision stores its expected net, fill chance and allocation, and
  the review page buckets predictions against confirmed sales.
- Seller concentration (HHI) discounts the score, price × duration search
  on the sell page (`/wahpricing`), and net-per-minute ranking.
- `/wahtransfer` moves goods and FIFO cost between characters;
  `/wahcost` books a vendor sale the client does not report; mailbox money
  in transit is displayed but never budgeted.
- A demand calendar (`src/data/events.json` → `WAH.EVENTS`) scales the
  ranking prior inside scheduled windows.

### Fixed

- A mailbox sale that reconcile had already booked as an inferred trade is
  now upgraded with a `confirm` event instead of being booked again; the
  revenue, fee and consumed lots are corrected in place and the trade
  becomes a clean fill label. `Ledger.VERSION` 3 forces a rebuild of the
  stored projection.
- The in-game core input no longer pre-applies `portfolio.dailyBudget`:
  the allocator applies it once, so the game and the terminal spend the
  same share of the same purse.
- `/wahopen auto` now clears the opening anchor in the terminal as well:
  the scan always reports `openedAt` (0 = cleared), and the import only
  leaves a stored anchor alone when the field is absent.
- The terminal reads the allocator's `exploratory` label instead of
  comparing sample counts against its own copy of `minKellySamples`.
- The "环比" label says which baseline it actually uses: the previous
  scan that priced the item, not necessarily the immediately previous one.

### Removed

- The unused `Core.weightedPercentile` helper.
- Write-only journal fields (`source`, the mailbox fingerprint, the sold
  event's `deposit`, the craft event's `recipeId`); the replay never read
  them, and `recipeId` held the recipe spell id rather than the dataset id
  it was named after.

## v0.5.0 — 2026-11-05

The learning loop gets its first clean labels.

### Added

- **Mailbox capture** (`Mail.lua`): collected sale mails become confirmed
  `sold` events (`inferred = false`) with fee, posting time and a dedup
  fingerprint; returned-item mails become expiries. Attribution runs
  attachment link → item name → unique open posting, and never guesses.
- **Craft capture** (`Craft.lua` + `GeneratedRecipes.lua`, 154 KB): the
  client's craft events book the product at the materials' FIFO cost.
  Recipe resolution tries spell id, then `GetRecipeInfo().recipeID`, then
  a unique-product index; unresolved crafts are counted, not booked.
- **Shared capital allocation** (`Core.allocate` / `Core.sizePosition`):
  fractional Kelly plus per-item exposure, spent from one purse across
  ranked rows. The radar's quantity and net columns, the actions and the
  terminal now describe the allocated trade.
- **Real inputs**: free bag slots come from `C_Container`; `/wahopen`
  sets the server opening anchor, carried through the scan into
  `Market.openedAt` so phase age survives reinstalls.
- **Bid demand in the decision**: `highestBid` reaches the core and nudges
  the ignition demand prior (×1.2); it never relaxes a gate.
- **Experiment recovery**: confirmed trades are paired with their price
  levels and posting times; the review page reports fills and median
  wait, and says "no sale" rather than inventing a 0% fill rate.

### Changed

- Fill probability uses per-listing exposure hours (`ownExposedHours`)
  instead of the span between the first and last sale.
- A commodity sale may fill part of a posting: the remainder stays open
  and the deposit is refunded only when the posting is exhausted.
- `Ledger.VERSION` 2; `Trade.listedAt` and `Market.openedAt` added.
- `/wahdiag` prints mailbox and craft diagnostics; `/wahdiag mail` prints
  only the mailbox block.

## v0.4.0 — 2026-11-05

The market snapshot machine becomes a closed-loop goblin system.

### Added

- **Shared decision core** (`addon/WoWderhoiAH/Core.lua`): sell front,
  ladder cost, executable quantity, fee/deposit breakevens, fill
  probability, phase gates and conditional buy/sell plans. The terminal
  runs the same file through fengari; a parity test compares both paths.
- **Scan pipeline v4**: every replicate field (bid, owner, sale status,
  remaining time), top-8 price ladder, distinct sellers, expiry buckets,
  bid-only demand, and a tier-level inferred flow interval: the lower edge
  is units that left an owner (sales + cancels, repricing excluded), the
  upper edge is units that left a price key (also repricing). Layered
  series retention with a 60k point cap, `SaveAddOns` after each scan,
  player search quieting and timeout backoff.
- **Journal and ledger**: append-only actions (buy/post/cancel/sold/
  expire/craft/vendor/disenchant), replayed into FIFO lots, positions,
  escrow, fees, lost deposits and realized P&L. The terminal replays the
  same events with parity tests.
- **Sell page** (`/wahsell`): bag stacks, client deposits for 12/24/48h,
  sale and expiry breakevens, undercut-and-post, owned auctions, undercut
  warnings and cancel/requote. Blocked posting degrades to a manual price
  assistant; nothing is recorded as if it succeeded.
- **Executable-profit radar**: buy quantity, ladder price, suggested sell
  price, net profit and fill probability, vendor first; P10 is demoted to
  a statistics line everywhere.
- **Charts v2**: order-book staircase, labelled 24h fill-probability
  curve, windowed trend (1h/6h/24h/7d/all) with sell-front and minimum
  lines, supply bars, log axis and scanning-gap breaks.
- **`/wahdiag`** live-client checklist and `/wahphase` manual override.
- **Terminal**: phase resolution, real-price deflator, cockpit action
  list, portfolio, review, and a production network over all 2,595
  Forever recipes with LP shadow prices, fractional-Kelly sizing,
  controlled experiments, off-policy evaluation and alpha-decay windows.
- **Performance gates** for the core, journal, LP, scan validation and
  SavedVariables size.
- Design documents: `docs/economic-system.md`, `docs/launch-runbook.md`.

### Fixed

- **Fill evidence is labelled**: own auction sales (≥3 samples) drive the
  hazard first, public disappearances second, the phase prior last; every
  row carries `fillBasis`, and the item chart derives its curve from the
  same core output instead of a second formula.
- **Spread is executable**: gates measure the live sell front against the
  cheapest unit, never a historical median; ignition ignores pre-open
  history entirely.
- **Expiry loss** is the deposit plus the gap between cost and the NPC
  floor, not the whole cost — the goods come back.
- **Terminal reads are market-scoped**: snapshots, daily summaries,
  positions, trades and decisions are filtered by `Market`
  (realm + faction); `AQT_MARKET` can pin a market explicitly.
- **Own-fill labels** flow from the journal ledger in game and the `Trade`
  table on the terminal with identical filters (auction channel, inferred
  rows excluded, 7-day window).
- Fixed a shadowed locale key that printed a literal `%s` in `/wah`
  status, and money formatting in the same status line.

### Removed

- Legacy P10 radar thresholds (`WAH.RADAR`, `dealRadarRules`), the
  thirteen-recipe TBC crafting table, demo history, event-study and
  experiment-summary helpers, and dead fields (`med7`, `distinct`,
  `p5`/`p10` in the core contract, write-only recipe columns,
  `Market.openedAt`, unused locale keys and Ledger/Journal helpers).

### Changed

- The deal radar no longer uses a 7-day P10 median as its reference;
  every percentage is anchored on the sell front and names its window.
- `WoWderhoiAH_Points` is replaced by `WoWderhoiAH_Series` (v4); old
  pipeline data is discarded on the first v4 scan.
- Daily OHLC is built from the sell front instead of P10.
- `fengari` is a runtime dependency because the terminal runs the shipped
  Lua decision core.
- The recipe dataset is fetched from the public wuxianwow MCP into
  `data/recipes.forever.json` and projected into SQLite.

### Fixed

- Bid-only listings are no longer dropped at the scanner; they are
  imported as demand instead of zero-priced snapshots.
- Purchases update the scan ladder from the surviving search rows so the
  radar cannot advertise a price nobody can pay.
- Deposits are charged once: refunded on sale/cancel, lost only on
  expiry.
- A purchase is only recorded after the client confirms it; an
  unconfirmed purchase is reported, not invented.

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
