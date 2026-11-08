import { describe, expect, it } from "vitest";
import { qualityColorClass, qualityLabel } from "@/lib/quality";

describe("qualityColorClass", () => {
  it("maps WoW item qualities to their canonical colors", () => {
    expect(qualityColorClass("poor")).toBe("text-wow-poor");
    expect(qualityColorClass("common")).toBe("text-wow-common");
    expect(qualityColorClass("uncommon")).toBe("text-wow-uncommon");
    expect(qualityColorClass("rare")).toBe("text-wow-rare");
    expect(qualityColorClass("epic")).toBe("text-wow-epic");
    expect(qualityColorClass("legendary")).toBe("text-wow-legendary");
  });

  it("falls back to common white for unknown qualities", () => {
    expect(qualityColorClass("unknown")).toBe("text-wow-common");
    expect(qualityColorClass("")).toBe("text-wow-common");
  });
});

describe("qualityLabel", () => {
  it("prints the Chinese quality name and leaves an unknown label alone", () => {
    expect(qualityLabel("common")).toBe("普通");
    expect(qualityLabel("epic")).toBe("史诗");
    expect(qualityLabel("custom")).toBe("custom");
  });
});
