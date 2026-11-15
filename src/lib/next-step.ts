// The plan's first step, written as an instruction instead of a row of
// numbers. Both surfaces show this copy: the game renders it in Locale.lua
// from the same CoreAction fields, and the terminal renders it here. The
// core owns the numbers and the order; this module only chooses the words.
import type { CoreAction } from "@/lib/core/types";

// Money stays a number until render time so both surfaces keep their own
// coin rendering (the terminal uses the self-hosted coin sprites).
export type NextStepPart = string | { copper: number };

export type NextStepCopy = {
  headline: NextStepPart[];
  condition: NextStepPart[];
  outcome: NextStepPart[];
  note: string;
};

export function describeNextStep(action: CoreAction): NextStepCopy {
  if (action.kind === "buy") {
    // Vendor rows are the one buy with no market fill chance; the core
    // labels them through `fillBasis`, and a 100% fill would be a claim the
    // label already explains away.
    const vendor = action.fillBasis === "vendor";
    const abort = action.stop?.ifPriceAbove ?? action.maxUnitPrice;
    const probability = vendor
      ? []
      : [` · 成交率 ${Math.round((action.fillProb ?? 0) * 100)}%`];
    return {
      headline: ["买入 ", `${action.qty} 件 `, action.name],
      condition: action.stop
        ? ["单价 ≤ ", { copper: abort }, "，高于即放弃"]
        : ["单价 ≤ NPC 价 ", { copper: action.maxUnitPrice }],
      outcome: ["预计净利 ", { copper: action.expectedNet }, ...probability],
      note: vendor
        ? "NPC 必赚：买下后直接卖店，没有市场风险。完成后计划会自动重算。"
        : "游戏内打开交易页 → 下一步，点击第一行的「查找」；上限会带进搜索结果。完成后计划会自动重算。"
    };
  }
  const name = action.name ?? `#${action.itemId}`;
  const realised = action.costKnown === false
    ? [" · 成本未知，不报盈亏"]
    : action.realizedPnl !== undefined && action.realizedPnl !== null
      ? [" · 已实现 ", { copper: action.realizedPnl }]
      : [];
  // A fill-chance sell step was priced with the client's deposit table.
  // Without one the step carries the core's base undercut, while the sell
  // page may choose another price and duration; the note must not present
  // the base number as the final recommendation.
  const priced = action.fillProb !== undefined && action.fillProb !== null;
  const note = action.requiresBank
    ? priced
      ? "先去银行取出这些货，再到卖出页按建议价挂出。完成后计划会自动重算。"
      : "先去银行取出这些货，再到卖出页设定时长后挂出；押金与成交时长可在卖出页优化。完成后计划会自动重算。"
    : priced
      ? "打开卖出页，按建议价挂出。完成后计划会自动重算。"
      : "打开卖出页，设定时长后挂出；押金与成交时长可在卖出页优化。完成后计划会自动重算。";
  return {
    headline: ["挂出 ", `${action.qty} 件 `, name],
    condition: ["挂单价 ", { copper: action.price }],
    outcome: ["回款 ", { copper: action.expectedNet }, ...realised],
    note
  };
}
