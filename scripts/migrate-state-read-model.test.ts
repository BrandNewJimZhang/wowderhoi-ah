import { describe, expect, it } from "vitest";
import { holdingSeed, MIGRATED_COVERAGE } from "./migrate-state-read-model";

describe("state read-model migration", () => {
  it("seeds a holding from the old ledger position", () => {
    expect(holdingSeed({ market_id: "m", item_id: 2589, qty: 4, cost_basis: 4000 })).toEqual({
      qty: 4,
      // The old model never observed the bag; the quantity is known, the
      // location is not.
      carriedQty: 0,
      knownQty: 4,
      unknownQty: 0,
      missingQty: 0,
      costBasis: 4000
    });
  });

  it("marks every location except cash as unobserved", () => {
    expect(MIGRATED_COVERAGE).toEqual({
      carried: "unobserved",
      bank: "unobserved",
      mail: "unobserved",
      listed: "unobserved",
      money: "observed"
    });
  });
});
