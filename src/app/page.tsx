import { Bell, CalendarClock, RadioTower, Star } from "lucide-react";
import { evaluateAlertRules } from "@/lib/alerts";
import {
  getAlertRules,
  getRecipes,
  getUpcomingEvents,
  getWatchedItemIds
} from "@/lib/repositories";
import { buildProductionPlan } from "@/lib/production-plan";
import { dbRecipeToLp } from "@/lib/recipes";
import { getMarketSignals } from "@/lib/market-signals";
import { describeFreshness } from "@/lib/freshness";
import { phaseDescription, phaseLabels } from "@/lib/phase";
import { QUALITY_NAMES } from "@/lib/addon-scan";
import { allocateCapital } from "@/lib/portfolio";
import { resolveBudgetCopper } from "@/lib/config";
import { AH_FEE_RATE, portfolioRules } from "@/lib/market-rules";
import { filterSortSignals, MARKET_PAGE_SIZE, paginate, parseMarketView } from "@/lib/market-filter";
import { formatPercent } from "@/lib/utils";
import { Coins } from "@/components/coins";
import { qualityColorClass } from "@/lib/quality";
import { ItemIcon } from "@/components/item-icon";
import { MarketTable } from "@/components/market-table";
import { WatchStar } from "@/components/watch-star";
import { Panel, PanelHeader } from "@/components/ui/panel";
import Link from "next/link";

const qualityName = (value: number | string | undefined) =>
  typeof value === "number" ? QUALITY_NAMES[value] ?? "unknown" : value ?? "unknown";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const view = parseMarketView(await searchParams);
  const [{ scope, signals, latestSnapshotAt, phase, evaluation }, upcomingEvents, watchedIds, alertRules, recipeRows] = await Promise.all([
    getMarketSignals(),
    getUpcomingEvents(),
    getWatchedItemIds(),
    getAlertRules(),
    getRecipes()
  ]);
  const freshness = describeFreshness(latestSnapshotAt, new Date());
  const watchedSignals = signals.filter((signal) => watchedIds.has(signal.itemId));
  const triggeredAlerts = evaluateAlertRules(alertRules, signals);
  // The opportunity list is Core.lua's evaluation, the same decision core
  // the addon runs in game. It is not a second radar implementation.
  const deals = evaluation.rows.slice(0, 12);
  const capitalBudget = resolveBudgetCopper();
  const vendorPriceById = new Map(signals.map((signal) => [signal.itemId, signal.vendorPrice]));
  const sizing = allocateCapital(
    evaluation.rows.filter((row) => !row.vendor).map((row) => ({
      itemId: row.itemId,
      name: row.name,
      unitCost: row.ladderPrice,
      sellPrice: row.listP,
      feeRate: AH_FEE_RATE,
      fillProb: row.fillProb,
      // A failed listing returns the goods, so the vendor price is the
      // loss floor — the same residual Core.sellPlan uses for expiry.
      residualValue: vendorPriceById.get(row.itemId) ?? 0,
      samples: row.confidence === "high" ? 20 : row.confidence === "medium" ? 8 : 2
    })),
    capitalBudget,
    {
      kappa: portfolioRules.kellyFraction,
      maxItemExposure: portfolioRules.maxItemExposure,
      dailyBudget: portfolioRules.dailyBudget,
      minSamplesForKelly: portfolioRules.minKellySamples
    }
  );
  // Same production plan as /recipes: one builder, so the dashboard and the
  // full page can never price a recipe against different inputs.
  const production = buildProductionPlan(signals, recipeRows.map(dbRecipeToLp));
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
          <p className="font-mono text-xs text-terminal-muted">
            {scope ? `${scope.realm} · ${scope.faction}` : "未导入市场"} · 无限服拍卖行情报与地精驾驶舱 · {phaseLabels[phase]}
          </p>
        </div>
        <div className="flex items-center gap-3 font-mono text-xs text-terminal-muted">
          <span className={freshness.stale ? "flex items-center gap-1 text-terminal-red" : "flex items-center gap-1 text-terminal-green"}>
            <RadioTower size={14} /> 数据更新于 {freshness.label}
          </span>
          <span className="flex items-center gap-1"><Bell size={14} /> 预警就绪</span>
          <Link href="/recipes" className="text-terminal-muted hover:text-terminal-amber">制造</Link>
          <span className="max-w-[360px] truncate text-terminal-muted" title={phaseDescription(phase)}>{phaseDescription(phase)}</span>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          <Panel>
            <PanelHeader title="下一步行动" action={<span className="font-mono text-xs text-terminal-muted">共享决策核心 · 条件策略</span>} />
            <div className="space-y-2 p-3 font-mono text-xs">
              {evaluation.actions.length === 0 && (
                <div className="text-terminal-muted">当前没有通过门槛的行动；先扫描，或等待阶段变化。</div>
              )}
              {evaluation.actions.slice(0, 8).map((action) => (
                <div key={`${action.kind}-${action.itemId}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-terminal-border/60 pb-1 last:border-0">
                  <Link href={`/items/${action.itemId}`} className="text-slate-100 hover:text-terminal-amber">
                    <span className={action.kind === "buy" ? "text-terminal-green" : "text-terminal-amber"}>
                      {action.kind === "buy" ? "买入" : "卖出"}
                    </span>
                    {" "}{("name" in action && action.name) || `#${action.itemId}`}
                  </Link>
                  {action.kind === "buy" ? (
                    <span className="flex items-center gap-3 text-terminal-muted">
                      <span>{action.qty} 件</span>
                      <span>上限 <Coins copper={action.maxUnitPrice} /></span>
                      <span>净利 <Coins copper={action.expectedNet} /></span>
                      <span>成交率 {(action.fillProb * 100).toFixed(0)}%</span>
                      {action.stop && <span className="text-terminal-amber">高于 <Coins copper={action.stop.ifPriceAbove} /> 放弃</span>}
                      <span className="text-slate-400">{action.reason}</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-3 text-terminal-muted">
                      <span>{action.qty} 件 @ <Coins copper={action.price} /></span>
                      <span>售出净利 <Coins copper={action.netIfSold} /></span>
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="可执行机会" action={<span className="font-mono text-xs text-terminal-green">NPC必赚 + 最低价 vs 建议卖价</span>} />
            <div className="space-y-2 p-3 font-mono text-xs">
              {deals.length === 0 && (
                <div className="text-terminal-muted">
                  {signals.length === 0 ? "暂无市场数据。进游戏 /wahscan 扫描。" : `当前没有满足${phaseLabels[phase]}门槛的可执行机会。`}
                </div>
              )}
              {deals.map((deal) => (
                <div key={deal.itemId} className="flex items-center justify-between gap-2">
                  <Link href={`/items/${deal.itemId}`} className={`inline-flex items-center gap-2 ${qualityColorClass(qualityName(deal.quality))}`}>
                    <ItemIcon itemId={deal.itemId} size={16} />
                    {deal.name}
                    {deal.vendor
                      ? <span className="text-terminal-amber">NPC必赚 +<Coins copper={deal.netProfit} /></span>
                      : <>
                          <span className="text-[10px] text-terminal-muted">{deal.marketType === "commodity" ? "商品" : "物品"}</span>
                          <span className="text-terminal-green">+{deal.spreadPercent.toFixed(0)}%</span>
                        </>}
                  </Link>
                  <span className="flex items-center gap-3">
                    <Coins copper={deal.minPrice} />
                    <span className="text-terminal-muted">{deal.vendor ? "NPC价" : "建议卖价"} <Coins copper={deal.sellP} /></span>
                    <span className="text-terminal-muted">净利 <Coins copper={deal.netProfit} /></span>
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
            <PanelHeader title="仓位建议" action={<span className="font-mono text-xs text-terminal-muted">分数凯利 · 预算 {capitalBudget / 10000}g</span>} />
            <div className="space-y-2 p-3 font-mono text-xs">
              {sizing.length === 0 && <div className="text-terminal-muted">当前没有通过风险预算的行动。</div>}
              {sizing.map((row) => (
                <div key={row.itemId} className="flex items-center justify-between gap-2">
                  <Link href={`/items/${row.itemId}`} className="text-slate-100 hover:text-terminal-amber">{row.name}</Link>
                  <span className="flex items-center gap-3 text-terminal-muted">
                    <span>{row.qty} 件</span>
                    <span>占用 <Coins copper={row.budget} /></span>
                    <span className={row.expectedNet >= 0 ? "text-terminal-green" : "text-terminal-red"}>净利 <Coins copper={row.expectedNet} /></span>
                    <span>{row.exploratory ? "探索" : row.cappedBy === "item-exposure" ? "敞口上限" : row.cappedBy === "daily-budget" ? "日预算" : "凯利"}</span>
                  </span>
                </div>
              ))}
            </div>
          </Panel>
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
                    <Coins copper={signal.sellPrice} />
                    <span title="相对上次扫描的建议卖价" className={signal.changePercent >= 0 ? "text-terminal-red" : "text-terminal-green"}>{formatPercent(signal.changePercent)}</span>
                  </span>
                </div>
              ))}
            </div>
          </Panel>
          <Panel>
            <PanelHeader
              title="制造利润"
              action={<Link href="/recipes" className="font-mono text-xs text-terminal-muted hover:text-terminal-amber">完整计划 →</Link>}
            />
            <div className="space-y-2 p-3 font-mono text-xs">
              {recipeRows.length === 0 && (
                <div className="text-terminal-muted">
                  配方表尚未导入。运行 <span className="text-terminal-amber">npm run recipes:import</span>。
                </div>
              )}
              {recipeRows.length > 0 && production.solution.rows.length === 0 && (
                <div className="text-terminal-muted">当前价格与产能下没有正利润的配方</div>
              )}
              {production.solution.rows.slice(0, 8).map((row) => (
                <div key={row.recipe.id} className="flex items-center justify-between gap-2">
                  <span className="text-slate-100">{row.recipe.name}<span className="ml-1 text-[10px] text-terminal-muted">{row.recipe.profession}</span></span>
                  <span className="flex items-center gap-3">
                    <span className="text-terminal-muted">{row.volume} 次</span>
                    <span className={row.unitProfit >= 0 ? "text-terminal-green" : "text-terminal-red"}><Coins copper={row.totalProfit} /></span>
                    <span className={row.marginPercent >= 0 ? "text-terminal-green" : "text-terminal-red"}>{row.marginPercent.toFixed(0)}%</span>
                  </span>
                </div>
              ))}
              {production.solution.excluded > 0 && (
                <div className="border-t border-terminal-border pt-2 text-[10px] text-terminal-muted">
                  另有 {production.solution.excluded} 个配方因缺少价格数据未计算
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
