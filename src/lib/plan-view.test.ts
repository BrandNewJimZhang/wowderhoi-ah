import { describe, expect, it } from "vitest";
import { planEpoch, planMatchesScan } from "@/lib/plan-view";

describe("plan view", () => {
  it("reads the scan epoch from the plan revision", () => {
    expect(planEpoch("A|Alliance|1721700000:2:7")).toBe(1721700000);
    expect(planEpoch("not-a-plan")).toBeNull();
  });

  it("only treats a plan minted for the current scan as current", () => {
    const latest = new Date(1721700000 * 1000);
    expect(planMatchesScan({ revision: "A|Alliance|1721700000:2:7" }, latest)).toBe(true);
    expect(planMatchesScan({ revision: "A|Alliance|1721600000:2:7" }, latest)).toBe(false);
    expect(planMatchesScan(null, latest)).toBe(false);
    expect(planMatchesScan({ revision: "A|Alliance|1721700000:2:7" }, null)).toBe(false);
  });
});
