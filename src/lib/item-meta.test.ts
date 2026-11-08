import { describe, expect, it } from "vitest";
import { parseWowheadTooltip } from "@/lib/item-meta";

describe("parseWowheadTooltip", () => {
  it("reads the localized name and icon from a tooltip payload", () => {
    const payload = JSON.stringify({ name: "侍从衬衣", icon: "inv_shirt_01", tooltip: "<table></table>" });
    expect(parseWowheadTooltip(payload)).toEqual({ name: "侍从衬衣", icon: "inv_shirt_01" });
  });

  it("returns null for the region-blocked HTML page", () => {
    expect(parseWowheadTooltip("<!DOCTYPE html><html>Site unavailable in your region</html>")).toBeNull();
  });

  it("returns null when the payload has no name", () => {
    expect(parseWowheadTooltip(JSON.stringify({ icon: "inv_shirt_01" }))).toBeNull();
  });

  it("returns null when the payload has no icon", () => {
    expect(parseWowheadTooltip(JSON.stringify({ name: "侍从衬衣" }))).toBeNull();
  });

  it("returns null for an empty name", () => {
    expect(parseWowheadTooltip(JSON.stringify({ name: "", icon: "inv_shirt_01" }))).toBeNull();
  });
});
