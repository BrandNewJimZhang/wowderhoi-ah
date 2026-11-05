// Demand calendar. WoW demand is not a stationary process: raid resets,
// the Darkmoon Faire, phase openings and PvP settlement move whole
// categories at once. The calendar is maintained by hand in
// src/data/events.json and compiled into WAH.EVENTS; the core multiplies
// the demand prior inside a window and nothing else.
//
// An entry with startsAt 0 is a template, not a scheduled event: it can
// never match, so shipping the file with one costs nothing and documents
// the shape.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type DemandEvent = {
  name: string;
  startsAt: number; // epoch seconds; 0 = template/disabled
  endsAt: number;
  leadHours: number; // stock up this long before the window
  weight: number; // demand-prior multiplier while active
  classes: string[];
  subClasses: string[];
};

const EVENTS_PATH = fileURLToPath(new URL("../data/events.json", import.meta.url));

export function loadDemandEvents(): DemandEvent[] {
  const parsed = JSON.parse(readFileSync(EVENTS_PATH, "utf8")) as unknown;
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
    return {
      name: event.name,
      startsAt: number("startsAt"),
      endsAt: number("endsAt"),
      leadHours: number("leadHours"),
      weight: number("weight", 1),
      classes: list("classes"),
      subClasses: list("subClasses")
    };
  });
}
