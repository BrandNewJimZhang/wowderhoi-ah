import { describe, expect, it } from "vitest";
import { formatWowMoney, splitCopper } from "@/lib/wow-money";

describe("splitCopper", () => {
  it("splits copper into gold/silver/copper parts", () => {
    expect(splitCopper(1234567)).toEqual({ gold: 123, silver: 45, copper: 67 });
    expect(splitCopper(9)).toEqual({ gold: 0, silver: 0, copper: 9 });
    expect(splitCopper(10000)).toEqual({ gold: 1, silver: 0, copper: 0 });
  });

  it("clamps negatives to zero parts with a sign flag", () => {
    expect(splitCopper(-1234567)).toEqual({ gold: 123, silver: 45, copper: 67 });
  });
});

describe("formatWowMoney", () => {
  it("renders compact g/s/c text skipping zero parts", () => {
    expect(formatWowMoney(1234567)).toBe("123g 45s 67c");
    expect(formatWowMoney(10000)).toBe("1g");
    expect(formatWowMoney(560)).toBe("5s 60c");
    expect(formatWowMoney(9)).toBe("9c");
    expect(formatWowMoney(0)).toBe("0c");
  });

  it("drops copper on large gold amounts for chart-axis brevity", () => {
    expect(formatWowMoney(1234567, { compact: true })).toBe("123g");
    expect(formatWowMoney(45600, { compact: true })).toBe("4g 56s");
  });

  it("prefixes negative amounts", () => {
    expect(formatWowMoney(-560)).toBe("-5s 60c");
  });
});
