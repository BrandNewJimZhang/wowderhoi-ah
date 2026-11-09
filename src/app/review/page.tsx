import Link from "next/link";

import { ClipboardCheck } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getMarketBundle } from "@/lib/market-read";
import { getPositions } from "@/lib/repositories";
import { alphaDecay, evaluatePolicy } from "@/lib/off-policy";
import { designExperiment, experimentResults } from "@/lib/experiments";
import { bucketPredictions, decisionLogSince } from "@/lib/decision-calibration";
import { fillRules } from "@/lib/market-rules";
import { phaseLabels } from "@/lib/phase";
import { fillBasisLabel } from "@/lib/fill";
import { describeFreshness } from "@/lib/freshness";
import { summarizeTrades, tradeChannelLabel } from "@/lib/trade-summary";
import { Coins } from "@/components/coins";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { AppShell } from "@/components/app-shell";
import { FreshnessLabel } from "@/components/freshness-label";

export const dynamic = "force-dynamic";


export default async function ReviewPage() {
  const bundle = await getMarketBundle();
  const scope = bundle.scope;
  const marketWhere = scope ? { marketId: scope.id } : {};
  // The prediction table compares every decision made in the calibration
  // window; ordering by time and taking a handful of rows turned the sample
  // into the newest two or three scans.
  const calibrationSince = decisionLogSince(new Date());
  const [trades, decisions, calibrationTrades, positions] = await Promise.all([
    prisma.trade.findMany({ where: marketWhere, orderBy: { realizedAt: "desc" }, take: 100 }),
    prisma.decision.findMany({
      where: { ...marketWhere, at: { gte: calibrationSince } },
      orderBy: { at: "desc" },
      take: 2000
    }),
    // The outcome set is every sale inside the calibration window, not the
    // newest 100 rows the summary card shows: a busy commodity day would
    // otherwise drop the fills of older decisions. The policy estimate reads
    // the same rows, so coverage and calibration describe one sample.
    prisma.trade.findMany({
      where: { ...marketWhere, realizedAt: { gte: calibrationSince } },
      select: {
        itemId: true, pnl: true, realizedAt: true, inferred: true, channel: true,
        decisionId: true, listedAt: true, observedAt: true, censored: true
      }
    }),
    getPositions(scope)
  ]);
  const { signals, phase } = bundle;
  // Experiments are priced from the newest scan's sell front; the ledger
  // itself is not, so the age labels the quote-derived sections only.
  const freshness = describeFreshness(bundle.latestScanAt, new Date());
  // Calibration reads confirmed sales only. An inferred sale is a vanished
  // listing booked at its ask; it may be a cancellation, so it is displayed
  // but never treated as a clean label.
  const confirmedTrades = trades.filter((trade) => !trade.inferred);
  const summary = summarizeTrades(trades);
  const decayTrades = confirmedTrades.map((trade) => ({
    itemId: trade.itemId,
    pnl: trade.pnl,
    realizedAt: trade.realizedAt,
    inferred: false,
    decisionId: trade.decisionId
  }));
  const decay = alphaDecay(decayTrades);
  const loggedDecisions = decisions.map((decision) => ({
    id: decision.id,
    itemId: decision.itemId,
    kind: decision.kind,
    at: decision.at,
    decisionId: decision.decisionId
  }));
  const policyTrades = calibrationTrades
    .filter((trade) => !trade.inferred)
    .map((trade) => ({
      itemId: trade.itemId,
      pnl: trade.pnl,
      realizedAt: trade.realizedAt,
      inferred: false,
      decisionId: trade.decisionId
    }));
  const policyEstimate = evaluatePolicy(loggedDecisions, policyTrades, () => true);
  const adoptedCount = decisions.filter((decision) => decision.adoptedAt !== null).length;
  // Predicted fill chance vs confirmed sells, bucketed. A decision counts
  // as filled when a confirmed sale of the same item lands inside its
  // window; the player chooses what to act on, so this is descriptive.
  const calibration = bucketPredictions(
    decisions.map((decision) => ({
      itemId: decision.itemId,
      kind: decision.kind,
      at: decision.at,
      fillProb: decision.fillProb,
      fillBasis: decision.fillBasis,
      decisionId: decision.decisionId
    })),
    calibrationTrades
  );
  const linkedFills = calibration.reduce((sum, bucket) => sum + bucket.linked, 0);
  const windowFills = calibration.reduce((sum, bucket) => sum + bucket.window, 0);
  const censoredFills = calibration.reduce((sum, bucket) => sum + bucket.censoredMatches, 0);
  // Largest committed position, not whatever order the database returned:
  // the experiment section must name the same item on every render.
  const focusPosition = Object.entries(positions).sort((left, right) => right[1].cost - left[1].cost)[0];
  // Experiments are priced around the current sell front; a held item that
  // left the newest scan has no usable reference, so it cannot get a new
  // plan. Recovery still runs: it reads booked sales, not today's prices.
  const currentSignals = signals.filter((signal) => !signal.stale);
  const focusItemId = focusPosition ? Number(focusPosition[0]) : currentSignals[0]?.itemId ?? null;
  // An experiment level is a price to post at. A stale book no longer has a
  // current price, so the plan is withheld like every other price-sized
  // plan; the recovery table reads booked sales and stays available.
  const experimentSignal = !freshness.stale && focusItemId !== null
    ? currentSignals.find((signal) => signal.itemId === focusItemId)
    : undefined;
  const experiment = experimentSignal
    ? designExperiment({
        itemId: experimentSignal.itemId,
        sellP: experimentSignal.sellPrice,
        inventory: Math.max(3, focusPosition ? focusPosition[1].qty : 3)
      })
    : null;
  const experimentHint = signals.length === 0
    ? "先扫描并导入一个市场，才能设计实验。"
    : freshness.stale
      ? "行情已过期，等下一次扫描后再设计实验。"
      : "持仓物品未出现在最近一次扫描中，没有可用的当前卖价来设计实验。";
  const experimentRecovery = focusItemId !== null ? experimentResults(trades, focusItemId) : [];
  const nameById = new Map(signals.map((signal) => [signal.itemId, signal.name]));
  const byChannel = new Map<string, { count: number; pnl: number }>();
  for (const trade of confirmedTrades) {
    const bucket = byChannel.get(trade.channel) ?? { count: 0, pnl: 0 };
    bucket.count += 1;
    bucket.pnl += trade.pnl;
    byChannel.set(trade.channel, bucket);
  }

  return (
    <AppShell active="/review" revision={bundle.revision} nextRefreshInMs={bundle.nextRefreshInMs}>
      <main className="terminal-grid min-h-screen bg-terminal-bg p-3 text-slate-200">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-terminal-border bg-terminal-panel px-4 py-3">
        <div>
          <div className="font-mono text-xs uppercase text-terminal-muted">复盘与校准</div>
          <h1 className="flex items-center gap-2 font-mono text-lg font-semibold text-terminal-amber"><ClipboardCheck size={18} /> 决策 vs 结果</h1>
          <p className="font-mono text-xs text-terminal-muted">{phaseLabels[phase]} · 行情更新于 <FreshnessLabel at={bundle.latestScanAt?.getTime() ?? null} initialLabel={freshness.label} initialStale={freshness.stale} /> · 只用真实成交校准，不用公共挂单分布假装利润</p>
        </div>
        <div className="flex gap-3 font-mono text-xs">
          <Link href="/" className="text-terminal-muted hover:text-terminal-amber">驾驶舱</Link>
          <Link href="/portfolio" className="text-terminal-muted hover:text-terminal-amber">组合</Link>
          <Link href="/recipes" className="text-terminal-muted hover:text-terminal-amber">制造</Link>
        </div>
      </div>

      <div className="mb-3 grid gap-3 font-mono text-xs sm:grid-cols-2 xl:grid-cols-4">
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">最近 100 笔已实现（确认成交）</div>
          <div className={`mt-1 text-lg ${summary.confirmedRealized >= 0 ? "text-terminal-green" : "text-terminal-red"}`}><Coins copper={summary.confirmedRealized} /></div>
        </div>
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">成交笔数</div>
          <div className="mt-1 text-lg text-slate-100">{summary.confirmedCount} 确认 / {summary.inferredCount} 推断</div>
        </div>
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">胜率（确认成交）</div>
          <div className="mt-1 text-lg text-slate-100">
            {summary.confirmedCount > 0 ? `${((summary.confirmedWins / summary.confirmedCount) * 100).toFixed(0)}%` : "—"}
          </div>
        </div>
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">推断成交占比</div>
          <div className="mt-1 text-lg text-slate-100">
            {trades.length > 0 ? `${((summary.inferredCount / trades.length) * 100).toFixed(0)}%` : "—"}
          </div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-4 border border-terminal-border bg-terminal-panel px-3 py-2 font-mono text-[11px] text-terminal-muted">
        <span>决策匹配：{policyEstimate.matched} / {policyEstimate.decisions}（覆盖率 {(policyEstimate.coverage * 100).toFixed(0)}%）</span>
        <span>已采纳 {adoptedCount} 条 · 按 id 归因 {linkedFills} 笔 vs 按窗口 {windowFills} 笔 · 区间匹配 {censoredFills} 笔</span>
        <span>
          匹配后平均净利 {policyEstimate.matched > 0 ? <Coins copper={policyEstimate.estimate} /> : "—"}
        </span>
        <span>有效样本 {policyEstimate.effectiveSampleSize.toFixed(1)}</span>
        <span>推断 {summary.inferredCount} 笔 · <Coins copper={summary.inferredRealized} /> 未计入</span>
        <span className="text-terminal-amber">描述性匹配，不是因果效应；要估计策略效果需要记录倾向并做探索。</span>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
        <Panel>
          <PanelHeader title="按渠道" action={<span className="font-mono text-xs text-terminal-muted">仅确认成交</span>} />
          <div className="space-y-2 p-3 font-mono text-xs">
            {Array.from(byChannel.entries()).map(([channel, bucket]) => (
              <div key={channel} className="flex items-center justify-between gap-2">
                <span className="text-slate-200">{tradeChannelLabel(channel)}</span>
                <span className="flex items-center gap-3">
                  <span className="text-terminal-muted">{bucket.count} 笔</span>
                  <span className={bucket.pnl >= 0 ? "text-terminal-green" : "text-terminal-red"}><Coins copper={bucket.pnl} /></span>
                </span>
              </div>
            ))}
            {byChannel.size === 0 && <div className="text-terminal-muted">还没有可复盘的确认成交。</div>}
            {summary.inferredCount > 0 && (
              <div className="border-t border-terminal-border pt-2 text-terminal-amber">
                另有 {summary.inferredCount} 笔推断成交（<Coins copper={summary.inferredRealized} />），未计入渠道盈亏与校准。
              </div>
            )}
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="决策日志" action={<span className="font-mono text-xs text-terminal-muted">{decisions.length} 条</span>} />
          <div className="space-y-2 p-3 font-mono text-xs">
            {decisions.map((decision) => (
              <div key={decision.id} className="border-b border-terminal-border/60 pb-1 last:border-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-100">
                    <span className={decision.kind === "buy" ? "text-terminal-green" : "text-terminal-amber"}>{decision.kind === "buy" ? "买入" : "卖出"}</span>
                    {" "}{nameById.get(decision.itemId ?? 0) ?? `#${decision.itemId}`}
                  </span>
                  <span className="flex items-center gap-2 text-terminal-muted">
                    {decision.adoptedAt !== null && <span className="text-terminal-green">已采纳</span>}
                    {decision.at.toISOString().slice(5, 16).replace("T", " ")} · {phaseLabels[decision.phase as keyof typeof phaseLabels] ?? decision.phase}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-terminal-muted">
                  {decision.expectedNet !== null && <span>预期 <Coins copper={decision.expectedNet} /></span>}
                  {decision.fillProb !== null && (
                    <span>成交率 {(decision.fillProb * 100).toFixed(0)}%（{fillBasisLabel(decision.fillBasis)}）</span>
                  )}
                  {decision.allocQty !== null && decision.allocUnitPrice !== null && (
                    <span>{decision.allocQty} 件 @ <Coins copper={decision.allocUnitPrice} /></span>
                  )}
                </div>
                <div className="text-[11px] text-terminal-muted">{decision.reason}</div>
              </div>
            ))}
            {decisions.length === 0 && <div className="text-terminal-muted">决策日志在每次新扫描后写入；先导入一次扫描。</div>}
          </div>
        </Panel>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[1fr_1fr]">
        <Panel>
          <PanelHeader title="Alpha 衰减" action={<span className={decay.decaying ? "font-mono text-xs text-terminal-red" : "font-mono text-xs text-terminal-green"}>{decay.decaying ? "衰减" : "未触发"}</span>} />
          <div className="space-y-2 p-3 font-mono text-xs">
            {decay.buckets.map((bucket) => (
              <div key={bucket.start.toISOString()} className="flex items-center justify-between gap-2">
                <span className="text-terminal-muted">{bucket.start.toISOString().slice(5, 10)} → {bucket.end.toISOString().slice(5, 10)}</span>
                <span className="flex items-center gap-3">
                  <span className="text-terminal-muted">{bucket.count} 笔 · 胜率 {(bucket.winRate * 100).toFixed(0)}%</span>
                  <span className={bucket.pnl >= 0 ? "text-terminal-green" : "text-terminal-red"}><Coins copper={bucket.pnl} /></span>
                </span>
              </div>
            ))}
            {decay.buckets.length === 0 && <div className="text-terminal-muted">还没有足够的成交窗口。</div>}
            {decay.reason && <div className="text-terminal-amber">{decay.reason}</div>}
          </div>
        </Panel>
        <Panel>
          <PanelHeader title="实验设计" action={<span className="font-mono text-xs text-terminal-muted">小批量 · 多价位 · 记录成交时间</span>} />
          {experiment ? (
            <div className="space-y-2 p-3 font-mono text-xs">
              <div className="text-slate-100">{nameById.get(experiment.itemId) ?? `#${experiment.itemId}`} · 观察 {experiment.horizonHours} 小时</div>
              {experiment.levels.map((level) => (
                <div key={level.price} className="flex items-center justify-between gap-2">
                  <span className="text-terminal-muted">挂 <Coins copper={level.price} /> × {level.qty}</span>
                  <span className="text-terminal-muted">记录成交件数与成交时间</span>
                </div>
              ))}
              <div className="text-[11px] text-terminal-muted">{experiment.note}</div>
            </div>
          ) : (
            <div className="p-3 font-mono text-xs text-terminal-muted">{experimentHint}</div>
          )}
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="实验回收" action={<span className="font-mono text-xs text-terminal-muted">只看确认成交 · 按实际成交价分组 · 未成交挂单未持久化</span>} />
        <div className="space-y-2 p-3 font-mono text-xs">
          {experimentRecovery.length === 0 && (
            <div className="text-terminal-muted">该物品还没有确认成交；挂出小批量多价位后，开箱回收才会出现结果。</div>
          )}
          {experimentRecovery.map((level) => (
            <div key={level.price} className="flex items-center justify-between gap-2">
              <span className="text-terminal-muted">成交价 <Coins copper={level.price} /></span>
              <span className="flex items-center gap-3">
                <span className="text-terminal-green">{level.filled} 笔 · {level.units} 件</span>
                <span className="text-terminal-muted">中位成交 {level.medianHours !== null ? `${level.medianHours.toFixed(1)} 小时` : "—"}</span>
              </span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="预测校准" action={<span className="font-mono text-xs text-terminal-muted">预测成交率 vs 预测 {fillRules.horizonHours} 小时内确认拍卖成交</span>} />
        <div className="space-y-2 p-3 font-mono text-xs">
          {calibration.every((bucket) => bucket.decisions === 0) && (
            <div className="text-terminal-muted">还没有带成交率预测的买入决策；先在新版本下导入一次扫描。</div>
          )}
          {calibration.filter((bucket) => bucket.decisions > 0).map((bucket) => (
            <div key={bucket.label} className="flex items-center justify-between gap-2">
              <span className="text-terminal-muted">预测 {bucket.label}</span>
              <span className="flex items-center gap-3">
                <span className="text-slate-100">{bucket.decisions} 条决策 · 成交 {bucket.filled}</span>
                <span className={bucket.enoughSamples ? "text-terminal-amber" : "text-terminal-muted"}>
                  {/* The threshold lives in decision-calibration.ts; the
                      page must not carry a second copy of it. */}
                  {bucket.enoughSamples ? `实测成交率 ${(bucket.rate * 100).toFixed(0)}%` : "样本不足，不下结论"}
                </span>
              </span>
            </div>
          ))}
          <div className="text-[11px] text-terminal-muted">描述性匹配，不是因果：你只执行了其中一部分推荐。</div>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="校准纪律" />
        <div className="space-y-2 p-4 font-mono text-[11px] text-terminal-muted">
          <p>阈值只从自己的成交、撤单、流拍和实验里校准；公共挂单的消失是区间先验，不是成交量。</p>
          <p>推断成交按挂单价与 5% 手续费记账，并在所有界面标注「推断」；它不是可以直接当作真实成交的标签。</p>
          <p>当策略的命中率下降时，先检查参照是否失效（价差变窄、供给增速上升、被压价），再调整参数。</p>
        </div>
      </Panel>
    </main>
    </AppShell>
  );
}
