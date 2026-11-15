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

describe("active event windows", () => {
  function withEvents(eventFactory: (now: number) => unknown[]) {
    const lua = loadAddon();
    const now = lua.number("time()");
    lua.exec(`WowTest.ns.EVENTS = ${toLua(eventFactory(now))}`);
    return { lua, now };
  }

  it("names the active windows by integer index", () => {
    const { lua } = withEvents((now) => [{
      name: "Inside", startsAt: now - 60, endsAt: now + 3600, leadHours: 0, weight: 1.5
    }, {
      name: "Past", startsAt: now - 7200, endsAt: now - 3600, leadHours: 0, weight: 2
    }, {
      name: "Template", startsAt: 0, endsAt: 0, leadHours: 0, weight: 2
    }]);
    expect(lua.text("WowTest.ns.Core.activeEventsKey(time())")).toBe("1");
    expect(lua.value("WowTest.ns.Core.activeEventIndices(time())")).toEqual([1]);
  });

  it("moves only at the window edges", () => {
    const { lua } = withEvents((now) => [{
      name: "Later", startsAt: now + 10800, endsAt: now + 14400, leadHours: 2, weight: 1.5
    }]);
    // The lead window opens an hour from now (startsAt - 2h).
    expect(lua.text("WowTest.ns.Core.activeEventsKey(time())")).toBe("-");
    lua.advance(3599);
    expect(lua.text("WowTest.ns.Core.activeEventsKey(time())")).toBe("-");
    lua.advance(1);
    expect(lua.text("WowTest.ns.Core.activeEventsKey(time())")).toBe("1");
    lua.advance(1800);
    expect(lua.text("WowTest.ns.Core.activeEventsKey(time())")).toBe("1");
    lua.advance(9001);
    expect(lua.text("WowTest.ns.Core.activeEventsKey(time())")).toBe("-");
  });

  it("does not put the event weight in the key", () => {
    const { lua } = withEvents((now) => [{
      name: "Inside", startsAt: now - 60, endsAt: now + 3600, leadHours: 0, weight: 1.5
    }]);
    const key = lua.text("WowTest.ns.Core.activeEventsKey(time())");
    lua.exec("WowTest.ns.EVENTS[1].weight = 3");
    expect(lua.text("WowTest.ns.Core.activeEventsKey(time())")).toBe(key);
  });

  it("uses the same predicate as the ranking boost", () => {
    const { lua } = withEvents((now) => [{
      name: "Inside", startsAt: now, endsAt: now + 3600, leadHours: 0, weight: 1.5,
      classes: ["*"], subClasses: []
    }]);
    expect(lua.number("WowTest.ns.Core.eventBoost(time(), 'Trade Goods', 'Cloth')")).toBeCloseTo(1.5, 3);
    expect(lua.text("WowTest.ns.Core.activeEventsKey(time())")).toBe("1");
  });
});

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

  it("treats an empty class list as no restriction, like subClasses", () => {
    // An event scheduled with only subClasses must not silently match
    // nothing: an empty restriction list means "all", the same rule the
    // subcategory list already follows.
    expect(boostWith((now) => [{
      name: "Subcategory only",
      startsAt: now,
      endsAt: now + 3600,
      leadHours: 0,
      weight: 1.4,
      classes: [],
      subClasses: ["Cloth"]
    }], "Trade Goods", "Cloth")).toBeCloseTo(1.4, 3);
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
