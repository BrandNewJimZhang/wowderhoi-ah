import { notFound } from "next/navigation";
import Link from "next/link";
import { buildMarketSignal, buildWeekdaySeasonality } from "@/lib/analytics";
import { getItemDetail, getWatchedItemIds } from "@/lib/repositories";
import { getMarketBundle } from "@/lib/market-read";
import { prisma } from "@/lib/prisma";
import { formatPercent } from "@/lib/utils";
import { Coins } from "@/components/coins";
import { qualityColorClass } from "@/lib/quality";
import { ItemIcon } from "@/components/item-icon";
import { describeFreshness } from "@/lib/freshness";
import { fillRules, SCAN_INTERVAL_MINUTES } from "@/lib/market-rules";
import { bandFromInterval } from "@/lib/fill";
import { buildTimeSeries } from "@/lib/chart-series";
import { seriesToDailyBars } from "@/lib/item-series";
import { currentScanDemand, sellPriceOf } from "@/lib/market-data";
import { CandlestickChart, FillProbabilityChart, OrderBookChart, TimeSeriesChart, type BookTier } from "@/components/charts";
import { AlertRulePanel } from "@/components/trader-panels";
import { WatchStar } from "@/components/watch-star";
import { Panel, PanelHeader } from "@/components/ui/panel";

export default async function ItemDetail({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const numericItemId = Number(itemId);
  // Resolve the market once through the read model: the item page and the
  // market table must read the same generation even if a new scan lands
  // mid-request.
  const bundle = await getMarketBundle();
  const detail = await getItemDetail(numericItemId, bundle.scope);
  if (!detail) notFound();
  const { item, quote, demandQuote, series, signal: storedSignal } = detail;
  const [watchedIds, alertRules] = await Promise.all([
    getWatchedItemIds(),
    prisma.alertRule.findMany({ where: { itemId: numericItemId } })
  ]);
  const now = new Date();
  const stale = quote !== null
    && bundle.latestSnapshotAt !== null
    && quote.timestamp.getTime() < bundle.latestSnapshotAt.getTime();
  const signal = storedSignal?.signal
    ?? (quote
      ? buildMarketSignal(
          {
            item: {
              itemId: item.itemId,
              name: item.name,
              quality: item.quality,
              category: item.category,
              subCategory: item.subCategory,
              vendorPrice: item.vendorPrice,
              iconId: item.iconId
            },
            quote,
            series
          },
          now,
          { phase: bundle.phase, index: bundle.priceIndex, currentAt: bundle.latestSnapshotAt ?? quote.timestamp }
        )
      : null);
  const dailyBars = seriesToDailyBars(series);
  const seasonality = buildWeekdaySeasonality(dailyBars);
  const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  // Bids only describe the book they were captured with: a demand row from
  // an older scan must not be shown beside the current prices.
  const demand = currentScanDemand(demandQuote, bundle.latestSnapshotAt);
  const expiring = quote?.expiring && typeof quote.expiring === "object"
    ? quote.expiring as { soon?: number; mid?: number; late?: number }
    : null;
  const freshness = describeFreshness(quote?.timestamp ?? demand?.timestamp ?? null, now);
  const candleData = dailyBars.map((bar) => ({
    label: bar.date.toISOString().slice(5, 10),
    open: bar.openPrice,
    close: bar.closePrice,
    high: bar.highPrice,
    low: bar.lowPrice,
    volume: bar.volume
  }));
  // Intraday view: every retained series point. The layered retention
  // already reaches from per-scan points to weekly closes, so the window
  // buttons never redraw the same half-day.
  const intradayData = buildTimeSeries(series);
  const defaultChartWindow = bundle.phase === "ignition" ? "全部" : bundle.phase === "wave" ? "6h" : "24h";
  const tiers = (Array.isArray(quote?.topTiers) ? quote.topTiers : []) as BookTier[];
  const bookTiers = tiers.length > 0 ? tiers : quote ? [{ p: quote.minPrice, q: quote.quantity }] : [];
  // The fill curve is derived from the shared core's 24-hour fill
  // probability, never from a second hazard formula: the chart and the
  // recommendation must cite the same evidence tier. The materialised
  // signal row carries the core row for this item, so no full-market scan.
  const fillRow = storedSignal?.coreRow ?? null;
  const fillEstimate = fillRow && !fillRow.vendor ? fillRow : null;
  const hazardPerHour = fillEstimate?.fillHazard && fillEstimate.fillHazard > 0 ? fillEstimate.fillHazard : null;
  const fillBasis = fillEstimate && fillEstimate.fillBasis !== "vendor" ? fillEstimate.fillBasis : "prior";
  const fillBand = fillEstimate
    ? bandFromInterval(fillEstimate.fillProb, fillEstimate.fillProbLow, fillEstimate.fillProbHigh)
    : 0.35;

  return (
    <main className="terminal-grid min-h-screen bg-terminal-bg p-3 text-slate-200">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-terminal-border bg-terminal-panel px-4 py-3">
        <div>
          <div className="font-mono text-xs uppercase text-terminal-muted">商品终端</div>
          <h1 className={`flex items-center gap-2 font-mono text-2xl font-semibold ${qualityColorClass(item.quality)}`}>
            <ItemIcon iconId={item.iconId} size={28} />{item.name}
          </h1>
          <div className={freshness.stale ? "font-mono text-xs text-terminal-red" : "font-mono text-xs text-terminal-green"}>
            数据更新于 {freshness.label}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/market" className="font-mono text-xs text-terminal-muted hover:text-terminal-amber">返回市场</Link>
          <a
            href={`https://wuxianwow.com/id/item:${item.itemId}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-terminal-muted hover:text-terminal-amber"
          >
            无限图鉴 ↗
          </a>
          <span className="text-xl"><WatchStar itemId={item.itemId} watched={watchedIds.has(item.itemId)} /></span>
        </div>
      </div>
      <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          <Panel>
            <PanelHeader title="目录事实" action={<span className="font-mono text-xs text-terminal-muted">来源 {item.catalogSource === "wuxianwow.com" ? "无限图鉴" : "扫描占位"}</span>} />
            <div className="grid grid-cols-2 gap-3 p-3 font-mono text-xs sm:grid-cols-4">
              <div><div className="text-terminal-muted">品类</div><div className="text-slate-200">{item.category}{item.subCategory !== item.category ? ` · ${item.subCategory}` : ""}</div></div>
              <div><div className="text-terminal-muted">品质</div><div className={qualityColorClass(item.quality)}>{item.quality}</div></div>
              <div><div className="text-terminal-muted">装等</div><div className="text-slate-200">{item.itemLevel ?? "—"}</div></div>
              <div><div className="text-terminal-muted">需求等级</div><div className="text-slate-200">{item.requiredLevel ?? "—"}</div></div>
              <div><div className="text-terminal-muted">部位</div><div className="text-slate-200">{item.slot ?? "—"}</div></div>
              <div><div className="text-terminal-muted">类型</div><div className="text-slate-200">{item.typeLabel ?? "—"}</div></div>
              <div><div className="text-terminal-muted">NPC 卖价</div><div className="text-slate-200">{item.vendorPrice === null ? "—" : <Coins copper={item.vendorPrice} />}</div></div>
              <div><div className="text-terminal-muted">物品 ID</div><div className="text-slate-200">{item.itemId}</div></div>
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="盘口阶梯 (价格 vs 累计在售)" />
            <div className="p-3">
              {quote
                ? <OrderBookChart tiers={bookTiers} sellP={signal?.sellPrice ?? sellPriceOf(quote)} minPrice={quote.minPrice} />
                : <div className="p-4 font-mono text-xs text-terminal-muted">尚无扫描数据</div>}
              {expiring && ((expiring.soon ?? 0) + (expiring.mid ?? 0) + (expiring.late ?? 0) > 0) && (
                <div className="mt-2 border-t border-terminal-border pt-2 font-mono text-[11px] text-terminal-muted">
                  到期分布：2 小时内 {expiring.soon ?? 0} 笔 · 2–12 小时 {expiring.mid ?? 0} 笔 · 12 小时以上 {expiring.late ?? 0} 笔
                </div>
              )}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title={`${fillRules.horizonHours} 小时成交概率`} />
            <div className="p-3">
              {hazardPerHour !== null && fillEstimate
                ? <FillProbabilityChart tiers={bookTiers} hazardPerHour={hazardPerHour} supply={quote?.quantity ?? 0} basis={fillBasis} quantity={fillEstimate.candidateQty} band={fillBand} />
                : <div className="p-4 font-mono text-xs text-terminal-muted">
                    {fillRow?.vendor
                      ? "NPC 收购价高于挂单价：成交由商人保证，无需挂单成交估计。"
                      : stale
                        ? "最近一次扫描中已无在售挂单，无法估计成交概率；价格是上次有货时的值。"
                        : quote
                          ? "该物品未通过当前阶段门槛或风险仓位检查，暂无成交概率估计；先看盘口与建议卖价。"
                          : "尚无扫描数据"}
                  </div>}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="盘中走势 (逐次扫描)" />
            <div className="p-3">
              {intradayData.length >= 2
                ? <TimeSeriesChart data={intradayData} defaultWindow={defaultChartWindow} />
                : <div className="p-4 font-mono text-xs text-terminal-muted">盘中曲线需要多次扫描——开 /wahauto 挂机自动积累（每约 {SCAN_INTERVAL_MINUTES} 分钟一个点）</div>}
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
            <PanelHeader title="星期几季节性 (建议卖价收盘中位)" />
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
              {!signal && !demand && <div className="text-xs text-terminal-muted">尚无扫描数据</div>}
              {stale && (
                <div className="border border-terminal-border bg-terminal-panel2 px-2 py-1 text-xs text-terminal-amber">
                  最近一次扫描中已无该物品的在售挂单，下方价格是上次有货时的值。
                </div>
              )}
              {signal && (
                <>
                  <div>
                    <div className="text-xs uppercase text-terminal-muted">建议卖价</div>
                    <div className="text-2xl"><Coins copper={signal.sellPrice} /></div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div><div className="text-terminal-muted">最低价</div><div><Coins copper={signal.minPrice} /></div></div>
                    <div title="阶段窗口内序列点的中位；n 是参与计算的观测数">
                      <div className="text-terminal-muted">建议卖价中位（n={signal.sellSamples}）</div>
                      <div><Coins copper={signal.sellRef} /></div>
                    </div>
                    <div><div className="text-terminal-muted">价差（对建议卖价）</div><div className={signal.spreadPercent >= 15 ? "text-terminal-green" : ""}>{signal.spreadPercent.toFixed(0)}%</div></div>
                    <div><div className="text-terminal-muted">趋势（对卖价中位）</div><div className={signal.trendPercent >= 0 ? "text-terminal-red" : "text-terminal-green"}>{formatPercent(signal.trendPercent)}</div></div>
                    <div><div className="text-terminal-muted">P10（统计）</div><div><Coins copper={signal.price} /></div></div>
                    {quote && quote.p5Price > 0 && (
                      <div><div className="text-terminal-muted">P5（统计）</div><div><Coins copper={quote.p5Price} /></div></div>
                    )}
                    <div><div className="text-terminal-muted">真实卖价</div><div>{signal.realSellPrice !== null ? <Coins copper={signal.realSellPrice} /> : "—"}</div></div>
                    <div><div className="text-terminal-muted">卖家数</div><div>{signal.sellerCount}{signal.sellersInvisible ? "（不可见）" : ""}</div></div>
                    <div><div className="text-terminal-muted">环比上次有报价扫描</div><div className={signal.changePercent >= 0 ? "text-terminal-red" : "text-terminal-green"}>{formatPercent(signal.changePercent)}</div></div>
                    <div><div className="text-terminal-muted">在售量</div><div>{signal.quantity.toLocaleString()}</div></div>
                    <div><div className="text-terminal-muted">挂单数</div><div>{signal.numAuctions.toLocaleString()}</div></div>
                    <div title="阶段窗口内序列卖价的四分位区间"><div className="text-terminal-muted">P25–P75</div><div><Coins copper={signal.priceP25} /> – <Coins copper={signal.priceP75} /></div></div>
                  </div>
                </>
              )}
              {demand && (
                <div className="border-t border-terminal-border pt-3">
                  <div className="text-xs uppercase text-terminal-muted">竞价需求（本次扫描）</div>
                  <div className="mt-1 grid grid-cols-2 gap-3 text-xs">
                    <div><div className="text-terminal-muted">竞价笔数</div><div>{demand.bidOnlyCount ?? 0}</div></div>
                    <div><div className="text-terminal-muted">最高竞价</div><div><Coins copper={demand.highestBid ?? 0} /></div></div>
                  </div>
                </div>
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
