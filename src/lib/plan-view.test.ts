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

  it("rejects a plan sized under another pipeline", () => {
    const latest = new Date(1721700000 * 1000);
    const plan = { revision: "A|Alliance|1721700000:2:7", configRevision: "3" };
    expect(planMatchesScan(plan, latest, undefined, "4")).toBe(false);
    expect(planMatchesScan({ ...plan, configRevision: "4" }, latest, undefined, "4")).toBe(true);
    // A stored row without a stamp is not a plan this pipeline minted.
    expect(planMatchesScan({ revision: plan.revision, configRevision: "" }, latest, undefined, "4")).toBe(false);
    // An unstamped object predates the field entirely; the scan epoch still
    // guards it.
    expect(planMatchesScan({ revision: plan.revision }, latest)).toBe(true);
  });

  it("rejects a plan sized from an older estate revision", () => {
    const latest = new Date(1721700000 * 1000);
    const plan = { revision: "A|Alliance|1721700000:2:7", estateRevision: 2 };
    expect(planMatchesScan(plan, latest, 2)).toBe(true);
    expect(planMatchesScan(plan, latest, 3)).toBe(false);
    // Without a state revision to compare, the scan epoch is the guard.
    expect(planMatchesScan(plan, latest)).toBe(true);
  });
});
