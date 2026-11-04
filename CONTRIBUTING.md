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
3. Keep history linear: rebase on `anniversary`, no merge commits.
4. Commit messages: English, imperative, `Feat:`/`Fix:`/`Docs:`/...
   prefixes (see `git log` for the house style).
5. Behavior changes land with tests. TypeScript: `npm run test`,
   `npm run typecheck`. The Lua addon is driven through a stubbed WoW
   client in `addon/test` (`npm test` runs the shipped Lua verbatim);
   add a case there instead of listing manual steps only. Still
   describe any in-game verification in the PR.

## Branch model

`anniversary` is the TBC Anniversary 2.5.6 maintenance line. The
default branch is `forever`, targeting WoW Forever 1.60.1. Shared
work lands on `forever` first and is merged into `anniversary`; keep
this branch's client-specific files (the `.toc`, the legacy scan and
buy paths in the addon, and these docs).

## 中文

欢迎发 PR——只有一条硬规则：

1. **每个 PR 必须挂在一个 issue 上。**先开 issue（bug、功能提案、
   疑问都行），PR 描述里用 `Closes #N` / `Fixes #N` 关联。没有关联
   issue 的 PR 会被直接关闭。
2. **所有 PR 由维护者（@BrandNewJimZhang）审阅**后合并。
3. 保持线性历史：基于 `anniversary` rebase，不要 merge commit。
4. Commit message 用英文祈使句，带 `Feat:`/`Fix:`/`Docs:` 等前缀。
5. 行为变更必须附带测试。TypeScript：`npm run test`、
   `npm run typecheck`。Lua 插件在 `addon/test` 里有模拟客户端的离线
   环境（`npm test` 直接跑发布用的 Lua），请在那里加用例，而不是只在
   PR 里写手工验证步骤；游戏内验证仍请一并描述。

### 分支模型

`anniversary` 是 TBC 周年服 2.5.6 维护线；默认分支是 `forever`
（无限 1.60.1）。共享改动先落 `forever`，再合并进本分支；合并时保留
本分支的客户端专属文件（`.toc`、插件的旧版扫描与购买路径、本文档）。
