import { AlertTriangle, Bell, CalendarClock, ClipboardList, RadioTower, Star } from "lucide-react";
import Link from "next/link";
import { alertMetricLabels, evaluateAlertRules, formatAlertValue, type AlertMetricKey } from "@/lib/alerts";
import { sellFrontByItem } from "@/lib/analytics";
import {
  getAlertRules,
  getPositions,
  getRecipes,
  getSeriesStats,
  getWatchedItemIds
} from "@/lib/repositories";
import { prisma } from "@/lib/prisma";
import { loadDemandEvents, upcomingDemandEvents } from "@/lib/events-calendar";
import { decisionLogSince, DECISION_LOG_WINDOW_HOURS } from "@/lib/decision-calibration";
import { buildProductionPlan } from "@/lib/production-plan";
import { recipeToLp } from "@/lib/recipes";
import { getMarketBundle } from "@/lib/market-read";
import { describeFreshness, scanGapHint, staleScanHint } from "@/lib/freshness";
import { seriesSpanDays } from "@/lib/item-series";
import { fillBasisLabels } from "@/lib/fill";
import { phaseDescription, phaseLabels } from "@/lib/phase";
import { resolveDeployableCopper } from "@/lib/config";
import { valuePositions } from "@/lib/position-valuation";
import { formatPercent } from "@/lib/utils";
import { qualityColorClass, qualityName as qualityNameByIndex } from "@/lib/quality";
import { Coins } from "@/components/coins";
import { ItemIcon } from "@/components/item-icon";
import { WatchStar } from "@/components/watch-star";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { AppShell } from "@/components/app-shell";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

const qualityName = (value: number | string | undefined) =>
  typeof value === "number" ? qualityNameByIndex(value) : value ?? "unknown";

export default async function Home() {
  const bundle = await getMarketBundle();
  const { scope, signals, latestScanAt, phase, evaluation } = bundle;
  const scopeId = scope?.id;
  const now = new Date();
  const [watchedIds, alertRules, recipeRows, positions, seriesStats, recentTrades, decisionCount] = await Promise.all([
    getWatchedItemIds(),
    getAlertRules(),
    getRecipes(),
    getPositions(scope),
    scopeId ? getSeriesStats(scopeId) : Promise.resolve({ items: 0, points: 0, firstAt: null, lastAt: null }),
    prisma.trade.findMany({
      where: { ...(scopeId ? { marketId: scopeId } : {}), realizedAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } },
      select: { pnl: true, inferred: true }
    }),
    // The readiness meter describes the sample the review can actually
    // calibrate: counting every decision ever written overstated it once
    // older decisions aged out of the review's window.
    prisma.decision.count({
      where: { ...(scopeId ? { marketId: scopeId } : {}), at: { gte: decisionLogSince(now) } }
    })
  ]);
  const upcomingEvents = upcomingDemandEvents(loadDemandEvents(), Math.floor(now.getTime() / 1000));
  const freshness = describeFreshness(latestScanAt, now);
  const gapHint = scanGapHint(bundle.gapMinutes);
  // Actions were sized under the generation's gates. Once the display phase
  // moves past them, applying the old plan would describe a different
  // market, so the list is withheld until the next scan.
  const actionsBlocked = freshness.stale || bundle.phaseMismatch;
  const watchedSignals = signals.filter((signal) => watchedIds.has(signal.itemId));
  const triggeredAlerts = evaluateAlertRules(alertRules, signals.filter((signal) => !signal.stale));
  const deals = evaluation.opportunities.slice(0, 12);
  const unfunded = evaluation.diagnostics.unfunded;
  const sizingExcluded = evaluation.diagnostics.excluded.sizing ?? 0;
  const emptyDealsMessage = signals.length === 0
    ? "暂无市场数据。进游戏 /wahscan 扫描。"
    : evaluation.rows.length === 0 && sizingExcluded > 0
      ? `本阶段门槛后有 ${sizingExcluded} 条机会被风险模型拒绝（成交率不足以覆盖价差），没有可执行交易。`
      : evaluation.rows.length === 0
        ? `当前没有满足${phaseLabels[phase]}门槛的可执行机会。`
        : `通过门槛 ${evaluation.rows.length} 条，均未获资金：钱包不足 ${unfunded.purse} 条、单物品敞口 ${unfunded.exposure} 条、盘口 ${unfunded.depth} 条${sizingExcluded > 0 ? `；另有 ${sizingExcluded} 条被风险模型拒绝` : ""}。`;
  const deployableCapital = resolveDeployableCopper(scope?.cash ?? null);
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
  const iconById = new Map(signals.map((signal) => [signal.itemId, signal.iconId]));
  const production = buildProductionPlan(signals, recipeRows.map(recipeToLp), scope?.cash ?? null);

  // Ledger summary: a position whose item left the newest scan is unpriced,
  // not worthless; the valuation helper keeps it out of the totals.
  const priceById = sellFrontByItem(signals);
  const nameById = new Map(signals.map((signal) => [signal.itemId, signal.name]));
  const valuation = valuePositions(positions, priceById, nameById);
  const confirmedWeek = recentTrades.filter((trade) => !trade.inferred);
  const weekRealized = confirmedWeek.reduce((sum, trade) => sum + trade.pnl, 0);
  const inferredWeek = recentTrades.length - confirmedWeek.length;

  // A move on a 4-copper junk item is noise in a dashboard: keep the
  // movers to books with a real price and enough listings to trade.
  const movers = signals.filter((signal) =>
    !signal.stale && signal.sellPrice >= 1000 && signal.quantity >= 20 && Number.isFinite(signal.changePercent)
  );
  const gainers = [...movers].sort((left, right) => right.changePercent - left.changePercent).slice(0, 5);
  const losers = [...movers].sort((left, right) => left.changePercent - right.changePercent).slice(0, 5);
  const seriesDays = seriesSpanDays(seriesStats.firstAt, seriesStats.lastAt);

  return (
    <AppShell active="/" revision={bundle.revision} nextRefreshInMs={bundle.nextRefreshInMs}>
      <main className="terminal-grid min-h-screen p-3 text-slate-200">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-terminal-border bg-terminal-panel px-4 py-3">
          <div>
            <h1 className="font-mono text-lg font-semibold uppercase text-terminal-amber">WoWderhoi 决策终端</h1>
            <p className="font-mono text-xs text-terminal-muted">
              {scope ? `${scope.realm} · ${scope.faction} · 角色 ${scope.character || "未知"}` : "未导入市场"} · {phaseLabels[phase]} · <span title={phaseDescription(phase)}>{phaseDescription(phase)}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-terminal-muted">
            <span className={freshness.stale ? "flex items-center gap-1 text-terminal-red" : "flex items-center gap-1 text-terminal-green"}>
              <RadioTower size={14} /> 数据更新于 {freshness.label}
            </span>
            <Link href="/market" className="text-terminal-muted hover:text-terminal-amber">市场行情 →</Link>
          </div>
        </div>

        {(actionsBlocked || gapHint) && (
          <div className="mb-3 flex flex-wrap items-center gap-3 border border-terminal-red/60 bg-terminal-panel px-4 py-3 font-mono text-xs text-terminal-red">
            <AlertTriangle size={15} />
            {freshness.stale && <span>{staleScanHint()}</span>}
            {bundle.phaseMismatch && <span>市场已从{phaseLabels[bundle.generationPhase]}推移到{phaseLabels[phase]}；行动清单需要重新扫描后再生成。</span>}
            {gapHint && <span>{gapHint}</span>}
          </div>
        )}

        <div className="mb-3 grid gap-3 font-mono text-xs sm:grid-cols-2 xl:grid-cols-4">
          <div className="border border-terminal-border bg-terminal-panel p-3">
            <div className="text-terminal-muted">现金（上次扫描）</div>
            <div className="mt-1 text-lg text-terminal-amber"><Coins copper={scope?.cash ?? 0} /></div>
            <div className="mt-1 text-[10px] text-terminal-muted">可动用 <Coins copper={deployableCapital} /></div>
          </div>
          <div className="border border-terminal-border bg-terminal-panel p-3">
            <div className="text-terminal-muted">持仓市值 / 成本</div>
            <div className="mt-1 text-lg"><Coins copper={valuation.pricedValue} /> <span className="text-xs text-terminal-muted">/ <Coins copper={valuation.pricedCost} /></span></div>
            <div className="mt-1 text-[10px] text-terminal-muted">{valuation.rows.length} 种，{valuation.unpricedCount} 种当前无报价</div>
          </div>
          <div className="border border-terminal-border bg-terminal-panel p-3">
            <div className="text-terminal-muted">持仓浮动</div>
            <div className={`mt-1 text-lg ${valuation.unrealized >= 0 ? "text-terminal-green" : "text-terminal-red"}`}><Coins copper={valuation.unrealized} /></div>
            <div className="mt-1 text-[10px] text-terminal-muted">只计有当前建议卖价的持仓</div>
          </div>
          <div className="border border-terminal-border bg-terminal-panel p-3">
            <div className="text-terminal-muted">7 日已实现（确认成交）</div>
            <div className={`mt-1 text-lg ${weekRealized >= 0 ? "text-terminal-green" : "text-terminal-red"}`}><Coins copper={weekRealized} /></div>
            <div className="mt-1 text-[10px] text-terminal-muted">{confirmedWeek.length} 确认 · {inferredWeek} 推断未计入</div>
          </div>
        </div>

        <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
          <div className="space-y-3">
            <Panel>
              <PanelHeader title="下一步行动" action={<span className="font-mono text-xs text-terminal-muted">共享决策核心 · 条件策略</span>} />
              <div className="space-y-2 p-3 font-mono text-xs">
                {actionsBlocked && <div className="text-terminal-muted">数据过期或阶段已推移，等下一次扫描后再给出行动。</div>}
                {!actionsBlocked && evaluation.actions.length === 0 && <div className="text-terminal-muted">{emptyDealsMessage}</div>}
                {!actionsBlocked && evaluation.actions.slice(0, 5).map((action) => (
                  <div key={`${action.kind}-${action.itemId}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-terminal-border/60 pb-1 last:border-0">
                    <Link href={`/items/${action.itemId}`} className="text-slate-100 hover:text-terminal-amber">
                      <span className={action.kind === "buy" ? "text-terminal-green" : "text-terminal-amber"}>
                        {action.kind === "buy" ? "买入" : "卖出"}
                      </span>
                      {" "}{("name" in action && action.name) || `#${action.itemId}`}
                    </Link>
                    {action.kind === "buy" ? (
                      <span className="flex flex-wrap items-center gap-3 text-terminal-muted">
                        <span>{action.qty} 件</span>
                        <span>上限 <Coins copper={action.maxUnitPrice} /></span>
                        <span>净利 <Coins copper={action.expectedNet} /></span>
                        <span>成交率 {(action.fillProb * 100).toFixed(0)}%</span>
                        {action.stop && <span className="text-terminal-amber">高于 <Coins copper={action.stop.ifPriceAbove} /> 放弃</span>}
                        <span className="text-slate-400">{action.reason}</span>
                      </span>
                    ) : (
                      <span className="flex flex-wrap items-center gap-3 text-terminal-muted">
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
                {actionsBlocked && <div className="text-terminal-muted">数据过期或阶段已推移，等下一次扫描后再给出机会。</div>}
                {!actionsBlocked && deals.length === 0 && <div className="text-terminal-muted">{emptyDealsMessage}</div>}
                {!actionsBlocked && deals.map((deal) => (
                  <div key={deal.itemId} className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`/items/${deal.itemId}`} className={`inline-flex items-center gap-2 ${qualityColorClass(qualityName(deal.quality))}`}>
                      <ItemIcon iconId={iconById.get(deal.itemId)} size={16} />
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
              <PanelHeader title="市场变动" action={<Link href="/market" className="font-mono text-xs text-terminal-muted hover:text-terminal-amber">全部行情 →</Link>} />
              <div className="grid gap-3 p-3 font-mono text-xs sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-[10px] uppercase text-terminal-muted">涨幅</div>
                  {gainers.map((signal) => (
                    <Link key={signal.itemId} href={`/items/${signal.itemId}`} className="flex items-center justify-between gap-2 border-b border-terminal-border/60 py-1 last:border-0 hover:text-terminal-amber">
                      <span className="truncate text-slate-200">{signal.name}</span>
                      <span className={signal.changePercent >= 0 ? "text-terminal-red" : "text-terminal-green"}>{formatPercent(signal.changePercent)}</span>
                    </Link>
                  ))}
                  {gainers.length === 0 && <div className="text-terminal-muted">暂无</div>}
                </div>
                <div>
                  <div className="mb-1 text-[10px] uppercase text-terminal-muted">跌幅</div>
                  {losers.map((signal) => (
                    <Link key={signal.itemId} href={`/items/${signal.itemId}`} className="flex items-center justify-between gap-2 border-b border-terminal-border/60 py-1 last:border-0 hover:text-terminal-amber">
                      <span className="truncate text-slate-200">{signal.name}</span>
                      <span className={signal.changePercent >= 0 ? "text-terminal-red" : "text-terminal-green"}>{formatPercent(signal.changePercent)}</span>
                    </Link>
                  ))}
                  {losers.length === 0 && <div className="text-terminal-muted">暂无</div>}
                </div>
              </div>
            </Panel>
          </div>

          <div className="space-y-3">
            <Panel>
              <PanelHeader title="预算内分配" action={<span className="font-mono text-xs text-terminal-muted">共享核心 · 分数凯利</span>} />
              <div className="space-y-2 p-3 font-mono text-xs">
                {actionsBlocked && <div className="text-terminal-muted">数据过期或阶段已推移，等下一次扫描后再给出分配。</div>}
                {!actionsBlocked && sizing.length === 0 && <div className="text-terminal-muted">当前没有获分配的机会。</div>}
                {!actionsBlocked && sizing.map((row) => (
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
              <PanelHeader title="数据就绪" action={<ClipboardList size={13} className="text-terminal-muted" />} />
              <div className="space-y-2 p-3 font-mono text-xs">
                {[
                  { label: "K 线（2 天）", have: seriesDays, need: 2, hint: "每天至少一次扫描" },
                  { label: "星期几季节性（7 天）", have: seriesDays, need: 7, hint: "跨过一整周" },
                  { label: "复盘校准（10 条决策）", have: decisionCount, need: 10, hint: `最近 ${DECISION_LOG_WINDOW_HOURS} 小时写入` }
                ].map((row) => {
                  const ratio = Math.min(1, row.have / row.need);
                  return (
                    <div key={row.label}>
                      <div className="flex items-center justify-between">
                        <span className="text-terminal-muted">{row.label}</span>
                        <span className={ratio >= 1 ? "text-terminal-green" : "text-slate-300"}>{row.have} / {row.need}</span>
                      </div>
                      <div className="mt-1 h-1 bg-terminal-panel2">
                        <div className={ratio >= 1 ? "h-1 bg-terminal-green" : "h-1 bg-terminal-amber"} style={{ width: `${ratio * 100}%` }} />
                      </div>
                      {ratio < 1 && <div className="mt-0.5 text-[10px] text-terminal-muted">{row.hint}</div>}
                    </div>
                  );
                })}
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

            {watchedSignals.length > 0 && (
              <Panel>
                <PanelHeader title="关注列表" action={<Star size={13} className="text-terminal-amber" />} />
                <div className="space-y-2 p-3 font-mono text-xs">
                  {watchedSignals.map((signal) => (
                    <div key={signal.itemId} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <WatchStar itemId={signal.itemId} watched />
                        <Link href={`/items/${signal.itemId}`} className={`inline-flex items-center gap-1 ${qualityColorClass(signal.quality)}`}><ItemIcon iconId={signal.iconId} size={16} />{signal.name}</Link>
                      </span>
                      <span className="flex items-center gap-3">
                        <Coins copper={signal.sellPrice} />
                        <span title="相对该物品上次有报价扫描的建议卖价" className={signal.changePercent >= 0 ? "text-terminal-red" : "text-terminal-green"}>{formatPercent(signal.changePercent)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>
            )}

            <Panel>
              <PanelHeader title="制造利润" action={<Link href="/recipes" className="font-mono text-xs text-terminal-muted hover:text-terminal-amber">完整计划 →</Link>} />
              <div className="space-y-2 p-3 font-mono text-xs">
                {actionsBlocked && <div className="text-terminal-muted">数据过期或阶段已推移，等下一次扫描后再给出制造计划。</div>}
                {!actionsBlocked && recipeRows.length === 0 && (
                  <div className="text-terminal-muted">配方表尚未导入。运行 <span className="text-terminal-amber">npm run recipes:import</span>。</div>
                )}
                {!actionsBlocked && recipeRows.length > 0 && production.solution.rows.length === 0 && (
                  <div className="text-terminal-muted">当前价格、产能与预算下没有正利润的配方</div>
                )}
                {!actionsBlocked && production.solution.rows.slice(0, 6).map((row) => (
                  <div key={row.recipe.id} className="flex items-center justify-between gap-2">
                    <span className="text-slate-100">{row.recipe.name}<span className="ml-1 text-[10px] text-terminal-muted">{row.recipe.profession}</span></span>
                    <span className="flex items-center gap-3">
                      <span className="text-terminal-muted">{row.volume} 次</span>
                      <span className={row.unitProfit >= 0 ? "text-terminal-green" : "text-terminal-red"}><Coins copper={row.totalProfit} /></span>
                      <span className={row.marginPercent >= 0 ? "text-terminal-green" : "text-terminal-red"}>{row.marginPercent.toFixed(0)}%</span>
                    </span>
                  </div>
                ))}
              </div>
            </Panel>

            {upcomingEvents.length > 0 && (
              <Panel>
                <PanelHeader title="版本日历" action={<CalendarClock size={13} className="text-terminal-muted" />} />
                <div className="space-y-2 p-3 font-mono text-xs">
                  {upcomingEvents.slice(0, 5).map((event) => (
                    <div key={`${event.name}-${event.startsAt}`} className="flex items-center justify-between gap-2">
                      <span className="text-slate-200">{event.name}</span>
                      <span className="text-terminal-muted">{new Date(event.startsAt * 1000).toISOString().slice(0, 10)}</span>
                    </div>
                  ))}
                </div>
              </Panel>
            )}
          </div>
        </div>
      </main>
    </AppShell>
  );
}
