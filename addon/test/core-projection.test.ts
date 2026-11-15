// A purchase removes depth from the book, but the scan is immutable. The
// plan therefore reads a projection: the scanned ladder minus the units the
// journal says the player bought since scannedAt. Only the buy side moves;
// sellP stays the scan's observation because the persisted top-8 ladder
// cannot reproduce the whole book's front.
import { describe, expect, it } from "vitest";
import { loadAddon, toLua, type WowLua } from "./wow-lua";

type Projected = {
  minPrice: number;
  quantity: number;
  sellP: number;
  numAuctions: number;
  tiers: Array<{ p: number; q: number }>;
  sellerHHI?: number;
  flowObserved?: boolean;
};

const BOOK = {
  name: "Clean Spread",
  minPrice: 700,
  sellP: 1000,
  quantity: 120,
  numAuctions: 10,
  sellerHHI: 0.4,
  topSellerShare: 0.5,
  flowObserved: true,
  tierTruncated: true,
  tiers: [{ p: 700, q: 20 }, { p: 800, q: 100 }]
};

function project(lua: WowLua, quantity: number, book: Record<string, unknown> = BOOK): Projected {
  return lua.value(`WowTest.ns.Core.projectBook(${toLua(book)}, ${quantity})`) as Projected;
}

describe("buy-side book projection", () => {
  it("returns the same table when nothing was bought", () => {
    const lua = loadAddon();
    const same = lua.eval(
      `(function() local book = ${toLua(BOOK)} return WowTest.ns.Core.projectBook(book, 0) == book end)()`
    );
    expect(same).toBe(true);
    expect(lua.eval(`(function() local book = ${toLua(BOOK)} return WowTest.ns.Core.projectBook(book, -3) == book end)()`))
      .toBe(true);
  });

  it("does not modify the scanned book", () => {
    const lua = loadAddon();
    lua.exec(`WowTest.book = ${toLua(BOOK)}`);
    lua.exec("WowTest.projected = WowTest.ns.Core.projectBook(WowTest.book, 30)");
    expect(lua.number("WowTest.book.tiers[1].q")).toBe(20);
    expect(lua.number("WowTest.book.minPrice")).toBe(700);
    expect(lua.number("WowTest.book.quantity")).toBe(120);
  });

  it("consumes the cheapest tier first and keeps a partial remainder", () => {
    const lua = loadAddon();
    const projected = project(lua, 5);
    expect(projected.tiers).toEqual([{ p: 700, q: 15 }, { p: 800, q: 100 }]);
    expect(projected.minPrice).toBe(700);
    expect(projected.quantity).toBe(115);
  });

  it("walks across tiers and re-prices the front", () => {
    const lua = loadAddon();
    const projected = project(lua, 30);
    expect(projected.tiers).toEqual([{ p: 800, q: 90 }]);
    expect(projected.minPrice).toBe(800);
    expect(projected.quantity).toBe(90);
  });

  it("closes the buy side when the visible ladder is bought out", () => {
    const lua = loadAddon();
    const projected = project(lua, 120);
    expect(projected.tiers).toEqual([]);
    expect(projected.minPrice).toBe(0);
    expect(projected.quantity).toBe(0);
  });

  it("does not guess a deep price when the journal exceeds the visible ladder", () => {
    const lua = loadAddon();
    // tierTruncated means the scan only persisted the cheap eight rungs;
    // the rest is unknown, not free. Close the book until a rescan.
    const projected = project(lua, 130);
    expect(projected.tiers).toEqual([]);
    expect(projected.minPrice).toBe(0);
  });

  it("keeps the scan's sell observation and competitor identity", () => {
    const lua = loadAddon();
    const projected = project(lua, 30);
    expect(projected.sellP).toBe(1000);
    expect(projected.numAuctions).toBe(10);
    expect(projected.sellerHHI).toBe(0.4);
    expect(projected.flowObserved).toBe(true);
  });

  it("feeds the core a closed book that yields no buy step", () => {
    const lua = loadAddon();
    const projected = project(lua, 120);
    const output = lua.coreEval({
      now: 1_700_000_000,
      phaseOverride: "wave",
      market: { firstScanAt: 1_700_000_000 - 30 * 3600, items: { 4338: projected } },
      capital: { cash: 1_000_000, budget: 1_000_000 },
      capacity: { bagSlots: 20, stackSize: 20 },
      positions: { 4338: { qty: 5, cost: 3500, sellableQty: 5, costKnown: true } }
    }) as { actions: Array<{ kind: string; itemId: number }> };
    expect(output.actions.filter((action) => action.kind === "buy")).toEqual([]);
    expect(output.actions.some((action) => action.kind === "sell")).toBe(true);
  });
});
