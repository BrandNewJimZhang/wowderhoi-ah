// Observation hygiene: the book the scan describes is the market's, not
// the player's. Own listings must not price the sell front or satisfy the
// seller gate, and own purchases must not be booked as public demand.
import { describe, expect, it } from "vitest";
import { loadAddon } from "./wow-lua";

const linen = (overrides: Record<string, unknown> = {}) => ({
  itemId: 2589,
  name: "Linen Cloth",
  count: 10,
  buyout: 1000,
  owner: "Other",
  timeLeft: 4 * 3600,
  ...overrides
});

describe("own listings are excluded from the book", () => {
  it("does not let the player's cheaper listing set the sell front", () => {
    const lua = loadAddon();
    lua.runScan([
      linen({ count: 10, buyout: 500, owner: "Tester" }), // own, 50 copper each
      linen({ count: 10, buyout: 1000, owner: "Other" }) // theirs, 100 each
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].quantity")).toBe(10);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].numAuctions")).toBe(1);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].sellers")).toBe(1);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].minPrice")).toBe(100);
    expect(lua.text("WoWderhoiAH_ScanData.items[2589].selfExclusion")).toBe("owner");
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].selfListings")).toBe(1);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].selfQty")).toBe(10);
  });

  it("recognizes an owner carrying a realm suffix", () => {
    const lua = loadAddon();
    lua.runScan([
      linen({ count: 10, buyout: 500, owner: "Tester-Realm" }),
      linen({ count: 10, buyout: 1000, owner: "Other" })
    ]);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].quantity")).toBe(10);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].selfListings")).toBe(1);
  });

  it("falls back to the owned-auction list when owners are hidden", () => {
    const lua = loadAddon();
    lua.setOwned([{ auctionID: 7, itemId: 2589, quantity: 5, buyoutAmount: 250 }]);
    lua.runScan([
      linen({ count: 5, buyout: 250, owner: null, sellerUnknown: true }), // own, hidden
      linen({ count: 10, buyout: 1000, owner: null, sellerUnknown: true })
    ]);
    // Only the unmatched hidden row is market supply.
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].quantity")).toBe(10);
    expect(lua.text("WoWderhoiAH_ScanData.items[2589].selfExclusion")).toBe("owned");
    // Every row was hidden, so the book is still unobservable.
    expect(lua.eval("WoWderhoiAH_ScanData.items[2589].sellersInvisible")).toBe(true);
    expect(lua.eval("WoWderhoiAH_ScanData.items[2589].ownerVisible")).toBe(false);
  });

  it("refuses to measure concentration on a partially hidden book", () => {
    // Owner totals only see the rows that named a seller. Measuring HHI on
    // that subset would call a mostly hidden book a monopoly: the visible
    // rows would claim 100% of a supply they do not own.
    const lua = loadAddon();
    lua.runScan([
      linen({ owner: "Alice", count: 10, buyout: 1000 }),
      linen({ owner: null, sellerUnknown: true, count: 90, buyout: 9000 })
    ]);
    expect(lua.eval("WoWderhoiAH_ScanData.items[2589].sellerHHI == nil")).toBe(true);
    expect(lua.eval("WoWderhoiAH_ScanData.items[2589].topSellerShare == nil")).toBe(true);
  });

  it("marks an unidentifiable hidden book as not calibration evidence", () => {
    const lua = loadAddon();
    lua.runScan([linen({ owner: null, sellerUnknown: true })]);
    expect(lua.text("WoWderhoiAH_ScanData.items[2589].selfExclusion")).toBe("none");
  });
});

describe("a disappearance needs a baseline to mean anything", () => {
  it("marks the first scan as flow-unobserved instead of zero demand", () => {
    // With no previous capture there was nothing to disappear from. The
    // empty interval is missing data, and the core must not shrink the
    // fill estimate to an observed zero because of it.
    const lua = loadAddon();
    lua.runScan([linen()]);
    expect(lua.eval("WoWderhoiAH_ScanData.items[2589].flowObserved")).toBe(false);
  });

  it("distinguishes a continuous item from one that just appeared", () => {
    const lua = loadAddon();
    lua.runScan([linen()]);
    lua.advance(900);
    lua.runScan([linen(), linen({ itemId: 2592 })]);
    expect(lua.eval("WoWderhoiAH_ScanData.items[2589].flowObserved")).toBe(true);
    // The second item was listed between the scans: its zero disappearance
    // says nothing about how fast it sells.
    expect(lua.eval("WoWderhoiAH_ScanData.items[2592].flowObserved")).toBe(false);
  });
});

describe("own purchases are not public demand", () => {
  it("subtracts the units the journal booked as buys", () => {
    const lua = loadAddon();
    lua.runScan([linen({ count: 10, buyout: 1000, owner: "Other" })]);
    lua.advance(900);
    // The player bought four of the ten between the scans.
    lua.exec(`WowTest.ns.recordEvent({ k = "buy", itemId = 2589, qty = 4, cost = 400 })`);
    lua.runScan([linen({ count: 6, buyout: 600, owner: "Other" })]);
    const low = lua.number("WoWderhoiAH_ScanData.items[2589].inferredSoldLow");
    const high = lua.number("WoWderhoiAH_ScanData.items[2589].inferredSoldHigh");
    expect(low).toBe(0);
    expect(high).toBe(0);
    // Supply really did fall by the four units the player holds. That is a
    // negative growth rate, not a phantom shortage blamed on demand, and
    // the fill model never reads it as a sale.
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].supplyGrowth")).toBeLessThan(0);
  });

  it("keeps other buyers' disappearances after the own-buy subtraction", () => {
    const lua = loadAddon();
    lua.runScan([linen({ count: 10, buyout: 1000, owner: "Other" })]);
    lua.advance(900);
    lua.exec(`WowTest.ns.recordEvent({ k = "buy", itemId = 2589, qty = 4, cost = 400 })`);
    // Six units left: four to the player, two to someone else.
    lua.runScan([linen({ count: 4, buyout: 400, owner: "Other" })]);
    expect(lua.number("WoWderhoiAH_ScanData.items[2589].inferredSoldLow")).toBe(2);
  });
});
