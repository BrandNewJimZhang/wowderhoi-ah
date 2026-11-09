import Link from "next/link";
import { statSync } from "node:fs";
import { join } from "node:path";
import { getMarketContext } from "@/lib/market-read";
import {
  getCatalogueStats,
  getGenerationCount,
  getImportRuns,
  getReconciliationStats,
  getSeriesStats
} from "@/lib/repositories";
import { describeFreshness, scanGapHint, staleScanHint } from "@/lib/freshness";
import { seriesSpanDays } from "@/lib/item-series";
import { phaseLabels } from "@/lib/phase";
import {
  CALIBRATION_GENERATIONS_KEPT,
  DECISION_RETENTION_DAYS,
  GENERATIONS_KEPT,
  IMPORT_RUN_RETENTION_DAYS
} from "@/lib/retention";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { AppShell } from "@/components/app-shell";
import { FreshnessLabel } from "@/components/freshness-label";

export const dynamic = "force-dynamic";

function databaseSize(): string | null {
  const url = process.env.DATABASE_URL ?? "";
  const file = url.replace(/^file:/, "");
  if (!file) return null;
  const path = /^([A-Za-z]:[\\/]|\/)/.test(file) ? file : join(process.cwd(), "prisma", file);
  try {
    return `${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`;
  } catch {
    return null;
  }
}

export default async function HealthPage() {
  const context = await getMarketContext();
  const scope = context.scope;
  const [series, catalogue, generationCount, runs, reconciliation] = scope
    ? await Promise.all([
        getSeriesStats(scope.id),
        getCatalogueStats(),
        getGenerationCount(scope.id),
        getImportRuns(scope.id, 20),
        getReconciliationStats(scope)
      ])
    : [
        { items: 0, points: 0, firstAt: null, lastAt: null },
        { total: 0, catalogue: 0, scanOwned: 0, placeholders: 0, withIcon: 0, build: null },
        0,
        [],
        { unknown: 0, missing: 0, holdings: 0, unobservedLocations: 0, planRevision: null }
      ];
  const freshness = describeFreshness(context.latestScanAt, new Date());
  const latestRun = runs[0];
  const seriesDays = seriesSpanDays(series.firstAt, series.lastAt);
  const gapHint = scanGapHint(context.gapMinutes);
  const database = databaseSize();

  return (
    <AppShell active="/health" revision={context.revision} nextRefreshInMs={context.nextRefreshInMs}>
      <main className="terminal-grid min-h-screen bg-terminal-bg p-3 text-slate-200">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-terminal-border bg-terminal-panel px-4 py-3">
        <div>
          <div className="font-mono text-xs uppercase text-terminal-muted">摄取与数据健康</div>
          <h1 className="font-mono text-lg font-semibold text-terminal-amber">数据健康</h1>
          <p className="font-mono text-xs text-terminal-muted">
            {scope ? `${scope.realm} · ${scope.faction} · ${scope.character || "未知角色"}` : "未导入市场"}
            {" · "}{phaseLabels[context.phase]} · 数据更新于 <FreshnessLabel at={context.latestScanAt?.getTime() ?? null} initialLabel={freshness.label} initialStale={freshness.stale} />
            {database ? ` · 数据库 ${database}` : ""}
          </p>
        </div>
        <div className="flex gap-3 font-mono text-xs">
          <Link href="/" className="text-terminal-muted hover:text-terminal-amber">驾驶舱</Link>
          <Link href="/market" className="text-terminal-muted hover:text-terminal-amber">市场</Link>
          <Link href="/portfolio" className="text-terminal-muted hover:text-terminal-amber">组合</Link>
          <Link href="/review" className="text-terminal-muted hover:text-terminal-amber">复盘</Link>
        </div>
      </div>

      {(freshness.stale || gapHint) && (
        <div className="mb-3 border border-terminal-red/60 bg-terminal-panel px-4 py-3 font-mono text-xs text-terminal-red">
          {freshness.stale ? staleScanHint() : ""}
          {gapHint ? ` ${gapHint}` : ""}
        </div>
      )}

      <div className="mb-3 grid gap-3 font-mono text-xs sm:grid-cols-2 xl:grid-cols-5">
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">物品种类 / 生成代际</div>
          <div className="mt-1 text-lg text-slate-100">{context.signalCount} / {generationCount}</div>
        </div>
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">序列覆盖</div>
          <div className="mt-1 text-lg text-slate-100">{series.items.toLocaleString()} 种 · {series.points.toLocaleString()} 点</div>
          <div className="mt-1 text-[10px] text-terminal-muted">{seriesDays} 天</div>
        </div>
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">目录覆盖</div>
          <div className="mt-1 text-lg text-slate-100">{catalogue.catalogue.toLocaleString()} / {catalogue.total.toLocaleString()}</div>
          <div className="mt-1 text-[10px] text-terminal-muted">占位 {catalogue.placeholders} · 目录外 {catalogue.scanOwned} · 图标 {catalogue.withIcon.toLocaleString()}</div>
        </div>
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">最近导入 / Journal 错误</div>
          <div className="mt-1 text-lg text-slate-100">{latestRun ? latestRun.status : "—"} / {latestRun?.journalErrors ?? 0}</div>
          <div className="mt-1 text-[10px] text-terminal-muted">{latestRun ? `${latestRun.durationMs} ms · ${latestRun.source}` : "还没有导入记录"}</div>
        </div>
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">对账 / 当前计划</div>
          <div className="mt-1 text-lg text-slate-100">
            {reconciliation.unknown} / {reconciliation.missing}
          </div>
          <div className="mt-1 text-[10px] text-terminal-muted">
            {reconciliation.holdings} 条持仓 · {reconciliation.unobservedLocations} 个未观测位置
            {reconciliation.planRevision ? ` · 计划 ${reconciliation.planRevision}` : " · 尚无计划"}
          </div>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
        <Panel>
          <PanelHeader title="最近 20 次导入" action={<span className="font-mono text-xs text-terminal-muted">状态 · 扫描 · 序列点 · quote · 账本</span>} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse font-mono text-xs">
              <thead className="bg-terminal-panel2 text-[10px] uppercase text-terminal-muted">
                <tr>
                  <th className="border-b border-terminal-border px-3 py-2 text-left">接收时间</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-left">扫描</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-left">来源</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-right">物品</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-right">序列点</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-right">quote</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-right">事件/错误</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-right">耗时</th>
                  <th className="border-b border-terminal-border px-3 py-2 text-left">状态</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-terminal-border/70">
                    <td className="px-3 py-2 text-terminal-muted">{run.receivedAt.toISOString().slice(5, 16).replace("T", " ")}</td>
                    <td className="px-3 py-2 text-slate-200">{run.scannedAt.toISOString().slice(5, 16).replace("T", " ")}</td>
                    <td className="px-3 py-2 text-terminal-muted">{run.source}</td>
                    <td className="px-3 py-2 text-right text-slate-300">{run.scanItems}</td>
                    <td className="px-3 py-2 text-right text-slate-300">{run.seriesPoints}</td>
                    <td className="px-3 py-2 text-right text-slate-300">{run.quotes}</td>
                    <td className="px-3 py-2 text-right text-slate-300">{run.journalEvents} / {run.journalErrors}</td>
                    <td className="px-3 py-2 text-right text-slate-300">{run.durationMs} ms</td>
                    <td className={`px-3 py-2 ${run.status === "ok" ? "text-terminal-green" : run.status === "error" ? "text-terminal-red" : "text-terminal-amber"}`}>
                      {run.status}{run.error ? ` · ${run.error}` : ""}
                    </td>
                  </tr>
                ))}
                {runs.length === 0 && (
                  <tr><td colSpan={9} className="px-3 py-4 text-terminal-muted">还没有导入记录。启动应用后，游戏内 /wahscan 会自动出现在这里。</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
        <div className="space-y-3">
          <Panel>
            <PanelHeader title="摄取方式" />
            <div className="space-y-2 p-3 font-mono text-[11px] text-terminal-muted">
              <p>打开任意页面时，如果 <span className="text-terminal-amber">AQT_SAVEDVARS_PATH</span> 指向插件存档，会自动开始监听并导入；无需另开进程。</p>
              <p>独立运行入口：<span className="text-terminal-amber">npm run addon:watch</span>。</p>
              <p>每次扫描生成一代不可变读模型；页面读取保留最近 {GENERATIONS_KEPT} 代，盘口保留最近 {CALIBRATION_GENERATIONS_KEPT} 代供校准，决策保留 {DECISION_RETENTION_DAYS} 天，导入记录保留 {IMPORT_RUN_RETENTION_DAYS} 天。</p>
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="数据来源" />
            <div className="space-y-2 p-3 font-mono text-[11px] text-terminal-muted">
              <p>物品静态事实：无限图鉴 wuxianwow.com，构建 {catalogue.build ?? "未导入"}。</p>
              <p>市场观测与历史序列：游戏内 WoWderhoiAH 插件。</p>
              <p>账本：追加式 Journal 事实重放；决策：游戏内发布的 Plan 导入后写入，扫描代际只保留当时的同口径估算。</p>
            </div>
          </Panel>
        </div>
      </div>
    </main>
    </AppShell>
  );
}
