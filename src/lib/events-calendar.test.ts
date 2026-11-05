// The calendar is maintained by hand, so the parser is the only place that
// can catch a shape the core would silently ignore.
import { describe, expect, it } from "vitest";
import { loadDemandEvents, parseDemandEvents, upcomingDemandEvents, type DemandEvent } from "@/lib/events-calendar";

describe("demand calendar parsing", () => {
  it("treats an omitted or zero end as an instantaneous event", () => {
    const [event] = parseDemandEvents([{ name: "Raid reset", startsAt: 1_800_000_000 }]);
    expect(event.endsAt).toBe(1_800_000_000);
    const [zero] = parseDemandEvents([{ name: "Zero end", startsAt: 1_800_000_000, endsAt: 0 }]);
    expect(zero.endsAt).toBe(1_800_000_000);
  });

  it("rejects an end before the start instead of compiling a dead window", () => {
    expect(() => parseDemandEvents([
      { name: "Backwards", startsAt: 1_800_000_000, endsAt: 1_700_000_000 }
    ])).toThrow(/before startsAt/);
  });

  it("ships a committed template that can never match", () => {
    const events = loadDemandEvents();
    expect(events.some((event) => event.startsAt === 0)).toBe(true);
    // Scheduling real events later is allowed; a backwards window is not.
    expect(events.every((event) => event.endsAt >= event.startsAt)).toBe(true);
  });

  it("lists only scheduled, unexpired events on the homepage", () => {
    const event = (name: string, startsAt: number, endsAt = startsAt): DemandEvent => ({
      name,
      startsAt,
      endsAt,
      leadHours: 0,
      weight: 1,
      classes: [],
      subClasses: []
    });
    const listed = upcomingDemandEvents(
      [event("template", 0), event("past", 100), event("future", 900), event("now", 500)],
      500
    );
    expect(listed.map((entry) => entry.name)).toEqual(["now", "future"]);
  });
});
