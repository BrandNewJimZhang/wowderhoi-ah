// The account view sums character-scoped holdings. A market with two
// characters can carry the same item twice; keying by item without adding
// the rows silently kept only one character's stock.
import { describe, expect, it } from "vitest";
import { summarizeHoldings } from "@/lib/holdings-summary";
import type { StoredHolding } from "@/lib/repositories";

function holding(partial: Partial<StoredHolding> & Pick<StoredHolding, "character" | "itemId">): StoredHolding {
  return {
    qty: 0,
    carriedQty: 0,
    keyringQty: 0,
    bankQty: 0,
    accountBankQty: 0,
    mailQty: 0,
    listedQty: 0,
    knownQty: 0,
    unknownQty: 0,
    missingQty: 0,
    costKnown: true,
    costBasis: 0,
    ...partial
  };
}

describe("summarizeHoldings", () => {
  it("sums the same item across characters", () => {
    const summary = summarizeHoldings([
      holding({ character: "Main", itemId: 2589, qty: 5, knownQty: 3, costBasis: 3000, carriedQty: 5 }),
      holding({ character: "Alt", itemId: 2589, qty: 2, knownQty: 2, costBasis: 2000, carriedQty: 2 })
    ]);
    expect(summary.positions[2589]).toEqual({ qty: 5, cost: 5000 });
  });

  it("keeps unknown and missing units and every location separate", () => {
    const summary = summarizeHoldings([
      holding({
        character: "Main",
        itemId: 2589,
        qty: 10,
        carriedQty: 2,
        keyringQty: 1,
        bankQty: 3,
        accountBankQty: 2,
        mailQty: 1,
        listedQty: 1,
        knownQty: 7,
        unknownQty: 2,
        missingQty: 1,
        costBasis: 7000
      })
    ]);
    expect(summary.unknownUnits).toBe(2);
    expect(summary.missingUnits).toBe(1);
    expect(summary.byLocation).toEqual({ carried: 2, keyring: 1, bank: 5, mail: 1, listed: 1 });
  });

  it("does not value a booked quantity whose cost was never proved", () => {
    const summary = summarizeHoldings([
      holding({ character: "Main", itemId: 2589, qty: 2, knownQty: 2, costKnown: false, costBasis: 2000 })
    ]);
    expect(summary.positions[2589]).toBeUndefined();
    expect(summary.unknownUnits).toBe(2);
  });

  it("does not value units the ledger cannot price", () => {
    const summary = summarizeHoldings([
      holding({ character: "Main", itemId: 2589, qty: 4, knownQty: 0, unknownQty: 4 })
    ]);
    expect(summary.positions[2589]).toBeUndefined();
    expect(summary.unknownUnits).toBe(4);
  });
});
