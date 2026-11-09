// Allocation is the only place one purse is shared across recommendations.
// Before it lived in the core, every row saw the whole budget and the game
// panel ignored the plan entirely.
import { describe, expect, it } from "vitest";
import { loadAddon, toLua } from "./wow-lua";

function item(itemId: number, overrides: Record<string, unknown> = {}) {
  // The map key is the identity; Core.evaluate never reads an id field.
  return {
    name: `item-${itemId}`,
    itemClass: "Trade Goods",
    marketType: "commodity",
    vendorP: 10,
    minPrice: 700,
    sellP: 1000,
    quantity: 1000,
    numAuctions: 10,
    sellers: 4,
    tiers: [{ p: 700, q: 20 }, { p: 800, q: 100 }],
    history: { samples: 8 },
    inferredSoldLow: 50,
    inferredSoldHigh: 50,
    elapsedHours: 0.25,
    ...overrides
  };
}

function evaluate(
  items: Record<number, unknown>,
  budget: number,
  phase = "wave",
  positions: Record<number, { qty: number; cost: number }> = {}
) {
  const lua = loadAddon();
  const input = {
    now: 1_700_000_000,
    phaseOverride: phase,
    market: { firstScanAt: 1_700_000_000 - 30 * 3600, items },
    capital: { cash: budget, budget },
    capacity: { bagSlots: 20, stackSize: 20 },
    positions
  };
  return lua.coreEval(input) as {
    rows: Array<{ itemId: number; candidateQty: number; allocQty: number; allocNet: number; allocCost: number; allocUnitPrice: number; candidateUnitPrice: number; vendor: boolean; exploratory: boolean; samples: number; score: number; netPerMinute: number; unfunded?: string }>;
    opportunities: Array<{ itemId: number; allocQty: number; candidateQty: number }>;
    actions: Array<{ kind: string; itemId: number; qty: number; expectedNet: number; netPerMinute: number }>;
    diagnostics: { unfunded: Record<string, number>; excluded: Record<string, number> };
  };
}

describe("shared capital allocation", () => {
  it("never spends more than the daily share across all rows", () => {
    const output = evaluate({ 2589: item(2589), 2592: item(2592) }, 100000);
    // allocCost is what the allocated quantity actually costs at the cheap
    // end; multiplying by the deep-ladder average would overstate the spend.
    const spend = output.rows.reduce((sum, row) => sum + row.allocCost, 0);
    // dailyBudget 0.5 of a 100k purse: 50k total, regardless of row count.
    expect(spend).toBeLessThanOrEqual(50000);
    expect(output.rows.every((row) => row.allocQty <= row.candidateQty)).toBe(true);
    expect(output.rows.some((row) => row.allocQty > 0)).toBe(true);
  });

  it("caps one item at the exposure share", () => {
    const output = evaluate({ 2589: item(2589) }, 100000);
    const row = output.rows[0];
    // maxItemExposure 0.25 of 100k = 25k; at ~700-800 a unit that is at
    // most 35 units, well below the 120-unit book depth.
    expect(row.allocQty).toBeGreaterThan(0);
    expect(row.allocCost).toBeLessThanOrEqual(25000);
    expect(row.allocQty).toBeLessThan(row.candidateQty);
  });

  it("emits actions with the allocated quantity and its net", () => {
    const output = evaluate({ 2589: item(2589) }, 100000);
    const row = output.rows[0];
    const buy = output.actions.find((action) => action.kind === "buy");
    expect(buy?.itemId).toBe(row.itemId);
    expect(buy?.qty).toBe(row.allocQty);
    expect(buy?.expectedNet).toBe(row.allocNet);
  });

  it("allocates nothing when Kelly says the bet is negative", () => {
    const lua = loadAddon();
    const rows = [{ candidateUnitPrice: 100, listP: 110, vendorP: 0, candidateQty: 100, fillProb: 0 }];
    lua.exec(`WowTest.allocRows, WowTest.allocUnfunded = WowTest.ns.Core.allocate(${toLua(rows)}, 100000, WowTest.ns.RULES)`);
    expect(lua.number("WowTest.allocRows[1].allocQty")).toBe(0);
    expect(lua.number("WowTest.allocRows[1].allocNet")).toBe(0);
    // A zero allocation has a cause, and it is not always the purse.
    expect(lua.text("WowTest.allocRows[1].unfunded")).toBe("kelly");
    expect(lua.number("WowTest.allocUnfunded.kelly")).toBe(1);
  });

  it("names the purse once the daily share is spent", () => {
    const lua = loadAddon();
    const rows = [
      { candidateUnitPrice: 100, listP: 300, sellP: 300, vendorP: 300, vendor: true, candidateQty: 400, fillProb: 1 },
      { candidateUnitPrice: 100, listP: 300, sellP: 300, vendorP: 300, vendor: true, candidateQty: 400, fillProb: 1 }
    ];
    // 10k purse x dailyBudget 0.5 = 5k, exactly fifty units at 100.
    lua.exec(`WowTest.allocRows, WowTest.allocUnfunded = WowTest.ns.Core.allocate(${toLua(rows)}, 10000, WowTest.ns.RULES)`);
    expect(lua.number("WowTest.allocRows[1].allocQty")).toBe(50);
    expect(lua.text("WowTest.allocRows[2].unfunded")).toBe("purse");
    expect(lua.number("WowTest.allocUnfunded.purse")).toBe(1);
  });

  it("names the per-item exposure cap, not the purse", () => {
    const lua = loadAddon();
    lua.exec("WowTest.ns.RULES.portfolio.maxItemExposure = 0");
    const rows = [{
      minPrice: 100, candidateUnitPrice: 100, listP: 200, sellP: 200,
      candidateQty: 100, fillProb: 1, samples: 20
    }];
    lua.exec(`WowTest.allocRows, WowTest.allocUnfunded = WowTest.ns.Core.allocate(${toLua(rows)}, 100000, WowTest.ns.RULES)`);
    expect(lua.number("WowTest.allocRows[1].allocQty")).toBe(0);
    expect(lua.text("WowTest.allocRows[1].unfunded")).toBe("exposure");
    expect(lua.number("WowTest.allocUnfunded.exposure")).toBe(1);
  });

  it("names an unaffordable ladder as depth", () => {
    const lua = loadAddon();
    // The row's average says 100, but its only rung costs 100,000: the cap
    // is above one unit of the average and below the rung it must buy.
    const rows = [{
      minPrice: 100, candidateUnitPrice: 100, listP: 200, sellP: 200,
      candidateQty: 5, fillProb: 1, samples: 20,
      tiers: [{ p: 100000, q: 5 }]
    }];
    lua.exec(`WowTest.allocRows, WowTest.allocUnfunded = WowTest.ns.Core.allocate(${toLua(rows)}, 100000, WowTest.ns.RULES)`);
    expect(lua.number("WowTest.allocRows[1].allocQty")).toBe(0);
    expect(lua.text("WowTest.allocRows[1].unfunded")).toBe("depth");
    expect(lua.number("WowTest.allocUnfunded.depth")).toBe(1);
  });

  it("names the purse when the remaining share cannot buy one unit", () => {
    const lua = loadAddon();
    const rows = [
      // A vendor row has no per-item exposure cap, so it can spend the
      // daily share down to less than one unit of the next row.
      { vendor: true, candidateUnitPrice: 100, listP: 300, sellP: 300, vendorP: 300, candidateQty: 49, fillProb: 1 },
      {
        minPrice: 200, candidateUnitPrice: 200, listP: 400, sellP: 400,
        candidateQty: 10, fillProb: 1, samples: 20, tiers: [{ p: 200, q: 10 }]
      }
    ];
    // 10k purse x dailyBudget 0.5 = 5k. The vendor row takes 49 units at
    // 100 (4,900), leaving 100 copper: less than the next row's 200-copper
    // unit, while its 2.5k exposure cap could afford one. The book has
    // depth; the shared purse is what ran out.
    lua.exec(`WowTest.allocRows, WowTest.allocUnfunded = WowTest.ns.Core.allocate(${toLua(rows)}, 10000, WowTest.ns.RULES)`);
    expect(lua.number("WowTest.allocRows[1].allocQty")).toBe(49);
    expect(lua.number("WowTest.allocRows[2].allocQty")).toBe(0);
    expect(lua.text("WowTest.allocRows[2].unfunded")).toBe("purse");
    expect(lua.number("WowTest.allocUnfunded.purse")).toBe(1);
    expect(lua.number("WowTest.allocUnfunded.depth")).toBe(0);
  });

  it("publishes funded rows as opportunities that match the buy actions", () => {
    const output = evaluate({ 2589: item(2589), 2592: item(2592) }, 100000);
    expect(output.opportunities.length).toBeGreaterThan(0);
    expect(output.opportunities.every((row) => row.allocQty > 0 && row.allocQty <= row.candidateQty)).toBe(true);
    const funded = new Set(output.opportunities.map((row) => row.itemId));
    for (const action of output.actions) {
      if (action.kind === "buy") expect(funded.has(action.itemId)).toBe(true);
    }
    expect(output.diagnostics.unfunded).toEqual({ kelly: 0, exposure: 0, purse: 0, depth: 0, slots: 0 });
  });

  it("prices the allocated quantity from the cheap end of the ladder", () => {
    const lua = loadAddon();
    // One unit at 100 plus a hundred at 1000: the full-depth average is
    // ~991, but an allocation of 25 units only touches the two cheapest
    // tiers (100 + 24 * 1000 = 24,100). Charging the deep average would
    // understate both the profit and the cash the plan occupies.
    const rows = [{
      candidateUnitPrice: 991,
      listP: 2000,
      sellP: 2000,
      vendorP: 0,
      candidateQty: 101,
      fillProb: 1,
      samples: 20,
      tiers: [{ p: 100, q: 1 }, { p: 1000, q: 100 }]
    }];
    lua.exec(`WowTest.allocRows = WowTest.ns.Core.allocate(${toLua(rows)}, 100000, WowTest.ns.RULES)`);
    expect(lua.number("WowTest.allocRows[1].allocQty")).toBe(25);
    expect(lua.number("WowTest.allocRows[1].allocCost")).toBe(24100);
    expect(lua.number("WowTest.allocRows[1].allocNet")).toBe(23400);
    // The row's displayed buy price must describe the same trade as its
    // quantity and net, not the full-depth average it no longer buys.
    expect(lua.number("WowTest.allocRows[1].allocUnitPrice")).toBeCloseTo(964, 6);
  });


  it("walks the ladder for the affordable quantity, not the deep average", () => {
    // Ten units at 100 behind a hundred at 1,000: the deep average is ~909.
    // Dividing a 1,500-copper exposure cap by that average funds one unit,
    // but the same cap actually buys the ten cheap ones.
    const lua = loadAddon();
    const rows = [{
      candidateUnitPrice: 909.0909090909091,
      minPrice: 100,
      listP: 2000,
      sellP: 2000,
      vendorP: 0,
      candidateQty: 110,
      fillProb: 1,
      samples: 20,
      tiers: [{ p: 100, q: 10 }, { p: 1000, q: 100 }]
    }];
    lua.exec(`WowTest.allocRows = WowTest.ns.Core.allocate(${toLua(rows)}, 6000, WowTest.ns.RULES)`);
    // maxItemExposure 25% of a 6,000 purse = 1,500.
    expect(lua.number("WowTest.allocRows[1].allocQty")).toBe(10);
    expect(lua.number("WowTest.allocRows[1].allocCost")).toBe(1000);
    expect(lua.number("WowTest.allocRows[1].allocUnitPrice")).toBe(100);
  });

  it("uses the highest bid as an ignition demand nudge, not a gate", () => {
    const noBid = item(2589, { history: { samples: 0 } });
    const withBid = item(2592, { history: { samples: 0 }, bidOnly: 1, highestBid: 900 });
    const output = evaluate({ 2589: noBid, 2592: withBid }, 100000, "ignition");
    expect(output.rows[0].itemId).toBe(2592);
    expect(output.rows[0]).toMatchObject({
      fillBasis: expect.anything()
    });
    const lua = loadAddon();
    const input = {
      now: 1_700_000_000,
      phaseOverride: "ignition",
      market: { firstScanAt: 1_700_000_000 - 3600, items: { 2592: withBid } },
      capital: { cash: 100000, budget: 100000 },
      capacity: { bagSlots: 20, stackSize: 20 }
    };
    const evaluated = lua.coreEval(input) as { rows: Array<{ reason: string; demandPrior: number }> };
    expect(evaluated.rows[0].demandPrior).toBeCloseTo(1.2, 6);
    expect(evaluated.rows[0].reason).toContain("最高 900");
  });

  it("marks thin-evidence rows as exploratory for the cockpit", () => {
    // minKellySamples is 10; the row carries 8 history samples. The engine
    // decides the label so the terminal does not re-derive it from a
    // hardcoded number.
    const thin = evaluate({ 2589: item(2589) }, 100000);
    expect(thin.rows[0].samples).toBe(8);
    expect(thin.rows[0].exploratory).toBe(true);
    const thick = evaluate({ 2589: item(2589, { history: { samples: 12 } }) }, 100000);
    expect(thick.rows[0].exploratory).toBe(false);
  });

  it("shares the purse between guaranteed vendor trades", () => {
    const lua = loadAddon();
    const rows = [
      { candidateUnitPrice: 100, listP: 300, sellP: 300, vendorP: 300, vendor: true, candidateQty: 400, fillProb: 1 },
      { candidateUnitPrice: 100, listP: 300, sellP: 300, vendorP: 300, vendor: true, candidateQty: 400, fillProb: 1 }
    ];
    lua.exec(`WowTest.allocRows = WowTest.ns.Core.allocate(${toLua(rows)}, 100000, WowTest.ns.RULES)`);
    // 50k daily share: the first row takes all 400 units (40k), the second
    // gets the 100 units that fit in the remaining 10k.
    expect(lua.number("WowTest.allocRows[1].allocQty")).toBe(400);
    expect(lua.number("WowTest.allocRows[2].allocQty")).toBe(100);
  });
});

describe("position sizing against a real book", () => {
  // The fixture the radar tests use hides the sizing flaw: proxy evidence
  // pins the fill probability near 1, so almost any loss term still yields
  // a bet. A steady-phase row with only prior fill evidence is what the
  // live market looks like, and it must still be funded.
  function steadyItem(overrides: Record<string, unknown> = {}) {
    return {
      itemId: 4306,
      name: "Silk Cloth",
      itemClass: "Trade Goods",
      marketType: "commodity",
      vendorP: 10,
      minPrice: 5000,
      sellP: 5800,
      quantity: 400,
      numAuctions: 12,
      sellers: 5,
      // A deep ladder: the whole executable depth averages close to the
      // price cap, which is exactly the case the old sizing zeroed.
      tiers: [{ p: 5000, q: 40 }, { p: 5300, q: 160 }, { p: 5600, q: 200 }],
      history: { samples: 60 },
      ...overrides
    };
  }

  it("funds a deep book on prior evidence instead of zeroing every row", () => {
    const output = evaluate({ 4306: steadyItem() }, 1_000_000, "steady");
    const row = output.rows[0];
    expect(row.allocQty).toBeGreaterThan(0);
    // The row still has to describe an executable trade, not the whole book.
    expect(row.allocQty).toBeLessThanOrEqual(row.candidateQty);
    expect(row.allocCost).toBeLessThanOrEqual(250_000);
  });

  it("sizes the bet at the entry price, not at the deep-ladder average", () => {
    // Identical opportunity, one with a two-tier book and one with a book so
    // deep that its average sits at the price cap. Sizing on the average
    // would shrink the second to nothing; the edge at the front is the same.
    const thin = evaluate({ 4306: steadyItem({ tiers: [{ p: 5000, q: 60 }], quantity: 60 }) }, 1_000_000, "steady");
    const deep = evaluate({ 4306: steadyItem() }, 1_000_000, "steady");
    expect(deep.rows[0].allocQty).toBeGreaterThan(0);
    expect(thin.rows[0].allocQty).toBeGreaterThan(0);
    // Same front, same fill prior: the funded amount may not collapse just
    // because more supply is listed behind it.
    expect(deep.rows[0].allocCost).toBeGreaterThan(thin.rows[0].allocCost * 0.5);
  });
});

describe("score corrections", () => {
  it("prefers a competitive book over one seller holding the supply", () => {
    const contested = item(1, { sellerHHI: 0.2, topSellerShare: 0.45 });
    const monopoly = item(2, { sellerHHI: 1, topSellerShare: 1 });
    const output = evaluate({ 1: contested, 2: monopoly }, 100000);
    const byId = new Map(output.rows.map((row) => [row.itemId, row]));
    expect(byId.get(1)!.score).toBeGreaterThan(byId.get(2)!.score);
    expect(output.rows[0].itemId).toBe(1);
  });

  it("reports net per minute so effort is visible next to the coins", () => {
    const output = evaluate({ 2589: item(2589) }, 100000);
    expect(output.rows[0].netPerMinute).toBeGreaterThan(0);
    expect(output.rows[0].netPerMinute).toBeLessThan(output.rows[0].allocNet);
  });

  it("prices a buy and a sell action with their own effort minutes", () => {
    const lua = loadAddon();
    // A listing costs the round trip plus posting, not plus buying. Set the
    // posting minutes apart from the buying ones so the two plans cannot
    // accidentally share a formula.
    lua.exec("WowTest.ns.RULES.timeCost.postMinutes = 8");
    const output = lua.coreEval({
      now: 1_700_000_000,
      phaseOverride: "wave",
      market: { firstScanAt: 1_700_000_000 - 30 * 3600, items: { 2589: item(2589) } },
      capital: { cash: 100000, budget: 100000 },
      capacity: { bagSlots: 20, stackSize: 20 },
      positions: { 2589: { qty: 10, cost: 8000 } }
    }) as {
      actions: Array<{ kind: string; expectedNet: number; netPerMinute: number }>;
    };
    const buy = output.actions.find((action) => action.kind === "buy");
    const sell = output.actions.find((action) => action.kind === "sell");
    expect(buy?.netPerMinute).toBe(Math.round(buy!.expectedNet / 12));
    expect(sell?.netPerMinute).toBe(Math.round(sell!.expectedNet / 18));
  });
});
