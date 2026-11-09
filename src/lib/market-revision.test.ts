// The auto-refresh revision is the market's committed data version. It is
// advanced inside the import transaction, so the poll moves with the data
// and not with a diagnostic ImportRun row that may fail or be pruned.
import { describe, expect, it } from "vitest";
import { marketRevision } from "@/lib/market-revision";

const scope = {
  id: "m1",
  realm: "TestRealm",
  faction: "Alliance",
  cash: 0,
  character: "Tester",
  dataVersion: 7
};

describe("marketRevision", () => {
  it("names the scope and the data version committed with its inputs", () => {
    expect(marketRevision(scope)).toBe("m1:7");
  });

  it("moves when the committed data version advances", () => {
    expect(marketRevision({ ...scope, dataVersion: 8 })).toBe("m1:8");
  });

  it("keeps two markets from sharing an empty revision", () => {
    expect(marketRevision({ ...scope, id: "m2", dataVersion: 0 })).toBe("m2:0");
  });

  it("has a stable revision before the market's first import", () => {
    expect(marketRevision(null)).toBe("none");
  });
});
