// The account view sums character-scoped holdings. A market with two
// characters can carry the same item twice; keying by item without adding
// the rows silently kept one character's stock. Every owned unit gets a row,
// including stock the ledger never priced: hiding it behind a counter left
// the table claiming the character held fewer items than the bag showed.
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
      holding({ character: "Main", itemId: 2589, qty: 3, knownQty: 3, costBasis: 3000, carriedQty: 3 }),
      holding({ character: "Alt", itemId: 2589, qty: 2, knownQty: 2, costBasis: 2000, carriedQty: 2 })
    ]);
    expect(summary.positions[2589]).toEqual({ qty: 5, cost: 5000, costKnown: true, unknownQty: 0 });
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
        unknownQty: 3,
        missingQty: 1,
        costBasis: 7000
      })
    ]);
    // The row still lists every owned unit; the two without a booked cost
    // make the whole row's basis unproved, so its unit cost cannot be shown.
    expect(summary.positions[2589]).toEqual({ qty: 10, cost: 7000, costKnown: false, unknownQty: 3 });
    expect(summary.unknownUnits).toBe(3);
    expect(summary.missingUnits).toBe(1);
    expect(summary.byLocation).toEqual({ carried: 2, keyring: 1, bank: 5, mail: 1, listed: 1 });
  });

  it("lists a booked quantity whose cost was never proved", () => {
    const summary = summarizeHoldings([
      holding({ character: "Main", itemId: 2589, qty: 2, knownQty: 2, costKnown: false, costBasis: 2000 })
    ]);
    expect(summary.positions[2589]).toEqual({ qty: 2, cost: 2000, costKnown: false, unknownQty: 2 });
    expect(summary.unknownUnits).toBe(2);
  });

  it("lists units the ledger cannot price at all", () => {
    const summary = summarizeHoldings([
      holding({ character: "Main", itemId: 2589, qty: 4, knownQty: 0, unknownQty: 4 })
    ]);
    expect(summary.positions[2589]).toEqual({ qty: 4, cost: 0, costKnown: false, unknownQty: 4 });
    expect(summary.unknownUnits).toBe(4);
  });

  it("merges a proved row with an unproved row for the same item", () => {
    const summary = summarizeHoldings([
      holding({ character: "Main", itemId: 2589, qty: 3, knownQty: 3, costBasis: 3000 }),
      holding({ character: "Alt", itemId: 2589, qty: 4, knownQty: 0, unknownQty: 4 })
    ]);
    expect(summary.positions[2589]).toEqual({ qty: 7, cost: 3000, costKnown: false, unknownQty: 4 });
  });
});
