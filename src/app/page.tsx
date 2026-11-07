import { Bell, CalendarClock, RadioTower, Star } from "lucide-react";
import { alertMetricLabels, evaluateAlertRules, formatAlertValue, type AlertMetricKey } from "@/lib/alerts";
import {
  getAlertRules,
  getRecipes,
  getWatchedItemIds
} from "@/lib/repositories";
import { loadDemandEvents, upcomingDemandEvents } from "@/lib/events-calendar";
import { buildProductionPlan } from "@/lib/production-plan";
import { recipeToLp } from "@/lib/recipes";
import { getMarketSignals } from "@/lib/market-signals";
import { describeFreshness } from "@/lib/freshness";
import { fillBasisLabels } from "@/lib/fill";
import { phaseDescription, phaseLabels } from "@/lib/phase";
import { QUALITY_NAMES } from "@/lib/addon-scan";
import { resolveBudgetCopper } from "@/lib/config";
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
  const [{ scope, signals, latestSnapshotAt, phase, evaluation }, watchedIds, alertRules, recipeRows] = await Promise.all([
    getMarketSignals(),
    getWatchedItemIds(),
    getAlertRules(),
    getRecipes()
  ]);
  const upcomingEvents = upcomingDemandEvents(loadDemandEvents(), Math.floor(new Date().getTime() / 1000));
  const freshness = describeFreshness(latestSnapshotAt, new Date());
  const watchedSignals = signals.filter((signal) => watchedIds.has(signal.itemId));
  // Alerts and the action list only see the newest scan's book: a price
  // from an item that is no longer listed must not page the trader.
  const triggeredAlerts = evaluateAlertRules(alertRules, signals.filter((signal) => !signal.stale));
  // The opportunity list is Core.lua's evaluation, the same decision core
  // the addon runs in game. It is not a second radar implementation. The
  // core publishes the funded layer; parsing `rows` for a zero quantity
  // here was a second copy of that rule and could drift from the radar.
  const deals = evaluation.opportunities.slice(0, 12);
  const unfunded = evaluation.diagnostics.unfunded;
  const sizingExcluded = evaluation.diagnostics.excluded.sizing ?? 0;
  // An empty list has three different answers: no data, nothing passed the
  // gates, or gate-passers the risk model refused. The core's diagnostics
  // are the only source for the third.
  const emptyDealsMessage = signals.length === 0
    ? "暂无市场数据。进游戏 /wahscan 扫描。"
    : evaluation.rows.length === 0 && sizingExcluded > 0
      ? `本阶段门槛后有 ${sizingExcluded} 条机会被风险模型拒绝（成交率不足以覆盖价差），没有可执行交易。`
      : evaluation.rows.length === 0
        ? `当前没有满足${phaseLabels[phase]}门槛的可执行机会。`
        : `通过门槛 ${evaluation.rows.length} 条，均未获资金：钱包不足 ${unfunded.purse} 条、单物品敞口 ${unfunded.exposure} 条、盘口 ${unfunded.depth} 条${sizingExcluded > 0 ? `；另有 ${sizingExcluded} 条被风险模型拒绝` : ""}。`;
  const capitalBudget = resolveBudgetCopper();
  // The planning budget is a cap, not a purse: never allocate more than the
  // cash the latest scan reported. Core.lua applies the same bound to its
  // spend, so the opportunity list and the position sizing share one base.
  // A scanned 0 is an empty purse, not an unknown balance: the core funds
  // nothing on it, so the label must not promise the planning budget.
  const deployableCapital = scope ? Math.min(capitalBudget, scope.cash) : capitalBudget;
  // The shared core already allocated one purse across the ranked rows;
  // the terminal renders that result instead of running a second sizing
  // implementation.
  const sizing = evaluation.opportunities
    .filter((row) => !row.vendor)
    .slice(0, 12)
    .map((row) => ({
      itemId: row.itemId,
      name: row.name,
      qty: row.allocQty,
      unitPrice: row.allocUnitPrice,
      budget: row.allocCost,
      expectedNet: row.allocNet,
      fillProb: row.fillProb,
      fillBasis: row.fillBasis,
      exploration: row.exploratory
    }));
  // Same production plan as /recipes: one builder, so the dashboard and the
  // full page can never price a recipe against different inputs.
  const production = buildProductionPlan(signals, recipeRows.map(recipeToLp), scope?.cash ?? null);
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
            {scope ? `${scope.realm} · ${scope.faction} · 角色 ${scope.character || "未知"}` : "未导入市场"} · 无限服拍卖行情报与地精驾驶舱 · {phaseLabels[phase]}
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
                <div className="text-terminal-muted">{emptyDealsMessage}</div>
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
                      <span>每分钟 <Coins copper={action.netPerMinute} /></span>
                      <span>成交率 {(action.fillProb * 100).toFixed(0)}%</span>
                      {action.stop && <span className="text-terminal-amber">高于 <Coins copper={action.stop.ifPriceAbove} /> 放弃</span>}
                      <span className="text-slate-400">{action.reason}</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-3 text-terminal-muted">
                      <span>{action.qty} 件 @ <Coins copper={action.price} /></span>
                      <span>售出净利 <Coins copper={action.expectedNet} /></span>
                      <span>每分钟 <Coins copper={action.netPerMinute} /></span>
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="可执行机会" action={<span className="font-mono text-xs text-terminal-green">NPC必赚 + 最低价 vs 建议卖价 · 分配后口径</span>} />
            <div className="space-y-2 p-3 font-mono text-xs">
              {deals.length === 0 && (
                <div className="text-terminal-muted">{emptyDealsMessage}</div>
              )}
              {deals.map((deal) => (
                <div key={deal.itemId} className="flex items-center justify-between gap-2">
                  <Link href={`/items/${deal.itemId}`} className={`inline-flex items-center gap-2 ${qualityColorClass(qualityName(deal.quality))}`}>
                    <ItemIcon itemId={deal.itemId} size={16} />
                    {deal.name}
                    {deal.vendor
                      ? <span className="text-terminal-amber">NPC必赚</span>
                      : <>
                          <span className="text-[10px] text-terminal-muted">{deal.marketType === "commodity" ? "商品" : "物品"}</span>
                          <span className="text-terminal-green">+{deal.spreadPercent.toFixed(0)}%</span>
                        </>}
                  </Link>
                  <span className="flex items-center gap-3">
                    <span className="text-terminal-muted">{deal.allocQty} 件 @ <Coins copper={deal.allocUnitPrice} /></span>
                    <span className="text-terminal-muted">{deal.vendor ? "NPC价" : "建议卖价"} <Coins copper={deal.sellP} /></span>
                    <span className="text-terminal-muted">净利 <Coins copper={deal.allocNet} /></span>
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
            <PanelHeader title="预算内分配" action={<span className="font-mono text-xs text-terminal-muted">共享核心 · 分数凯利 · 可动用 {deployableCapital / 10000}g</span>} />
            <div className="space-y-2 p-3 font-mono text-xs">
              {sizing.length === 0 && <div className="text-terminal-muted">当前没有获分配的机会。</div>}
              {sizing.map((row) => (
                <div key={row.itemId} className="flex items-center justify-between gap-2">
                  <Link href={`/items/${row.itemId}`} className="text-slate-100 hover:text-terminal-amber">{row.name}</Link>
                  <span className="flex items-center gap-3 text-terminal-muted">
                    <span>{row.qty} 件 @ <Coins copper={row.unitPrice} /></span>
                    <span>占用 <Coins copper={row.budget} /></span>
                    <span className={row.expectedNet >= 0 ? "text-terminal-green" : "text-terminal-red"}>净利 <Coins copper={row.expectedNet} /></span>
                    <span>成交率 {(row.fillProb * 100).toFixed(0)}%</span>
                    <span>{row.exploration ? "探索" : fillBasisLabels[row.fillBasis]}</span>
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
                    {alertMetricLabels[hit.rule.metric as AlertMetricKey] ?? hit.rule.metric}{" "}
                    {hit.rule.operator === "gt" ? ">" : "<"} {formatAlertValue(hit.rule.metric, hit.rule.threshold)}
                    （现 {formatAlertValue(hit.rule.metric, hit.actual)}）
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
                    {signal.stale && <span className="text-[10px] text-terminal-muted" title="最近一次扫描中已无在售挂单，价格是上次有货时的值">已下架</span>}
                    <span title="相对该物品上次有报价扫描的建议卖价" className={signal.changePercent >= 0 ? "text-terminal-red" : "text-terminal-green"}>{formatPercent(signal.changePercent)}</span>
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
                <div className="text-terminal-muted">当前价格、产能与预算下没有正利润的配方</div>
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
                <div key={`${event.name}-${event.startsAt}`} className="flex items-center justify-between gap-2">
                  <span className="text-slate-200">{event.name}</span>
                  <span className="text-terminal-muted">{new Date(event.startsAt * 1000).toISOString().slice(0, 10)}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </main>
  );
}
