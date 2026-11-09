import Link from "next/link";

import { Wallet } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getMarketView } from "@/lib/market-view";
import { sellFrontByItem } from "@/lib/analytics";
import { phaseLabels } from "@/lib/phase";
import { describeFreshness } from "@/lib/freshness";
import { valuePositions } from "@/lib/position-valuation";
import { summarizeTrades, tradeChannelLabel } from "@/lib/trade-summary";
import { Coins } from "@/components/coins";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { AppShell } from "@/components/app-shell";
import { FreshnessLabel } from "@/components/freshness-label";

export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const bundle = await getMarketView();
  const scope = bundle.scope;
  const allTrades = await prisma.trade.findMany({
    where: scope ? { marketId: scope.id } : {},
    orderBy: { realizedAt: "desc" }
  });
  const { signals, phase } = bundle;
  // The valuation uses the units the ledger can price. The estate and
  // reconciliation columns below carry the rest explicitly.
  const positions = Object.fromEntries(
    bundle.holdings
      .filter((holding) => holding.knownQty > 0)
      .map((holding) => [holding.itemId, { qty: holding.knownQty, cost: holding.costBasis }])
  );
  const unknownUnits = bundle.holdings.reduce((sum, holding) => sum + holding.unknownQty, 0);
  const missingUnits = bundle.holdings.reduce((sum, holding) => sum + holding.missingQty, 0);
  const byLocation = bundle.holdings.reduce(
    (totals, holding) => ({
      carried: totals.carried + holding.carriedQty,
      keyring: totals.keyring + holding.keyringQty,
      bank: totals.bank + holding.bankQty + holding.accountBankQty,
      mail: totals.mail + holding.mailQty,
      listed: totals.listed + holding.listedQty
    }),
    { carried: 0, keyring: 0, bank: 0, mail: 0, listed: 0 }
  );
  // A position whose item left the newest scan has no current sell front:
  // value it as unpriced instead of carrying the last price it was seen at.
  const priceById = sellFrontByItem(signals);
  const nameById = new Map(signals.map((signal) => [signal.itemId, signal.name]));
  const {
    rows,
    pricedValue: positionValue,
    pricedCost: positionCost,
    unrealized,
    unpricedCount
  } = valuePositions(positions, priceById, nameById);
  const trades = summarizeTrades(allTrades);
  const cash = scope?.cash ?? 0;
  const freshness = describeFreshness(bundle.latestScanAt, new Date());

  return (
    <AppShell active="/portfolio" revision={bundle.revision} nextRefreshInMs={bundle.nextRefreshInMs}>
      <main className="terminal-grid min-h-screen bg-terminal-bg p-3 text-slate-200">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-terminal-border bg-terminal-panel px-4 py-3">
        <div>
          <div className="font-mono text-xs uppercase text-terminal-muted">组合与资金</div>
          <h1 className="flex items-center gap-2 font-mono text-lg font-semibold text-terminal-amber"><Wallet size={18} /> 头寸账本</h1>
          <p className="font-mono text-xs text-terminal-muted">
            {scope ? `角色 ${scope.character || "未知"}` : "未导入市场"} · {phaseLabels[phase]} · 行情更新于 <FreshnessLabel at={bundle.latestScanAt?.getTime() ?? null} initialLabel={freshness.label} initialStale={freshness.stale} /> · 持仓来自客户端 estate 快照，成本与已实现来自 Journal 事实
          </p>
        </div>
        <div className="flex gap-3 font-mono text-xs">
          <Link href="/" className="text-terminal-muted hover:text-terminal-amber">驾驶舱</Link>
          <Link href="/recipes" className="text-terminal-muted hover:text-terminal-amber">制造</Link>
          <Link href="/review" className="text-terminal-muted hover:text-terminal-amber">复盘</Link>
        </div>
      </div>

      <div className="mb-3 grid gap-3 font-mono text-xs sm:grid-cols-2 xl:grid-cols-4">
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">现金（上次扫描）</div>
          <div className="mt-1 text-lg text-terminal-amber"><Coins copper={cash} /></div>
        </div>
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">持仓市值 / 成本（有报价）</div>
          <div className="mt-1 text-lg"><Coins copper={positionValue} /> <span className="text-xs text-terminal-muted">/ <Coins copper={positionCost} /></span></div>
          {unpricedCount > 0 && (
            <div className="mt-1 text-[10px] text-terminal-muted">另有 {unpricedCount} 种当前无挂单，不计入市值与浮动</div>
          )}
        </div>
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">浮动盈亏（有报价）</div>
          <div className={`mt-1 text-lg ${unrealized >= 0 ? "text-terminal-green" : "text-terminal-red"}`}>
            <Coins copper={unrealized} />
          </div>
        </div>
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">已实现（确认成交） / 手续费</div>
          <div className={`mt-1 text-lg ${trades.confirmedRealized >= 0 ? "text-terminal-green" : "text-terminal-red"}`}>
            <Coins copper={trades.confirmedRealized} /> <span className="text-xs text-terminal-muted">/ <Coins copper={trades.confirmedFees} /></span>
          </div>
          <div className="mt-1 text-[10px] text-terminal-muted">
            推断 {trades.inferredCount} 笔 · <Coins copper={trades.inferredRealized} /> 未计入
          </div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-3 border border-terminal-border bg-terminal-panel px-4 py-2 font-mono text-xs text-terminal-muted">
        <span>背包 {byLocation.carried}</span>
        {byLocation.keyring > 0 && <span>钥匙链 {byLocation.keyring}</span>}
        <span>银行 {byLocation.bank}</span>
        <span>邮箱 {byLocation.mail}</span>
        <span>在售 {byLocation.listed}</span>
        <span className={unknownUnits > 0 ? "text-terminal-amber" : ""}>成本未知 {unknownUnits}</span>
        <span className={missingUnits > 0 ? "text-terminal-red" : ""}>账实不符 {missingUnits}</span>
        {bundle.holdings.some((holding) => holding.unknownQty > 0) && (
          <span className="text-terminal-muted">成本未知的物品不进入浮动盈亏合计</span>
        )}
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
        <Panel>
          <PanelHeader title="持仓" action={<span className="font-mono text-xs text-terminal-muted">{rows.length} 种</span>} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse font-mono text-xs">
              <thead className="bg-terminal-panel2 text-[10px] uppercase text-terminal-muted">
                <tr>
                  <th className="border-b border-terminal-border px-3 py-2 text-left">物品</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-right">数量</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-right">单位成本</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-right">建议卖价</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-right">市值</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-right">浮动</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.itemId} className="border-b border-terminal-border/70">
                    <td className="px-3 py-2 text-left"><Link href={`/items/${row.itemId}`} className="text-slate-100 hover:text-terminal-amber">{row.name}</Link></td>
                    <td className="px-3 py-2 text-right text-slate-300">{row.qty}</td>
                    <td className="px-3 py-2 text-right"><Coins copper={row.unitCost} /></td>
                    <td className="px-3 py-2 text-right">{row.priced ? <Coins copper={row.price} /> : <span className="text-terminal-muted">—</span>}</td>
                    <td className="px-3 py-2 text-right">{row.priced ? <Coins copper={row.value} /> : <span className="text-terminal-muted">—</span>}</td>
                    <td className={`px-3 py-2 text-right ${row.unrealized === null ? "text-terminal-muted" : row.unrealized >= 0 ? "text-terminal-green" : "text-terminal-red"}`}>
                      {row.unrealized === null ? "—" : <Coins copper={row.unrealized} />}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-4 text-terminal-muted">还没有导入任何头寸。买入并确认后，下次扫描会带上 Journal。</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="最近成交" action={<span className="font-mono text-xs text-terminal-muted">{allTrades.length} 笔 · 推断 {trades.inferredCount}</span>} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse font-mono text-xs">
              <thead className="bg-terminal-panel2 text-[10px] uppercase text-terminal-muted">
                <tr>
                  <th className="border-b border-terminal-border px-3 py-2 text-left">时间</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-left">物品</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-right">数量</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-right">单价</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-right">净利</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-right">渠道</th>
                </tr>
              </thead>
              <tbody>
                {allTrades.slice(0, 30).map((trade) => (
                  <tr key={trade.id} className="border-b border-terminal-border/70">
                    <td className="px-3 py-2 text-left text-terminal-muted">{trade.realizedAt.toISOString().slice(5, 16).replace("T", " ")}</td>
                    <td className="px-3 py-2 text-left text-slate-200">{nameById.get(trade.itemId) ?? `#${trade.itemId}`}</td>
                    <td className="px-3 py-2 text-right text-slate-300">{trade.qty}</td>
                    <td className="px-3 py-2 text-right"><Coins copper={trade.price} /></td>
                    <td className={`px-3 py-2 text-right ${trade.pnl >= 0 ? "text-terminal-green" : "text-terminal-red"}`}><Coins copper={trade.pnl} /></td>
                    <td className="px-3 py-2 text-right text-terminal-muted">{tradeChannelLabel(trade.channel)}{trade.inferred ? " · 推断" : ""}</td>
                  </tr>
                ))}
                {allTrades.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-4 text-terminal-muted">还没有成交记录。</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </main>
    </AppShell>
  );
}
