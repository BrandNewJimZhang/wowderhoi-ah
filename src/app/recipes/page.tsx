import Link from "next/link";

import { Hammer } from "lucide-react";
import { getMarketSignals } from "@/lib/market-signals";
import { phaseLabels } from "@/lib/phase";
import { buildProductionPlan } from "@/lib/production-plan";
import { recipeToLp } from "@/lib/recipes";
import { getRecipes } from "@/lib/repositories";
import { Coins } from "@/components/coins";
import { Panel, PanelHeader } from "@/components/ui/panel";

export const dynamic = "force-dynamic";

export default async function RecipesPage() {
  const [{ signals, phase, scope }, recipeRows] = await Promise.all([getMarketSignals(), getRecipes()]);
  const recipes = recipeRows.map(recipeToLp);
  const { solution, budget } = buildProductionPlan(signals, recipes, scope?.cash ?? null);

  return (
    <main className="terminal-grid min-h-screen bg-terminal-bg p-3 text-slate-200">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border border-terminal-border bg-terminal-panel px-4 py-3">
        <div>
          <div className="font-mono text-xs uppercase text-terminal-muted">生产网络</div>
          <h1 className="flex items-center gap-2 font-mono text-lg font-semibold text-terminal-amber">
            <Hammer size={18} /> 制造机会
          </h1>
          <p className="font-mono text-xs text-terminal-muted">
            {phaseLabels[phase]} · 预算 <Coins copper={budget} /> · {recipes.length} 条配方
          </p>
        </div>
        <div className="flex gap-3 font-mono text-xs">
          <Link href="/" className="text-terminal-muted hover:text-terminal-amber">驾驶舱</Link>
          <Link href="/portfolio" className="text-terminal-muted hover:text-terminal-amber">组合</Link>
          <Link href="/review" className="text-terminal-muted hover:text-terminal-amber">复盘</Link>
        </div>
      </div>

      {recipeRows.length === 0 && (
        <Panel>
          <div className="p-6 font-mono text-xs text-terminal-muted">
            配方表尚未导入。运行 <span className="text-terminal-amber">npm run recipes:import</span> 把
            data/recipes.forever.json 投影到数据库。
          </div>
        </Panel>
      )}

      {recipeRows.length > 0 && (
        <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
          <Panel>
            <PanelHeader
              title="按影子价格排序的制造计划"
              action={
                <span className="font-mono text-xs text-terminal-muted">
                  {solution.method === "lp" ? "线性规划 · 向下取整" : "贪心回退"} · 候选 {solution.candidates} · 缺价{" "}
                  {solution.excluded}
                </span>
              }
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse font-mono text-xs">
                <thead className="bg-terminal-panel2 text-[10px] uppercase text-terminal-muted">
                  <tr>
                    <th className="border-b border-terminal-border px-3 py-2 text-left">配方</th>
                    <th className="border-b border-terminal-border px-3 py-2 text-left">专业</th>
                    <th className="border-b border-terminal-border px-3 py-2 text-right">成本</th>
                    <th className="border-b border-terminal-border px-3 py-2 text-right">收入</th>
                    <th className="border-b border-terminal-border px-3 py-2 text-right">单件净利</th>
                    <th className="border-b border-terminal-border px-3 py-2 text-right">毛利率</th>
                    <th className="border-b border-terminal-border px-3 py-2 text-right">次数</th>
                    <th className="border-b border-terminal-border px-3 py-2 text-right">总净利</th>
                  </tr>
                </thead>
                <tbody>
                  {solution.rows.slice(0, 40).map((row) => (
                    <tr key={row.recipe.id} className="border-b border-terminal-border/70">
                      <td className="px-3 py-2 text-left text-slate-100">{row.recipe.name}</td>
                      <td className="px-3 py-2 text-left text-terminal-muted">{row.recipe.profession}</td>
                      <td className="px-3 py-2 text-right"><Coins copper={row.unitCost} /></td>
                      <td className="px-3 py-2 text-right"><Coins copper={row.unitRevenue} /></td>
                      <td className={row.unitProfit >= 0 ? "px-3 py-2 text-right text-terminal-green" : "px-3 py-2 text-right text-terminal-red"}>
                        <Coins copper={row.unitProfit} />
                      </td>
                      <td className="px-3 py-2 text-right text-slate-300">
                        {Number.isFinite(row.marginPercent) ? `${row.marginPercent.toFixed(0)}%` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-300">{row.volume}</td>
                      <td className="px-3 py-2 text-right text-terminal-green"><Coins copper={row.totalProfit} /></td>
                    </tr>
                  ))}
                  {solution.rows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-3 py-4 text-terminal-muted">
                        当前价格、产能与预算下没有正利润的配方；等扫描覆盖材料与成品后再看。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
          <div className="space-y-3">
            <Panel>
              <PanelHeader title="影子价格" action={<span className="font-mono text-xs text-terminal-muted">每多一个产能单位值多少</span>} />
              <div className="space-y-2 p-3 font-mono text-xs">
                {Object.entries(solution.shadowPrices)
                  .sort((left, right) => right[1] - left[1])
                  .map(([name, value]) => (
                    <div key={name} className="flex items-center justify-between gap-2">
                      <span className="text-terminal-muted">
                        {name.replace("profession:", "").replace("material:", "材料 #").replace("budget", "预算")}
                      </span>
                      <span className={value > 0 ? "text-terminal-green" : "text-slate-400"}>
                        <Coins copper={value} />
                      </span>
                    </div>
                  ))}
                {Object.keys(solution.shadowPrices).length === 0 && (
                  <div className="text-terminal-muted">没有绑定的产能约束</div>
                )}
              </div>
            </Panel>
            <Panel>
              <PanelHeader title="口径" />
              <div className="space-y-2 p-3 font-mono text-[11px] text-terminal-muted">
                <p>成本 = 材料按当前建议卖价（没有则 NPC 价）；收入 = 成品建议卖价，扣 5% 手续费。</p>
                <p>约束 = 每专业每日制造次数、材料在售量、预算。LP 解向下取整，报告的净利按整数计划重算。</p>
                <p>配方来自「无限图鉴 wuxianwow.com」的 1.60 客户端导出；产能是本终端配置，不是客户端事实。</p>
              </div>
            </Panel>
          </div>
        </div>
      )}
    </main>
  );
}
