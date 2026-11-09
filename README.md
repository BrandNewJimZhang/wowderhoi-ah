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
  mailbox-confirmed sales, expiries and finished crafts. The journal also
  accepts vendor, disenchant, prospect and mill rows; those producers are
  not wired yet, so no UI assumes they will appear.
- **State**: a client-pushed estate (bag, bank, mailbox, own postings, cash
  and free slots, each location marked observed or unobserved), reconciled
  against append-only journal facts that carry the FIFO cost and realized
  history. The game mints a versioned plan from that state; the terminal
  stores the copy, not a second authority.
- **Decision**: one Lua decision core, `Core.lua`, runs in game and in the
  terminal through fengari. It prices the sell front, the ladder cost,
  executable quantity, net profit and fill probability under the current
  phase's gates, then allocates one purse across every recommendation.
- **Action**: an in-game cockpit with conditional buy/sell plans and a
  sell page; a terminal cockpit with the same action list and the same
  allocated quantities.
- **Learning**: mailbox-collected sales are the only clean label; public
  disappearances are a bounded prior, and legacy inferred rows stay
  labelled and out of realized P&L. Fill probability uses per-listing
  exposure hours. The review page shows decision matching, alpha decay,
  experiment recovery and the next controlled experiment.

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
- `/wahopen now|-<hours>|<epoch>|auto` — set the server opening anchor so
  phase age survives a reinstall or cleared SavedVariables; `auto` clears
  it, and the next scan clears it in the terminal too.
- `/wahcapture mail|craft on|off` — the rollback lever for the two
  collectors: with mail capture off a sale the client never reports stays
  `unobserved` (it is not re-inferred), and with craft capture off craft
  booking is skipped; `/wahdiag` prints the current state.
- Mailbox capture — `MAIL_INBOX_UPDATE` turns collected sale mails into
  confirmed `sold` events (`inferred = false`) with the posting time; a
  legacy row an older addon version had inferred is upgraded with `confirm`
  instead of being booked twice; duplicates are fingerprinted and never
  booked twice.
- Craft capture — `TRADE_SKILL_CRAFT_BEGIN` / `TRADE_SKILL_ITEM_CRAFTED_RESULT`
  book the product at the materials' FIFO cost from the compiled recipe
  table; an unknown recipe is counted, never guessed.
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

Every auction action is written to `WoWderhoiAH_Journal`, whether this
addon or the Blizzard UI started it. `Ledger.lua` replays it into lots, FIFO
positions, open postings, escrow, fees, lost deposits and realized P&L. A
posting that leaves the owned list without a sale, cancel or expiry event is
marked `unobserved`: it is not booked as revenue. Rows an older addon
version inferred from that disappearance stay in the ledger labelled
`inferred` until a mail or event confirms them.

## Terminal

- **Cockpit** (`/`): phase banner, the shared action list, executable
  opportunities, market movers, alerts, watchlist, crafting snapshot and
  the event calendar.
- **Market** (`/market`): sell price, minimum, sell-front median, spread,
  trend, change, supply, listings, sparklines and a P25–P75 band; the whole
  projection is sent once and filtered/sorted/paged in the client.
- **Item page** (`/items/<id>`): order-book ladder, 24-hour
  fill-probability curve, windowed intraday trend, daily candles and
  weekday seasonality.
- **Portfolio** (`/portfolio`): cash and free slots from the client-pushed
  estate, position value and cost with unknown-cost and unobserved stock
  kept separate, unrealized P&L, confirmed realized P&L and fees, plus
  legacy inferred sales shown separately and labelled.
- **Manufacturing** (`/recipes`): 2,595 Forever recipes solved as a linear
  program with profession, material-supply and budget constraints; dual
  variables are shown as shadow prices; LP volumes are floored and profit
  is recomputed from the integer plan.
- **Review** (`/review`): decision matching, alpha-decay windows, the next
  listing experiment, and the discipline that thresholds are calibrated
  from own fills, not from public asks.
- **Data health** (`/health`): scan age and gaps, series coverage,
  catalogue/icon coverage, the last 20 import runs and Journal replay
  errors.

Every open page polls `/api/market/revision` every 15 seconds. The revision
is the market's committed data version, advanced inside the import
transaction, so a new scan or a mailbox-flushed journal replay reaches the
screen without a manual reload while a failed or duplicate import never
triggers one. Pages also re-render when the stale flag or the display phase
crosses a boundary even if no import lands, and relative freshness labels
tick in the browser at their own boundaries. `router.refresh()` keeps client
state such as the market browser's filters, sort and page. The navigation
rail shows whether auto-refresh is live, refreshing or offline; a hidden tab
pauses polling and checks once when it returns.

## Data pipeline

```powershell
Copy-Item .env.example .env
npm install
npm run db:push
npm run items:catalog:import  # project data/items.forever.json into Item
npm run icons:fetch          # download the shared icons (public/icons is gitignored)
npm run recipes:import       # project data/recipes.forever.json into SQLite
npm run recipes:lua          # compile the materials into addon/GeneratedRecipes.lua
npm run dev
```

In game, scan (`/wahscan`); the addon calls `C_AddOns.SaveAddOns()` after
each scan, and falls back to log out / `/reload` on clients without it. Point
`AQT_SAVEDVARS_PATH` at the SavedVariables file; the app starts the
watcher on its first server render, so `npm run dev` is the only long-running
command. The
standalone `npm run addon:watch` remains for a terminal deployment.

The watcher posts the scan and series to `/api/import/addon-scan` and the
private state (`estate`, `journal`, `plan`) to `/api/import/addon-state`.
The scan import materialises one immutable `MarketGeneration`: the current
book (`MarketQuote`), the signals derived from it and the addon series, and
the shared core's output (`MarketSignalRow`). The state import is
idempotent per domain — estate by revision, journal facts by
`(character, seq)`, plans by revision — so a mailbox flush or a bag change
reaches the terminal without a new scan. The terminal keeps its own longer
`ItemSeries`, so an addon upgrade that rebuilds the game file cannot erase
history. `WoWderhoiAH_Capture` is the previous scan's tier-level identity
table, used only for the flow estimate.

Every terminal read is scoped to one `Market` (realm + faction): the
market of the newest generation, or `AQT_MARKET="realm|faction"` when you
want to pin it. Generations, series, holdings, trades and decisions from
another realm can never leak into the same signal.

Journal facts are stored per character, holdings are rebuilt for every
character from that character's facts and estate, and trades are appended
per character; one character's book never supplies another one's cost. The
cockpit and portfolio headers name the character whose estate was observed
most recently (falling back to the newest scan), because the purse on
screen must follow the character, not the book. Account-scoped stock — the
account bank and own postings — is carried by that same character, so a
switch does not count the same auction twice. A character with no events
shows an empty ledger rather than an alt's holdings.

Upgrading an existing `prisma/dev.db` from the snapshot read model: back it
up, then run `npm run read-model:backfill` once. The script reads the legacy
snapshot and daily-summary rows into memory before pushing the current
schema (the push drops those tables, so it must not run first), rebuilds
`ItemSeries` from them, merges the addon series when the SavedVariables file
is configured and materialises one generation per market. It is idempotent
and pushes the schema itself, so a new database does not need it.

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

Performance gates cover 866- and 6,000-item core evaluation, core-input
assembly, 5,000-event journal replay, a 120-candidate LP solve, 9,000-item
scan validation, a 250,000-listing replicate walk, a 3,692-item generation
with series, client-side filtering of 4,048 rows and the SavedVariables size
budget. The core budget is looser than the client frame budget because the
terminal runs Lua in fengari; the addon runs the same file natively.

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
| `src/lib/position-valuation.ts` / `off-policy.ts` / `experiments.ts` | Portfolio valuation, policy evaluation, controlled experiments |
| `src/lib/market-generation.ts` / `market-read.ts` / `import-store.ts` | Generation planning, the read model, the transactional writer |
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

- **事件**：全量拍卖行扫描（盘口、卖家、到期、竞价需求，**已剔除自有挂单与自有买入**）+ 玩家自己的买/挂/撤/成交/流拍 + 制造（材料 FIFO 成本）+ 跨角色转移。卖店用 `/wahcost` 手动补记（客户端没有逐笔事件）；分解/勘探/研磨仍无干净事件，界面不假设它们会出现。
- **状态**：插件实时推送的 estate（背包、银行、邮箱、自有挂单、现金与空位，每个位置标 `observed` / `unobserved`），与追加式 Journal 事实对账：数量来自 estate，FIFO 成本与已实现历史来自 Journal。计划由游戏内按这份状态铸造并发布版本，终端只存副本。
- **决策**：唯一一份 `Core.lua`，游戏内与桌面通过 fengari 运行同一份代码；按当前阶段门槛计算卖价前沿、阶梯成本、可执行数量、净利、成交率、卖家集中度与时间成本，并在单一预算下分配，卖出侧搜索价格 × 时长。
- **行动**：游戏内驾驶舱（“下一步”条件买卖计划）+ 卖出页；桌面对应同一份行动清单。
- **学习**：只有自己的成交是干净标签；公共消失是区间先验，且“零消失”按 Gamma–Poisson 收缩压低成交率——它是有信息量的观测，不是缺失。复盘页展示决策匹配、预测分桶校准、alpha 衰减与下一次受控实验。

完整设计见 [docs/economic-system.md](docs/economic-system.md)，开服与首周操作见 [docs/launch-runbook.md](docs/launch-runbook.md)。

### 分支

不再有 `main`：`forever`（默认，无限 1.60.1）与 `anniversary`（TBC 2.5.6 维护线）。共享代码先落 `forever`，再合并进 `anniversary`；客户端专属文件（`.toc`、扫描采集、买卖 API 路径）各自保留。

### 游戏内

- `/wahscan` 全量扫描（v4：盘口阶梯、卖家、到期桶、竞价需求、消失量区间；自有挂单按 owner 或在售列表剔除，自有买入从推断消失量扣除）；`/wahauto` 自动重扫；`/wahphase` 手动阶段；`/wahopen` 设开服锚点；`/wahcapture mail|craft on|off` 开关采集；`/wahpricing on|off` 开关卖出页价格搜索；`/wahtransfer` 跨角色转移；`/wahcost` 补记卖店。
- 邮箱成交采集：开箱即读取发票，把成交写成 `inferred = false` 的确认成交（同价分批成交按指纹计数去重），并记录挂单时间用于暴露时间口径；暂时无法归因的邮件不记为已处理，后续扫描认识物品时会补记。
- 制造采集：按 `TRADE_SKILL_ITEM_CRAFTED_RESULT` 记账，产物成本 = 材料 FIFO 成本；未知配方只计数，不猜成本。
- `/wahtrade` 驾驶舱：可执行净利榜（预算内可买 / 买价 / 建议卖价 / 分配后净利 / 成交率），NPC 必赚优先；“下一步”视图渲染条件买入计划与持仓卖出计划；实时价格簿与核验购买。
- `/wahsell` 卖出与在售：押金 12/24/48 小时、售出/流拍保本价、压价上架、被压价提示、撤单重挂；有该物品自己的成交或可观测消失时，按期望净利搜索价格 × 时长；客户端拦截时降级为价格助手，不假装成功。
- `/wahprice` 卖价指引；`/wahdiag`（含 `/wahdiag mail`）开服排雷。
- 提示框以建议卖价领衔；图表默认盘口阶梯，走势图支持 1h/6h/24h/7d/全部、对数轴与扫描空洞断线。

### 桌面

驾驶舱、行情（`/market`，客户端即时筛选排序）、物品页（盘口/成交概率/走势图/K 线/季节性）、组合、制造（2,595 条配方 + LP 影子价格）、复盘（决策匹配、预测分桶校准、alpha 衰减、实验设计）与数据健康（`/health`）。`npm run calibrate` 从洁净扫描给出成交率先验建议。

每个打开的页面每 15 秒轮询 `/api/market/revision`。版本号是当前市场已提交的数据版本，在导入事务内随页面输入一起推进：新扫描或邮箱触发的账本重放会自动到达屏幕，失败或重复的导入不会误触发刷新。即使没有新导入，页面也会在数据过期或阶段边界到来时重新渲染，相对时间标签由浏览器按边界自行跳动。刷新通过 `router.refresh()` 就地完成，保留行情浏览器的筛选、排序与页码等客户端状态；左侧导航显示自动刷新的实时状态，标签页隐藏时暂停轮询，回到前台立即检查一次。

### 数据管道

```powershell
Copy-Item .env.example .env
npm install
npm run db:push
npm run items:catalog:import
npm run icons:fetch
npm run recipes:import
npm run recipes:lua
npm run dev
```

游戏内扫描后插件会自动调用 `SaveAddOns`，任何账本写入（成交、买入、上架、制造、手动记录）也会在约 2 秒内合并落盘（不支持时小退/`/reload`）；配置 `AQT_SAVEDVARS_PATH` 后 `npm run dev` 会自己监听存档，不需要另开进程（`npm run addon:watch` 仍可独立运行）。一次扫描生成一代不可变读模型：当前盘口、物化信号、共享核心输出与序列一起落库；重复的扫描不新建代际，也不重写核心输出。背包、银行、邮箱、在售、现金与 Journal 事实走独立的状态导入，持仓由 estate 快照与账本事实重建；计划由游戏内实时计算并发布，终端按版本存档并写入不可变决策。

### 边界

客户端没有公共成交历史接口，自己的成交只能从邮箱归因（粒度是物品 + 价格）；`PostItem`/`PostCommodity`/`CancelAuction` 带调用限制；插件不做全自动扫货或上架；公共捡漏信号不是 alpha；阶段阈值与产能是待校准的先验。

### 许可与贡献

[AGPL-3.0-or-later](LICENSE)。欢迎 PR，但每个 PR 必须关联 issue；见 [CONTRIBUTING.md](CONTRIBUTING.md)。
