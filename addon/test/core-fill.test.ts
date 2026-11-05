// The fill model is the decision core's only forecast. These tests pin the
// evidence hierarchy -- own sales, then public disappearances, then the
// phase prior -- because a silently promoted proxy would turn a bounded
// inference into false precision.
import { describe, expect, it } from "vitest";
import { loadAddon } from "./wow-lua";

function fill(input: Record<string, number | string | boolean>) {
  const lua = loadAddon();
  const fields = Object.entries(input)
    .map(([key, value]) => `${key} = ${typeof value === "string" ? JSON.stringify(value) : value}`)
    .join(", ");
  const text = lua.text(
    `(function()
      local low, high, point, basis, hazard = WowTest.ns.Core.fillProbability({ ${fields} })
      return string.format("%.4f|%.4f|%.4f|%s|%.4f", low, high, point, basis, hazard)
    end)()`
  );
  const [low, high, point, basis, hazard] = text.split("|");
  return { low: Number(low), high: Number(high), point: Number(point), basis, hazard: Number(hazard) };
}

describe("fill evidence hierarchy", () => {
  it("uses own sales once there are at least three samples", () => {
    const result = fill({
      horizonHours: 1,
      phase: "steady",
      marketType: "commodity",
      qty: 10,
      ownSold: 20,
      ownSamples: 4,
      ownExposedHours: 2,
      supply: 100
    });
    // 20 units over 2 hours = 10/hour. As a share of the 100-unit book that
    // is 0.1/hour; the queue formula turns it back into 10 units/hour, so a
    // 10-unit listing clears at 1/hour either way.
    expect(result.basis).toBe("own");
    expect(result.point).toBeCloseTo(1 - Math.exp(-1), 3);
    expect(result.low).toBeLessThan(result.point);
    expect(result.high).toBeGreaterThan(result.point);
  });

  it("scales the own-sale hazard by the quantity being listed", () => {
    const small = fill({ horizonHours: 1, qty: 10, ownSold: 20, ownSamples: 4, ownExposedHours: 2 });
    const large = fill({ horizonHours: 1, qty: 20, ownSold: 20, ownSamples: 4, ownExposedHours: 2 });
    expect(large.point).toBeCloseTo(1 - Math.exp(-0.5), 3);
    expect(large.point).toBeLessThan(small.point);
  });

  it("falls back to the public disappearance proxy below three own samples", () => {
    const result = fill({
      horizonHours: 1,
      phase: "steady",
      marketType: "commodity",
      qty: 10,
      ownSold: 2,
      ownSamples: 2,
      sold: 10,
      supply: 100,
      elapsedHours: 1
    });
    expect(result.basis).toBe("proxy");
    // 10 units left a 100-unit book in an hour, so 10 units/hour leave it.
    // A 10-unit listing with nothing cheaper ahead waits for its own
    // quantity to clear: 1 - exp(-10 * 1 / 10).
    expect(result.point).toBeCloseTo(1 - Math.exp(-1), 3);
  });

  it("puts the listing behind the units already priced ahead of it", () => {
    // Share 0.001/h over 100 units is 0.1 units/hour. Ten units at the
    // front clear in 100 hours; behind thirty cheaper units the queue is 40.
    const front = fill({ horizonHours: 24, sold: 1, supply: 100, elapsedHours: 10, qty: 10 });
    const behind = fill({ horizonHours: 24, sold: 1, supply: 100, elapsedHours: 10, qty: 10, ahead: 30 });
    expect(front.point).toBeCloseTo(1 - Math.exp(-0.24), 4);
    expect(behind.point).toBeCloseTo(1 - Math.exp(-0.06), 4);
  });

  it("uses the phase prior when nothing is observable", () => {
    const result = fill({ horizonHours: 1, phase: "ignition", marketType: "commodity", qty: 10 });
    expect(result.basis).toBe("prior");
    expect(result.point).toBeCloseTo(1 - Math.exp(-0.35), 3);
  });

  it("returns the hazard behind the point so the chart cannot refit its own curve", () => {
    // The terminal's fill curve is anchored to this hazard. Reversing the
    // point estimate in the chart made an exactly-certain fill (the hazard
    // cap at long horizons) look like no estimate at all.
    const result = fill({ horizonHours: 24, phase: "ignition", marketType: "commodity", qty: 1 });
    expect(result.hazard).toBeCloseTo(0.35, 4);
    expect(1 - Math.exp(-result.hazard * 24)).toBeCloseTo(result.point, 4);
  });

  it("does not call a book observable without a previous capture to diff", () => {
    // Owner visibility alone is not enough: if the scan had no baseline,
    // nothing could have disappeared, so zero movement is missing data.
    const lua = loadAddon();
    const text = lua.text(
      `(function()
        local fresh = WowTest.ns.Core.isObservable({ ownerVisible = true, sellersInvisible = false, flowObserved = false })
        local based = WowTest.ns.Core.isObservable({ ownerVisible = true, sellersInvisible = false })
        return tostring(fresh) .. "|" .. tostring(based)
      end)()`
    );
    expect(text).toBe("false|true");
  });

  it("treats an observed zero as evidence, not as missing data", () => {
    // A big observable book with no disappearances: the prior must be
    // shrunk toward zero, not replaced by itself.
    const observed = fill({
      horizonHours: 24,
      phase: "steady",
      marketType: "commodity",
      sold: 0,
      supply: 5000,
      elapsedHours: 0.25,
      observable: true
    });
    expect(observed.basis).toBe("observed-zero");
    const priorOnly = fill({ horizonHours: 24, phase: "steady", marketType: "commodity" });
    expect(priorOnly.basis).toBe("prior");
    expect(observed.hazard).toBeLessThan(priorOnly.hazard / 2);
  });

  it("lets a busy observable book override the prior", () => {
    const busy = fill({
      horizonHours: 1,
      phase: "steady",
      marketType: "commodity",
      sold: 100,
      supply: 100,
      elapsedHours: 1,
      observable: true
    });
    expect(busy.basis).toBe("proxy");
    expect(busy.hazard).toBeGreaterThan(0.5);
  });

  it("reads the prior from the compiled rules rather than a local table", () => {
    const lua = loadAddon();
    lua.exec("WowTest.ns.RULES.fillPrior.hazard.ignition.commodity = 0.9");
    const text = lua.text(
      `(function()
        local _, _, _, basis, hazard = WowTest.ns.Core.fillProbability({ horizonHours = 1, phase = "ignition", marketType = "commodity" })
        return string.format("%s|%.3f", basis, hazard)
      end)()`
    );
    expect(text).toBe("prior|0.900");
  });

  it("floors the proxy window at the compiled scan interval", () => {
    // Ten units vanished from a hundred over an unstated gap. With a
    // 30-minute cadence the floor is half an hour, so the hazard is
    // 10 / (100 * 0.5) = 0.2/hour — not the old hardcoded quarter hour.
    const lua = loadAddon();
    lua.exec("WowTest.ns.RULES.scanIntervalMinutes = 30");
    const text = lua.text(
      `(function()
        local _, _, point, basis = WowTest.ns.Core.fillProbability({ horizonHours = 1, sold = 10, supply = 100, qty = 100 })
        return string.format("%.4f|%s", point, basis)
      end)()`
    );
    const [point, basis] = text.split("|");
    expect(basis).toBe("proxy");
    // The listing is the whole book, so the queue factor is 1 and the
    // point equals the share: 10 / (100 * 0.5) = 0.2/hour.
    expect(Number(point)).toBeCloseTo(1 - Math.exp(-0.2), 4);
  });

  it("reads the listing queue from the book, not from the listing size alone", () => {
    // The same share over a deeper book is more units per hour, so the
    // same listing clears faster. Treating the share as a listing hazard
    // made these two books indistinguishable.
    const lua = loadAddon();
    const text = lua.text(
      `(function()
        local _, _, thin = WowTest.ns.Core.fillProbability({ horizonHours = 24, sold = 1, supply = 100, elapsedHours = 10, qty = 10 })
        local _, _, deep = WowTest.ns.Core.fillProbability({ horizonHours = 24, sold = 1, supply = 1000, elapsedHours = 10, qty = 10 })
        return string.format("%.4f|%.4f", thin, deep)
      end)()`
    );
    const [thin, deep] = text.split("|").map(Number);
    expect(thin).toBeCloseTo(1 - Math.exp(-0.24), 4);
    expect(deep).toBeGreaterThan(thin);
  });
});

describe("ledger own-sale labels", () => {
  it("counts collected auction sales and excludes inferred and vendor rows", () => {
    const lua = loadAddon();
    const now = 1_700_000_000;
    lua.exec(`WoWderhoiAH_Ledger = WowTest.ns.Ledger.replay({
      { t = ${now - 1200}, k = "sold", itemId = 2589, qty = 5, price = 100, fee = 5 },
      { t = ${now - 600}, k = "sold", itemId = 2589, qty = 3, price = 100, fee = 5 },
      { t = ${now - 300}, k = "sold", itemId = 2589, qty = 9, price = 100, fee = 5, inferred = true },
      { t = ${now - 900}, k = "vendor", itemId = 2589, qty = 4, paid = 40 },
      { t = ${now - 900}, k = "sold", itemId = 2770, qty = 2, price = 200, fee = 10 }
    }, "TestRealm|Alliance|Tester")`);
    const text = lua.text(
      `(function()
        local sales = WowTest.ns.Ledger.salesSince(3600, ${now})
        return sales[2589].qty .. "|" .. sales[2589].samples .. "|" .. string.format("%.2f", sales[2589].exposedHours)
      end)()`
    );
    // Each sale contributes its own exposure window; without a listing
    // time the scan interval is the resolution floor, so two sales are
    // two floors of exposure, not one.
    const floor = lua.number("WowTest.ns.RULES.scanIntervalMinutes") / 60;
    expect(text).toBe(`8|2|${(floor * 2).toFixed(2)}`);
    expect(lua.text("(function() local s = WowTest.ns.Ledger.salesSince(3600, " + now + ") return tostring(s[2770] and s[2770].qty) end)()"))
      .toBe("2");
  });

  it("measures exposure from the listing time, not the span between sales", () => {
    const lua = loadAddon();
    const now = 1_700_000_000;
    lua.exec(`WoWderhoiAH_Ledger = WowTest.ns.Ledger.replay({
      { t = ${now - 600}, k = "sold", itemId = 2589, qty = 1, price = 100, listedAt = ${now - 6000} },
      { t = ${now - 300}, k = "sold", itemId = 2589, qty = 1, price = 100, listedAt = ${now - 3300} }
    }, "TestRealm|Alliance|Tester")`);
    // 1.5h + 50min = 2.33h exposed; the old first-to-last span was 5 minutes.
    expect(lua.text("(function() return string.format('%.2f', WowTest.ns.Ledger.salesSince(3600, " + now + ")[2589].exposedHours) end)()"))
      .toBe("2.33");
  });
});
