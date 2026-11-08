import Link from "next/link";
import { statSync } from "node:fs";
import { join } from "node:path";
import { getMarketBundle } from "@/lib/market-read";
import {
  getCatalogueStats,
  getGenerationCount,
  getImportRuns,
  getSeriesStats
} from "@/lib/repositories";
import { describeFreshness } from "@/lib/freshness";
import { phaseLabels } from "@/lib/phase";
import {
  CALIBRATION_GENERATIONS_KEPT,
  DECISION_RETENTION_DAYS,
  GENERATIONS_KEPT,
  IMPORT_RUN_RETENTION_DAYS
} from "@/lib/retention";
import { SCAN_INTERVAL_MINUTES } from "@/lib/market-rules";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { AppShell } from "@/components/app-shell";

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
  const bundle = await getMarketBundle();
  const scope = bundle.scope;
  const [series, catalogue, generationCount, runs] = scope
    ? await Promise.all([
        getSeriesStats(scope.id),
        getCatalogueStats(),
        getGenerationCount(scope.id),
        getImportRuns(scope.id, 20)
      ])
    : [{ items: 0, points: 0, firstAt: null, lastAt: null }, { total: 0, catalogue: 0, scanOwned: 0, placeholders: 0, withIcon: 0, build: null }, 0, []];
  const freshness = describeFreshness(bundle.latestScanAt, new Date());
  const latestRun = runs[0];
  const seriesDays = series.firstAt && series.lastAt
    ? Math.max(1, Math.round((series.lastAt.getTime() - series.firstAt.getTime()) / (24 * 60 * 60 * 1000)))
    : 0;
  const gapWarning = bundle.gapMinutes !== null && bundle.gapMinutes > 2 * SCAN_INTERVAL_MINUTES;

  return (
    <AppShell active="/health">
      <main className="terminal-grid min-h-screen bg-terminal-bg p-3 text-slate-200">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-terminal-border bg-terminal-panel px-4 py-3">
        <div>
          <div className="font-mono text-xs uppercase text-terminal-muted">摄取与数据健康</div>
          <h1 className="font-mono text-lg font-semibold text-terminal-amber">数据健康</h1>
          <p className="font-mono text-xs text-terminal-muted">
            {scope ? `${scope.realm} · ${scope.faction} · ${scope.character || "未知角色"}` : "未导入市场"}
            {" · "}{phaseLabels[bundle.phase]} · 数据更新于 {freshness.label}
            {databaseSize() ? ` · 数据库 ${databaseSize()}` : ""}
          </p>
        </div>
        <div className="flex gap-3 font-mono text-xs">
          <Link href="/" className="text-terminal-muted hover:text-terminal-amber">驾驶舱</Link>
          <Link href="/market" className="text-terminal-muted hover:text-terminal-amber">市场</Link>
          <Link href="/portfolio" className="text-terminal-muted hover:text-terminal-amber">组合</Link>
          <Link href="/review" className="text-terminal-muted hover:text-terminal-amber">复盘</Link>
        </div>
      </div>

      {(freshness.stale || gapWarning) && (
        <div className="mb-3 border border-terminal-red/60 bg-terminal-panel px-4 py-3 font-mono text-xs text-terminal-red">
          {freshness.stale ? `最新扫描已超过 ${SCAN_INTERVAL_MINUTES} 分钟；进游戏 /wahscan。` : ""}
          {gapWarning ? ` 扫描缺口 ${bundle.gapMinutes} 分钟，超过 2 个扫描间隔。` : ""}
        </div>
      )}

      <div className="mb-3 grid gap-3 font-mono text-xs sm:grid-cols-2 xl:grid-cols-4">
        <div className="border border-terminal-border bg-terminal-panel p-3">
          <div className="text-terminal-muted">物品种类 / 生成代际</div>
          <div className="mt-1 text-lg text-slate-100">{bundle.signals.length} / {generationCount}</div>
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
              <p>账本：插件 Journal 重放；决策：共享 Core.lua 在导入时求值。</p>
            </div>
          </Panel>
        </div>
      </div>
    </main>
    </AppShell>
  );
}
