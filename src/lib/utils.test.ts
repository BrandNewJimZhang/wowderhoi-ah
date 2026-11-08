import { describe, expect, it } from "vitest";
import { formatPercent } from "@/lib/utils";

describe("formatPercent", () => {
  it("prints a signed two-decimal change", () => {
    expect(formatPercent(12.345)).toBe("+12.35%");
    expect(formatPercent(-3)).toBe("-3.00%");
  });

  it("bounds a move that would overflow the column", () => {
    expect(formatPercent(1_388_888_662.5)).toBe(">9999%");
    expect(formatPercent(-1_388_888_662.5)).toBe("<-9999%");
    expect(formatPercent(9999)).toBe("+9999.00%");
  });
});
