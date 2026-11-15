# Forever 客户端假设登记

本文登记代码依赖、但当前仓库没有在 Forever 1.60.1（Interface 16001）真实会话里
逐字段核对的客户端行为。目的不是免责，而是让「测过的」和「按形状实现的」永远分得开。

状态标签：

- **已实测**：有可复现的客户端观测或日志。
- **测试覆盖**：仓库测试钉住了我们的处理方式；它证明代码按约定运行，不证明客户端真这样返回。
- **判断值**：按社区惯例或保守估计设定，等待实测校准。
- **未验证**：按客户端 API 的形状实现，尚未在真实会话核对。

复测入口：游戏内 `/wahdiag`（打印原始字段与降级状态）、`/wahdiag mail`（邮件分类），
以及 `npm test` 中对应的 fixture 测试。每条假设被实测后，把状态和证据一起改掉。

| 假设 | 代码位置 | 当前处理 | 状态 | 复测方式 |
|---|---|---|---|---|
| 拍卖行成交手续费 5% | `AH_FEE_RATE`、`Core.netIfSold`、`Ledger` | 售价扣 5% | 判断值（社区惯例） | 开一封成交邮件，对比发票手续费/consignment 与 Journal 的 `fee` |
| 中立拍卖行 15% 费率 | 未建模 | 与 5% 同价 | 未验证 | 在中立拍卖行挂一单，比较到账 |
| 押金成交退还，流拍/撤单损失 | `Core.expireBreakeven`、`Ledger` 的 post/cancel/expire | 押金进 escrow，成交/撤单退回，流拍记损失 | 测试覆盖，未在 Forever 实测 | 挂 12h 最低价后撤销，比较现金与 escrow |
| `CalculateItemDeposit` / `CalculateCommodityDeposit` 的返回值即押金 | `Sell.lua` | 三档时长取客户端值；不可用时不优化 | 测试覆盖（stub 固定返回） | `/wahdiag` 记录一次真实挂单前后的现金差 |
| `GetReplicateItemTimeLeft` 返回秒，或返回 0..4 档位 | `WoWderhoiAH.lua` 的 `timeLeftSeconds` | 大于 4 按秒，0..4 按档位上沿 | 未验证（双形态兼容） | `/wahdiag` 打印原始值与类型 |
| replicate 行带 `owner`，隐藏时为空 | 扫描的 `ownerVisible` / `selfExclusion` | owner 可见时按名字排除自有挂单；不可见时回退 `GetOwnedAuctions` 匹配 | 未验证（按服务器/客户端可能不同） | `/wahdiag` 看 owner 可见比例，挂一单确认 `selfListings` |
| 自有挂单可按物品、买断价、数量从 `GetOwnedAuctions` 匹配 | 扫描的 `selfExclusion = owned` | 匹配不到标 `none`，该行不参与先验校准 | 测试覆盖 | 挂一单后扫描，确认该行不出现在卖价前沿 |
| `GetCommoditySearchResultInfo(itemId, 1)` 是最便宜一档 | `Trade.lua` 的商品购买校验 | 用第一行作为市场价参考 | 未验证 | 搜一个商品，核对第一行单价不高于其余行 |
| `GetInboxInvoiceInfo` 字段与 `kind` 语义 | `Mail.lua` | 结合「钱/物品」组合判定成交、流拍、竞价赢得、取消返还 | 未验证（1.60 exe 有该函数，未收录进生成文档） | `/wahdiag mail` 打印原始字段 |
| 邮件附件最多 12 个 | `Mail.lua` 的 `MAX_ATTACHMENTS` | 循环到第一个空槽为止 | 判断值（硬上界，不参与决策） | 满附件邮件开箱 |
| 背包容量按 `bagSlots × stackSize(20)` 估算 | `WAH.coreInput`、`Core.allocate` | 假设所有物品按 20 堆叠，会高估小堆叠物品的容量 | 判断值（保守方向相反，属已知上限） | 用小堆叠物品对一次买入数量 |
| `PostItem` / `PostCommodity` 可能被 `HasRestrictions` 拦截 | `Sell.lua` | 被拦截时降级为手动价格助手，不重试、不假装成功 | 未验证 | 首次上架时看是否走降级提示 |
| `ReplicateItems` 给出可用的全量盘口 | 扫描器 | 一次扫描重建整本盘口并记录到 `ScanData` | 未验证完整性（是否有分页/上限未确认） | 对比 `total` 与客户端浏览结果 |
| `GetMoney()` 是唯一可花费现金 | `Estate`、`WAH.coreInput` | Estate 快照优先，扫描种子兜底，实时读取最后兜底 | 已实测（基础 API） | `/wahdiag` 对比 estate 现金与金币显示 |
| 扫描每 15 分钟自动重扫由 ticker 驱动 | `WoWderhoiAH.lua` 的扫描节拍 | AH 打开时到点自动扫描 | 测试覆盖 | 打开 AH 静置 16 分钟 |

## 更新规则

1. 新代码依赖任何客户端行为时，先在这里登记一行，再写实现。
2. 实测后把状态改成「已实测」，在「复测方式」里写清观测结果和日期，不删历史。
3. 假设变化会改变计划身份的输入（例如费率），必须同时检查 `RULES_REVISION`：
   规则源改了，`gen:lua-rules` 会生成新的内容哈希。
