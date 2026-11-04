<div align="center">

<img src="docs/logo-256.png" width="128" alt="WoWderhoi AHelper logo"/>

# WoWderhoi AHelper

[![Release](https://img.shields.io/github/v/release/BrandNewJimZhang/wowderhoi-ah?color=f0479e)](https://github.com/BrandNewJimZhang/wowderhoi-ah/releases)
![Interface](https://img.shields.io/badge/WoW-Forever%201.60.1-ffd94d)
![Stack](https://img.shields.io/badge/Next.js%2016-TypeScript-2ce8a4)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-c493ff)](LICENSE)

**English** | [中文](#中文)

Auction house intelligence and a closed-loop goblin trading system for
World of Warcraft: Forever (client 1.60.1, Interface 16001), with a
maintenance line for TBC Anniversary 2.5.6.

</div>

The system is built around one loop:

```text
events -> state -> decision -> action -> learning
```

- **Events**: full auction-house scans (order book, sellers, expiry,
  bid-only demand) plus the player's own buys, postings, cancellations,
  sales and expiries. The journal and ledger also accept craft, vendor,
  disenchant, prospect and mill rows; those producers are not wired yet,
  so no UI assumes they will appear.
- **State**: positions from a replayable journal, deployable capital,
  capacity, and beliefs about fill probability and competition.
- **Decision**: one Lua decision core, `Core.lua`, runs in game and in the
  terminal through fengari. It prices the sell front, the ladder cost,
  executable quantity, net profit and fill probability under the current
  phase's gates.
- **Action**: an in-game cockpit with conditional buy/sell plans and a
  sell page; a terminal cockpit with the same action list.
- **Learning**: own fills are the only clean label. Public disappearances
  are a bounded prior; inferred sales are labeled as inferred. The review
  page shows decision matching, alpha decay and the next controlled
  experiment.

Read [docs/economic-system.md](docs/economic-system.md) for the design and
[docs/launch-runbook.md](docs/launch-runbook.md) for the first-day and
first-week operating procedure.

## Branches

There is no `main`:

| Branch | Target client | Role |
|---|---|---|
| `forever` (default) | WoW Forever 1.60.1, Interface 16001 | Development trunk |
| `anniversary` | TBC Anniversary 2.5.6, Interface 20506 | Maintenance line |

Shared work — the terminal, the decision core, pricing math, rules,
tooltip and chart logic — lands on `forever` first and is merged into
`anniversary`. Client-specific files (the `.toc`, scan acquisition,
buy/sell API paths) stay per branch. See [CONTRIBUTING.md](CONTRIBUTING.md).

## In game

- `/wahscan` — `C_AuctionHouse.ReplicateItems()` full scan. Pipeline v4
  stores the top-8 price ladder, distinct sellers, expiry buckets,
  bid-only demand and an inferred flow range from the previous scan.
- `/wahauto` — rescan on the compiled scan interval (15 minutes by
  default) while the AH stays open, pausing while the player searches and
  backing off after a timeout.
- `/wahphase ignition|wave|settle|steady|auto` — override the phase when
  the automatic breadth/age rule lags the real market.
- `/wahtrade` — cockpit: executable-profit radar with buy quantity, ladder
  price, suggested sell price, net profit and fill probability; vendor
  arbitrage first; live price book and verified buying.
- `/wahsell` — sell page: bag stacks, sell front, deposit for 12/24/48
  hours, sale and expiry breakevens, undercut-and-post, owned auctions,
  undercut warnings, cancel/requote. Posting uses `PostItem` /
  `PostCommodity`; if the client blocks the call, the page degrades to a
  manual price assistant and records nothing.
- `/wahprice` — hold an item on the cursor (or pass a link): sell front,
  list price, ladder, supply, sell-front median and trend.
- `/wahdiag` — the live-client checklist: time-left semantics, owner
  visibility, `SaveAddOns`, posting APIs, deposit arithmetic, owned
  auctions, throttle, journal/ledger totals and phase.
- Tooltip: sell front first, then ladder, supply/sellers, inferred flow,
  P10 as a statistics line, and trend against the sell-front median.
- Chart: order-book staircase by default; windowed trend (1h/6h/24h/7d/all)
  with sell-front and minimum lines, supply bars, log axis for wide
  ranges and breaks across scanning gaps.

Every action is written to `WoWderhoiAH_Journal`. `Ledger.lua` replays it
into lots, FIFO positions, open postings, escrow, fees, lost deposits and
realized P&L. A vanished owned auction older than a minute is booked as
an **inferred** sale at the posted price and labelled everywhere.

## Terminal

- **Cockpit** (`/`): phase banner, the shared action list, executable
  opportunities, market monitor, alerts, watchlist, crafting snapshot and
  the event calendar.
- **Market table**: sell price, minimum, sell-front median, spread,
  trend, change, supply and listings; server-side filter/sort/paging.
- **Item page**: order-book ladder, 24-hour fill-probability curve,
  windowed intraday trend, daily candles and weekday seasonality.
- **Portfolio** (`/portfolio`): cash from the last scan, position value
  and cost, unrealized P&L, confirmed realized P&L and fees, plus inferred
  sales shown separately and labelled.
- **Manufacturing** (`/recipes`): 2,595 Forever recipes solved as a linear
  program with profession, material-supply and budget constraints; dual
  variables are shown as shadow prices; LP volumes are floored and profit
  is recomputed from the integer plan.
- **Review** (`/review`): decision matching, alpha-decay windows, the next
  listing experiment, and the discipline that thresholds are calibrated
  from own fills, not from public asks.

## Data pipeline

```powershell
Copy-Item .env.example .env
npm install
npm run db:push
npm run recipes:import   # project data/recipes.forever.json into SQLite
npm run dev
```

In game, scan (`/wahscan`); the addon calls `C_AddOns.SaveAddOns()` after
each scan, and falls back to log out / `/reload` on clients without it. Point
`AQT_SAVEDVARS_PATH` at the SavedVariables file and run:

```powershell
npm run addon:watch
```

The watcher posts `{ scan, journal }` to `/api/import/addon-scan`. The
import is transactional: the snapshot, daily OHLC (built from the sell
front), positions and trades land all-or-nothing; duplicate scan
timestamps are skipped. `WoWderhoiAH_Capture` is the previous scan's
tier-level identity table, used only for the flow estimate.

Every terminal read is scoped to one `Market` (realm + faction): the
market of the newest snapshot, or `AQT_MARKET="realm|faction"` when you
want to pin it. Snapshots, daily summaries, positions, trades and
decisions from another realm can never leak into the same signal.

Upgrading an existing `prisma/dev.db` from an earlier v0.4 build needs one
schema push that drops write-only columns/tables and re-keys daily
summaries. Either delete `prisma/dev.db` and re-import, or run
`npx prisma db push --accept-data-loss` once.

### Recipe data

```powershell
npm run recipes:fetch    # public wuxianwow MCP -> data/recipes.forever.json
npm run recipes:import   # dataset -> Recipe table
```

The committed dataset contains all 2,595 recipes (1,147 new in 1.60) with
authoritative material and product item IDs. The importer replaces the
table on every run, so a partial import cannot masquerade as the
catalogue.

## Development

```powershell
npm test             # vitest, including the shipped Lua in the Forever stub
npm run typecheck
npm run lint
npm run build
npm run perf:seed    # deterministic synthetic market, leaves dev.db alone
npm run perf:run     # page/import latency budgets
```

The Lua harness (`addon/test`) loads the addon files verbatim in the order
the `.toc` declares, so the code under test is the code that ships.
`Core.lua` is also loaded by `src/lib/core/run-core.ts`; a parity test
compares the two load paths.

Performance gates cover 866-item core evaluation, core-input assembly,
5,000-event journal replay, a 120-candidate LP solve, 9,000-item scan
validation and the SavedVariables size budget. The core budget is looser
than the client frame budget because the terminal runs Lua in fengari;
the addon runs the same file natively.

## Key modules

| Path | Role |
|---|---|
| `addon/WoWderhoiAH/Core.lua` | Pure decision core: sell front, ladder, executable quantity, fill probability, phase gates, conditional plans |
| `addon/WoWderhoiAH/WoWderhoiAH.lua` | v4 replicate scanner, order book, series retention, flow inference |
| `addon/WoWderhoiAH/Journal.lua` / `Ledger.lua` | Append-only actions and the FIFO/P&L projection |
| `addon/WoWderhoiAH/Trade.lua` / `Sell.lua` | Cockpit, price book, sell page, owned auctions |
| `addon/WoWderhoiAH/GUI.lua` | Tooltip, order-book/trend charts, `/wahdiag` |
| `src/lib/core/run-core.ts` | fengari runner for the shipped `Core.lua` |
| `src/lib/market-rules.ts` | Single rule source: phases, market types, fees, sell front |
| `src/lib/analytics.ts` / `phase.ts` / `deflator.ts` | Signals, phase, real prices |
| `src/data/demand-bands.json` / `src/lib/demand.ts` | Opening-week demand priors, compiled into `WAH.DEMAND` |
| `src/lib/journal.ts` | Journal parser and replay, parity-tested against Lua |
| `src/lib/craft-lp.ts` / `recipes.ts` | Production network and the Forever catalogue |
| `src/lib/portfolio.ts` / `off-policy.ts` / `experiments.ts` | Sizing, evaluation, controlled experiments |
| `src/app/api/import/addon-scan/route.ts` | Transactional scan + journal import |
| `scripts/fetch-recipes.ts` / `import-recipes.ts` | Recipe dataset refresh and projection |
| `scripts/perf/` | HTTP-level latency budget gates |
| `docs/economic-system.md` / `docs/launch-runbook.md` | Design and operating procedure |

## Limits and safety

- The client exposes **no sale-history API**. Own fills and posted-price
  inferences are the only demand labels; everything else is a range.
- `PostItem`, `PostCommodity` and `CancelAuction` are marked
  `HasRestrictions`. The addon never retries a blocked call and never
  pretends a listing exists.
- There is no automatic shopping or automatic posting loop. Every
  purchase and posting goes through the client's confirmation.
- Public deal feeds are not alpha. The edge comes from execution,
  private fills, production capacity and capital allocation.
- Phase thresholds and production capacities are starting priors. They
  are calibrated from real fills and are expected to change.

## License & contributing

[AGPL-3.0-or-later](LICENSE). PRs welcome — every PR must be linked to
an issue; see [CONTRIBUTING.md](CONTRIBUTING.md). Security notes in
[SECURITY.md](SECURITY.md).

---

<div align="center">

## 中文

**English** | [中文](#中文)

</div>

《魔兽世界：无限》（WoW Forever，客户端 1.60.1，Interface 16001）的拍卖行情报与**闭环地精交易系统**；仓库另保留 TBC 周年服 2.5.6 维护线。

### 一句话

不是更准的雷达，而是把玩家经济行为做成一个闭环：

```text
事件 → 状态 → 决策 → 行动 → 学习
```

- **事件**：全量拍卖行扫描（盘口、卖家、到期、竞价需求）+ 玩家自己的买/挂/撤/成交/流拍。Journal 与 Ledger 也接受制造/卖店/分解/勘探/研磨行，但这些采集器尚未接入，界面不假设它们会出现。
- **状态**：可从 Journal 重放的头寸、可动用资金、产能、成交概率与竞争信念。
- **决策**：唯一一份 `Core.lua`，游戏内与桌面通过 fengari 运行同一份代码；按当前阶段门槛计算卖价前沿、阶梯成本、可执行数量、净利与成交率。
- **行动**：游戏内驾驶舱（条件买卖计划）+ 卖出页；桌面对应同一份行动清单。
- **学习**：只有自己的成交是干净标签；公共消失只是区间先验，推断成交处处标注。复盘页展示决策匹配、alpha 衰减与下一次受控实验。

完整设计见 [docs/economic-system.md](docs/economic-system.md)，开服与首周操作见 [docs/launch-runbook.md](docs/launch-runbook.md)。

### 分支

不再有 `main`：`forever`（默认，无限 1.60.1）与 `anniversary`（TBC 2.5.6 维护线）。共享代码先落 `forever`，再合并进 `anniversary`；客户端专属文件（`.toc`、扫描采集、买卖 API 路径）各自保留。

### 游戏内

- `/wahscan` 全量扫描（v4：盘口阶梯、卖家、到期桶、竞价需求、消失量区间）；`/wahauto` 自动重扫；`/wahphase` 手动阶段。
- `/wahtrade` 驾驶舱：可执行净利榜（可买数量 / 买价 / 建议卖价 / 净利 / 成交率），NPC 必赚优先；实时价格簿与核验购买。
- `/wahsell` 卖出与在售：押金 12/24/48 小时、售出/流拍保本价、压价上架、被压价提示、撤单重挂；客户端拦截时降级为价格助手，不假装成功。
- `/wahprice` 卖价指引；`/wahdiag` 十项开服排雷。
- 提示框以建议卖价领衔；图表默认盘口阶梯，走势图支持 1h/6h/24h/7d/全部、对数轴与扫描空洞断线。

### 桌面

驾驶舱、市场监控、盘口/成交概率/走势图、组合、制造（2,595 条配方 + LP 影子价格）、复盘（决策匹配、alpha 衰减、实验设计）。

### 数据管道

```powershell
Copy-Item .env.example .env
npm install
npm run db:push
npm run recipes:import
npm run dev
```

游戏内扫描后插件会自动调用 `SaveAddOns`（不支持时小退/`/reload`）；配置 `AQT_SAVEDVARS_PATH` 后运行 `npm run addon:watch`。导入是事务式的：快照、日线、头寸与成交一起落库；重复扫描时间戳自动跳过。

### 边界

客户端没有成交历史接口；`PostItem`/`PostCommodity`/`CancelAuction` 带调用限制；插件不做全自动扫货或上架；公共捡漏信号不是 alpha；阶段阈值与产能是待校准的先验。

### 许可与贡献

[AGPL-3.0-or-later](LICENSE)。欢迎 PR，但每个 PR 必须关联 issue；见 [CONTRIBUTING.md](CONTRIBUTING.md)。
