// Market phase is derived from data age and market breadth, never from
// the calendar. A server restart, a late import or a paused scan would
// make dates lie; breadth and age are properties of the data itself.
import { phaseBoundaries, phaseHistory, type MarketPhase } from "@/lib/market-rules";

export function resolvePhase(ageHours: number, breadth: number): MarketPhase {
  const limits = phaseBoundaries;
  if (ageHours < limits.ignitionHours || breadth < limits.ignitionBreadth) return "ignition";
  if (ageHours < limits.waveHours || breadth < limits.waveBreadth) return "wave";
  if (ageHours < limits.settleHours || breadth < limits.settleBreadth) return "settle";
  return "steady";
}

export function phaseWindowHours(phase: MarketPhase): number {
  return phaseHistory[phase].windowHours;
}

export const phaseLabels: Record<MarketPhase, string> = {
  ignition: "点火期",
  wave: "洪流期",
  settle: "沉淀期",
  steady: "稳态"
};

export function phaseDescription(phase: MarketPhase): string {
  switch (phase) {
    case "ignition":
      return "供给近零，价格由首批卖家设定；用结构先验和小仓位实验，不依赖历史";
    case "wave":
      return "材料供给暴涨、价格坍塌；卖便利品，不接盘，盯供给增速";
    case "settle":
      return "第一波满级出现，需求转向团本消耗与附魔材料；低吸供给停止增长的材料";
    case "steady":
      return "正常薄/厚市场，价差收窄；用账本复盘，做套利、制造与做市";
  }
}
