# 开服运行手册

从安装到首周操作的完整清单。对应 `forever` 分支（无限 1.60.1，Interface 16001）。

## 0. 一次性准备

```powershell
cd <项目目录>
Copy-Item .env.example .env
npm install
npm run db:push
npm run recipes:import
npm run dev
```

`.env` 至少设置：

```ini
DATABASE_URL="file:./dev.db"
AQT_SAVEDVARS_PATH="<游戏数据目录>\\WTF\\Account\\<账号ID>\\SavedVariables\\WoWderhoiAH.lua"
AQT_IMPORT_URL="http://localhost:3000/api/import/addon-scan"
AQT_BUDGET_COPPER="500000"          # 终端计划预算；与扫描里的现金分开
# AQT_PHASE="ignition"   # 可选：手动锁阶段
# AQT_MARKET="服务器|阵营"   # 可选：默认跟随最新扫描的市场
```

把 `addon/WoWderhoiAH` 复制到客户端实际的 `Interface/AddOns/WoWderhoiAH`
（`.toc` 必须在文件夹第一层）。

## 1. 开服第一次登录

1. 打开拍卖行，`/wahdiag`。
2. 逐项记录结论，尤其是：
   - `GetReplicateItemTimeLeft(1)` 返回秒还是档位；
   - `owner` 可见率（>50% 才能用真实卖家数）；
   - `own listings excluded` 行：自己挂出一件后重新扫描，确认笔数增加、
     `observation v2` 出现，且雷达的卖价前沿不取自己的报价；
   - `SaveAddOns` 是否可用；
   - `PostItem/PostCommodity` 是否存在；
   - `CalculateCommodityDeposit` 的返回值；
   - `GetNumOwnedAuctions` 的结构；
   - `throttle ready`；
   - `bags` 行：实时空位与扫描记录的空位是否一致（终端按扫描记录的数字规划可买数量）；
   - 当前阶段。
3. `/wahdiag mail`，确认 `GetInboxInvoiceInfo` 的字段顺序、物品链接与
   `CanCheckInbox`；邮箱为空时先挂一件低价物品卖出，再开箱复查。
4. `/wahscan`，等聊天框显示扫描完成。
5. 如果服务器已经开了一段时间，`/wahopen -<小时数>`（或 `/wahopen now`）设定开服
   锚点；否则阶段会按本机首次扫描从点火期重新开始。
6. 制造一件物品，确认 `/wahdiag` 的 `craft: N recorded` 增加；材料未入账时会记短头寸，
   这是账本在说“成本未知”，不是失败。
7. 小退或 `/reload` 一次（即使 `SaveAddOns` 可用，也先确认文件真的落盘）。
8. 启动 `npm run addon:watch`，看到 `Imported N items, M positions and K trades`
   即接通。
9. 打开 `http://localhost:3000`，确认驾驶舱有阶段、数据龄、行动清单，且行动数量与
   游戏内雷达的“可买”一致；交易页的“下一步”应同时出现买入动作与持仓的卖出计划。
10. 卖出页 `/wahsell`：有该物品自己的成交或可观测消失时，应显示“推荐：价格 / 时长 /
    成交率”；`/wahpricing off` 可退回单一时长。跨角色搬货先 `/wahtransfer … out`，
    记下打印的单位成本，再到接收角色 `/wahtransfer … in <单位成本>`。

### 如果 `/wahdiag` 报异常

| 现象 | 处理 |
|---|---|
| `timeLeft` 是档位 | 消失量退化为区间，置信度降级；不要把它当精确秒 |
| `owner` 不可见 | 卖家数退化为挂单数，界面标“卖家不可见” |
| `SaveAddOns` 缺失 | 依赖小退/`/reload`；终端显示数据龄 |
| `PostItem` 缺失 | 卖出页降级为价格助手 |
| `throttle ready` 为 false | 自动扫描退避；手动降低扫描频率 |
| 扫描超时 | 确认 AH 开着；失败会指数退避，连续失败 3 次降为 10 分钟 |
| mail 发票字段为空 | 该客户端不暴露发票；`/wahcapture mail off` 关闭采集，系统退回推断成交 |
| 邮箱成交显示 unattributed | 物品不在扫描名表且无唯一开仓挂单；下次扫描后自动重试，不写错账 |
| craft 一直 unmapped | 配方 id 与数据集不一致且产物非唯一；对照 `/wahdiag` 的 recipe 计数，补映射；需要停掉采集时用 `/wahcapture craft off` |
| 阶段一直停在点火期 | `/wahopen` 未设或设成了未来时间；`/wahopen -<小时数>` 校正 |

## 2. 点火期（0–6 小时）

市场特征：供给近零，价格由首批卖家设定；没有历史；挂单可能几分钟被压。

- 阶段：自动判定可能滞后，手动 `/wahphase ignition`。
- 雷达：`minAuctions=1`，不做历史门槛；只碰刚需与 NPC 套利。
- 卖：先卖背包、魔杖、药水、食物/水、弹药、专业工具；每次扫描后按建议卖价压 1 铜。
- 买：只买 NPC 收购价高于挂单价的货；不接“比参考价低 90%”的盘——开服没有可靠参考价。
- 数据：每次扫描后确认 `journal` 和 `capture` 都有增长；第一次“买 → 挂 → 成交”务必走完整闭环。
- 实验：找 1–2 个刚需物品，按 `designExperiment` 的价位小批量挂，记录成交时间。

## 3. 洪流期（6–48 小时）

市场特征：升级材料供给暴涨，价格坍塌；成品仍稀缺。

- 阶段：`/wahphase wave` 或自动。
- 雷达：价差按当前建议卖价计；历史门槛 = 6 小时窗口至少 6 个点（趋势也以同窗口中位为参照）；供给增速 >25%/小时的机会降权。
- 卖：材料价格在跌，持有就是亏；把时间花在卖上，盯增速先放缓的品类。
- 买：只扫明显错价与 NPC 套利；不接盘。
- 数据：开始积累自己的成交；复盘页的胜率与 alpha 窗口开始有意义。
- 实验：对“供给停止增长、卖价开始抬头”的材料做小批量多价位测试。

## 4. 沉淀期（48 小时–7 天）

市场特征：第一波满级出现，需求转向团本消耗、预 BIS、附魔材料；低级材料见底。

- 阶段：`/wahphase settle` 或自动。
- 雷达：价差按当前建议卖价计；历史门槛 = 24 小时窗口至少 12 个点；按市场类型分组。
- 买：低吸“供给停止增长、卖价开始抬头”的材料；用制造页的影子价格判断产能该给谁。
- 卖：做成品；用押金与手续费算保本；被压价时撤单重挂或退出。
- 数据：第三次校准；把 `data/recipes.forever.json` 的价格覆盖情况检查一遍。

## 5. 稳态（7 天+）

- 阶段：自动。
- 雷达：价差按当前建议卖价计；历史门槛 = 7 天窗口至少 48 个点；严格流动性与置信度。
- 买：套利、制造、做市；用组合页复盘资金周转。
- 卖：在售页管理到期与重挂；关注被压价。
- 学习：复盘页的 alpha 衰减；命中率下降时先检查参照是否失效，再调参数。

## 6. 每日循环

1. 开拍卖行 → `/wahscan`（或确认 `/wahauto` 在跑）。
2. 看驾驶舱状态行：扫描龄、条数、阶段、卖家可见率。
3. 看“下一步行动”：只执行通过门槛的条目；购买前核对实时价格。
4. 卖出页：给背包里积压的物品定价、上架、处理在售。
5. 开一次邮箱：确认成交会把 `inferred = false` 的事件写进 Journal；重复开箱不应增加笔数。
6. 确认 `SaveAddOns` 已在扫描后落盘、watcher 已导入；客户端不支持即时落盘时小退/`/reload`。
7. 复盘页：看昨天的成交、确认/推断占比、alpha 窗口与实验回收。

## 7. 校准纪律

- 只用真实成交校准阈值；公共挂单分布不是利润分布。
- 成交率先验用 `npm run calibrate`：它只读 `observationVersion >= 2`（已剔除自有挂单与
  自有买入）的快照，按阶段 × 市场类型打印中位数与四分位。样本不足 500 条时只打印
  “样本不足”；脚本不改规则文件，人审后改 `fillPrior` 再 `npm run gen:lua-rules`。
- 每阶段只改三档：`minSpread`、`minNet`、`minListings`；改完重新生成 Lua 规则并跑漂移测试。
- 推断成交单独统计；不要把它和真实成交混在一起算胜率。
- 产能配置（`src/lib/production-config.ts`）按角色实际时间调整，不要为了排名好看调高。
- 任何“自动扫货/自动上架”的想法都不在本系统范围内；客户端限制与 taint 不可绕过。

## 8. 故障排查

| 现象 | 原因与处理 |
|---|---|
| 插件列表没有 WoWDerhoiAH | `.toc` 不在第一层，或客户端不是 16001 |
| `/wahscan` 提示先开拍卖行 | 必须站在拍卖师面前且 AH 窗口开着 |
| 扫描超时 | 服务器未返回全量副本；确认 AH 开着后重试，或等退避结束 |
| watcher 没反应 | 看 `/wahdiag` 的 `SaveAddOns` 与数据龄；或 `AQT_SAVEDVARS_PATH` 错 |
| 导入 409 | 同一次扫描已导入且没有附带 Journal；邮箱成交触发的账本重放返回 200，不应报 409 |
| 导入 400 | 扫描版本不是 v4；用当前插件重扫 |
| 配方页为空 | 运行 `npm run recipes:import` |
| 制造页没有正利润 | 扫描未覆盖材料/成品，或价格低于成本；先扩大扫描覆盖 |
| 组合页现金为 0 | 扫描数据里没有 `cash`；确认插件是当前版本 |
| 卖出页提示被拦截 | 客户端 taint 限制；按聊天框给出的价格手动上架 |
| 卖出页不显示推荐时长 | 该物品还没有自己的成交或可观测消失（`fillBasis = prior`），价格搜索不启用；先看单一时长方案 |
| 雷达里找不到自己刚挂的物品 | 正常：自有挂单已从盘口剔除，状态行会显示“自有挂单已排除 N 笔” |
| 观察到的成交率明显偏低 | 两次扫描都没有消失时成交率会被压到先验以下，这是“零观测”的证据；确认不是扫描中断 |
