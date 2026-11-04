import { describe, expect, it } from "vitest";
import { demandBands, demandFor } from "@/lib/demand";

describe("demand priors", () => {
  it("favours opening-week necessities", () => {
    expect(demandFor("Container", "Bag")).toBe(1.7);
    expect(demandFor("Consumable", "Potion")).toBe(1.6);
    expect(demandFor("Weapon", "Wand")).toBe(1.5);
  });

  it("matches the localized client class names", () => {
    expect(demandFor("容器", "背包")).toBe(1.7);
    expect(demandFor("消耗品", "药水")).toBe(1.6);
    expect(demandFor("武器", "魔杖")).toBe(1.5);
  });

  it("is case-insensitive", () => {
    expect(demandFor("container", "bag")).toBe(1.7);
  });

  it("uses the wildcard band for an unknown category", () => {
    expect(demandFor("Miscellaneous", "Other")).toBe(1);
  });

  it("carries the band's rationale alongside its weight", () => {
    // The dataset feeds the compiled Lua table; the note documents why the
    // weight exists, so a review can check the prior, not just its value.
    const band = demandBands.find((entry) => entry.classes.includes("Container") && entry.subClasses.includes("Bag"));
    expect(band?.levelBand).toBe("1-60");
    expect(band?.note).toContain("刚需");
  });
});
