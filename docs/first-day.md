# 第一天上手教程

从零开始，30 分钟内让第一条价格曲线出现在终端里。本教程对应 `forever` 分支：**魔兽世界：无限（WoW Forever）客户端 1.60.1**。TBC 周年服 2.5.6 的步骤在 `anniversary` 分支。

## 前置条件

- Windows + 魔兽世界：无限客户端（1.60.1，Interface 16001）
- Node.js 20+

## 第 1 步：启动 web 终端（约 5 分钟）

```powershell
cd <项目目录>  # 例如 X:\path\to\wowderhoi-ah
Copy-Item .env.example .env
npm install
npm run db:push
npm run dev
```

打开 `http://localhost:3000`。此时市场是空的——真实数据在第 4 步接入后出现。

## 第 2 步：安装游戏内插件（约 2 分钟）

把 `addon\WoWderhoiAH` 整个文件夹复制到客户端实际使用的数据目录下的插件目录：

```text
<游戏数据目录>\Interface\AddOns\WoWDerhoiAH
```

`<游戏数据目录>` 以启动器实际使用的那一层为准（可能是 `_retail_`、`_classic_era_` 或启动器自建目录）。复制后目录里应直接可见 `WoWDerhoiAH.toc`（不能多套一层文件夹）。如果游戏已经开着，需要重新登录角色（或 `/reload`）才会加载插件。

## 第 3 步：第一次扫描（约 1–3 分钟）

1. 进游戏，走到拍卖师面前打开拍卖行。
2. 聊天框输入 `/wahscan`。
3. 插件会调用 `C_AuctionHouse.ReplicateItems()` 一次复制整个拍卖行；聊天框显示 `已接收 N 条拍卖，处理中...`，随后是 `扫描完成`。
4. **小退到角色选择界面或 `/reload`** —— 这一步是必须的：魔兽客户端只在退出/重载时才把数据写入磁盘。

AH 开着时按约 15 分钟自动重扫，可以 `/wahauto` 开启。

## 第 4 步：接通数据管道（约 3 分钟）

找到你的 SavedVariables 文件，路径形如：

```text
<游戏数据目录>\WTF\Account\<你的账号ID>\SavedVariables\WoWDerhoiAH.lua
```

写进 `.env`：

```ini
AQT_SAVEDVARS_PATH="<游戏数据目录>\\WTF\\Account\\<你的账号ID>\\SavedVariables\\WoWDerhoiAH.lua"
```

保持 `npm run dev` 运行，另开一个终端：

```powershell
npm run addon:watch
```

看到 `Imported N items from scan ...` 就说明第一批快照已入库。刷新 `http://localhost:3000`，市场总览已经是你服务器的真实行情。

## 第 5 步：在游戏里用起来

- 打开拍卖行：WAH 交易页默认在右侧自动打开（`/wahtrade` 手动开关）。
- **找便宜**：雷达列出低于 7 日P10中位 15% 以上、且过流动性/历史/利润三道闸门的挂单；NPC 必赚排最前。
- **购买**：物品拍卖点“购买”会先重读实时一口价，变价则中止；商品点“购买*”按数量走客户端自己的确认框。
- **卖价指引**：把要卖的物品拿在鼠标上，输入 `/wahprice`；或在命令后跟物品链接。

## 日常循环

之后每天只需要：开拍卖行 → `/wahscan` → 小退或 `/reload`。`addon:watch` 会自动发现新扫描并入库；同一次扫描不会重复导入。快照积累两天以上后，商品详情页的价格曲线和均线开始有意义。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 插件列表里没有 WoWDerhoiAH | `.toc` 不在文件夹第一层，或客户端版本不是 1.60.1（`## Interface: 16001`） |
| `/wahscan` 提示先开拍卖行 | 必须站在拍卖师面前且拍卖行窗口开着 |
| 扫描超时 | 服务器没有返回全量副本；确认 AH 已打开后重试，或等自动重扫 |
| watcher 报 `AQT_SAVEDVARS_PATH is not set` | `.env` 里没配路径，或路径带引号错误 |
| watcher 一直没反应 | 忘了小退/`/reload`，数据还没写到磁盘 |
| 导入报 409 | 同一次扫描已导入过，正常现象 |
| 商品点购买后还要确认 | 正常：商品按市价成交，最终总价由客户端确认框显示 |
