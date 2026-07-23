import { notFound } from "next/navigation";
import { buildMarketSignal, buildWeekdaySeasonality } from "@/lib/analytics";
import { getItemDetail, getWatchedItemIds } from "@/lib/repositories";
import { prisma } from "@/lib/prisma";
import { formatPercent } from "@/lib/utils";
import { Coins } from "@/components/coins";
import { qualityColorClass } from "@/lib/quality";
import { ItemIcon } from "@/components/item-icon";
import { describeFreshness } from "@/lib/freshness";
import { CandlestickChart, TimeSeriesChart } from "@/components/charts";
import { AlertRulePanel } from "@/components/trader-panels";
import { WatchStar } from "@/components/watch-star";
import { Panel, PanelHeader } from "@/components/ui/panel";

export default async function ItemDetail({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const numericItemId = Number(itemId);
  const item = await getItemDetail(numericItemId);
  if (!item) notFound();
  const [watchedIds, alertRules] = await Promise.all([
    getWatchedItemIds(),
    prisma.alertRule.findMany({ where: { itemId: numericItemId } })
  ]);
  const now = new Date();
  const hasSnapshots = item.snapshots.length > 0;
  const signal = hasSnapshots ? buildMarketSignal(item, now) : null;
  const seasonality = buildWeekdaySeasonality(item.dailySummaries);
  const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const latestSnapshot = item.snapshots[item.snapshots.length - 1];
  const freshness = describeFreshness(latestSnapshot?.timestamp ?? null, now);
  const candleData = item.dailySummaries.map((summary) => ({
    label: summary.date.toISOString().slice(5, 10),
    open: summary.openPrice,
    close: summary.closePrice,
    high: summary.highPrice,
    low: summary.lowPrice,
    volume: summary.volume
  }));
  // Intraday view: raw scan snapshots. AH prices swing hour to hour;
  // with auto-rescan every ~15 min this is the actual trading chart.
  const intradayData = item.snapshots.slice(-48).map((snapshot) => ({
    ts: snapshot.timestamp.getTime(),
    price: snapshot.marketPrice,
    volume: snapshot.quantity
  }));

  return (
    <main className="terminal-grid min-h-screen bg-terminal-bg p-3 text-slate-200">
      <div className="mb-3 flex items-center justify-between border border-terminal-border bg-terminal-panel px-4 py-3">
        <div>
          <div className="font-mono text-xs uppercase text-terminal-muted">商品终端</div>
          <h1 className={`flex items-center gap-2 font-mono text-2xl font-semibold ${qualityColorClass(item.quality)}`}><ItemIcon itemId={item.itemId} size={28} />{item.name}</h1>
          <div className={freshness.stale ? "font-mono text-xs text-terminal-red" : "font-mono text-xs text-terminal-green"}>
            数据更新于 {freshness.label}
          </div>
        </div>
        <span className="text-xl"><WatchStar itemId={item.itemId} watched={watchedIds.has(item.itemId)} /></span>
      </div>
      <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          <Panel>
            <PanelHeader title="盘中走势 (逐次扫描)" />
            <div className="p-3">
              {intradayData.length >= 2
                ? <TimeSeriesChart data={intradayData} />
                : <div className="p-4 font-mono text-xs text-terminal-muted">盘中曲线需要多次扫描——开 /wahauto 挂机自动积累（每约 15 分钟一个点）</div>}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="K线 (日线 OHLC)" />
            <div className="p-3">
              {candleData.length >= 2
                ? <CandlestickChart data={candleData} />
                : <div className="p-4 font-mono text-xs text-terminal-muted">K 线需要至少 2 天的扫描数据</div>}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="星期几季节性 (中位收盘)" />
            <div className="grid grid-cols-7 gap-px bg-terminal-border font-mono text-xs">
              {seasonality.map((day) => (
                <div key={day.weekday} className="bg-terminal-panel px-2 py-3 text-center">
                  <div className="uppercase text-terminal-muted">{weekdayNames[day.weekday]}</div>
                  <div className={day.priceDeviation >= 0 ? "mt-1 text-terminal-red" : "mt-1 text-terminal-green"}>
                    {day.priceDeviation >= 0 ? "+" : ""}{day.priceDeviation.toFixed(1)}%
                  </div>
                  <div className="mt-1 text-[10px] text-terminal-muted">在售 {day.listedShare.toFixed(0)}% · n={day.sampleCount}</div>
                </div>
              ))}
              {seasonality.length === 0 && (
                <div className="col-span-7 bg-terminal-panel px-3 py-3 text-terminal-muted">数据不足，需要跨越至少一周的扫描积累</div>
              )}
            </div>
          </Panel>
        </div>
        <div className="space-y-3">
          <Panel>
            <PanelHeader title="行情概要" />
            <div className="space-y-3 p-4 font-mono text-sm">
              {!signal && <div className="text-xs text-terminal-muted">尚无扫描数据</div>}
              {signal && (
                <>
                  <div>
                    <div className="text-xs uppercase text-terminal-muted">P50 市价</div>
                    <div className="text-2xl"><Coins copper={signal.price} /></div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div><div className="text-terminal-muted">最低价</div><div><Coins copper={signal.minPrice} /></div></div>
                    <div><div className="text-terminal-muted">7日中位</div><div><Coins copper={signal.med7} /></div></div>
                    <div><div className="text-terminal-muted">折扣</div><div className={signal.discountPercent >= 15 ? "text-terminal-green" : ""}>{signal.discountPercent.toFixed(0)}%</div></div>
                    <div><div className="text-terminal-muted">环比上次</div><div className={signal.changePercent >= 0 ? "text-terminal-red" : "text-terminal-green"}>{formatPercent(signal.changePercent)}</div></div>
                    <div><div className="text-terminal-muted">在售量</div><div>{signal.quantity.toLocaleString()}</div></div>
                    <div><div className="text-terminal-muted">挂单数</div><div>{signal.numAuctions.toLocaleString()}</div></div>
                  </div>
                </>
              )}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="价格预警" />
            <AlertRulePanel itemId={item.itemId} rules={alertRules} />
          </Panel>
        </div>
      </div>
    </main>
  );
}
