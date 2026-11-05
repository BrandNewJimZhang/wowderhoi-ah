# Contributing

**English** | [中文](#中文-1)

PRs are welcome — with one hard rule:

1. **Every PR must be attached to an issue.** Open an issue first (bug
   report, feature proposal, question — anything), get it visible, and
   reference it from the PR body with `Closes #N` / `Fixes #N`. PRs
   without a linked issue will be closed with a pointer to this file.
2. **All PRs are reviewed by the maintainer** (@BrandNewJimZhang)
   before merging. Expect review comments; unresponsive PRs may be
   closed after a while.
3. Keep history linear: rebase on `forever` (the default branch), no
   merge commits. `anniversary` is a maintenance line that receives
   shared work by merging `forever` into it.
4. Commit messages: English, imperative, `Feat:`/`Fix:`/`Docs:`/...
   prefixes (see `git log` for the house style).
5. Behavior changes land with tests. TypeScript: `npm run test`,
   `npm run typecheck`, `npm run lint`. The Lua addon is driven through a stubbed Wow
   Forever client in `addon/test` (`npm test` runs the shipped Lua
   verbatim); add a case there instead of listing manual steps only.
   Still describe any in-game verification in the PR.

## Branch model

| Branch | Target | Role |
|---|---|---|
| `forever` (default) | WoW Forever 1.60.1, Interface 16001 | Development trunk |
| `anniversary` | TBC Anniversary 2.5.6, Interface 20506 | Maintenance line |

Shared work lands on `forever` first. When merging into `anniversary`,
keep that branch's client-specific files:

- `addon/WoWderhoiAH/WoWderhoiAH.toc`
- the scan acquisition path in `addon/WoWderhoiAH/WoWderhoiAH.lua`
- the buy/sell API paths in `addon/WoWderhoiAH/Trade.lua` and
  `addon/WoWderhoiAH/Sell.lua`, `Mail.lua`, `Craft.lua` and the compiled
  `GeneratedRecipes.lua` (the recipe dataset is Forever-specific)
- branch-specific docs and README badges

Shared by design: `Core.lua` (pure pricing and plans), `Journal.lua`,
`Ledger.lua`, `GUI.lua` (tooltip and charts), `src/lib/market-rules.ts`,
`src/lib/analytics.ts`, `src/lib/core/`, `src/lib/journal.ts`,
`src/lib/craft-lp.ts`, the recipe dataset and the whole terminal. A fix
that applies to both should not be written twice.

## 中文

欢迎发 PR——只有一条硬规则：

1. **每个 PR 必须挂在一个 issue 上。**先开 issue（bug、功能提案、
   疑问都行），PR 描述里用 `Closes #N` / `Fixes #N` 关联。没有关联
   issue 的 PR 会被直接关闭。
2. **所有 PR 由维护者（@BrandNewJimZhang）审阅**后合并。
3. 保持线性历史：基于 `forever`（默认分支）rebase，不要 merge
   commit。`anniversary` 是维护线，通过把 `forever` 合并进来接收共享
   改动。
4. Commit message 用英文祈使句，带 `Feat:`/`Fix:`/`Docs:` 等前缀。
5. 行为变更必须附带测试。TypeScript：`npm run test`、
   `npm run typecheck`、`npm run lint`。Lua 插件在 `addon/test` 里有模拟无限客户端的
   离线环境（`npm test` 直接跑发布用的 Lua），请在那里加用例，而不是
   只在 PR 里写手工验证步骤；游戏内验证仍请一并描述。

### 分支模型

| 分支 | 目标 | 角色 |
|---|---|---|
| `forever`（默认） | 无限 1.60.1，Interface 16001 | 开发主线 |
| `anniversary` | TBC 周年服 2.5.6，Interface 20506 | 维护线 |

共享改动先落 `forever`。合并到 `anniversary` 时保留该分支的客户端
专属文件：

- `addon/WoWderhoiAH/WoWderhoiAH.toc`
- `addon/WoWderhoiAH/WoWderhoiAH.lua` 里的扫描采集路径
- `addon/WoWderhoiAH/Trade.lua` 与 `Sell.lua` 里的买卖 API 路径
- `Mail.lua`、`Craft.lua` 与编译产物 `GeneratedRecipes.lua`（配方数据集是无限服专属）
- 分支专属文档与 README 徽章

按设计共享：`Core.lua`（纯定价与计划）、`Journal.lua`、`Ledger.lua`、
`GUI.lua`（tooltip 与图表）、`src/lib/market-rules.ts`、
`src/lib/analytics.ts`、`src/lib/core/`、`src/lib/journal.ts`、
`src/lib/craft-lp.ts`、配方数据集与整个桌面终端。两边都适用的修复不要
写两遍。
