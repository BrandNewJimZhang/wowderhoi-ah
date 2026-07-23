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
3. Keep history linear: rebase on `main`, no merge commits.
4. Commit messages: English, imperative, `Feat:`/`Fix:`/`Docs:`/...
   prefixes (see `git log` for the house style).
5. Behavior changes to the TypeScript side land with tests
   (`npm run test`, `npm run typecheck` must pass). The Lua addon has
   no offline harness — describe your in-game verification in the PR.

## 中文

欢迎发 PR——只有一条硬规则：

1. **每个 PR 必须挂在一个 issue 上。**先开 issue（bug、功能提案、
   疑问都行），PR 描述里用 `Closes #N` / `Fixes #N` 关联。没有关联
   issue 的 PR 会被直接关闭。
2. **所有 PR 由维护者（@BrandNewJimZhang）审阅**后合并。
3. 保持线性历史：基于 `main` rebase，不要 merge commit。
4. Commit message 用英文祈使句，带 `Feat:`/`Fix:`/`Docs:` 等前缀。
5. TypeScript 侧的行为变更需附带测试（`npm run test`、
   `npm run typecheck` 必须通过）；Lua 插件无离线测试环境，请在 PR
   里描述你的游戏内验证过程。
