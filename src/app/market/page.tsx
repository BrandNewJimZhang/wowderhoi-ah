import Link from "next/link";
import { getMarketBundle } from "@/lib/market-read";
import { phaseLabels } from "@/lib/phase";
import { describeFreshness } from "@/lib/freshness";
import { Coins } from "@/components/coins";
import { ItemIcon } from "@/components/item-icon";
import { qualityColorClass } from "@/lib/quality";
import { formatPercent } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/panel";

export const dynamic = "force-dynamic";

export default async function MarketPage() {
  const bundle = await getMarketBundle();
  const { signals, phase, latestSnapshotAt } = bundle;
  const freshness = describeFreshness(latestSnapshotAt, new Date());
  return (
    <main className="terminal-grid min-h-screen bg-terminal-bg p-3 text-slate-200">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-terminal-border bg-terminal-panel px-4 py-3">
        <div>
          <div className="font-mono text-xs uppercase text-terminal-muted">市场浏览</div>
          <h1 className="font-mono text-lg font-semibold text-terminal-amber">行情</h1>
          <p className="font-mono text-xs text-terminal-muted">
            {bundle.scope ? `${bundle.scope.realm} · ${bundle.scope.faction}` : "未导入市场"} · {phaseLabels[phase]} · 数据更新于 {freshness.label}
          </p>
        </div>
        <div className="flex gap-3 font-mono text-xs">
          <Link href="/" className="text-terminal-muted hover:text-terminal-amber">驾驶舱</Link>
          <Link href="/portfolio" className="text-terminal-muted hover:text-terminal-amber">组合</Link>
          <Link href="/review" className="text-terminal-muted hover:text-terminal-amber">复盘</Link>
        </div>
      </div>
      <Panel>
        <PanelHeader title="全部物品" action={<span className="font-mono text-xs text-terminal-muted">{signals.length} 项</span>} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] border-collapse font-mono text-xs">
            <thead className="bg-terminal-panel2 text-[10px] uppercase text-terminal-muted">
              <tr>
                <th className="border-b border-terminal-border px-3 py-2 text-left">物品</th>
                <th className="border-b border-terminal-border px-3 py-2 text-right">建议卖价</th>
                <th className="border-b border-terminal-border px-3 py-2 text-right">最低价</th>
                <th className="border-b border-terminal-border px-3 py-2 text-right">卖价中位</th>
                <th className="border-b border-terminal-border px-3 py-2 text-right">价差%</th>
                <th className="border-b border-terminal-border px-3 py-2 text-right">趋势%</th>
                <th className="border-b border-terminal-border px-3 py-2 text-right">环比%</th>
                <th className="border-b border-terminal-border px-3 py-2 text-right">在售量</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((signal) => (
                <tr key={signal.itemId} className="border-b border-terminal-border/70 hover:bg-slate-800/35">
                  <td className="px-3 py-2 text-left">
                    <Link href={`/items/${signal.itemId}`} className={`inline-flex items-center gap-2 ${qualityColorClass(signal.quality)}`}>
                      <ItemIcon iconId={signal.iconId} />
                      {signal.name}
                      {signal.stale && <span className="text-[10px] text-terminal-muted">已下架</span>}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right"><Coins copper={signal.sellPrice} /></td>
                  <td className="px-3 py-2 text-right"><Coins copper={signal.minPrice} /></td>
                  <td className="px-3 py-2 text-right"><Coins copper={signal.sellRef} /></td>
                  <td className="px-3 py-2 text-right">{signal.spreadPercent.toFixed(0)}%</td>
                  <td className="px-3 py-2 text-right">{formatPercent(signal.trendPercent)}</td>
                  <td className="px-3 py-2 text-right">{formatPercent(signal.changePercent)}</td>
                  <td className="px-3 py-2 text-right">{signal.quantity.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </main>
  );
}
