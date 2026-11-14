import { describe, expect, it } from "vitest";
import type { CoreAction } from "@/lib/core/types";
import { describeNextStep, type NextStepPart } from "@/lib/next-step";

const copper = (parts: NextStepPart[]) =>
  parts.flatMap((part) => (typeof part === "string" ? [] : [part.copper]));
const text = (parts: NextStepPart[]) =>
  parts.map((part) => (typeof part === "string" ? part : "¤")).join("");

const buy = (patch: Partial<Extract<CoreAction, { kind: "buy" }>> = {}): CoreAction => ({
  kind: "buy",
  itemId: 2840,
  name: "Copper Bar",
  qty: 20,
  maxUnitPrice: 9399,
  unitPrice: 8000,
  expectedNet: 30000,
  netPerMinute: 6000,
  fillProb: 0.42,
  fillBasis: "proxy",
  allocQty: 20,
  allocUnitPrice: 8000,
  stop: { kind: "abort", ifPriceAbove: 9399 },
  cashBefore: 160000,
  cashAfter: 0,
  slotsBefore: 10,
  slotsAfter: 9,
  reason: "",
  ...patch
});

const sell = (patch: Partial<Extract<CoreAction, { kind: "sell" }>> = {}): CoreAction => ({
  kind: "sell",
  itemId: 2840,
  name: "Copper Bar",
  qty: 10,
  price: 9999,
  expectedNet: 94990,
  realizedPnl: 19990,
  costKnown: true,
  netPerMinute: 15831,
  requiresBank: false,
  cashBefore: 0,
  cashAfter: 94990,
  slotsBefore: 9,
  slotsAfter: 10,
  reason: "",
  ...patch
});

describe("describeNextStep", () => {
  it("turns a buy into an order with its abort price", () => {
    const copy = describeNextStep(buy());
    expect(text(copy.headline)).toBe("买入 20 件 Copper Bar");
    expect(text(copy.condition)).toContain("高于即放弃");
    expect(copper(copy.condition)).toEqual([9399]);
    expect(copper(copy.outcome)).toEqual([30000]);
    expect(text(copy.outcome)).toContain("42%");
    expect(copy.note).toContain("查找");
  });

  it("caps a vendor buy at the NPC price instead of inventing a fill chance", () => {
    const copy = describeNextStep(buy({
      maxUnitPrice: 120,
      unitPrice: 100,
      expectedNet: 400,
      fillProb: 1,
      fillBasis: "vendor",
      stop: undefined
    }));
    expect(text(copy.condition)).toContain("NPC");
    expect(copper(copy.condition)).toEqual([120]);
    expect(text(copy.outcome)).not.toContain("成交率");
    expect(copy.note).toContain("NPC");
  });

  it("sends the player to the bank before listing bank stock", () => {
    const copy = describeNextStep(sell({ requiresBank: true }));
    expect(text(copy.headline)).toBe("挂出 10 件 Copper Bar");
    expect(copper(copy.condition)).toEqual([9999]);
    expect(copper(copy.outcome)).toEqual([94990, 19990]);
    expect(copy.note).toContain("银行");
  });

  it("does not report a realised result when the basis is unknown", () => {
    const copy = describeNextStep(sell({ costKnown: false, realizedPnl: null }));
    expect(text(copy.outcome)).toContain("成本未知");
    expect(copper(copy.outcome)).toEqual([94990]);
  });

  it("falls back to the item id when a sell step carries no name", () => {
    const copy = describeNextStep(sell({ name: undefined, itemId: 12345 }));
    expect(text(copy.headline)).toContain("#12345");
  });
});
