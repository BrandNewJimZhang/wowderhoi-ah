import Link from "next/link";

import { ClipboardCheck } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getMarketSignals } from "@/lib/market-signals";
import { getPositions } from "@/lib/repositories";
import { alphaDecay, evaluatePolicy } from "@/lib/off-policy";
import { designExperiment } from "@/lib/experiments";
import { phaseLabels } from "@/lib/phase";
import { Coins } from "@/components/coins";
import { Panel, PanelHeader } from "@/components/ui/panel";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const bundle = await getMarketSignals();
  const scope = bundle.scope;
  const marketWhere = scope ? { marketId: scope.id } : {};
  const [trades, decisions, positions] = await Promise.all([
    prisma.trade.findMany({ where: marketWhere, orderBy: { realizedAt: "desc" }, take: 100 }),
    prisma.decision.findMany({ where: marketWhere, orderBy: { at: "desc" }, take: 30 }),
    getPositions(scope)
  ]);
  const { signals, phase } = bundle;
  const realizedTrades = trades.map((trade) => ({
    itemId: trade.itemId,
    pnl: trade.pnl,
    realizedAt: trade.realizedAt,
    inferred: trade.inferred
  }));
  const decay = alphaDecay(realizedTrades);
  const loggedDecisions = decisions.map((decision) => ({
    id: decision.id,
    itemId: decision.itemId,
    kind: decision.kind,
    at: decision.at
  }));
  const policyEstimate = evaluatePolicy(loggedDecisions, realizedTrades, () => true);
  const firstPosition = Object.entries(positions)[0];
  const experimentSignal = firstPosition
    ? signals.find((signal) => signal.itemId === Number(firstPosition[0]))
    : signals[0];
  const experiment = experimentSignal
    ? designExperiment({
        itemId: experimentSignal.itemId,
        sellP: experimentSignal.sellPrice,
        inventory: Math.max(3, firstPosition ? firstPosition[1].qty : 3)
      })
    : null;
  const nameById = new Map(signals.map((signal) => [signal.itemId, signal.name]));
  const realized = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const inferred = trades.filter((trade) => trade.inferred).length;
  const byChannel = new Map<string, { count: number; pnl: number }>();
  for (const trade of trades) {
    const bucket = byChannel.get(trade.channel) ?? { count: 0, pnl: 0 };
    bucket.count += 1;
    bucket.pnl += trade.pnl;
    byChannel.set(trade.channel, bucket);
  }

  return (
    <main className="terminal-grid min-h-screen bg-terminal-bg p-3 text-slate-200">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-terminal-border bg-terminal-panel px-4 py-3">
        <div>
          <div className="font-mono text-xs uppercase text-terminal-muted">复盘与校准</div>
          <h1 className="flex items-center gap-2 font-mono text-lg font-semibold text-terminal-amber"><ClipboardCheck size={18} /> 决策 vs 结果</h1>
          <p className="font-mono text-xs text-terminal-muted">{phaseLabels[phase]} · 只用真实成交校准，不用公共挂单分布假装利润</p>
        </div>
        <div className="flex gap-3 font-mono text-xs">
          <Link href="/" className="text-terminal-muted hover:text-terminal-amber">驾驶舱</Link>
          <Link href="/portfolio" className="text-terminal-muted hover:text-terminal-amber">组合</Link>
          <Link href="/recipes" className="text-terminal-muted hover:text-terminal-amber">制造</Link>
        </div>
      </div>

      <div className="mb-3 grid gap-3 font-mono text-xs sm:grid-cols-2 xl:grid-cols-4">
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">窗口内已实现</div>
          <div className={`mt-1 text-lg ${realized >= 0 ? "text-terminal-green" : "text-terminal-red"}`}><Coins copper={realized} /></div>
        </div>
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">成交笔数</div>
          <div className="mt-1 text-lg text-slate-100">{trades.length}</div>
        </div>
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">胜率</div>
          <div className="mt-1 text-lg text-slate-100">{trades.length > 0 ? `${((wins / trades.length) * 100).toFixed(0)}%` : "—"}</div>
        </div>
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">推断成交占比</div>
          <div className="mt-1 text-lg text-slate-100">{trades.length > 0 ? `${((inferred / trades.length) * 100).toFixed(0)}%` : "—"}</div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-4 border border-terminal-border bg-terminal-panel px-3 py-2 font-mono text-[11px] text-terminal-muted">
        <span>决策匹配：{policyEstimate.matched} / {policyEstimate.decisions}（覆盖率 {(policyEstimate.coverage * 100).toFixed(0)}%）</span>
        <span>匹配后平均净利 <Coins copper={policyEstimate.estimate} /></span>
        <span>有效样本 {policyEstimate.effectiveSampleSize.toFixed(1)}</span>
        <span className="text-terminal-amber">描述性匹配，不是因果效应；要估计策略效果需要记录倾向并做探索。</span>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
        <Panel>
          <PanelHeader title="按渠道" action={<span className="font-mono text-xs text-terminal-muted">推断成交单独标注</span>} />
          <div className="space-y-2 p-3 font-mono text-xs">
            {Array.from(byChannel.entries()).map(([channel, bucket]) => (
              <div key={channel} className="flex items-center justify-between gap-2">
                <span className="text-slate-200">{channel === "auction" ? "拍卖行" : channel === "vendor" ? "卖店" : channel}</span>
                <span className="flex items-center gap-3">
                  <span className="text-terminal-muted">{bucket.count} 笔</span>
                  <span className={bucket.pnl >= 0 ? "text-terminal-green" : "text-terminal-red"}><Coins copper={bucket.pnl} /></span>
                </span>
              </div>
            ))}
            {byChannel.size === 0 && <div className="text-terminal-muted">还没有可复盘的成交。</div>}
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
                  <span className="text-terminal-muted">{decision.at.toISOString().slice(5, 16).replace("T", " ")} · {phaseLabels[decision.phase as keyof typeof phaseLabels] ?? decision.phase}</span>
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
            <div className="p-3 font-mono text-xs text-terminal-muted">先扫描并导入一个市场，才能设计实验。</div>
          )}
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="校准纪律" />
        <div className="space-y-2 p-4 font-mono text-[11px] text-terminal-muted">
          <p>阈值只从自己的成交、撤单、流拍和实验里校准；公共挂单的消失是区间先验，不是成交量。</p>
          <p>推断成交按挂单价与 5% 手续费记账，并在所有界面标注「推断」；它不是可以直接当作真实成交的标签。</p>
          <p>当策略的命中率下降时，先检查参照是否失效（价差变窄、供给增速上升、被压价），再调整参数。</p>
        </div>
      </Panel>
    </main>
  );
}
