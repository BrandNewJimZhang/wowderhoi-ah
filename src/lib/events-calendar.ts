// Demand calendar. WoW demand is not a stationary process: raid resets,
// the Darkmoon Faire, phase openings and PvP settlement move whole
// categories at once. The calendar is maintained by hand in
// src/data/events.json and compiled into WAH.EVENTS; the core multiplies
// the demand prior inside a window and nothing else.
//
// An entry with startsAt 0 is a template, not a scheduled event: it can
// never match, so shipping the file with one costs nothing and documents
// the shape.
import rawEvents from "@/data/events.json";

export type DemandEvent = {
  name: string;
  startsAt: number; // epoch seconds; 0 = template/disabled
  endsAt: number;
  leadHours: number; // stock up this long before the window
  weight: number; // demand-prior multiplier while active
  classes: string[];
  subClasses: string[];
};

// Bundled rather than read at runtime: the page, the addon rule generator
// and the tests must all see the same parsed schedule, and a filesystem
// read is not available to every bundler target.
export function loadDemandEvents(): DemandEvent[] {
  return parseDemandEvents(rawEvents as unknown);
}

// The homepage lists the same schedule the core ranks on. Keeping a second
// event table in the database is how the displayed calendar and the applied
// demand boost drift apart.
export function upcomingDemandEvents(
  events: DemandEvent[],
  nowSeconds: number,
  limit = 6
): DemandEvent[] {
  return events
    .filter((event) => event.startsAt > 0 && event.endsAt >= nowSeconds)
    .sort((left, right) => left.startsAt - right.startsAt)
    .slice(0, limit);
}

// `endsAt` omitted (or 0) means the event is instantaneous: it fires at
// `startsAt` and closes at the same epoch. Leaving it at 0 used to compile a
// window that could never match, so a hand-written event silently did
// nothing; a declared end before the start is a typo and fails loudly.
export function parseDemandEvents(parsed: unknown): DemandEvent[] {
  if (!Array.isArray(parsed)) throw new Error("events.json must be an array of demand events");
  return parsed.map((entry, index) => {
    const event = entry as Record<string, unknown>;
    if (typeof event.name !== "string" || event.name === "") {
      throw new Error(`events.json[${index}]: name must be a non-empty string`);
    }
    const number = (key: string, fallback = 0) => {
      const value = event[key];
      if (value === undefined) return fallback;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`events.json[${index}]: ${key} must be a non-negative number`);
      }
      return value;
    };
    const list = (key: string) => {
      const value = event[key];
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`events.json[${index}]: ${key} must be an array of strings`);
      }
      return value as string[];
    };
    const startsAt = number("startsAt");
    const declaredEnd = number("endsAt");
    if (declaredEnd > 0 && declaredEnd < startsAt) {
      throw new Error(`events.json[${index}]: endsAt (${declaredEnd}) is before startsAt (${startsAt})`);
    }
    return {
      name: event.name,
      startsAt,
      endsAt: declaredEnd > 0 ? declaredEnd : startsAt,
      leadHours: number("leadHours"),
      weight: number("weight", 1),
      classes: list("classes"),
      subClasses: list("subClasses")
    };
  });
}
