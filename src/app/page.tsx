import { Bell, CalendarClock, Hammer, RadioTower, Star } from "lucide-react";
import { buildDealRadar } from "@/lib/analytics";
import { evaluateAlertRules } from "@/lib/alerts";
import { computeCraftProfits, craftRecipes } from "@/lib/crafting";
import {
  getAlertRules,
  getUpcomingEvents,
  getWatchedItemIds
} from "@/lib/repositories";
import { getMarketSignals } from "@/lib/market-signals";
import { describeFreshness } from "@/lib/freshness";
import { filterSortSignals, MARKET_PAGE_SIZE, paginate, parseMarketView } from "@/lib/market-filter";
import { formatPercent } from "@/lib/utils";
import { Coins } from "@/components/coins";
import { qualityColorClass } from "@/lib/quality";
import { ItemIcon } from "@/components/item-icon";
import { MarketTable } from "@/components/market-table";
import { WatchStar } from "@/components/watch-star";
import { Panel, PanelHeader } from "@/components/ui/panel";
import Link from "next/link";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const view = parseMarketView(await searchParams);
  const [{ signals, latestSnapshotAt }, upcomingEvents, watchedIds, alertRules] = await Promise.all([
    getMarketSignals(),
    getUpcomingEvents(),
    getWatchedItemIds(),
    getAlertRules()
  ]);
  const freshness = describeFreshness(latestSnapshotAt, new Date());
  const watchedSignals = signals.filter((signal) => watchedIds.has(signal.itemId));
  const triggeredAlerts = evaluateAlertRules(alertRules, signals);
  // Deal radar: same rule set as the in-game radar (vendor arbitrage plus
  // guarded median discount), so both surfaces flag identical listings.
  const deals = buildDealRadar(signals).slice(0, 12);
  const priceByItemId = new Map(signals.map((signal) => [signal.itemId, signal.price]));
  const craftRows = computeCraftProfits(craftRecipes, priceByItemId);
  const craftOk = craftRows.filter((row) => row.status === "ok");
  const craftMissingCount = craftRows.length - craftOk.length;
  // The client table only ever receives the visible page; filtering and
  // sorting run here against the URL-provided view.
  const filtered = filterSortSignals(signals, view);
  const marketPage = paginate(filtered, view.page, MARKET_PAGE_SIZE);
  const categories = Array.from(new Set(signals.map((signal) => signal.category))).sort();
  const pageWatchedIds = marketPage.rows.filter((signal) => watchedIds.has(signal.itemId)).map((signal) => signal.itemId);

  return (
    <main className="terminal-grid min-h-screen bg-terminal-bg p-3 text-slate-200">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-terminal-border bg-terminal-panel px-4 py-3">
        <div>
          <h1 className="font-mono text-lg font-semibold uppercase text-terminal-amber">WoWderhoi AHelper</h1>
          <p className="font-mono text-xs text-terminal-muted">周年服拍卖行情报与短线交易终端</p>
        </div>
        <div className="flex items-center gap-3 font-mono text-xs text-terminal-muted">
          <span className={freshness.stale ? "flex items-center gap-1 text-terminal-red" : "flex items-center gap-1 text-terminal-green"}>
            <RadioTower size={14} /> 数据更新于 {freshness.label}
          </span>
          <span className="flex items-center gap-1"><Bell size={14} /> 预警就绪</span>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          <Panel>
            <PanelHeader title="捡漏雷达" action={<span className="font-mono text-xs text-terminal-green">NPC必赚 + 最低价 vs 7日中位</span>} />
            <div className="space-y-2 p-3 font-mono text-xs">
              {deals.length === 0 && (
                <div className="text-terminal-muted">
                  {signals.length === 0 ? "暂无市场数据。进游戏 /wahscan 扫描。" : "当前没有满足流动性与利润门槛的捡漏挂单。"}
                </div>
              )}
              {deals.map((deal) => (
                <div key={deal.itemId} className="flex items-center justify-between gap-2">
                  <Link href={`/items/${deal.itemId}`} className={`inline-flex items-center gap-2 ${qualityColorClass(deal.quality)}`}>
                    <ItemIcon itemId={deal.itemId} size={16} />
                    {deal.name}
                    {deal.vendor
                      ? <span className="text-terminal-amber">NPC必赚 +<Coins copper={deal.profit} /></span>
                      : <span className="text-terminal-green">-{deal.discountPercent.toFixed(0)}%</span>}
                  </Link>
                  <span className="flex items-center gap-3">
                    <Coins copper={deal.minPrice} />
                    <span className="text-terminal-muted">{deal.vendor ? "NPC价" : "中位"} <Coins copper={deal.reference} /></span>
                  </span>
                </div>
              ))}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="市场监控" />
            <MarketTable
              rows={marketPage.rows}
              watchedItemIds={pageWatchedIds}
              view={view}
              categories={categories}
              totalCount={signals.length}
              filteredCount={filtered.length}
              page={marketPage.page}
              pageCount={marketPage.pageCount}
            />
          </Panel>
        </div>
        <div className="space-y-3">
          <Panel>
            <PanelHeader title="触发的预警" action={<Bell size={13} className={triggeredAlerts.length > 0 ? "text-terminal-red" : "text-terminal-muted"} />} />
            <div className="space-y-2 p-3 font-mono text-xs">
              {triggeredAlerts.length === 0 && <div className="text-terminal-muted">无触发预警</div>}
              {triggeredAlerts.map((hit) => (
                <div key={hit.rule.id} className="flex items-center justify-between gap-2">
                  <Link href={`/items/${hit.rule.itemId}`} className="text-slate-100 hover:text-terminal-amber">{hit.signal.name}</Link>
                  <span className="text-terminal-red">
                    {hit.rule.metric} {hit.rule.operator === "gt" ? ">" : "<"} {hit.rule.threshold}（现 {hit.actual.toFixed(2)}）
                  </span>
                </div>
              ))}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="关注列表" action={<Star size={13} className="text-terminal-amber" />} />
            <div className="space-y-2 p-3 font-mono text-xs">
              {watchedSignals.length === 0 && <div className="text-terminal-muted">市场表中点 ☆ 添加关注</div>}
              {watchedSignals.map((signal) => (
                <div key={signal.itemId} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <WatchStar itemId={signal.itemId} watched />
                    <Link href={`/items/${signal.itemId}`} className={`inline-flex items-center gap-1 ${qualityColorClass(signal.quality)}`}><ItemIcon itemId={signal.itemId} size={16} />{signal.name}</Link>
                  </span>
                  <span className="flex items-center gap-3">
                    <Coins copper={signal.price} />
                    <span className={signal.changePercent >= 0 ? "text-terminal-red" : "text-terminal-green"}>{formatPercent(signal.changePercent)}</span>
                  </span>
                </div>
              ))}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="制造利润" action={<Hammer size={13} className="text-terminal-muted" />} />
            <div className="space-y-2 p-3 font-mono text-xs">
              {craftOk.length === 0 && (
                <div className="text-terminal-muted">扫描覆盖配方材料与成品后此处显示利润排行</div>
              )}
              {craftOk.slice(0, 8).map((row) => (
                <div key={row.recipe.name} className="flex items-center justify-between gap-2">
                  <span className="text-slate-100">{row.recipe.name}<span className="ml-1 text-[10px] text-terminal-muted">{row.recipe.profession}</span></span>
                  <span className="flex items-center gap-3">
                    <span className={row.profit >= 0 ? "text-terminal-green" : "text-terminal-red"}><Coins copper={row.profit} /></span>
                    <span className={row.marginPercent >= 0 ? "text-terminal-green" : "text-terminal-red"}>{formatPercent(row.marginPercent)}</span>
                  </span>
                </div>
              ))}
              {craftMissingCount > 0 && (
                <div className="border-t border-terminal-border pt-2 text-[10px] text-terminal-muted">
                  另有 {craftMissingCount} 个配方因缺少价格数据未计算
                </div>
              )}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="版本日历" action={<CalendarClock size={13} className="text-terminal-muted" />} />
            <div className="space-y-2 p-3 font-mono text-xs">
              {upcomingEvents.length === 0 && <div className="text-terminal-muted">暂无已录入的版本事件</div>}
              {upcomingEvents.map((event) => (
                <div key={event.id} className="flex items-center justify-between gap-2">
                  <span className="text-slate-200">{event.eventName}</span>
                  <span className="text-terminal-muted">{event.startTime.toISOString().slice(0, 10)}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </main>
  );
}
