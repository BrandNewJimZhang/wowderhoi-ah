// The demand calendar only scales the ranking prior inside a scheduled
// window. It must never match a template entry, never relax a gate, and
// never apply outside its lead and end times.
import { describe, expect, it } from "vitest";
import { loadAddon, toLua } from "./wow-lua";

// The stub clock is fixed; build event windows relative to the addon's own
// time() so the test does not depend on the wall clock.
function boostWith(events: (now: number) => unknown[], category: string, subCategory: string) {
  const lua = loadAddon();
  const now = lua.number("time()");
  lua.exec(`WowTest.ns.EVENTS = ${toLua(events(now))}`);
  return lua.number(
    `WowTest.ns.Core.eventBoost(time(), ${JSON.stringify(category)}, ${JSON.stringify(subCategory)})`
  );
}

describe("demand calendar", () => {
  it("multiplies the prior inside the lead window", () => {
    expect(boostWith((now) => [{
      name: "Raid reset",
      startsAt: now + 3600,
      endsAt: now + 7200,
      leadHours: 2,
      weight: 1.5,
      classes: ["Trade Goods"],
      subClasses: []
    }], "Trade Goods", "Cloth")).toBeCloseTo(1.5, 3);
  });

  it("ignores an event outside its window and a template entry", () => {
    expect(boostWith((now) => [{
      name: "Past",
      startsAt: now - 7200,
      endsAt: now - 3600,
      leadHours: 0,
      weight: 2,
      classes: ["*"],
      subClasses: []
    }], "Trade Goods", "Cloth")).toBe(1);
    expect(boostWith(() => [{
      name: "Template",
      startsAt: 0,
      endsAt: 0,
      leadHours: 0,
      weight: 2,
      classes: ["*"],
      subClasses: []
    }], "Trade Goods", "Cloth")).toBe(1);
  });

  it("requires the subcategory to match when the event names one", () => {
    const event = (now: number) => [{
      name: "Enchanting",
      startsAt: now,
      endsAt: now + 3600,
      leadHours: 0,
      weight: 1.3,
      classes: ["Trade Goods"],
      subClasses: ["Enchanting"]
    }];
    expect(boostWith(event, "Trade Goods", "Enchanting")).toBeCloseTo(1.3, 3);
    expect(boostWith(event, "Trade Goods", "Cloth")).toBe(1);
  });
});
