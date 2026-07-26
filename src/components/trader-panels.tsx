"use client";

import { useState, useTransition } from "react";
import { createAlertRule, deleteAlertRule } from "@/app/actions";
import { alertMetricKeys, goldDenominatedMetrics } from "@/lib/alerts";
import { formatWowMoney } from "@/lib/wow-money";

type AlertRuleRow = { id: string; metric: string; operator: string; threshold: number; enabled: boolean };

const metricLabels: Record<string, string> = {
  price: "P10 市价",
  minPrice: "最低价",
  med7: "7日中位价",
  discountPercent: "折扣%",
  quantity: "在售量"
};

function thresholdLabel(rule: AlertRuleRow) {
  return goldDenominatedMetrics.has(rule.metric) ? formatWowMoney(rule.threshold) : String(rule.threshold);
}

export function AlertRulePanel({ itemId, rules }: { itemId: number; rules: AlertRuleRow[] }) {
  const [metric, setMetric] = useState<string>("minPrice");
  const [operator, setOperator] = useState("lt");
  const [threshold, setThreshold] = useState("");
  const [pending, startTransition] = useTransition();

  const isGold = goldDenominatedMetrics.has(metric);
  const inputClass = "border border-terminal-border bg-terminal-panel2 px-2 py-1 text-slate-100 focus:outline-none";
  return (
    <div className="space-y-2 p-3 font-mono text-xs">
      {rules.map((rule) => (
        <div key={rule.id} className="flex items-center justify-between gap-2">
          <span>
            {metricLabels[rule.metric] ?? rule.metric} {rule.operator === "gt" ? ">" : "<"} {thresholdLabel(rule)}
          </span>
          <button
            onClick={() => startTransition(() => deleteAlertRule(rule.id))}
            disabled={pending}
            className="text-terminal-red hover:text-red-300"
          >
            删除
          </button>
        </div>
      ))}
      {rules.length === 0 && <div className="text-terminal-muted">暂无预警规则</div>}
      <div className="flex flex-wrap items-center gap-2 border-t border-terminal-border pt-2">
        <select value={metric} onChange={(event) => setMetric(event.target.value)} className={inputClass}>
          {alertMetricKeys.map((key) => (
            <option key={key} value={key}>{metricLabels[key]}</option>
          ))}
        </select>
        <select value={operator} onChange={(event) => setOperator(event.target.value)} className={inputClass}>
          <option value="lt">&lt;</option>
          <option value="gt">&gt;</option>
        </select>
        <input
          value={threshold}
          onChange={(event) => setThreshold(event.target.value)}
          placeholder={isGold ? "阈值(金)" : "阈值"}
          className={`${inputClass} w-24`}
        />
        <button
          onClick={() => {
            const raw = Number(threshold);
            if (!Number.isFinite(raw)) return;
            const value = isGold ? Math.round(raw * 10000) : raw;
            startTransition(() => createAlertRule(itemId, metric, operator, value));
            setThreshold("");
          }}
          disabled={pending || threshold === ""}
          className="border border-terminal-border bg-terminal-panel2 px-3 py-1 text-terminal-green hover:bg-slate-800"
        >
          添加预警
        </button>
      </div>
    </div>
  );
}
