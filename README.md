<div align="center">

<img src="docs/logo-256.png" width="128" alt="WoWderhoi AHelper logo"/>

# WoWderhoi AHelper

[![Release](https://img.shields.io/github/v/release/BrandNewJimZhang/wowderhoi-ah?color=f0479e)](https://github.com/BrandNewJimZhang/wowderhoi-ah/releases)
![Interface](https://img.shields.io/badge/WoW-TBC%20Anniversary%202.5.6-ffd94d)
![Stack](https://img.shields.io/badge/Next.js%2016-TypeScript-2ce8a4)
[![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-c493ff)](LICENSE)

**English** | [中文](#中文)

Auction house price intelligence and short-swing trading kit for
World of Warcraft Classic Anniversary (TBC 2.5.6).

</div>

Two parts, one fully local data loop — no Battle.net API:

- **In-game addon** (`addon/WoWderhoiAH`) — scans the auction house,
  accumulates price history scan-to-scan, and provides tooltip market
  data, dual-window price charts, and a dedicated **WAH trade tab**:
  deal radar, verified one-click buying, undercut sell prefill. The
  addon *is* the data backend.
- **Desktop terminal** (Next.js 16) — a Bloomberg-style dark,
  high-density interface: market monitor table, intraday/daily charts,
  price alerts and watchlists, crafting profit rankings.

New here? Start with [docs/first-day.md](docs/first-day.md) — the full
path from installing the addon to your first real price curve, ~30 min.

## Features

### Deal radar (same rules in game and terminal)

- **Vendor arbitrage**: listings below the NPC sell price — zero market
  risk, no history needed.
- **P10 median discount**: min price 15%+ below the 7-day P10 median,
  gated by liquidity (3+ auctions), history depth (3+ scans), and
  absolute profit (5s+) — filters out discounts nobody will ever buy.
- Sorting: vendor arbitrage first, then by absolute profit. The in-game
  WAH tab searches straight from a radar row and buys after verifying
  the listing is unchanged.

### Price statistics

- Every scan produces a **quantity-weighted percentile ladder**
  (min/P5/P10): P10 is the market price; min/P5 mark the very bottom of
  the book. This realm's upper book is thin and stale — nothing trades
  against it — so only the bottom decile reflects real prices.
  Percentiles shrug off bait listings that wreck any mean.
- **Sell front** (depth-aware): the cheapest price with real quantity
  behind it — undercutting *it* matters; undercutting a lone dump
  listing just gives gold away.
- Price history accumulates inside the addon (`WoWderhoiAH_Points`,
  7 days × 192 points); the 7-day P10 median, trend, and range all
  derive from it. No desktop write-back.

### In game

- `/wahscan` full scan: getAll fast path (whole AH in one query) with
  paged fallback on cooldown; `/wahauto` auto-rescan (~every 15 min).
- Tooltip market data: sell front leads (orange), then min price,
  P5/P10, supply, 7-day P10 median and trend.
- Price charts beside the auction frame: last 3 hours / last 48 hours,
  plotting the P10 series.
- Sell prefill: buyout auto-filled at an undercut of the sell front.

### Terminal

- Market monitor: search, category filter, sorting, server-side paging —
  handles real 2400+ item scans.
- Item terminal page: intraday (scan-to-scan) chart, daily candles,
  day-of-week seasonality.
- Price alert rules and watchlists.
- Crafting profit ranking (built-in TBC recipe table).
- Self-hosted item icons (`npm run icons:fetch`, one-shot).

## Stack

Next.js 16 + React Server Components + TypeScript · TailwindCSS ·
Prisma + SQLite · Recharts · WoW Lua addon (Interface 20506).

## Development

```powershell
Copy-Item .env.example .env
npm install
npm run db:push
npm run db:seed   # calendar only; market data always comes from real scans
npm run dev
```

Open `http://localhost:3000`. Tests and perf gates:

```powershell
npm run test        # vitest
npm run typecheck
npm run perf:seed   # deterministic synthetic market (leaves dev.db alone)
npm run perf:run    # page/import latency budget gate
```

## Data pipeline (in-game addon)

1. Copy `addon/WoWderhoiAH` into the game directory at
   `_anniversary_\Interface\AddOns\WoWderhoiAH`.
2. In game, open the AH and run `/wahscan` (or enable `/wahauto`).
3. Log out briefly or `/reload` — the client only writes
   SavedVariables to disk on exit/reload.
4. Point `AQT_SAVEDVARS_PATH` in `.env` at that file, then:

```powershell
npm run addon:watch
```

The watcher POSTs every new scan to `/api/import/addon-scan`;
duplicate scan timestamps are skipped automatically.

## Key modules

- `addon/WoWderhoiAH/WoWderhoiAH.lua` — full scanner, quantity-weighted percentiles, scan-to-scan history.
- `addon/WoWderhoiAH/Trade.lua` — WAH trade tab: deal radar, search & buy, sell prefill.
- `addon/WoWderhoiAH/GUI.lua` — tooltip injection and the 3h/48h price charts.
- `scripts/watch-savedvars.ts` — SavedVariables watcher and importer.
- `src/lib/addon-scan.ts` — SavedVariables parsing and scan validation (single entry point).
- `src/lib/analytics.ts` — 7d P10 median signals, deal radar rules, seasonality.
- `src/app/page.tsx` — market overview: deal radar, monitor table, alerts/watchlist/crafting.
- `src/app/items/[itemId]/page.tsx` — item terminal, intraday and daily charts.
- `scripts/perf/` — deterministic perf benchmarks and latency budget gates.

## License & contributing

[AGPL-3.0-or-later](LICENSE). PRs welcome — every PR must be linked to
an issue; see [CONTRIBUTING.md](CONTRIBUTING.md). Security notes in
[SECURITY.md](SECURITY.md).

---

<div align="center">

## 中文

[English](#wowderhoi-ahelper) | **中文**

</div>

《魔兽世界》经典周年服（TBC 2.5.6）拍卖行价格情报与短线交易工具。两个部件，一条本地数据闭环，不依赖 Battle.net API：

- **游戏内插件**（`addon/WoWderhoiAH`）——扫描拍卖行、逐次积累价格历史，提供 tooltip 行情、双窗口价格走势图，以及独立的 **WAH 交易页**：捡漏雷达、核验后一键购买、压价卖单预填。插件即数据后端。
- **桌面终端**（Next.js 16）——类 Bloomberg 的深色高密度界面：市场监控表、盘中/日线图表、预警与关注列表、制造利润排行。

新用户从 [docs/first-day.md](docs/first-day.md) 开始：从安装插件到看到第一条真实价格曲线的完整路径，约 30 分钟。

### 核心功能

**捡漏雷达**（游戏内与终端同一套规则）

- **NPC 必赚**：挂单价低于 NPC 收购价，零市场风险，无需历史数据。
- **P10中位折扣**：最低价低于 7 日P10中位 15% 以上，且同时过三道闸门——流动性（≥3 个挂单）、历史深度（≥3 次扫描）、绝对利润（≥5 银）——滤掉没人接盘的垃圾折扣。
- 排序：NPC 必赚优先，其余按绝对利润降序。游戏内 WAH 页可直接从雷达行发起搜索，核验挂单未变后购买。

**价格统计**

- 每次扫描产出**量加权百分位阶梯**（最低/P5/P10）：P10 是市价，最低/P5 标出订单簿最底部。本服上层挂单又薄又陈、根本没有成交，只有底部十分位才反映真实价格；百分位天然抗钓鱼挂单。
- **建议卖价**（深度感知卖价前沿）：有真实量支撑的最低价，而非孤立甩卖单——压过它才有意义，压过甩卖单只是白送钱。
- 价格历史由插件逐次扫描自行积累（`WoWderhoiAH_Points`，7 天 × 192 点），7 日P10中位、趋势、区间全部由它派生，无需桌面端回写。

**游戏内**

- `/wahscan` 全量扫描：getAll 快路径 + 冷却时分页回退；`/wahauto` 挂机自动扫描（约 15 分钟一次）。
- tooltip 行情：建议卖价领衔（橙色标注），随后最低价、P5/P10、供给、7 日P10中位与趋势。
- 拍卖行旁价格走势图：最近 3 小时 / 最近 48 小时双窗口，绘制 P10 低位价序列。
- 卖货预填：自动以建议卖价压价填入买断价，确认后发布。

**终端**

- 市场监控表：搜索、分类过滤、排序、服务端分页，扛得住 2400+ 商品的真实扫描。
- 商品终端页：盘中走势、日线 K 线、星期几季节性。
- 价格预警规则与关注列表。
- 制造利润排行（内置 TBC 配方表）。
- 自托管商品图标（`npm run icons:fetch` 一次性抓取）。

### 本地开发与数据采集

开发命令与数据管道步骤见上方英文版（命令相同）：`npm run dev` 起终端，游戏内 `/wahscan` 扫描后小退/`/reload` 落盘，`npm run addon:watch` 自动入库。关键模块清单同上。
