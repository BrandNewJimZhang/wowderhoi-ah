import Link from "next/link";

import { Wallet } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getMarketSignals } from "@/lib/market-signals";
import { getPositions } from "@/lib/repositories";
import { phaseLabels } from "@/lib/phase";
import { summarizeTrades } from "@/lib/trade-summary";
import { Coins } from "@/components/coins";
import { Panel, PanelHeader } from "@/components/ui/panel";

export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const bundle = await getMarketSignals();
  const scope = bundle.scope;
  const [positions, allTrades] = await Promise.all([
    getPositions(scope),
    prisma.trade.findMany({
      where: scope ? { marketId: scope.id } : {},
      orderBy: { realizedAt: "desc" }
    })
  ]);
  const { signals, phase } = bundle;
  const priceById = new Map(signals.map((signal) => [signal.itemId, signal.sellPrice]));
  const nameById = new Map(signals.map((signal) => [signal.itemId, signal.name]));
  const rows = Object.entries(positions)
    .map(([key, position]) => {
      const itemId = Number(key);
      const price = priceById.get(itemId) ?? 0;
      const value = price * position.qty;
      return {
        itemId,
        name: nameById.get(itemId) ?? `#${itemId}`,
        qty: position.qty,
        cost: position.cost,
        unitCost: position.qty > 0 ? position.cost / position.qty : 0,
        price,
        value,
        unrealized: value - position.cost
      };
    })
    .sort((left, right) => right.value - left.value);
  const positionValue = rows.reduce((sum, row) => sum + row.value, 0);
  const positionCost = rows.reduce((sum, row) => sum + row.cost, 0);
  const trades = summarizeTrades(allTrades);
  const cash = scope?.cash ?? 0;

  return (
    <main className="terminal-grid min-h-screen bg-terminal-bg p-3 text-slate-200">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-terminal-border bg-terminal-panel px-4 py-3">
        <div>
          <div className="font-mono text-xs uppercase text-terminal-muted">组合与资金</div>
          <h1 className="flex items-center gap-2 font-mono text-lg font-semibold text-terminal-amber"><Wallet size={18} /> 头寸账本</h1>
          <p className="font-mono text-xs text-terminal-muted">{phaseLabels[phase]} · 账本由游戏内 Journal 重放而来</p>
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
          <div className="text-terminal-muted">持仓市值 / 成本</div>
          <div className="mt-1 text-lg"><Coins copper={positionValue} /> <span className="text-xs text-terminal-muted">/ <Coins copper={positionCost} /></span></div>
        </div>
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">浮动盈亏</div>
          <div className={`mt-1 text-lg ${positionValue - positionCost >= 0 ? "text-terminal-green" : "text-terminal-red"}`}>
            <Coins copper={positionValue - positionCost} />
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
                    <td className="px-3 py-2 text-right"><Coins copper={row.price} /></td>
                    <td className="px-3 py-2 text-right"><Coins copper={row.value} /></td>
                    <td className={`px-3 py-2 text-right ${row.unrealized >= 0 ? "text-terminal-green" : "text-terminal-red"}`}><Coins copper={row.unrealized} /></td>
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
                    <td className="px-3 py-2 text-right text-terminal-muted">{trade.channel}{trade.inferred ? " · 推断" : ""}</td>
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
  );
}
