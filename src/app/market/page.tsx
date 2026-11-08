import { getMarketBundle } from "@/lib/market-read";
import { getWatchedItemIds } from "@/lib/repositories";
import { parseMarketView } from "@/lib/market-filter";
import { phaseLabels } from "@/lib/phase";
import { describeFreshness } from "@/lib/freshness";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { AppShell } from "@/components/app-shell";
import { MarketBrowser, type MarketRow } from "@/components/market-browser";

export const dynamic = "force-dynamic";

export default async function MarketPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const initialView = parseMarketView(await searchParams);
  const [bundle, watchedIds] = await Promise.all([getMarketBundle(), getWatchedItemIds()]);
  const { signals, phase, latestScanAt } = bundle;
  const freshness = describeFreshness(latestScanAt, new Date());
  // Only the columns the table draws cross the client boundary. The full
  // signal stays on the server; a row that needs more opens its item page.
  const rows: MarketRow[] = signals.map((signal) => ({
    itemId: signal.itemId,
    iconId: signal.iconId,
    name: signal.name,
    quality: signal.quality,
    category: signal.category,
    sellPrice: signal.sellPrice,
    minPrice: signal.minPrice,
    sellRef: signal.sellRef,
    spreadPercent: signal.spreadPercent,
    trendPercent: signal.trendPercent,
    changePercent: signal.changePercent,
    quantity: signal.quantity,
    numAuctions: signal.numAuctions,
    stale: signal.stale,
    spark: signal.spark,
    priceP25: signal.priceP25,
    priceP75: signal.priceP75
  }));
  return (
    <AppShell active="/market">
      <main className="terminal-grid min-h-screen p-3 text-slate-200">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-terminal-border bg-terminal-panel px-4 py-3">
          <div>
            <div className="font-mono text-xs uppercase text-terminal-muted">市场浏览</div>
            <h1 className="font-mono text-lg font-semibold text-terminal-amber">行情</h1>
            <p className="font-mono text-xs text-terminal-muted">
              {bundle.scope ? `${bundle.scope.realm} · ${bundle.scope.faction}` : "未导入市场"} · {phaseLabels[phase]} · 数据更新于 {freshness.label}
              {" · "}{bundle.staleCount} 种已下架仍保留历史
            </p>
          </div>
          <div className="font-mono text-xs text-terminal-muted">
            查物品资料与跨服行情用无限图鉴；这里只做本服盘口与个人决策。
          </div>
        </div>
        <Panel>
          <PanelHeader title="全部物品" action={<span className="font-mono text-xs text-terminal-muted">{rows.length} 项 · 客户端即时筛选</span>} />
          <MarketBrowser rows={rows} watchedItemIds={Array.from(watchedIds)} initialView={initialView} />
        </Panel>
      </main>
    </AppShell>
  );
}
